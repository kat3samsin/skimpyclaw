// Codex Provider (ChatGPT Backend)

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ProviderChatParams, ProviderToolChatParams, ToolChatResult } from './types.js';
import { stripProvider, truncateToolResult } from './utils.js';
import { compactCodexMessages } from './context-manager.js';
import { toCodexContent, toCodexToolDefinitions } from './content.js';
import { toNumericUsageDetails, toCostDetails } from './observability.js';
import { executeTool } from '../tools.js';
import { ToolCallGuard } from './tool-guard.js';
import { startTrace, addEvent, endTrace } from '../audit.js';
import { startObservation } from '@langfuse/tracing';
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

function recordCodexUsage(params: {
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
  return startObservation(name, attributes, { asType: 'generation' });
}

/**
 * Make a single Codex API call. Returns raw SSE text.
 */
async function codexFetch(body: any, timeoutMs: number = DEFAULT_CODEX_FETCH_TIMEOUT_MS): Promise<string> {
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

export async function chatCodex(params: ProviderChatParams): Promise<string> {
  const { messages, options } = params;
  const modelId = stripProvider(options.model);

  // Build input — system messages go to `instructions`, rest to `input`
  let instructions = 'You are a helpful assistant.';
  const input: any[] = [];
  
  for (const m of messages) {
    if (m.role === 'system') {
      // Convert content to text
      const { contentToText } = await import('./utils.js');
      instructions = contentToText(m.content);
    } else {
      const contentType = m.role === 'assistant' ? 'output_text' : 'input_text';
      const content = toCodexContent(m.content, contentType);
      input.push({
        type: 'message',
        role: m.role,
        content,
      });
    }
  }

  const body: any = {
    model: modelId,
    instructions,
    input,
    store: false,
    stream: true,
    reasoning: { effort: 'medium', summary: 'auto' },
    include: ['reasoning.encrypted_content'],
  };

  const genObs = await startGenerationObservation(`codex:${modelId}`, {
    input: { instructions, input },
    model: modelId,
    modelParameters: { stream: true, reasoning: body.reasoning },
    metadata: { provider: 'codex' },
  });

  try {
    const sseText = await codexFetch(body);
    const parsed = parseCodexSSE(sseText);
    recordCodexUsage({ model: modelId, usage: parsed.response?.usage, trigger: 'api' });
    
    genObs?.update({
      output: { text: parsed.outputText },
      usageDetails: toNumericUsageDetails(parsed.response?.usage),
      costDetails: toCostDetails(modelId, parsed.response?.usage),
    });
    genObs?.end();

    return parsed.outputText || '[No response from Codex]';
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    genObs?.update({ level: 'ERROR', statusMessage: errorMessage, output: { error: errorMessage } });
    genObs?.end();
    throw err;
  }
}

export async function chatWithToolsCodex(params: ProviderToolChatParams): Promise<ToolChatResult> {
  const { messages, options, toolConfig, toolContext } = params;
  const modelId = stripProvider(options.model);
  const maxIterations = toolConfig.maxIterations || 100;

  // Build input — system messages go to `instructions`, rest to `input`
  let instructions = 'You are a helpful assistant.';
  const input: any[] = [];
  
  for (const m of messages) {
    if (m.role === 'system') {
      const { contentToText } = await import('./utils.js');
      instructions = contentToText(m.content);
    } else {
      const contentType = m.role === 'assistant' ? 'output_text' : 'input_text';
      const content = toCodexContent(m.content, contentType);
      input.push({
        type: 'message',
        role: m.role,
        content,
      });
    }
  }

  // Get tool definitions
  const { getToolDefinitions } = await import('../tools.js');
  const includeSpawn = !!(toolContext?.fullConfig && (toolContext?.chatId || toolContext?.isCronJob));
  const toolDefs = await getToolDefinitions(toolConfig, { 
    includeSpawnSubagent: includeSpawn, 
    includeMcp: false, 
    projects: toolContext?.fullConfig?.projects 
  });
  const tools = toolDefs ? toCodexToolDefinitions(toolDefs) : undefined;

  const toolLog: string[] = [];
  const auditTraceId = toolContext?.auditTraceId || startTrace((toolContext?.trigger || 'api') as any);

  // Guard: spin detection, no-progress detection, token budget
  const guard = new ToolCallGuard(toolConfig.maxTurnTokens);

  for (let i = 0; i < maxIterations; i++) {
    // Check abort signal before each iteration
    if (toolContext?.abortSignal?.aborted) {
      return {
        response: `[Cancelled after ${toolLog.length} tool calls]`,
        toolCalls: toolLog,
      };
    }

    // Compact old tool results if context is growing large
    const inputForApi = compactCodexMessages(input, toolConfig.contextManagement, i + 1);

    const body: any = {
      model: modelId,
      instructions,
      input: inputForApi,
      store: false,
      stream: true,
      reasoning: { effort: 'medium', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
    };
    if (tools) body.tools = tools;

    console.log(`[codex] Iteration ${i + 1}/${maxIterations} (model: ${modelId})`);

    const genObs = await startGenerationObservation(`codex:${modelId}`, {
      input: { instructions, input },
      model: modelId,
      modelParameters: { stream: true, reasoning: body.reasoning },
      metadata: { provider: 'codex', iteration: i + 1 },
    });

    let parsed: { outputText: string; functionCalls: any[]; response: any | null };
    try {
      const sseText = await codexFetch(body);
      parsed = parseCodexSSE(sseText);
      recordCodexUsage({
        model: modelId,
        usage: parsed.response?.usage,
        trigger: toolContext?.trigger || 'api',
        agentId: toolContext?.agentId,
      });
      genObs?.update({
        output: { text: parsed.outputText },
        usageDetails: toNumericUsageDetails(parsed.response?.usage),
        costDetails: toCostDetails(modelId, parsed.response?.usage),
      });
      genObs?.end();

      // Guard: track token usage (stats only, no enforcement)
      guard.recordTokens(
        parsed.response?.usage?.input_tokens ?? 0,
        parsed.response?.usage?.output_tokens ?? 0,
      );
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
      let finalText = parsed.outputText;
      if (!finalText && toolLog.length > 0) {
        try {
          // Some Codex runs finish tool execution but omit final text. Ask once more
          // (without tools) for a user-facing answer from the gathered context.
          const finalizeInput = [...input];
          if (parsed.response?.output) {
            for (const item of parsed.response.output) {
              finalizeInput.push(item);
            }
          }
          finalizeInput.push({
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'Provide the final answer to the user using the tool results above. Do not call tools. Be concise.',
              },
            ],
          });

          const finalizeBody: any = {
            model: modelId,
            instructions,
            input: finalizeInput,
            store: false,
            stream: true,
            reasoning: { effort: 'medium', summary: 'auto' },
            include: ['reasoning.encrypted_content'],
          };

          console.log('[codex] Finalizing tool run with a text-only follow-up');
          const finalizeSse = await codexFetch(finalizeBody);
          const finalized = parseCodexSSE(finalizeSse);
          finalText = finalized.outputText?.trim() || '';
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[codex] Finalization pass failed: ${msg}`);
        }
      }
      if (!finalText && toolLog.length > 0) {
        finalText = `[Completed ${toolLog.length} tool calls, but no final text response was generated.]`;
      }
      const usage = parsed.response?.usage;
      return {
        response: finalText || '[No response from Codex]',
        toolCalls: toolLog,
        usage: {
          prompt_tokens: usage?.input_tokens ?? 0,
          completion_tokens: usage?.output_tokens ?? 0,
          total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
        },
        cost: toCostDetails(modelId, usage),
      };
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

      // Guard: spin detection
      const guardResult = guard.recordCall(fc.name, args);
      if (guardResult.warning) console.warn(`[codex:tools:guard] ${guardResult.warning}`);
      if (guardResult.blocked) {
        input.push({
          type: 'function_call_output',
          call_id: fc.callId,
          output: guardResult.warning || 'Blocked: repeated identical call',
        });
        toolLog.push(`${fc.name} [BLOCKED: spin detected]`);
        continue;
      }

      const { isLangfuseEnabled } = await import('../langfuse.js');
      const toolObs = isLangfuseEnabled()
        ? startObservation(`tool:${fc.name}`, { input: args, metadata: { app: LANGFUSE_APP_NAME, tool: fc.name } }, { asType: 'tool' })
        : null;

      const toolStart = Date.now();
      try {
        const result = await executeTool(fc.name, args, toolConfig, toolContext) || '';
        const truncatedResult = truncateToolResult(result);
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
          output: truncatedResult,
        });

        // Guard: no-progress detection
        const progressResult = guard.recordResult(result);
        if (progressResult.nudge) {
          console.warn(`[codex:tools:guard] ${progressResult.nudge}`);
          input[input.length - 1].output += `\n\n[System: ${progressResult.nudge}]`;
        }
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

/** Build UsageDetails from Codex usage response */
function buildCodexUsageDetails(usage: any) {
  return {
    prompt_tokens: usage?.input_tokens ?? 0,
    completion_tokens: usage?.output_tokens ?? 0,
    total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
  };
}
