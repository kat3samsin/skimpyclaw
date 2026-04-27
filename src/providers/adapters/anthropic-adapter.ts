/**
 * Anthropic provider adapter for the unified tool loop.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ChatOptions, Config } from '../../types.js';
import type {
  ProviderAdapter,
  ProviderMessages,
  NormalizedResponse,
  NormalizedToolCall,
  CompactionResult,
} from '../adapter.js';
import { getAnthropicClient } from '../anthropic.js';
import { buildSystemParam, addToolCacheBreakpoint, contentToText, stripProvider, buildThinkingConfig } from '../utils.js';
import { toCostDetails } from '../observability.js';
import { compactMessages, anthropicFormatHelper } from '../context-manager.js';
import { buildUsageRecord, recordUsage } from '../../usage.js';

const NONSTREAMING_TOKEN_LIMIT = 21_333;

function shouldStreamAnthropicRequest(params: { max_tokens?: number }): boolean {
  return typeof params.max_tokens === 'number' && params.max_tokens > NONSTREAMING_TOKEN_LIMIT;
}

async function createAnthropicMessage(client: Anthropic, params: any): Promise<any> {
  if (shouldStreamAnthropicRequest(params) && typeof (client.messages as any).stream === 'function') {
    return await (client.messages as any).stream(params).finalMessage();
  }
  return await client.messages.create(params);
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = 'anthropic';

  isAvailable(): boolean {
    return getAnthropicClient() !== null;
  }

  async chat(messages: ChatMessage[], options: ChatOptions, config: Config): Promise<string> {
    const client = getAnthropicClient();
    if (!client) {
      throw new Error('Anthropic client not initialized');
    }

    const modelId = stripProvider(options.model);
    const systemMessage = messages.find(m => m.role === 'system');
    const chatMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content as any,
      }));

    const cacheEnabled = config.models?.promptCaching !== false;
    const anthropicParams: any = {
      model: modelId,
      max_tokens: options.maxTokens || 4096,
      messages: chatMessages,
    };

    const systemParam = buildSystemParam(contentToText(systemMessage?.content || ''), cacheEnabled);
    if (systemParam) {
      anthropicParams.system = systemParam;
    }

    const thinkingConfig = buildThinkingConfig(options.thinking);
    if (thinkingConfig) {
      anthropicParams.thinking = { type: 'enabled', budget_tokens: thinkingConfig.budget };
      anthropicParams.max_tokens = Math.max(anthropicParams.max_tokens, thinkingConfig.maxTokens);
    }

    const response = await createAnthropicMessage(client, anthropicParams);
    const usage = (response as any).usage;

    if (usage?.cache_read_input_tokens > 0 || usage?.cache_creation_input_tokens > 0) {
      console.log(`[cache] read=${usage.cache_read_input_tokens || 0} created=${usage.cache_creation_input_tokens || 0}`);
    }
    this.recordUsage(modelId, {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_input_tokens,
      cacheCreationTokens: usage?.cache_creation_input_tokens,
    }, 'api');

    const textContent = response.content.find((c: any) => c.type === 'text');
    return (textContent as any)?.text || '';
  }

  buildMessages(messages: ChatMessage[], options: ChatOptions, config: Config): ProviderMessages {
    const cacheEnabled = config.models?.promptCaching !== false;
    const systemMessage = messages.find(m => m.role === 'system');
    const systemParam = buildSystemParam(contentToText(systemMessage?.content || ''), cacheEnabled);

    const apiMessages: any[] = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }));

    return {
      messages: apiMessages,
      systemParam,
    };
  }

  buildToolDefs(toolDefs: any[], config: Config): any[] {
    const cacheEnabled = config.models?.promptCaching !== false;

    // Make a copy to avoid mutating the original
    const defs = JSON.parse(JSON.stringify(toolDefs));

    if (cacheEnabled) {
      addToolCacheBreakpoint(defs);
    }

    return defs;
  }

  async call(
    providerMessages: ProviderMessages,
    toolDefs: any[],
    options: ChatOptions,
    config: Config,
  ): Promise<NormalizedResponse> {
    const client = getAnthropicClient();
    if (!client) {
      throw new Error('Anthropic client not initialized');
    }

    const modelId = stripProvider(options.model);

    const anthropicParams: any = {
      model: modelId,
      max_tokens: options.maxTokens || 16384,
      messages: providerMessages.messages,
      tools: toolDefs,
    };

    if (providerMessages.systemParam) {
      anthropicParams.system = providerMessages.systemParam;
    }

    // Add thinking if configured
    const thinkingConfig = buildThinkingConfig(options.thinking);
    if (thinkingConfig) {
      anthropicParams.thinking = { type: 'enabled', budget_tokens: thinkingConfig.budget };
      anthropicParams.max_tokens = Math.max(anthropicParams.max_tokens, thinkingConfig.maxTokens);
    }

    const response = await createAnthropicMessage(client, anthropicParams);
    const usage = (response as any).usage;

    // Log cache metrics
    if (usage?.cache_read_input_tokens > 0 || usage?.cache_creation_input_tokens > 0) {
      console.log(`[cache] read=${usage.cache_read_input_tokens || 0} created=${usage.cache_creation_input_tokens || 0}`);
    }

    // Normalize response
    const hasToolCalls = response.stop_reason === 'tool_use';
    const toolCalls: NormalizedToolCall[] = [];
    let textContent = '';

    for (const block of response.content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: block.input as Record<string, any>,
          rawArgs: JSON.stringify(block.input),
        });
      }
    }

    const cost = toCostDetails(modelId, usage) || undefined;

    return {
      hasToolCalls,
      toolCalls,
      textContent,
      usage: {
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        cacheReadTokens: usage?.cache_read_input_tokens,
        cacheCreationTokens: usage?.cache_creation_input_tokens,
      },
      cost,
      rawResponse: response,
    };
  }

  appendAssistantResponse(providerMessages: ProviderMessages, rawResponse: unknown): void {
    const response = rawResponse as any;
    providerMessages.messages.push({ role: 'assistant', content: response.content });
  }

  appendToolResult(
    providerMessages: ProviderMessages,
    toolCallId: string,
    result: string,
    isError?: boolean,
  ): void {
    const toolResult: any = {
      type: 'tool_result',
      tool_use_id: toolCallId,
      content: result,
    };
    if (isError) {
      toolResult.is_error = true;
    }

    // Anthropic expects tool_result blocks in a user message
    providerMessages.messages.push({ role: 'user', content: [toolResult] });
  }

  appendToolResults(
    providerMessages: ProviderMessages,
    results: { toolCallId: string; result: string; isError?: boolean }[],
  ): void {
    // Anthropic expects all tool_result blocks for one turn in a single user message
    const toolResults = results.map(r => {
      const block: any = {
        type: 'tool_result',
        tool_use_id: r.toolCallId,
        content: r.result,
      };
      if (r.isError) {
        block.is_error = true;
      }
      return block;
    });
    providerMessages.messages.push({ role: 'user', content: toolResults });
  }

  async compactMessages(
    providerMessages: ProviderMessages,
    config: any,
    iteration: number,
    fullConfig?: Config,
  ): Promise<CompactionResult<any>> {
    const result = await compactMessages(
      providerMessages.messages,
      anthropicFormatHelper,
      config,
      iteration,
      fullConfig,
    );
    providerMessages.messages = result.messages;
    return result;
  }

  recordUsage(model: string, usage: unknown, trigger?: string, agentId?: string): void {
    const u = usage as any;
    const inputTokens = typeof u?.inputTokens === 'number' ? u.inputTokens : 0;
    const outputTokens = typeof u?.outputTokens === 'number' ? u.outputTokens : 0;
    if (inputTokens === 0 && outputTokens === 0) return;
    const cost = toCostDetails(model, { input_tokens: inputTokens, output_tokens: outputTokens });
    const usageRecord = buildUsageRecord({
      model,
      provider: 'anthropic',
      inputTokens,
      outputTokens,
      inputCost: cost?.input ?? 0,
      outputCost: cost?.output ?? 0,
      totalCost: cost?.total ?? 0,
      trigger: trigger || 'api',
      agentId,
      cacheReadTokens: u?.cacheReadTokens,
      cacheCreationTokens: u?.cacheCreationTokens,
    });
    recordUsage(usageRecord);
  }
}
