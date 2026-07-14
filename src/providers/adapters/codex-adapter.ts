/**
 * Codex provider adapter for the unified tool loop.
 */

import type { ChatMessage, ChatOptions, Config, ThinkingLevel } from '../../types.js';
import type {
  ProviderAdapter,
  ProviderMessages,
  NormalizedResponse,
  NormalizedToolCall,
  CompactionResult,
  FinalizationResponse,
} from '../adapter.js';
import type { ExecuteToolContext } from '../../tools.js';
import { contentToText, stripProvider } from '../utils.js';
import { compactMessages, codexFormatHelper, repairCodexFunctionCallOutputs } from '../context-manager.js';
import { toCodexContent, toCodexToolDefinitions } from '../content.js';
import { toCostDetails } from '../observability.js';
import { codexFetch, parseCodexSSE, isCodexAvailable, recordCodexUsage } from '../codex.js';

type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

function isSolModel(modelId: string): boolean {
  return modelId === 'gpt-5.6-sol' || modelId === 'gpt-5.6';
}

function codexReasoningEffort(thinking?: ThinkingLevel): CodexReasoningEffort {
  switch (thinking) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return thinking;
    case 'ultra':
      return 'xhigh';
    default:
      return 'medium';
  }
}

function codexReasoning(options: ChatOptions): { effort: CodexReasoningEffort; summary: 'auto' } {
  return { effort: codexReasoningEffort(options.thinking), summary: 'auto' };
}

function enableFastTierForSol(body: Record<string, unknown>, modelId: string): void {
  if (isSolModel(modelId)) {
    body.service_tier = 'priority';
  }
}

function codexTextTypeForRole(role: unknown): 'input_text' | 'output_text' {
  return role === 'assistant' ? 'output_text' : 'input_text';
}

function fetchCodex(body: any, abortSignal?: AbortSignal): Promise<string> {
  // Signal-carrying turns are wrapped by a bounded cron or Discord deadline.
  return abortSignal
    ? codexFetch(body, null, abortSignal)
    : codexFetch(body);
}

function normalizeCodexMessageContent(content: unknown, role: unknown): any[] {
  const textType = codexTextTypeForRole(role);
  if (typeof content === 'string') {
    return [{ type: textType, text: content }];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content.map((block) => {
    if (!block || typeof block !== 'object') {
      return block;
    }

    const contentBlock = block as any;
    if (
      (contentBlock.type === 'output_text'
        || contentBlock.type === 'text'
        || contentBlock.type === 'input_text')
      && typeof contentBlock.text === 'string'
    ) {
      return { ...contentBlock, type: textType };
    }

    return contentBlock;
  });
}

function normalizeCodexInputItems(items: any[]): any[] {
  const normalized: any[] = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') {
      normalized.push(item);
      continue;
    }

    if (item.type === 'output_text' && typeof item.text === 'string') {
      normalized.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: item.text }],
      });
      continue;
    }

    if (item.type === 'message') {
      normalized.push({
        ...item,
        content: normalizeCodexMessageContent(item.content, item.role),
      });
      continue;
    }

    normalized.push(item);
  }

  return normalized;
}

function prepareCodexInput(items: any[]): any[] {
  return repairCodexFunctionCallOutputs(normalizeCodexInputItems(items));
}

export class CodexAdapter implements ProviderAdapter {
  readonly name = 'codex';

  isAvailable(): boolean {
    return isCodexAvailable();
  }

  async chat(messages: ChatMessage[], options: ChatOptions, _config: Config): Promise<string> {
    const modelId = stripProvider(options.model);

    let instructions = 'You are a helpful assistant.';
    const input: any[] = [];

    for (const m of messages) {
      if (m.role === 'system') {
        instructions = contentToText(m.content);
        continue;
      }
      input.push({
        type: 'message',
        role: m.role,
        content: toCodexContent(m.content, codexTextTypeForRole(m.role)),
      });
    }

    const body: any = {
      model: modelId,
      instructions,
      input,
      store: false,
      stream: true,
      reasoning: codexReasoning(options),
      include: ['reasoning.encrypted_content'],
    };
    enableFastTierForSol(body, modelId);

    const sseText = await fetchCodex(body, options.abortSignal);
    const parsed = parseCodexSSE(sseText);

    this.recordUsage(modelId, {
      inputTokens: parsed.response?.usage?.input_tokens ?? 0,
      outputTokens: parsed.response?.usage?.output_tokens ?? 0,
      cacheReadTokens: parsed.response?.usage?.input_tokens_details?.cached_tokens,
    }, options.trigger || 'api', options.agentId);

    return parsed.outputText || '[No response from Codex]';
  }

  getToolDefinitionOptions(_toolContext?: ExecuteToolContext, _config?: Config): { includeMcp?: boolean } {
    // MCP tools are standard function calls — Codex handles them fine.
    return { includeMcp: true };
  }

  buildMessages(messages: ChatMessage[], _options: ChatOptions, _config: Config): ProviderMessages {
    let instructions = 'You are a helpful assistant.';
    const input: any[] = [];

    for (const m of messages) {
      if (m.role === 'system') {
        instructions = contentToText(m.content);
        continue;
      }

      input.push({
        type: 'message',
        role: m.role,
        content: toCodexContent(m.content, codexTextTypeForRole(m.role)),
      });
    }

    return {
      messages: input,
      systemParam: instructions,
    };
  }

  buildToolDefs(toolDefs: any[], _config: Config): any[] {
    return toCodexToolDefinitions(toolDefs || []);
  }

  async call(
    providerMessages: ProviderMessages,
    toolDefs: any[],
    options: ChatOptions,
    _config: Config,
  ): Promise<NormalizedResponse> {
    const modelId = stripProvider(options.model);
    providerMessages.messages = prepareCodexInput(providerMessages.messages);
    const body: any = {
      model: modelId,
      instructions: providerMessages.systemParam || 'You are a helpful assistant.',
      input: providerMessages.messages,
      store: false,
      stream: true,
      reasoning: codexReasoning(options),
      include: ['reasoning.encrypted_content'],
    };
    enableFastTierForSol(body, modelId);
    if (toolDefs?.length) {
      body.tools = toolDefs;
    }

    const sseText = await fetchCodex(body, options.abortSignal);
    const parsed = parseCodexSSE(sseText);

    const toolCalls: NormalizedToolCall[] = parsed.functionCalls.map((fc: any) => {
      const rawArgs = typeof fc.arguments === 'string' ? fc.arguments : '{}';
      let args: Record<string, any>;
      try {
        args = JSON.parse(rawArgs);
      } catch {
        args = {};
      }
      return {
        id: fc.callId,
        name: fc.name,
        args,
        rawArgs,
      };
    });

    const usage = parsed.response?.usage;
    const hasUsage = Number.isFinite(usage?.input_tokens) && Number.isFinite(usage?.output_tokens);
    const cost = hasUsage ? toCostDetails(modelId, usage) || undefined : undefined;

    return {
      hasToolCalls: toolCalls.length > 0,
      toolCalls,
      textContent: parsed.outputText || '',
      usage: hasUsage ? {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage?.input_tokens_details?.cached_tokens,
      } : undefined,
      cost,
      rawResponse: parsed.response,
    };
  }

  appendAssistantResponse(providerMessages: ProviderMessages, rawResponse: unknown): void {
    const response = rawResponse as any;
    if (!response?.output || !Array.isArray(response.output)) return;
    providerMessages.messages.push(...normalizeCodexInputItems(response.output));
  }

  appendToolResult(providerMessages: ProviderMessages, toolCallId: string, result: string, _isError?: boolean): void {
    providerMessages.messages.push({
      type: 'function_call_output',
      call_id: toolCallId,
      output: result,
    });
  }

  /**
   * Codex sometimes finishes tool execution but omits final text.
   * Re-ask once (without tools) for a user-facing answer from the gathered context.
   */
  async onEmptyFinalResponse(
    providerMessages: ProviderMessages,
    _toolDefs: any[],
    options: ChatOptions,
    _config: Config,
  ): Promise<FinalizationResponse> {
    const modelId = stripProvider(options.model);

    // Build a finalization input: existing messages + nudge
    const finalizeInput = [...prepareCodexInput(providerMessages.messages)];
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

    const body: any = {
      model: modelId,
      instructions: providerMessages.systemParam || 'You are a helpful assistant.',
      input: finalizeInput,
      store: false,
      stream: true,
      reasoning: codexReasoning(options),
      include: ['reasoning.encrypted_content'],
    };
    enableFastTierForSol(body, modelId);

    console.log('[codex] Finalizing tool run with a text-only follow-up');
    const sseText = await fetchCodex(body, options.abortSignal);
    const parsed = parseCodexSSE(sseText);
    const usage = parsed.response?.usage;
    const hasUsage = Number.isFinite(usage?.input_tokens) && Number.isFinite(usage?.output_tokens);
    return {
      textContent: parsed.outputText?.trim() || '',
      hasToolCalls: parsed.functionCalls.length > 0,
      usage: hasUsage ? {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.input_tokens_details?.cached_tokens,
      } : undefined,
      cost: hasUsage ? toCostDetails(modelId, usage) || undefined : undefined,
    };
  }

  async compactMessages(
    providerMessages: ProviderMessages,
    config: any,
    iteration: number,
    fullConfig?: Config,
    abortSignal?: AbortSignal,
    usageContext?: Pick<ChatOptions, 'trigger' | 'agentId'>,
  ): Promise<CompactionResult<any>> {
    const result = await compactMessages(
      providerMessages.messages,
      codexFormatHelper,
      config,
      iteration,
      fullConfig,
      abortSignal,
      usageContext,
    );
    providerMessages.messages = result.messages;
    return result;
  }

  recordUsage(model: string, usage: unknown, trigger?: string, agentId?: string): void {
    const u = usage as any;
    recordCodexUsage({
      model,
      usage: {
        input_tokens: typeof u?.inputTokens === 'number' ? u.inputTokens : 0,
        output_tokens: typeof u?.outputTokens === 'number' ? u.outputTokens : 0,
        input_tokens_details: {
          cached_tokens: typeof u?.cacheReadTokens === 'number' ? u.cacheReadTokens : undefined,
        },
      },
      trigger,
      agentId,
    });
  }
}
