// Codex Provider (ChatGPT Backend)

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ProviderChatParams, ProviderToolChatParams, ToolChatResult } from './types.js';
import { toCostDetails } from './observability.js';
import { buildUsageRecord, recordUsage } from '../usage.js';

const DEFAULT_CODEX_HOME = join(homedir(), '.codex');
const DEFAULT_CODEX_AUTH_PATH = join(DEFAULT_CODEX_HOME, 'auth.json');
const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
const DEFAULT_CODEX_FETCH_TIMEOUT_MS = 120_000;
const DEFAULT_CODEX_FETCH_RETRY_DELAYS_MS = [1_000, 3_000];

let codexAuthPath = DEFAULT_CODEX_AUTH_PATH;
let codexBaseUrl = DEFAULT_CODEX_BASE_URL;
let codexAuth: { accessToken: string; accountId: string } | null = null;
let codexFetchRetryDelaysMs = [...DEFAULT_CODEX_FETCH_RETRY_DELAYS_MS];

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
  codexFetchRetryDelaysMs = [...DEFAULT_CODEX_FETCH_RETRY_DELAYS_MS];
}

export function setCodexAuthPath(path: string): void {
  codexAuthPath = resolveCodexAuthPath(path);
}

export function setCodexBaseUrl(url: string): void {
  codexBaseUrl = url;
}

export function setCodexFetchRetryDelaysForTesting(delays: number[]): void {
  codexFetchRetryDelaysMs = delays;
}

interface CodexAuth {
  accessToken: string;
  accountId: string;
}

export function resolveCodexAuthPath(authPath?: string): string {
  if (!authPath) return DEFAULT_CODEX_AUTH_PATH;
  if (authPath === '~') return homedir();
  if (authPath.startsWith('~/')) return join(homedir(), authPath.slice(2));
  return authPath;
}

function decodeJwtPayload(token: string): Record<string, any> | null {
  const payloadPart = token.split('.')[1];
  if (!payloadPart) return null;
  try {
    const normalized = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(normalized, 'base64').toString());
  } catch {
    return null;
  }
}

export function loadCodexAuth(authPath: string = codexAuthPath): CodexAuth | null {
  authPath = resolveCodexAuthPath(authPath);
  if (!existsSync(authPath)) {
    console.log(`[codex] No auth file at ${authPath}`);
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(authPath, 'utf-8'));
    const token = raw?.tokens?.access_token;
    if (typeof token !== 'string' || token.length === 0) {
      console.log('[codex] No access_token in auth file');
      return null;
    }

    // Decode JWT to check expiry and extract account ID
    const payload = decodeJwtPayload(token);
    if (payload?.exp) {
      const exp = payload.exp * 1000;
      const now = Date.now();
      if (now > exp) {
        const expiredAgo = Math.round((now - exp) / 60000);
        console.warn(`[codex] Token expired ${expiredAgo} min ago. Run 'codex' to re-auth.`);
        return null;
      }
    }

    // Current Codex CLI auth files include tokens.account_id; older files only
    // expose it in the JWT claims.
    const authClaims = payload?.['https://api.openai.com/auth'];
    const accountId = raw?.tokens?.account_id || authClaims?.chatgpt_account_id;
    if (typeof accountId !== 'string' || accountId.length === 0) {
      console.error('[codex] No account ID in auth file');
      return null;
    }

    const expiresIn = payload?.exp ? Math.round((payload.exp * 1000 - Date.now()) / 60000) : null;
    const expiryDetail = expiresIn === null ? 'expiry unknown' : `expires in ${expiresIn} min`;
    console.log(`[codex] Token valid (${expiryDetail}, account: ${accountId.slice(0, 8)}...)`);
    return { accessToken: token, accountId };
  } catch (error) {
    console.error('[codex] Failed to read auth file:', error);
    return null;
  }
}

export function initCodexAuth(path?: string, baseUrl?: string): boolean {
  if (path) codexAuthPath = resolveCodexAuthPath(path);
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

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function errorMessageWithCause(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const parts = [error.message];
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message && cause.message !== error.message) {
    parts.push(`cause: ${cause.message}`);
  }
  return parts.join('; ');
}

function isRetryableCodexFetchError(error: unknown): boolean {
  const message = errorMessageWithCause(error).toLowerCase();
  return [
    'fetch failed',
    'socket',
    'network',
    'terminated',
    'econnreset',
    'econnrefused',
    'etimedout',
    'eai_again',
    'enotfound',
    'connect timeout',
    'und_err_connect_timeout',
    'codex api 429',
    'codex api 500',
    'codex api 502',
    'codex api 503',
    'codex api 504',
    'codex api 529',
    'overloaded_error',
    'temporarily unavailable',
  ].some(pattern => message.includes(pattern));
}

function formatCodexFetchError(error: unknown, url: string): string {
  return `Codex fetch failed for ${url}: ${errorMessageWithCause(error)}`;
}

/**
 * Make a single Codex API call. Returns raw SSE text.
 */
export async function codexFetch(body: any, timeoutMs: number = DEFAULT_CODEX_FETCH_TIMEOUT_MS): Promise<string> {
  if (!codexAuth) {
    throw new Error('Codex auth not initialized. Run "codex" CLI to authenticate.');
  }

  const baseUrl = codexBaseUrl || DEFAULT_CODEX_BASE_URL;
  const url = `${baseUrl}/codex/responses`;

  for (let attempt = 0; attempt <= codexFetchRetryDelaysMs.length; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));
    try {
      const response = await fetch(url, {
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

      if (attempt >= codexFetchRetryDelaysMs.length || !isRetryableCodexFetchError(error)) {
        throw new Error(formatCodexFetchError(error, url));
      }

      const delayMs = codexFetchRetryDelaysMs[attempt];
      console.warn(
        `[codex] Transient fetch failure; retrying in ${Math.round(delayMs / 1000)}s ` +
        `(${attempt + 1}/${codexFetchRetryDelaysMs.length}): ${formatCodexFetchError(error, url)}`,
      );
      await sleep(delayMs);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error('Unreachable Codex fetch retry state');
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

  // Debug: log when Codex produced neither final text nor tool calls.
  // Tool-call-only turns are expected in the agentic loop.
  if (!outputText && functionCalls.length === 0 && completedResponse) {
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
  return runToolLoop(adapter, params.messages, params.options, params.config, params.toolConfig, params.toolContext);
}
