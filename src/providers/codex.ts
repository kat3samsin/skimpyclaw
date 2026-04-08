// Codex Provider (ChatGPT Backend)

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ProviderChatParams, ProviderToolChatParams, ToolChatResult } from './types.js';
import { toCostDetails } from './observability.js';
import { buildUsageRecord, recordUsage } from '../usage.js';

const DEFAULT_CODEX_AUTH_PATH = join(homedir(), '.codex', 'auth.json');
const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
const DEFAULT_CODEX_FETCH_TIMEOUT_MS = 120_000;

let codexAuthPath = DEFAULT_CODEX_AUTH_PATH;
let codexBaseUrl = DEFAULT_CODEX_BASE_URL;
let codexAuth: { accessToken: string; accountId: string } | null = null;

// Set of providers that use the Codex Responses API
const responsesApiProviders = new Set<string>();

export function addResponsesApiProvider(name: string): void {
  responsesApiProviders.add(name);
}

export function isResponsesApiProvider(name: string): boolean {
  return responsesApiProviders.has(name);
}

export function resetCodexProviderState(): void {
  responsesApiProviders.clear();
  codexAuthPath = DEFAULT_CODEX_AUTH_PATH;
  codexBaseUrl = DEFAULT_CODEX_BASE_URL;
  codexAuth = null;
}

export function setCodexAuthPath(path: string): void {
  codexAuthPath = path;
}

export function setCodexBaseUrl(url: string): void {
  codexBaseUrl = url;
}

interface CodexAuth {
  accessToken: string;
  accountId: string;
}

export function loadCodexAuth(authPath: string = codexAuthPath): CodexAuth | null {
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

export function initCodexAuth(path?: string, baseUrl?: string): boolean {
  if (path) codexAuthPath = path;
  if (baseUrl) codexBaseUrl = baseUrl;
  codexAuth = loadCodexAuth();
  return codexAuth !== null;
}

export function getCodexAuth(): CodexAuth | null {
  return codexAuth;
}

export function isCodexAvailable(): boolean {
  return codexAuth !== null;
}

const LANGFUSE_APP_NAME = 'skimpyclaw';

export function recordCodexUsage(params: {
  model: string;
  usage: any;
  trigger?: string;
  agentId?: string;
}): void {
  const usage = params.usage;
  const inputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens = typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0;
  if (inputTokens === 0 && outputTokens === 0) return;

  const cost = toCostDetails(params.model, usage);
  recordUsage(buildUsageRecord({
    model: params.model,
    provider: 'codex',
    inputTokens,
    outputTokens,
    inputCost: cost?.input ?? 0,
    outputCost: cost?.output ?? 0,
    totalCost: cost?.total ?? 0,
    trigger: params.trigger || 'api',
    agentId: params.agentId,
    cacheReadTokens: typeof usage?.input_tokens_details?.cached_tokens === 'number' ? usage.input_tokens_details.cached_tokens : undefined,
  }));
}

async function startGenerationObservation(name: string, attributes: Record<string, any>) {
  const { isLangfuseEnabled } = await import('../langfuse.js');
  if (!isLangfuseEnabled()) return null;
  attributes.metadata = { app: LANGFUSE_APP_NAME, ...attributes.metadata };
  const { startObservation } = await import('@langfuse/tracing');
  return startObservation(name, attributes, { asType: 'generation' });
}

/**
 * Make a single Codex API call. Returns raw SSE text.
 */
export async function codexFetch(body: any, timeoutMs: number = DEFAULT_CODEX_FETCH_TIMEOUT_MS): Promise<string> {
  if (!codexAuth) {
    throw new Error('Codex auth not initialized. Run "codex" CLI to authenticate.');
  }

  const baseUrl = codexBaseUrl || DEFAULT_CODEX_BASE_URL;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));
  try {
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
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown');
      throw new Error(`Codex API ${response.status}: ${errorText}`);
    }

    return response.text();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Codex request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Parse an SSE response from the Codex backend.
 * Extracts function calls from the completed response object.
 */
export function parseCodexSSE(text: string): { outputText: string; functionCalls: any[]; response: any | null } {
  let outputText = '';
  let completedResponse: any = null;

  // Track streaming function calls and output items
  const streamingFunctionCalls: Map<number, { callId: string; name: string; arguments: string }> = new Map();
  const streamingOutputTexts: Map<number, string> = new Map();
  let currentOutputIndex = -1;
  let currentFcIndex = -1;

  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') break;
    try {
      const event = JSON.parse(data);

      if (event.type === 'response.output_text.delta') {
        // Text delta — accumulate by output_index or globally
        const idx = event.output_index ?? currentOutputIndex;
        if (idx >= 0) {
          streamingOutputTexts.set(idx, (streamingOutputTexts.get(idx) || '') + (event.delta || ''));
        } else {
          outputText += event.delta || '';
        }
      } else if (event.type === 'response.output_item.added') {
        // New output item — track its type
        const item = event.item;
        const idx = event.output_index ?? -1;
        if (item?.type === 'function_call') {
          currentFcIndex = idx;
          streamingFunctionCalls.set(idx, {
            callId: item.call_id || item.id || `fc-${idx}`,
            name: item.name || '',
            arguments: '',
          });
        } else if (item?.type === 'output_text' || item?.type === 'message') {
          currentOutputIndex = idx;
        }
      } else if (event.type === 'response.function_call_arguments.delta') {
        // Function call argument delta
        const idx = event.output_index ?? currentFcIndex;
        const fc = streamingFunctionCalls.get(idx);
        if (fc) {
          fc.arguments += event.delta || '';
        }
      } else if (event.type === 'response.completed' && event.response) {
        completedResponse = event.response;
        if (event.response.output_text) outputText = event.response.output_text;
      }
    } catch { /* skip non-JSON lines */ }
  }

  // Build function calls — prefer completed response, fall back to streaming
  const functionCalls: any[] = [];
  if (completedResponse?.output?.length) {
    for (const item of completedResponse.output) {
      if (item.type === 'function_call') {
        functionCalls.push({
          callId: item.call_id,
          name: item.name,
          arguments: item.arguments,
        });
      } else if (item.type === 'output_text' && item.text) {
        if (!outputText) outputText = item.text;
      } else if (item.type === 'message' && item.content) {
        for (const c of item.content) {
          if (c.type === 'output_text' && c.text) {
            outputText += c.text;
          }
        }
      }
    }
  } else {
    // Completed response had empty output — use streaming data
    // Also patch the rawResponse so appendAssistantResponse includes these items
    const patchedOutput: any[] = [];
    for (const [, fc] of streamingFunctionCalls) {
      if (fc.name) {
        functionCalls.push(fc);
        patchedOutput.push({
          type: 'function_call',
          call_id: fc.callId,
          name: fc.name,
          arguments: fc.arguments,
        });
      }
    }
    for (const [, txt] of streamingOutputTexts) {
      if (txt) {
        if (!outputText) outputText = txt;
        patchedOutput.push({ type: 'output_text', text: txt });
      }
    }
    if (completedResponse && patchedOutput.length > 0) {
      completedResponse.output = patchedOutput;
      console.log(`[codex] Patched empty response.output with ${patchedOutput.length} streaming items`);
    }
  }

  if (completedResponse?.usage) {
    console.log(`[codex] Usage: ${JSON.stringify(completedResponse.usage)}`);
  } else {
    console.log('[codex] No usage data in response');
  }

  // Fallback: Codex may put text in response.text instead of output_text or output[]
  if (!outputText && completedResponse?.text) {
    const textContent = typeof completedResponse.text === 'string'
      ? completedResponse.text
      : typeof completedResponse.text?.content === 'string'
        ? completedResponse.text.content
        : '';
    if (textContent) outputText = textContent;
  }

  // Debug: log when output is empty despite having tokens
  if (!outputText && completedResponse) {
    const outputTypes = (completedResponse.output || []).map((item: any) => `${item.type}${item.content ? `[${(item.content || []).map((c: any) => c.type).join(',')}]` : ''}`);
    console.warn(`[codex] Empty outputText! status: ${completedResponse.status}, output: ${JSON.stringify(completedResponse.output)?.slice(0, 1000)}, text: ${JSON.stringify(completedResponse.text)?.slice(0, 200)}, reasoning: ${JSON.stringify(completedResponse.reasoning)?.slice(0, 200)}`);
  }

  return { outputText, functionCalls, response: completedResponse };
}

/** @deprecated Use adapter.chat() via the provider registry instead. */
export async function chatCodex(params: ProviderChatParams): Promise<string> {
  const { CodexAdapter } = await import('./adapters/codex-adapter.js');
  const adapter = new CodexAdapter();
  return adapter.chat(params.messages, params.options, params.config);
}

export async function chatWithToolsCodex(params: ProviderToolChatParams): Promise<ToolChatResult> {
  const { runToolLoop } = await import('./tool-loop.js');
  const { CodexAdapter } = await import('./adapters/codex-adapter.js');
  const adapter = new CodexAdapter();
  const unifiedToolConfig = params.toolConfig.maxIterations
    ? params.toolConfig
    : { ...params.toolConfig, maxIterations: 100 };
  return runToolLoop(adapter, params.messages, params.options, params.config, unifiedToolConfig, params.toolContext);
}
