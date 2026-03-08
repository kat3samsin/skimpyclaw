/**
 * Codex provider adapter for the unified tool loop.
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
import { contentToText, stripProvider } from '../utils.js';
import { compactMessages, codexFormatHelper } from '../context-manager.js';
import { toCodexContent, toCodexToolDefinitions } from '../content.js';
import { toCostDetails } from '../observability.js';
import { codexFetch, parseCodexSSE, isCodexAvailable, recordCodexUsage } from '../codex.js';

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
      const contentType = m.role === 'assistant' ? 'output_text' : 'input_text';
      input.push({
        type: 'message',
        role: m.role,
        content: toCodexContent(m.content, contentType),
      });
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

    const sseText = await codexFetch(body);
    const parsed = parseCodexSSE(sseText);

    this.recordUsage(modelId, {
      inputTokens: parsed.response?.usage?.input_tokens ?? 0,
      outputTokens: parsed.response?.usage?.output_tokens ?? 0,
      cacheReadTokens: parsed.response?.usage?.input_tokens_details?.cached_tokens,
    }, 'api');

    return parsed.outputText || '[No response from Codex]';
  }

  getToolDefinitionOptions(_toolContext?: ExecuteToolContext, _config?: Config): { includeMcp?: boolean } {
    // Codex/OpenAI-compatible providers do not support MCP tools.
    return { includeMcp: false };
  }

  buildMessages(messages: ChatMessage[], _options: ChatOptions, _config: Config): ProviderMessages {
    let instructions = 'You are a helpful assistant.';
    const input: any[] = [];

    for (const m of messages) {
      if (m.role === 'system') {
        instructions = contentToText(m.content);
        continue;
      }

      const contentType = m.role === 'assistant' ? 'output_text' : 'input_text';
      input.push({
        type: 'message',
        role: m.role,
        content: toCodexContent(m.content, contentType),
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
    const body: any = {
      model: modelId,
      instructions: providerMessages.systemParam || 'You are a helpful assistant.',
      input: providerMessages.messages,
      store: false,
      stream: true,
      reasoning: { effort: 'medium', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
    };
    if (toolDefs?.length) {
      body.tools = toolDefs;
    }

    const sseText = await codexFetch(body);
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
    const cost = toCostDetails(modelId, usage) || undefined;

    return {
      hasToolCalls: toolCalls.length > 0,
      toolCalls,
      textContent: parsed.outputText || '',
      usage: {
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        cacheReadTokens: usage?.input_tokens_details?.cached_tokens,
      },
      cost,
      rawResponse: parsed.response,
    };
  }

  appendAssistantResponse(providerMessages: ProviderMessages, rawResponse: unknown): void {
    const response = rawResponse as any;
    if (!response?.output || !Array.isArray(response.output)) return;
    for (const item of response.output) {
      providerMessages.messages.push(item);
    }
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
  ): Promise<string | undefined> {
    const modelId = stripProvider(options.model);

    // Build a finalization input: existing messages + nudge
    const finalizeInput = [...providerMessages.messages];
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
      reasoning: { effort: 'medium', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
    };

    console.log('[codex] Finalizing tool run with a text-only follow-up');
    const sseText = await codexFetch(body);
    const parsed = parseCodexSSE(sseText);
    return parsed.outputText?.trim() || undefined;
  }

  async compactMessages(
    providerMessages: ProviderMessages,
    config: any,
    iteration: number,
    fullConfig?: Config,
  ): Promise<CompactionResult<any>> {
    const result = await compactMessages(
      providerMessages.messages,
      codexFormatHelper,
      config,
      iteration,
      fullConfig,
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
