// Agent runner: loads templates, calls models, manages memory

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getAgentDir } from './config.js';
import { buildSafeSystemPrompt, sanitizeUserInput } from './security.js';
import type { Config, ChatMessage, ChatOptions, ToolConfig, AgentRunContext, ContentBlock } from './types.js';
import { getToolDefinitions, executeTool, type ExecuteToolContext } from './tools.js';
import { startTrace, addEvent, endTrace } from './audit.js';
import { loadSkills, getSkillsForContext, formatSkillsPrompt } from './skills.js';
import type { SkillConfig } from './skills-types.js';
import { calculateUsageCost, getLangfuseConfig, isLangfuseEnabled } from './langfuse.js';
import { startActiveObservation, startObservation, updateActiveTrace } from '@langfuse/tracing';

// --- Template Loading ---

export const TEMPLATE_FILES = ['SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md', 'BOOT.md', 'HEARTBEAT.md', 'MEMORY.md'];

export function loadAgentTemplates(agentId: string): Record<string, string> {
  const agentDir = getAgentDir(agentId);
  const templates: Record<string, string> = {};

  for (const file of TEMPLATE_FILES) {
    const path = join(agentDir, file);
    if (existsSync(path)) {
      templates[file.replace('.md', '')] = readFileSync(path, 'utf-8');
    }
  }

  return templates;
}

// Track if using OAuth (requires Claude Code identity)
let usingOAuth = false;

export function setUsingOAuth(value: boolean): void {
  usingOAuth = value;
}

/** Context for skills injection into the system prompt */
export interface SkillsPromptContext {
  channel?: string;
  cronJobId?: string;
  tags?: string[];
  toolConfig?: ToolConfig;
  skillConfig?: SkillConfig;
}

export function buildSystemPrompt(agentId: string, skillsContext?: SkillsPromptContext): string {
  const templates = loadAgentTemplates(agentId);

  const soul = templates.SOUL || '';
  const identity = templates.IDENTITY || '';
  const user = templates.USER || '';
  const tools = templates.TOOLS || '';
  const memory = templates.MEMORY || '';

  // Load and filter skills
  let skillsSection = '';
  if (skillsContext?.skillConfig?.enabled !== false) {
    const allSkills = loadSkills(skillsContext?.skillConfig, skillsContext?.toolConfig);
    const contextSkills = getSkillsForContext(allSkills, {
      channel: skillsContext?.channel,
      cronJobId: skillsContext?.cronJobId,
      tags: skillsContext?.tags,
    });
    skillsSection = formatSkillsPrompt(contextSkills, skillsContext?.skillConfig?.maxPromptTokens);
  }

  const base = [soul, identity, tools, skillsSection].filter(Boolean).join('\n\n---\n\n');
  const userContext = [user, memory].filter(Boolean).join('\n\n');

  const prompt = buildSafeSystemPrompt(base, userContext);

  return prompt;
}

// Anti-hallucination instructions injected between the Claude Code identity
// block and the actual system prompt. Prevents the model from roleplaying
// Claude Code's full behavior (XML tool calls, fabricated output, etc.)
const TOOL_GUARD = `You are a personal assistant running inside SkimpyClaw.
You are NOT the full Claude Code CLI. Do NOT roleplay as Claude Code.

## Tool Rules
- You have ONLY the tools provided via the API tool_use mechanism.
- Tool names are case-sensitive. Call tools exactly as listed.
- NEVER output tool calls as text/XML/JSON. Use the API tool_use mechanism only.
- NEVER fabricate tool results or file contents. If you haven't read a file, say so.
- NEVER invent tools that are not in your tool list (no str_replace_editor, no view, etc.)
- If a Browser tool is available, you DO have web-browsing access via that tool. Use it instead of claiming you can’t browse.
- If you need information, use a tool to get it. Do not guess.`;

// --- Langfuse App Tagging ---
const LANGFUSE_APP_NAME = 'skimpyclaw';
const LANGFUSE_APP_TAG = 'app:skimpyclaw';

/** Build Langfuse costDetails from model + token usage. Returns undefined if no pricing data. */
function toCostDetails(model: string, usage: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number } | null | undefined): { input: number; output: number; total: number } | undefined {
  // Support both OpenAI (prompt_tokens/completion_tokens) and Anthropic (input_tokens/output_tokens)
  const inputTok = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
  const outputTok = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
  if (!inputTok && !outputTok) return undefined;
  const cost = calculateUsageCost(model, inputTok, outputTok);
  if (cost.totalCost === 0) return undefined;
  return { input: cost.inputCost, output: cost.outputCost, total: cost.totalCost };
}

/** Normalize Anthropic usage (input_tokens/output_tokens) to Langfuse format */
function toAnthropicUsageDetails(usage: any): Record<string, number> | undefined {
  if (!usage) return undefined;
  const details: Record<string, number> = {};

  // Map Anthropic fields to standard names Langfuse expects
  if (typeof usage.input_tokens === 'number') {
    details.prompt_tokens = usage.input_tokens;
    details.input_tokens = usage.input_tokens;
  }
  if (typeof usage.output_tokens === 'number') {
    details.completion_tokens = usage.output_tokens;
    details.output_tokens = usage.output_tokens;
  }
  if (details.prompt_tokens != null && details.completion_tokens != null) {
    details.total_tokens = details.prompt_tokens + details.completion_tokens;
  }

  // Include cache details if present
  if (typeof usage.cache_creation_input_tokens === 'number') {
    details.cache_creation_input_tokens = usage.cache_creation_input_tokens;
  }
  if (typeof usage.cache_read_input_tokens === 'number') {
    details.cache_read_input_tokens = usage.cache_read_input_tokens;
  }

  return Object.keys(details).length > 0 ? details : undefined;
}

function startGenerationObservation(name: string, attributes: Record<string, any>) {
  if (!isLangfuseEnabled()) return null;
  attributes.metadata = { app: LANGFUSE_APP_NAME, ...attributes.metadata };
  return startObservation(name, attributes, { asType: 'generation' });
}

function toUsageDetails(usage: OpenAI.Completions.CompletionUsage | null | undefined): Record<string, number> | undefined {
  if (!usage) return undefined;

  const usageDetails: Record<string, number> = {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
  };

  if (usage.prompt_tokens_details) {
    for (const [key, value] of Object.entries(usage.prompt_tokens_details)) {
      if (typeof value === 'number') {
        usageDetails[`prompt_tokens_details_${key}`] = value;
      }
    }
  }

  if (usage.completion_tokens_details) {
    for (const [key, value] of Object.entries(usage.completion_tokens_details)) {
      if (typeof value === 'number') {
        usageDetails[`completion_tokens_details_${key}`] = value;
      }
    }
  }

  return usageDetails;
}

function toNumericUsageDetails(usage: unknown): Record<string, number> | undefined {
  if (!usage || typeof usage !== 'object') return undefined;

  const details: Record<string, number> = {};

  const flatten = (value: unknown, prefix = ''): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;

    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const field = prefix ? `${prefix}_${key}` : key;
      if (typeof nested === 'number') {
        details[field] = nested;
      } else if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        flatten(nested, field);
      }
    }
  };

  flatten(usage);
  return Object.keys(details).length > 0 ? details : undefined;
}

/**
 * Build the system parameter for Anthropic API calls.
 * For OAuth: returns an array with Claude Code identity + guard + actual prompt as separate blocks.
 * For API key: returns the prompt string directly (or array with cache_control if caching enabled).
 * When cacheEnabled, adds cache_control breakpoint to the last system block.
 */
export function buildSystemParam(
  systemContent: string | undefined,
  cacheEnabled: boolean = false
): string | Array<{type: 'text', text: string, cache_control?: {type: 'ephemeral'}}> | undefined {
  if (!systemContent) return undefined;

  if (usingOAuth) {
    const blocks: Array<{type: 'text', text: string, cache_control?: {type: 'ephemeral'}}> = [
      { type: 'text' as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: 'text' as const, text: TOOL_GUARD },
      { type: 'text' as const, text: systemContent },
    ];
    if (cacheEnabled) {
      blocks[2].cache_control = { type: 'ephemeral' };
    }
    return blocks;
  }

  if (cacheEnabled) {
    return [{ type: 'text' as const, text: systemContent, cache_control: { type: 'ephemeral' } }];
  }
  return systemContent;
}

/**
 * Add cache_control breakpoint to the last tool definition.
 * One breakpoint on the last tool caches the entire tools array.
 */
export function addToolCacheBreakpoint(toolDefs: any[]): void {
  if (toolDefs.length === 0) return;
  toolDefs[toolDefs.length - 1].cache_control = { type: 'ephemeral' };
}

// --- Memory Management ---

export function getMemoryDir(agentId: string): string {
  return join(getAgentDir(agentId), 'memory', 'logs');
}

export function getTodayMemoryPath(agentId: string): string {
  const date = new Date().toISOString().split('T')[0];
  return join(getMemoryDir(agentId), `${date}.md`);
}

export function appendToMemory(agentId: string, entry: string): void {
  const memoryDir = getMemoryDir(agentId);
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }

  const path = getTodayMemoryPath(agentId);
  const timestamp = new Date().toISOString();
  const content = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const newContent = content + `\n## ${timestamp}\n\n${entry}\n`;
  writeFileSync(path, newContent.trim() + '\n');
}

// --- Codex OAuth ---

const DEFAULT_CODEX_AUTH_PATH = join(homedir(), '.codex', 'auth.json');
const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
let codexAuthPath = DEFAULT_CODEX_AUTH_PATH;
let codexBaseUrl = DEFAULT_CODEX_BASE_URL;

interface CodexAuth {
  accessToken: string;
  accountId: string;
}

function loadCodexAuth(authPath: string = codexAuthPath): CodexAuth | null {
  if (!existsSync(authPath)) {
    console.log(`[codex] No auth file at ${authPath}`);
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(authPath, 'utf-8'));
    const token = raw?.tokens?.access_token;
    if (!token) {
      console.log('[codex] No access_token in auth file');
      return null;
    }

    // Decode JWT to check expiry and extract account ID
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    const exp = payload.exp * 1000;
    const now = Date.now();
    if (now > exp) {
      const expiredAgo = Math.round((now - exp) / 60000);
      console.warn(`[codex] Token expired ${expiredAgo} min ago. Run 'codex' to re-auth.`);
      return null;
    }

    // Extract account ID from JWT claims
    const authClaims = payload['https://api.openai.com/auth'];
    const accountId = authClaims?.chatgpt_account_id;
    if (!accountId) {
      console.error('[codex] No account ID in token');
      return null;
    }

    const expiresIn = Math.round((exp - now) / 60000);
    console.log(`[codex] Token valid (expires in ${expiresIn} min, account: ${accountId.slice(0, 8)}...)`);
    return { accessToken: token, accountId };
  } catch (error) {
    console.error('[codex] Failed to read auth file:', error);
    return null;
  }
}

let codexAuth: CodexAuth | null = null;

/**
 * Convert Anthropic tool definitions to OpenAI function format for Responses API.
 */
function toCodexToolDefinitions(tools: any[]): any[] {
  return tools.map(t => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));
}

/**
 * Parse an SSE response from the Codex backend.
 * Extracts function calls from the completed response object (not from delta events)
 * because call_id is only reliably available on the final output items.
 */
function parseCodexSSE(text: string): { outputText: string; functionCalls: any[]; response: any | null } {
  let outputText = '';
  let completedResponse: any = null;

  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') break;
    try {
      const event = JSON.parse(data);
      if (event.type === 'response.output_text.delta') {
        outputText += event.delta || '';
      } else if (event.type === 'response.completed' && event.response) {
        completedResponse = event.response;
        if (event.response.output_text) outputText = event.response.output_text;
      }
    } catch { /* skip non-JSON lines */ }
  }

  // Extract function calls and output_text items from completed response
  const functionCalls: any[] = [];
  if (completedResponse?.output) {
    for (const item of completedResponse.output) {
      if (item.type === 'function_call') {
        functionCalls.push({
          callId: item.call_id,
          name: item.name,
          arguments: item.arguments,
        });
      } else if (item.type === 'output_text' && item.text) {
        // Capture output_text items that may not appear at top-level
        if (!outputText) outputText = item.text;
      }
    }
  }

  if (completedResponse?.usage) {
    console.log(`[codex] Usage: ${JSON.stringify(completedResponse.usage)}`);
  } else {
    console.log('[codex] No usage data in response');
  }

  return { outputText, functionCalls, response: completedResponse };
}

/**
 * Make a single Codex API call. Returns raw SSE text.
 */
async function codexFetch(body: any): Promise<string> {
  if (!codexAuth) {
    throw new Error('Codex auth not initialized. Run "codex" CLI to authenticate.');
  }

  const baseUrl = codexBaseUrl || DEFAULT_CODEX_BASE_URL;
  const response = await fetch(`${baseUrl}/codex/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${codexAuth.accessToken}`,
      'chatgpt-account-id': codexAuth.accountId,
      'OpenAI-Beta': 'responses=experimental',
      'originator': 'codex_cli_rs',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown');
    throw new Error(`Codex API ${response.status}: ${errorText}`);
  }

  return response.text();
}

/**
 * Call the Codex Responses API via ChatGPT backend.
 * Supports tool use via agentic loop.
 */
async function codexChat(messages: ChatMessage[], model: string, toolConfig?: ToolConfig, toolDefs?: any[], toolContext?: ExecuteToolContext): Promise<{ response: string; toolCalls: string[] }> {
  // Build input — system messages go to `instructions`, rest to `input`
  let instructions = 'You are a helpful assistant.';
  const input: any[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      instructions = contentToText(m.content);
    } else {
      const contentType = m.role === 'assistant' ? 'output_text' : 'input_text';
      input.push({
        type: 'message',
        role: m.role,
        content: [{ type: contentType, text: contentToText(m.content) }],
      });
    }
  }

  const maxIterations = toolConfig?.maxIterations || 100;
  const tools = toolConfig?.enabled && toolDefs ? toCodexToolDefinitions(toolDefs) : undefined;
  const toolLog: string[] = [];

  for (let i = 0; i < maxIterations; i++) {
    const body: any = {
      model,
      instructions,
      input,
      store: false,
      stream: true,
      reasoning: { effort: 'medium', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
    };
    if (tools) body.tools = tools;

    console.log(`[codex] Iteration ${i + 1}/${maxIterations} (model: ${model})`);

    const genObs = startGenerationObservation(`codex:${model}`, {
      input: { instructions, input },
      model,
      modelParameters: { stream: true, reasoning: body.reasoning },
      metadata: { provider: 'codex', iteration: i + 1 },
    });

    let parsed: { outputText: string; functionCalls: any[]; response: any | null };
    try {
      const sseText = await codexFetch(body);
      parsed = parseCodexSSE(sseText);
      genObs?.update({
        output: { text: parsed.outputText },
        usageDetails: toNumericUsageDetails(parsed.response?.usage),
        costDetails: toCostDetails(model, parsed.response?.usage),
      });
      genObs?.end();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      genObs?.update({ level: 'ERROR', statusMessage: errorMessage, output: { error: errorMessage } });
      genObs?.end();
      throw err;
    }

    // No function calls — we're done
    if (parsed.functionCalls.length === 0) {
      // Debug: log what Codex actually returned when outputText is empty
      if (!parsed.outputText) {
        console.log(`[codex] Empty outputText. Response output items:`, JSON.stringify(parsed.response?.output?.map((i: any) => ({ type: i.type, text: i.text?.slice(0, 200) })), null, 2));
      }
      // If no text output, use the last tool result as the response
      let finalText = parsed.outputText;
      if (!finalText && toolLog.length > 0) {
        finalText = `[Completed with ${toolLog.length} tool calls, no text response]\n\nLast tool: ${toolLog[toolLog.length - 1]}`;
      }
      return { response: finalText || '[No response from Codex]', toolCalls: toolLog };
    }

    // Add the assistant's output items to input for next turn
    if (parsed.response?.output) {
      for (const item of parsed.response.output) {
        input.push(item);
      }
    }

    // Execute each function call and add results to input
    for (const fc of parsed.functionCalls) {
      const argsStr = fc.arguments || '{}';
      let args: Record<string, any>;
      try {
        args = JSON.parse(argsStr);
      } catch {
        args = {};
      }

      const inputStr = argsStr.slice(0, 200);
      console.log(`[codex:tools] -> ${fc.name}(${inputStr})`);

      const toolObs = isLangfuseEnabled()
        ? startObservation(`tool:${fc.name}`, { input: args, metadata: { app: LANGFUSE_APP_NAME, tool: fc.name } }, { asType: 'tool' })
        : null;

      const toolStart = Date.now();
      try {
        const result = await executeTool(fc.name, args, toolConfig!, toolContext) || '';
        const resultPreview = result.slice(0, 200) + (result.length > 200 ? '...' : '');
        console.log(`[codex:tools] <- ${resultPreview}`);
        toolLog.push(`${fc.name}(${inputStr}) → ${resultPreview}`);

        toolObs?.update({ output: result });
        toolObs?.end();

        if (toolContext?.auditTraceId) {
          addEvent(toolContext.auditTraceId, {
            type: 'tool_use',
            summary: `${fc.name}(${inputStr})`,
            durationMs: Date.now() - toolStart,
          });
        }

        input.push({
          type: 'function_call_output',
          call_id: fc.callId,
          output: result,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        toolObs?.update({ level: 'ERROR', statusMessage: errorMessage, output: { error: errorMessage } });
        toolObs?.end();

        if (toolContext?.auditTraceId) {
          addEvent(toolContext.auditTraceId, {
            type: 'tool_error',
            summary: `${fc.name} error: ${errorMessage.slice(0, 150)}`,
            durationMs: Date.now() - toolStart,
          });
        }
        throw err;
      }
    }
  }

  console.warn(`[codex:tools] Max iterations (${maxIterations}) reached`);
  return { response: '[Tool use loop reached maximum iterations]', toolCalls: toolLog };
}

// --- Model Providers ---

let anthropicClient: Anthropic | null = null;
// Map of provider name → OpenAI client (supports openai, openrouter, groq, together, etc.)
const openaiClients = new Map<string, OpenAI>();
// Providers that use the Codex Responses API (ChatGPT backend)
const responsesApiProviders = new Set<string>();

export function initProviders(config: Config): void {
  const anthropicConfig = config.models.providers.anthropic;
  if (anthropicConfig?.apiKey || anthropicConfig?.authToken) {
    const opts: Record<string, any> = {};

    if (anthropicConfig.authToken) {
      // OAuth token path - must impersonate Claude Code exactly
      setUsingOAuth(true);
      opts.apiKey = null;  // Critical: must be null for OAuth
      opts.authToken = anthropicConfig.authToken;
      opts.defaultHeaders = {
        'accept': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
        'user-agent': 'claude-cli/2.1.2 (external, cli)',
        'x-app': 'cli',
      };
      opts.dangerouslyAllowBrowser = true;
    } else if (anthropicConfig.apiKey) {
      opts.apiKey = anthropicConfig.apiKey;
    }
    anthropicClient = new Anthropic(opts);
  }

  // Initialize all non-Anthropic providers
  for (const [name, providerConfig] of Object.entries(config.models.providers)) {
    if (name === 'anthropic' || !providerConfig) continue;

    // Codex OAuth uses ChatGPT backend, not OpenAI API
    if (providerConfig.authToken === 'codex') {
      codexAuthPath = providerConfig.authPath || DEFAULT_CODEX_AUTH_PATH;
      codexBaseUrl = providerConfig.baseURL || DEFAULT_CODEX_BASE_URL;
      codexAuth = loadCodexAuth();
      if (codexAuth) {
        responsesApiProviders.add(name);
        console.log(`[providers] Initialized ${name} [codex ChatGPT backend]`);
      } else {
        console.log(`[providers] Skipping ${name} — no Codex OAuth token found`);
      }
      continue;
    }

    const apiKey = providerConfig.apiKey;
    if (!apiKey) continue;

    const opts: Record<string, any> = { apiKey };
    if (providerConfig.baseURL) opts.baseURL = providerConfig.baseURL;
    // Kimi Code API requires a coding-agent User-Agent with version string
    if (providerConfig.baseURL?.includes('kimi.com')) {
      opts.defaultHeaders = { 'User-Agent': 'claude-code/2.1.42' };
    }
    openaiClients.set(name, new OpenAI(opts));
    console.log(`[providers] Initialized ${name}${providerConfig.baseURL ? ` (${providerConfig.baseURL})` : ''}`);
  }
}

export function resolveModel(modelSpec: string, config: Config): string {
  // Check aliases first
  if (config.models.aliases[modelSpec]) {
    return config.models.aliases[modelSpec];
  }
  return modelSpec;
}

function getProvider(model: string): string {
  // Explicit prefix: "openrouter/google/gemini-2.0-flash" → "openrouter"
  const slashIdx = model.indexOf('/');
  if (slashIdx > 0) {
    const prefix = model.slice(0, slashIdx);
    // Known Anthropic prefix
    if (prefix === 'anthropic') return 'anthropic';
    // Any other prefix = provider name (openai, openrouter, groq, together, etc.)
    return prefix;
  }
  // No prefix: infer from model name
  if (model.includes('claude')) return 'anthropic';
  if (model.includes('gpt')) return 'openai';
  // Default to anthropic
  return 'anthropic';
}

function stripProvider(model: string): string {
  const slashIdx = model.indexOf('/');
  if (slashIdx > 0) {
    const prefix = model.slice(0, slashIdx);
    // Only strip the first prefix if it matches a known provider
    if (openaiClients.has(prefix) || responsesApiProviders.has(prefix) || prefix === 'anthropic') {
      return model.slice(slashIdx + 1);
    }
  }
  return model;
}

/**
 * Convert content array to OpenAI vision-compatible format.
 * Preserves images as data URIs for multimodal models (Kimi, MiniMax, etc.).
 */
function toOpenAIContent(content: string | ContentBlock[]): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  if (typeof content === 'string') return content;

  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
      });
    }
  }
  return parts;
}

/**
 * Convert content array to text-only for non-vision models.
 */
function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;

  const textParts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'image') {
      textParts.push('[Image attached — vision not supported with this provider]');
    }
  }
  return textParts.join('\n');
}

// --- Chat ---

export async function chat(
  messages: ChatMessage[],
  options: ChatOptions,
  config: Config
): Promise<string> {
  const resolvedModel = resolveModel(options.model, config);
  const provider = getProvider(resolvedModel);
  const modelId = stripProvider(resolvedModel);

  if (provider === 'anthropic') {
    if (!anthropicClient) {
      throw new Error('Anthropic client not initialized');
    }

    const systemMessage = messages.find(m => m.role === 'system');
    const chatMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content as any,
      }));

    // Build request parameters
    const cacheEnabled = config.models?.promptCaching !== false;
    const params: Anthropic.MessageCreateParams = {
      model: modelId,
      max_tokens: options.maxTokens || 4096,
      messages: chatMessages,
    };

    const systemParam = buildSystemParam(contentToText(systemMessage?.content || ''), cacheEnabled);
    if (systemParam) {
      params.system = systemParam;
    }

    // Add extended thinking if requested
    if (options.thinking && options.thinking !== 'none') {
      const budgetTokens = {
        low: 2048,
        medium: 8192,
        high: 16384,
      }[options.thinking];

      params.thinking = {
        type: 'enabled',
        budget_tokens: budgetTokens,
      };
      // Extended thinking requires higher max_tokens
      params.max_tokens = Math.max(params.max_tokens, budgetTokens + 4096);
    }

    const genObs = startGenerationObservation(`anthropic:${modelId}`, {
      input: { system: systemMessage?.content, messages: chatMessages },
      model: modelId,
      modelParameters: {
        max_tokens: params.max_tokens,
        ...(options.thinking && options.thinking !== 'none' ? { thinking: options.thinking } : {}),
      },
      metadata: { provider: 'anthropic' },
    });

    try {
      const response = await anthropicClient.messages.create(params);
      const usage = (response as any).usage;

      // Log cache metrics
      if (usage?.cache_read_input_tokens > 0 || usage?.cache_creation_input_tokens > 0) {
        console.log(`[cache] read=${usage.cache_read_input_tokens || 0} created=${usage.cache_creation_input_tokens || 0}`);
      }

      // Extract text content
      const textContent = response.content.find(c => c.type === 'text');
      const text = textContent?.text || '';
      genObs?.update({
        output: { text },
        usageDetails: toAnthropicUsageDetails(usage),
        costDetails: toCostDetails(modelId, usage),
      });
      genObs?.end();

      return text;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      genObs?.update({ level: 'ERROR', statusMessage: errorMessage, output: { error: errorMessage } });
      genObs?.end();
      throw err;
    }
  }

  // Codex OAuth providers use ChatGPT backend (not OpenAI API)
  if (responsesApiProviders.has(provider)) {
    const result = await codexChat(messages, modelId);
    return result.response;
  }

  // All other non-Anthropic providers use OpenAI-compatible API
  const client = openaiClients.get(provider);
  if (client) {
    const openaiMessages: any[] = messages.map(m => ({
      role: m.role,
      content: toOpenAIContent(m.content),
    }));

    const genObs = startGenerationObservation(`openai:${modelId}`, {
      input: { messages: openaiMessages },
      model: modelId,
      modelParameters: {
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature,
      },
      metadata: { provider },
    });

    try {
      const response = await client.chat.completions.create({
        model: modelId,
        messages: openaiMessages,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature,
      });

      let content = response.choices[0]?.message?.content || '';
      // Strip <think>...</think> reasoning blocks (e.g. MiniMax M2.x)
      content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
      genObs?.update({
        output: response.choices[0]?.message,
        usageDetails: toUsageDetails(response.usage),
        costDetails: toCostDetails(modelId, response.usage),
      });
      genObs?.end();

      return content;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      genObs?.update({ level: 'ERROR', statusMessage: errorMessage, output: { error: errorMessage } });
      genObs?.end();
      throw err;
    }
  }

  throw new Error(`Unknown provider "${provider}" for model: ${resolvedModel}. Available: anthropic, ${[...openaiClients.keys()].join(', ')}`);
}

// --- Chat with Tools (Agentic Loop) ---

export interface ToolChatResult {
  response: string;
  toolCalls: string[];
}

export async function chatWithTools(
  messages: ChatMessage[],
  options: ChatOptions,
  config: Config,
  toolConfig: ToolConfig,
  toolContext?: ExecuteToolContext
): Promise<ToolChatResult> {
  if (!anthropicClient) {
    throw new Error('Anthropic client not initialized');
  }

  const resolvedModel = resolveModel(options.model, config);
  const modelId = stripProvider(resolvedModel);
  const maxIterations = toolConfig.maxIterations || 20;

  // Resolve tools once at start of agent loop
  const includeSpawn = !!(toolContext?.chatId && toolContext?.fullConfig);
  const toolDefs = await getToolDefinitions(toolConfig, { includeSpawnSubagent: includeSpawn, projects: toolContext?.fullConfig?.projects });

  // Enable prompt caching for system + tools (uses 2 of 4 allowed breakpoints)
  const cacheEnabled = config.models?.promptCaching !== false;
  if (cacheEnabled) addToolCacheBreakpoint(toolDefs);

  // Build system param with OAuth identity guard
  const systemMessage = messages.find(m => m.role === 'system');
  const systemParam = buildSystemParam(contentToText(systemMessage?.content || ''), cacheEnabled);

  // Build initial messages (exclude system) — content arrays pass through for Anthropic vision
  const apiMessages: any[] = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role, content: m.content }));

  // Track tool calls for logging
  const toolLog: string[] = [];

  for (let i = 0; i < maxIterations; i++) {
    // Check abort signal before each iteration
    if (toolContext?.abortSignal?.aborted) {
      return {
        response: `[Cancelled after ${toolLog.length} tool calls]`,
        toolCalls: toolLog,
      };
    }

    const params: any = {
      model: modelId,
      max_tokens: options.maxTokens || 16384,
      messages: apiMessages,
      tools: toolDefs,
    };

    if (systemParam) {
      params.system = systemParam;
    }

    // Add thinking if configured
    if (options.thinking && options.thinking !== 'none') {
      const budgetTokens: Record<string, number> = {
        low: 2048,
        medium: 8192,
        high: 16384,
      };
      const budget = budgetTokens[options.thinking] || 2048;
      params.thinking = { type: 'enabled', budget_tokens: budget };
      params.max_tokens = Math.max(params.max_tokens, budget + 4096);
    }

    console.log(`[agent:tools] Iteration ${i + 1}/${maxIterations}`);

    const genObs = startGenerationObservation(`anthropic:${modelId}`, {
      input: { messages: apiMessages },
      model: modelId,
      modelParameters: { max_tokens: params.max_tokens },
      metadata: { provider: 'anthropic', iteration: i + 1 },
    });

    let response: any;
    try {
      response = await anthropicClient.messages.create(params);
      const usage = (response as any).usage;

      // Log cache metrics
      if (usage?.cache_read_input_tokens > 0 || usage?.cache_creation_input_tokens > 0) {
        console.log(`[cache] read=${usage.cache_read_input_tokens || 0} created=${usage.cache_creation_input_tokens || 0}`);
      }

      genObs?.update({
        output: response.content,
        usageDetails: toAnthropicUsageDetails(usage),
        costDetails: toCostDetails(modelId, usage),
      });
      genObs?.end();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      genObs?.update({ level: 'ERROR', statusMessage: errorMessage, output: { error: errorMessage } });
      genObs?.end();
      throw err;
    }

    // If no tool use, we're done — extract text
    if (response.stop_reason !== 'tool_use') {
      const textBlocks = response.content.filter((c: any) => c.type === 'text');
      let responseText = textBlocks.map((b: any) => b.text).join('\n') || '';
      // Fallback when model did tool work but returned no text summary
      if (!responseText && toolLog.length > 0) {
        responseText = `[Completed with ${toolLog.length} tool calls, no text response]`;
      }
      return {
        response: responseText,
        toolCalls: toolLog,
      };
    }

    // Add assistant response (full content including tool_use blocks)
    apiMessages.push({ role: 'assistant', content: response.content });

    // Execute each tool_use block
    const toolResults: any[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      const inputStr = JSON.stringify(block.input).slice(0, 200);
      console.log(`[agent:tools] -> ${block.name}(${inputStr})`);

      const toolObs = isLangfuseEnabled()
        ? startObservation(`tool:${block.name}`, { input: block.input, metadata: { app: LANGFUSE_APP_NAME, tool: block.name } }, { asType: 'tool' })
        : null;

      const toolStart = Date.now();
      try {
        const result = await executeTool(block.name, block.input as Record<string, any>, toolConfig, toolContext);
        const resultPreview = result.slice(0, 200) + (result.length > 200 ? '...' : '');
        console.log(`[agent:tools] <- ${resultPreview}`);
        toolLog.push(`${block.name}(${inputStr}) → ${resultPreview}`);

        toolObs?.update({ output: result });
        toolObs?.end();

        // Record audit event
        if (toolContext?.auditTraceId) {
          addEvent(toolContext.auditTraceId, {
            type: 'tool_use',
            summary: `${block.name}(${inputStr})`,
            durationMs: Date.now() - toolStart,
          });
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        toolObs?.update({ level: 'ERROR', statusMessage: errorMessage, output: { error: errorMessage } });
        toolObs?.end();

        if (toolContext?.auditTraceId) {
          addEvent(toolContext.auditTraceId, {
            type: 'tool_error',
            summary: `${block.name} error: ${errorMessage.slice(0, 150)}`,
            durationMs: Date.now() - toolStart,
          });
        }
        throw err;
      }
    }

    // Send tool results back
    apiMessages.push({ role: 'user', content: toolResults });
  }

  console.warn(`[agent:tools] Max iterations (${maxIterations}) reached`);
  return {
    response: '[Tool use loop reached maximum iterations]',
    toolCalls: toolLog,
  };
}

// --- OpenAI-Compatible Tool Use Loop ---

/**
 * Convert Anthropic-format tool definitions to OpenAI function calling format.
 */
export function toOpenAITools(toolDefs: any[]): any[] {
  return toolDefs.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

/**
 * Agentic tool use loop for OpenAI-compatible providers (Kimi, MiniMax, etc.).
 * Mirrors chatWithTools() but uses OpenAI function calling format.
 */
export async function openaiChatWithTools(
  messages: ChatMessage[],
  options: ChatOptions,
  config: Config,
  toolConfig: ToolConfig,
  toolContext?: ExecuteToolContext
): Promise<ToolChatResult> {
  const resolvedModel = resolveModel(options.model, config);
  const provider = getProvider(resolvedModel);
  const modelId = stripProvider(resolvedModel);
  const maxIterations = toolConfig.maxIterations || 20;

  const client = openaiClients.get(provider);
  if (!client) {
    throw new Error(`OpenAI client not initialized for provider: ${provider}`);
  }

  // Resolve tools once at start
  const includeSpawn = !!(toolContext?.chatId && toolContext?.fullConfig);
  const toolDefs = await getToolDefinitions(toolConfig, { includeSpawnSubagent: includeSpawn, projects: toolContext?.fullConfig?.projects });
  const openaiTools: any[] = toOpenAITools(toolDefs);

  // Inject Kimi $web_search builtin tool when using Moonshot/Kimi provider
  const providerBaseURL = config.models.providers[provider]?.baseURL || '';
  if (providerBaseURL.includes('kimi.com') || providerBaseURL.includes('moonshot.ai')) {
    openaiTools.push({ type: 'builtin_function', function: { name: '$web_search' } });
    console.log('[agent:openai-tools] Injected Kimi $web_search builtin tool');
  }

  // Build messages for OpenAI format — preserve images for vision models
  const apiMessages: any[] = messages.map(m => ({
    role: m.role,
    content: toOpenAIContent(m.content),
  }));

  const toolLog: string[] = [];

  for (let i = 0; i < maxIterations; i++) {
    // Check abort signal
    if (toolContext?.abortSignal?.aborted) {
      return {
        response: `[Cancelled after ${toolLog.length} tool calls]`,
        toolCalls: toolLog,
      };
    }

    console.log(`[agent:openai-tools] Iteration ${i + 1}/${maxIterations} (provider: ${provider}, model: ${modelId})`);

    const genObs = startGenerationObservation(`openai:${modelId}`, {
      input: { messages: apiMessages },
      model: modelId,
      modelParameters: {
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature,
      },
      metadata: { provider, iteration: i + 1 },
    });

    let completion: any;
    try {
      completion = await client.chat.completions.create({
        model: modelId,
        messages: apiMessages,
        tools: openaiTools,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature,
      });
      genObs?.update({
        output: completion.choices[0]?.message,
        usageDetails: toUsageDetails(completion.usage),
        costDetails: toCostDetails(modelId, completion.usage),
      });
      genObs?.end();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      genObs?.update({ level: 'ERROR', statusMessage: errorMessage, output: { error: errorMessage } });
      genObs?.end();
      throw err;
    }

    const message = completion.choices[0]?.message;
    if (!message) {
      return { response: '[No response from model]', toolCalls: toolLog };
    }

    // No tool calls — return the text response
    if (completion.choices[0]?.finish_reason !== 'tool_calls' || !message.tool_calls?.length) {
      let content = message.content || '';
      // Strip <think>...</think> reasoning blocks (e.g. MiniMax M2.x)
      content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
      if (!content && toolLog.length > 0) {
        content = `[Completed with ${toolLog.length} tool calls, no text response]`;
      }
      return { response: content, toolCalls: toolLog };
    }

    // Append assistant message with tool_calls to conversation
    apiMessages.push(message);

    // Execute each tool call
    for (const toolCall of message.tool_calls) {
      const fnName = toolCall.function.name;
      let args: Record<string, any>;
      try {
        args = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        args = {};
      }

      const inputStr = JSON.stringify(args).slice(0, 200);
      console.log(`[agent:openai-tools] -> ${fnName}(${inputStr})`);

      const toolObs = isLangfuseEnabled()
        ? startObservation(`tool:${fnName}`, { input: args, metadata: { app: LANGFUSE_APP_NAME, tool: fnName } }, { asType: 'tool' })
        : null;

      const toolStart = Date.now();
      try {
        const result = await executeTool(fnName, args, toolConfig, toolContext) || '';
        const resultPreview = result.slice(0, 200) + (result.length > 200 ? '...' : '');
        console.log(`[agent:openai-tools] <- ${resultPreview}`);
        toolLog.push(`${fnName}(${inputStr}) → ${resultPreview}`);

        toolObs?.update({ output: result });
        toolObs?.end();

        if (toolContext?.auditTraceId) {
          addEvent(toolContext.auditTraceId, {
            type: 'tool_use',
            summary: `${fnName}(${inputStr})`,
            durationMs: Date.now() - toolStart,
          });
        }

        // Add tool result in OpenAI format
        apiMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        toolObs?.update({ level: 'ERROR', statusMessage: errorMessage, output: { error: errorMessage } });
        toolObs?.end();

        if (toolContext?.auditTraceId) {
          addEvent(toolContext.auditTraceId, {
            type: 'tool_error',
            summary: `${fnName} error: ${errorMessage.slice(0, 150)}`,
            durationMs: Date.now() - toolStart,
          });
        }
        throw err;
      }
    }
  }

  console.warn(`[agent:openai-tools] Max iterations (${maxIterations}) reached`);
  return {
    response: '[Tool use loop reached maximum iterations]',
    toolCalls: toolLog,
  };
}

// --- Agent Turn ---

export async function runAgentTurn(
  agentId: string,
  userMessage: string | ContentBlock[],
  config: Config,
  modelOverride?: string,
  toolConfig?: ToolConfig,
  history?: ChatMessage[],
  context?: AgentRunContext
): Promise<string> {
  const agentConfig = config.agents.list[agentId];
  if (!agentConfig) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  let systemPrompt = buildSystemPrompt(agentId, {
    channel: context?.channel,
    tags: context?.tags,
    toolConfig,
    skillConfig: config.skills,
  });

  // Inject channel-specific formatting context
  if (context?.channel) {
    const channelHints: Record<string, string> = {
      telegram: `\n\n## Output Channel: Telegram\nTelegram does NOT render markdown. Use plain text only.\n- No **bold**, _italic_, or \`code blocks\`\n- Use CAPS or spacing for emphasis\n- Use plain dashes for lists\n- Include full URLs as plain text (no markdown links)`,
      discord: `\n\n## Output Channel: Discord\nDiscord renders markdown. Use it for formatting.\n- Use **bold**, *italic*, \`code\`, and \`\`\`code blocks\`\`\`\n- Use markdown links: [text](url)\n- Use bullet lists and headers`,
    };
    systemPrompt += channelHints[context.channel] || '';
  }

  // Build user content — support both string and content arrays (for images)
  let userContent: string | ContentBlock[];
  let sanitizedMessage: string;
  if (typeof userMessage === 'string') {
    sanitizedMessage = sanitizeUserInput(userMessage);
    userContent = sanitizedMessage;
  } else {
    // Content array (image + text) — sanitize text blocks only
    userContent = userMessage.map(block => {
      if (block.type === 'text') {
        return { ...block, text: sanitizeUserInput(block.text) };
      }
      return block;
    });
    const textBlock = userMessage.find(b => b.type === 'text');
    sanitizedMessage = textBlock?.type === 'text' ? textBlock.text : '[Image]';
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(history || []),
    { role: 'user', content: userContent },
  ];

  const model = modelOverride || agentConfig.model;
  const chatOptions: ChatOptions = { model, thinking: agentConfig.thinking };

  const resolvedModel = resolveModel(model, config);
  const provider = getProvider(resolvedModel);
  const modelId = stripProvider(resolvedModel);

  let response: string = '';
  let toolCalls: string[] = [];

  // Start audit trace
  const auditTrigger = context?.trigger || 'system';
  const auditTraceId = startTrace(auditTrigger);

  // Build tool context once — used by all providers for spawn_subagent and file locking
  const chatIdNum = (context?.metadata as any)?.chatId
    ?? (context?.sessionId ? parseInt(context.sessionId, 10) : undefined);

  // Determine channel target ID: for Telegram use numeric chatId, for Discord use sessionId string (snowflake)
  let channelTargetId: string | number | undefined;
  if (context?.channel === 'telegram') {
    channelTargetId = (context.metadata as any)?.chatId;
  } else if (context?.channel === 'discord') {
    channelTargetId = context.sessionId; // Discord channel snowflake — keep as string
  }

  const toolCtx: ExecuteToolContext = {
    chatId: Number.isFinite(chatIdNum) ? chatIdNum : undefined,
    fullConfig: config,
    history,
    abortSignal: context?.abortSignal,
    lockTaskId: context?.sessionId,
    auditTraceId,
    channel: context?.channel,
    channelTargetId,
    approverUserId: context?.userId,
    approverUsername: (context?.metadata as any)?.username,
  };

  const runTurn = async (): Promise<string> => {
    if (toolConfig?.enabled && provider === 'anthropic' && !!anthropicClient) {
      // Anthropic tool_use loop
      console.log(`[agent] Running with tools enabled (paths: ${toolConfig.allowedPaths.join(', ')})`);
      const result = await chatWithTools(messages, chatOptions, config, toolConfig, toolCtx);
      response = result.response;
      toolCalls = result.toolCalls;
    } else if (toolConfig?.enabled && responsesApiProviders.has(provider)) {
      // Codex tool_use loop via Responses API
      console.log(`[agent] Running Codex with tools enabled (paths: ${toolConfig.allowedPaths.join(', ')})`);
      const includeSpawn = !!(toolCtx.chatId && toolCtx.fullConfig);
      const toolDefs = await getToolDefinitions(toolConfig, { includeSpawnSubagent: includeSpawn, projects: toolCtx?.fullConfig?.projects });
      const result = await codexChat(messages, modelId, toolConfig, toolDefs, toolCtx);
      response = result.response;
      toolCalls = result.toolCalls;
    } else if (responsesApiProviders.has(provider)) {
      // Codex without tools
      const result = await codexChat(messages, modelId);
      response = result.response;
    } else if (toolConfig?.enabled && openaiClients.has(provider)) {
      // OpenAI-compatible tool_use loop (Kimi, MiniMax, etc.)
      console.log(`[agent] Running OpenAI-compatible tools (provider: ${provider}, paths: ${toolConfig.allowedPaths.join(', ')})`);
      const result = await openaiChatWithTools(messages, chatOptions, config, toolConfig, toolCtx);
      response = result.response;
      toolCalls = result.toolCalls;
    } else {
      response = await chat(messages, chatOptions, config);
    }

    // Log to memory with tool usage summary
    let memoryEntry = `**User:** ${sanitizedMessage}\n\n`;
    if (toolCalls.length > 0) {
      memoryEntry += `**Tools used (${toolCalls.length}):**\n${toolCalls.map(t => `- ${t}`).join('\n')}\n\n`;
    }
    memoryEntry += `**Assistant:** ${response}`;
    appendToMemory(agentId, memoryEntry);

    return response;
  };

  if (!isLangfuseEnabled()) {
    try {
      const result = await runTurn();
      await endTrace(auditTraceId, 'ok');
      return result;
    } catch (err) {
      await endTrace(auditTraceId, 'error');
      throw err;
    }
  }

  const lfConfig = getLangfuseConfig();
  const traceName = `agent:${agentId}`;
  const traceInput = { message: sanitizedMessage };
  const traceMetadata = {
    app: LANGFUSE_APP_NAME,
    agentId,
    model: resolvedModel,
    provider,
    toolEnabled: !!toolConfig?.enabled,
    channel: context?.channel,
    ...context?.metadata,
  };

  return startActiveObservation(
    traceName,
    async (agentObs) => {
      updateActiveTrace({
        name: traceName,
        userId: context?.userId,
        sessionId: context?.sessionId,
        input: traceInput,
        metadata: traceMetadata,
        tags: [...new Set([...(context?.tags || []), LANGFUSE_APP_TAG])],
        environment: lfConfig?.environment,
        release: lfConfig?.release,
      });

      agentObs.update({
        input: traceInput,
        metadata: traceMetadata,
        environment: lfConfig?.environment,
      });

      try {
        const result = await runTurn();
        agentObs.update({
          output: { response: result, toolCalls },
          metadata: { toolCallsCount: toolCalls.length },
        });
        updateActiveTrace({
          output: { response: result },
          metadata: { toolCallsCount: toolCalls.length },
        });
        await endTrace(auditTraceId, 'ok');
        return result;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        agentObs.update({
          level: 'ERROR',
          statusMessage: errorMessage,
          output: { error: errorMessage },
        });
        updateActiveTrace({ output: { error: errorMessage } });
        await endTrace(auditTraceId, 'error');
        throw err;
      }
    },
    { asType: 'agent' }
  );
}

// --- Bootstrap Check ---

export function hasBootstrap(agentId: string): boolean {
  const path = join(getAgentDir(agentId), 'BOOTSTRAP.md');
  return existsSync(path);
}

export function deleteBootstrap(agentId: string): void {
  const path = join(getAgentDir(agentId), 'BOOTSTRAP.md');
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

export function getAgentTemplateContent(agentId: string, templateName: string): string | null {
  if (!TEMPLATE_FILES.includes(templateName)) {
    return null;
  }

  const filePath = join(getAgentDir(agentId), templateName);
  if (!existsSync(filePath)) {
    return null;
  }

  return readFileSync(filePath, 'utf-8');
}

export function saveAgentTemplate(agentId: string, templateName: string, content: string): void {
  if (!TEMPLATE_FILES.includes(templateName)) {
    throw new Error(`Invalid template name: ${templateName}. Must be one of: ${TEMPLATE_FILES.join(', ')}`);
  }

  const filePath = join(getAgentDir(agentId), templateName);
  writeFileSync(filePath, content, 'utf-8');
}
