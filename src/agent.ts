// Agent runner: loads templates, calls models, manages memory

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getAgentDir } from './config.js';
import { buildSafeSystemPrompt, sanitizeUserInput } from './security.js';
import type { Config, ChatMessage, ChatOptions, ToolConfig, AgentRunContext } from './types.js';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';
import { getLangfuseConfig, isLangfuseEnabled } from './langfuse.js';
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

export function buildSystemPrompt(agentId: string): string {
  const templates = loadAgentTemplates(agentId);

  const soul = templates.SOUL || '';
  const identity = templates.IDENTITY || '';
  const user = templates.USER || '';
  const tools = templates.TOOLS || '';
  const memory = templates.MEMORY || '';

  const base = [soul, identity, tools].filter(Boolean).join('\n\n---\n\n');
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
- If you need information, use a tool to get it. Do not guess.`;

function startGenerationObservation(name: string, attributes: Record<string, any>) {
  if (!isLangfuseEnabled()) return null;
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
 * For API key: returns the prompt string directly.
 */
export function buildSystemParam(systemContent: string | undefined): string | Array<{type: 'text', text: string}> | undefined {
  if (!systemContent) return undefined;

  if (usingOAuth) {
    return [
      { type: 'text' as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: 'text' as const, text: TOOL_GUARD },
      { type: 'text' as const, text: systemContent },
    ];
  }
  return systemContent;
}

// --- Memory Management ---

export function getMemoryDir(agentId: string): string {
  return join(getAgentDir(agentId), 'memory');
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
function getCodexToolDefinitions(): any[] {
  return TOOL_DEFINITIONS.map(t => ({
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

  // Extract function calls from completed response output items
  const functionCalls: any[] = [];
  if (completedResponse?.output) {
    for (const item of completedResponse.output) {
      if (item.type === 'function_call') {
        functionCalls.push({
          callId: item.call_id,
          name: item.name,
          arguments: item.arguments,
        });
      }
    }
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
async function codexChat(messages: ChatMessage[], model: string, toolConfig?: ToolConfig): Promise<{ response: string; toolCalls: string[] }> {
  // Build input — system messages go to `instructions`, rest to `input`
  let instructions = 'You are a helpful assistant.';
  const input: any[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      instructions = m.content;
    } else {
      const contentType = m.role === 'assistant' ? 'output_text' : 'input_text';
      input.push({
        type: 'message',
        role: m.role,
        content: [{ type: contentType, text: m.content }],
      });
    }
  }

  const maxIterations = toolConfig?.maxIterations || 100;
  const tools = toolConfig?.enabled ? getCodexToolDefinitions() : undefined;
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
      return { response: parsed.outputText || '[No response from Codex]', toolCalls: toolLog };
    }

    // Add the assistant's output items to input for next turn
    if (parsed.response?.output) {
      for (const item of parsed.response.output) {
        input.push(item);
      }
    }

    // Execute each function call and add results to input
    for (const fc of parsed.functionCalls) {
      let args: Record<string, any>;
      try {
        args = JSON.parse(fc.arguments);
      } catch {
        args = {};
      }

      const inputStr = fc.arguments.slice(0, 200);
      console.log(`[codex:tools] -> ${fc.name}(${inputStr})`);

      const toolObs = isLangfuseEnabled()
        ? startObservation(`tool:${fc.name}`, { input: args, metadata: { tool: fc.name } }, { asType: 'tool' })
        : null;

      try {
        const result = await executeTool(fc.name, args, toolConfig!);
        const resultPreview = result.slice(0, 200) + (result.length > 200 ? '...' : '');
        console.log(`[codex:tools] <- ${resultPreview}`);
        toolLog.push(`${fc.name}(${inputStr}) → ${resultPreview}`);

        toolObs?.update({ output: result });
        toolObs?.end();

        input.push({
          type: 'function_call_output',
          call_id: fc.callId,
          output: result,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        toolObs?.update({ level: 'ERROR', statusMessage: errorMessage, output: { error: errorMessage } });
        toolObs?.end();
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
        content: m.content,
      }));

    // Build request parameters
    const params: Anthropic.MessageCreateParams = {
      model: modelId,
      max_tokens: options.maxTokens || 4096,
      messages: chatMessages,
    };

    const systemParam = buildSystemParam(systemMessage?.content);
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

      // Extract text content
      const textContent = response.content.find(c => c.type === 'text');
      const text = textContent?.text || '';
      const usageDetails = response.usage
        ? {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
            total_tokens: response.usage.input_tokens + response.usage.output_tokens,
          }
        : undefined;
      genObs?.update({
        output: { text },
        usageDetails,
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
    const openaiMessages = messages.map(m => ({
      role: m.role,
      content: m.content,
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

      const content = response.choices[0]?.message?.content || '';
      genObs?.update({
        output: response.choices[0]?.message,
        usageDetails: toUsageDetails(response.usage),
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
  toolConfig: ToolConfig
): Promise<ToolChatResult> {
  if (!anthropicClient) {
    throw new Error('Anthropic client not initialized');
  }

  const resolvedModel = resolveModel(options.model, config);
  const modelId = stripProvider(resolvedModel);
  const maxIterations = toolConfig.maxIterations || 20;

  // Build system param with OAuth identity guard
  const systemMessage = messages.find(m => m.role === 'system');
  const systemParam = buildSystemParam(systemMessage?.content);

  // Build initial messages (exclude system)
  const apiMessages: any[] = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role, content: m.content }));

  // Track tool calls for logging
  const toolLog: string[] = [];

  for (let i = 0; i < maxIterations; i++) {
    const params: any = {
      model: modelId,
      max_tokens: options.maxTokens || 4096,
      messages: apiMessages,
      tools: TOOL_DEFINITIONS,
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
      genObs?.update({
        output: response.content,
        usageDetails: (response as any).usage,
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
      return {
        response: textBlocks.map((b: any) => b.text).join('\n') || '',
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
        ? startObservation(`tool:${block.name}`, { input: block.input, metadata: { tool: block.name } }, { asType: 'tool' })
        : null;

      try {
        const result = await executeTool(block.name, block.input as Record<string, any>, toolConfig);
        const resultPreview = result.slice(0, 200) + (result.length > 200 ? '...' : '');
        console.log(`[agent:tools] <- ${resultPreview}`);
        toolLog.push(`${block.name}(${inputStr}) → ${resultPreview}`);

        toolObs?.update({ output: result });
        toolObs?.end();

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        toolObs?.update({ level: 'ERROR', statusMessage: errorMessage, output: { error: errorMessage } });
        toolObs?.end();
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

// --- Agent Turn ---

export async function runAgentTurn(
  agentId: string,
  userMessage: string,
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

  const systemPrompt = buildSystemPrompt(agentId);
  const sanitizedMessage = sanitizeUserInput(userMessage);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(history || []),
    { role: 'user', content: sanitizedMessage },
  ];

  const model = modelOverride || agentConfig.model;
  const chatOptions: ChatOptions = { model, thinking: agentConfig.thinking };

  const resolvedModel = resolveModel(model, config);
  const provider = getProvider(resolvedModel);
  const modelId = stripProvider(resolvedModel);

  let response: string = '';
  let toolCalls: string[] = [];

  const runTurn = async (): Promise<string> => {
    if (toolConfig?.enabled && provider === 'anthropic' && !!anthropicClient) {
      // Anthropic tool_use loop
      console.log(`[agent] Running with tools enabled (paths: ${toolConfig.allowedPaths.join(', ')})`);
      const result = await chatWithTools(messages, chatOptions, config, toolConfig);
      response = result.response;
      toolCalls = result.toolCalls;
    } else if (toolConfig?.enabled && responsesApiProviders.has(provider)) {
      // Codex tool_use loop via Responses API
      console.log(`[agent] Running Codex with tools enabled (paths: ${toolConfig.allowedPaths.join(', ')})`);
      const result = await codexChat(messages, modelId, toolConfig);
      response = result.response;
      toolCalls = result.toolCalls;
    } else if (responsesApiProviders.has(provider)) {
      // Codex without tools
      const result = await codexChat(messages, modelId);
      response = result.response;
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
    return runTurn();
  }

  const lfConfig = getLangfuseConfig();
  const traceName = `agent:${agentId}`;
  const traceInput = { message: sanitizedMessage };
  const traceMetadata = {
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
        tags: context?.tags,
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
        return result;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        agentObs.update({
          level: 'ERROR',
          statusMessage: errorMessage,
          output: { error: errorMessage },
        });
        updateActiveTrace({ output: { error: errorMessage } });
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
