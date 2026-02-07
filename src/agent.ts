// Agent runner: loads templates, calls models, manages memory

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getAgentDir } from './config.js';
import { buildSafeSystemPrompt, sanitizeUserInput } from './security.js';
import type { Config, ChatMessage, ChatOptions, AgentTurn, Session, ToolConfig } from './types.js';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';

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

  let prompt = buildSafeSystemPrompt(base, userContext);

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

const CODEX_AUTH_PATH = '/Users/katre/.codex/auth.json';

function loadCodexToken(): string | null {
  if (!existsSync(CODEX_AUTH_PATH)) {
    console.log('[codex] No auth file at ~/.codex/auth.json');
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(CODEX_AUTH_PATH, 'utf-8'));
    const token = raw?.tokens?.access_token;
    if (!token) {
      console.log('[codex] No access_token in auth file');
      return null;
    }

    // Check if token is expired (JWT: header.payload.signature)
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    const exp = payload.exp * 1000; // JWT exp is in seconds
    const now = Date.now();
    if (now > exp) {
      const expiredAgo = Math.round((now - exp) / 60000);
      console.warn(`[codex] Token expired ${expiredAgo} min ago. Run 'codex' to re-auth.`);
      return null;
    }

    const expiresIn = Math.round((exp - now) / 60000);
    console.log(`[codex] Token valid (expires in ${expiresIn} min)`);
    return token;
  } catch (error) {
    console.error('[codex] Failed to read auth file:', error);
    return null;
  }
}

// --- Model Providers ---

let anthropicClient: Anthropic | null = null;
// Map of provider name → OpenAI client (supports openai, openrouter, groq, together, etc.)
const openaiClients = new Map<string, OpenAI>();
// Providers that use the Responses API instead of Chat Completions
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

  // Initialize all OpenAI-compatible providers
  for (const [name, providerConfig] of Object.entries(config.models.providers)) {
    if (name === 'anthropic' || !providerConfig) continue;

    // Resolve API key — support reading from Codex OAuth
    let apiKey = providerConfig.apiKey;
    if (providerConfig.authToken === 'codex') {
      apiKey = loadCodexToken() || undefined;
      if (!apiKey) {
        console.log(`[providers] Skipping ${name} — no Codex OAuth token found`);
        continue;
      }
    }
    if (!apiKey) continue;

    const opts: Record<string, any> = { apiKey };
    if (providerConfig.baseURL) opts.baseURL = providerConfig.baseURL;
    openaiClients.set(name, new OpenAI(opts));
    if (providerConfig.authToken === 'codex') {
      responsesApiProviders.add(name);
    }
    console.log(`[providers] Initialized ${name}${providerConfig.baseURL ? ` (${providerConfig.baseURL})` : ''}${responsesApiProviders.has(name) ? ' [responses API]' : ''}`);
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
    // For OpenRouter etc., the model ID includes sub-paths like "google/gemini-2.0-flash"
    // Only strip the first prefix if it matches a known provider
    if (openaiClients.has(prefix) || prefix === 'anthropic') {
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

    const response = await anthropicClient.messages.create(params);

    // Extract text content
    const textContent = response.content.find(c => c.type === 'text');
    return textContent?.text || '';
  }

  // All non-Anthropic providers use OpenAI-compatible API
  const client = openaiClients.get(provider);
  if (client) {
    // Codex / Responses API providers use client.responses.create()
    if (responsesApiProviders.has(provider)) {
      // Build input: system instruction + conversation as structured items
      const input: any[] = [];
      const systemMsg = messages.find(m => m.role === 'system');
      if (systemMsg) {
        input.push({ role: 'system', content: systemMsg.content });
      }
      for (const m of messages) {
        if (m.role === 'system') continue;
        input.push({ role: m.role, content: m.content });
      }

      console.log(`[agent] Using Responses API for ${provider}/${modelId}`);
      const response = await client.responses.create({
        model: modelId,
        input,
      });

      return response.output_text || '';
    }

    // Standard Chat Completions API
    const openaiMessages = messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    const response = await client.chat.completions.create({
      model: modelId,
      messages: openaiMessages,
      max_tokens: options.maxTokens || 4096,
      temperature: options.temperature,
    });

    return response.choices[0]?.message?.content || '';
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
    const response = await anthropicClient.messages.create(params);

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
      const result = await executeTool(block.name, block.input as Record<string, any>, toolConfig);
      const resultPreview = result.slice(0, 200) + (result.length > 200 ? '...' : '');
      console.log(`[agent:tools] <- ${resultPreview}`);
      toolLog.push(`${block.name}(${inputStr}) → ${resultPreview}`);

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result,
      });
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
  history?: ChatMessage[]
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

  // Determine if we can use tools (only Anthropic supports tool_use via our API)
  const resolvedModel = resolveModel(model, config);
  const provider = getProvider(resolvedModel);
  const canUseTools = provider === 'anthropic' && !!anthropicClient;

  let response: string;
  let toolCalls: string[] = [];
  if (toolConfig?.enabled && canUseTools) {
    console.log(`[agent] Running with tools enabled (paths: ${toolConfig.allowedPaths.join(', ')})`);
    const result = await chatWithTools(messages, chatOptions, config, toolConfig);
    response = result.response;
    toolCalls = result.toolCalls;
  } else {
    if (toolConfig?.enabled && !canUseTools) {
      console.log(`[agent] Tools requested but ${provider} doesn't support tool_use — running without tools`);
    }
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
}

// --- Bootstrap Check ---

export function hasBootstrap(agentId: string): boolean {
  const path = join(getAgentDir(agentId), 'BOOTSTRAP.md');
  return existsSync(path);
}

export function deleteBootstrap(agentId: string): void {
  const path = join(getAgentDir(agentId), 'BOOTSTRAP.md');
  if (existsSync(path)) {
    const { unlinkSync } = require('fs');
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
