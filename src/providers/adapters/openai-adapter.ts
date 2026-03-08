/**
 * OpenAI-compatible provider adapter for the unified tool loop.
 * Works with OpenAI, OpenRouter, Groq, Kimi, MiniMax, and other compatible providers.
 */

import type { ChatMessage, ChatOptions, Config } from '../../types.js';
import type {
  ProviderAdapter,
  ProviderMessages,
  NormalizedResponse,
  NormalizedToolCall,
  CompactionResult,
} from '../adapter.js';
import type { ExecuteToolContext } from '../../tools.js';
import { contentToText, stripProvider, toOpenAITools } from '../utils.js';
import { compactMessages, openaiFormatHelper } from '../context-manager.js';
import { toOpenAIContent } from '../content.js';
import { toCostDetails } from '../observability.js';
import { getOpenAIClient, recordOpenAIUsage } from '../openai.js';

export class OpenAIAdapter implements ProviderAdapter {
  readonly name: string;
  private readonly provider: string;

  constructor(provider: string) {
    this.provider = provider;
    this.name = `openai:${provider}`;
  }

  getToolDefinitionOptions(_toolContext?: ExecuteToolContext, _config?: Config): { includeMcp?: boolean } {
    // OpenAI-compatible providers do not support MCP tools.
    return { includeMcp: false };
  }

  buildMessages(messages: ChatMessage[], _options: ChatOptions, _config: Config): ProviderMessages {
    // OpenAI uses role-based messages; system messages stay as role: 'system'.
    const apiMessages: any[] = messages.map(m => ({
      role: m.role,
      content: toOpenAIContent(m.content),
    }));

    return { messages: apiMessages };
  }

  buildToolDefs(toolDefs: any[], _config: Config): any[] {
    return toOpenAITools(toolDefs || []);
  }

  async call(
    providerMessages: ProviderMessages,
    toolDefs: any[],
    options: ChatOptions,
    config: Config,
  ): Promise<NormalizedResponse> {
    const client = getOpenAIClient(this.provider);
    if (!client) {
      throw new Error(`OpenAI client not initialized for provider: ${this.provider}`);
    }

    const modelId = stripProvider(options.model);

    // Kimi requires interleaved reasoning content.
    const providerBaseURL = config.models.providers[this.provider]?.baseURL || '';
    const isKimiLike = providerBaseURL.includes('kimi.com') || providerBaseURL.includes('moonshot.ai');
    const kimiRequestExtras = isKimiLike
      ? { extra_body: { interleaved: { field: 'reasoning_content' } } }
      : {};

    const completion = await client.chat.completions.create({
      model: modelId,
      messages: providerMessages.messages,
      tools: toolDefs,
      max_tokens: options.maxTokens || 4096,
      temperature: options.temperature,
      ...kimiRequestExtras,
    });

    const message = completion.choices[0]?.message;
    const usage = completion.usage;
    const cost = toCostDetails(modelId, usage) || undefined;

    if (!message) {
      return {
        hasToolCalls: false,
        toolCalls: [],
        textContent: '',
        usage: {
          inputTokens: usage?.prompt_tokens ?? 0,
          outputTokens: usage?.completion_tokens ?? 0,
        },
        cost,
        rawResponse: completion,
      };
    }

    // Normalize tool calls
    const hasToolCalls = completion.choices[0]?.finish_reason === 'tool_calls' && !!message.tool_calls?.length;
    const toolCalls: NormalizedToolCall[] = [];

    if (hasToolCalls && message.tool_calls) {
      for (const tc of message.tool_calls) {
        const rawArgs = tc.function.arguments || '{}';
        let args: Record<string, any>;
        try {
          args = JSON.parse(rawArgs);
        } catch {
          args = {};
        }
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          args,
          rawArgs,
        });
      }
    }

    // Strip <think>...</think> reasoning blocks (e.g. MiniMax M2.x)
    let textContent = message.content || '';
    if (!hasToolCalls) {
      textContent = textContent.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
    }

    return {
      hasToolCalls,
      toolCalls,
      textContent,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
      },
      cost,
      rawResponse: completion,
    };
  }

  appendAssistantResponse(providerMessages: ProviderMessages, rawResponse: unknown): void {
    const completion = rawResponse as any;
    const message = completion?.choices?.[0]?.message;
    if (!message) return;

    // Build assistant message with tool_calls for OpenAI format.
    // Preserve reasoning_content for Kimi compatibility.
    const assistantMsg: Record<string, any> = {
      role: 'assistant',
      content: message.content ?? null,
      tool_calls: message.tool_calls,
    };

    const rawReasoning = message.reasoning_content
      ?? message.additional_kwargs?.reasoning_content
      ?? message.reasoning?.content;
    if (rawReasoning !== undefined && rawReasoning !== null) {
      assistantMsg.reasoning_content = Array.isArray(rawReasoning)
        ? rawReasoning.join('\n')
        : String(rawReasoning);
    }

    providerMessages.messages.push(assistantMsg);
  }

  appendToolResult(providerMessages: ProviderMessages, toolCallId: string, result: string, _isError?: boolean): void {
    providerMessages.messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: result,
    });
  }

  async compactMessages(
    providerMessages: ProviderMessages,
    config: any,
    iteration: number,
    fullConfig?: Config,
  ): Promise<CompactionResult<any>> {
    const result = await compactMessages(
      providerMessages.messages,
      openaiFormatHelper,
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
    recordOpenAIUsage({
      model,
      provider: this.provider,
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
      },
      trigger,
      agentId,
    });
  }
}
