/**
 * Provider adapter interface for the unified tool loop.
 * Each provider implements this to handle API-specific concerns
 * while sharing the same agentic loop orchestration logic.
 */

import type { ChatMessage, ChatOptions, Config, ToolConfig } from '../types.js';
import type { ContextManagementConfig } from './context-manager.js';

/** Normalized representation of a model response within the tool loop. */
export interface NormalizedResponse {
  /** Whether the model wants to call tools (vs. returning a final answer) */
  hasToolCalls: boolean;
  /** Tool calls extracted from the response */
  toolCalls: NormalizedToolCall[];
  /** Text content from the response (final answer when hasToolCalls=false) */
  textContent: string;
  /** Raw usage data from the provider */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  /** Cost details for this response */
  cost?: {
    input: number;
    output: number;
    total: number;
  };
  /** Raw response object (provider-specific, for appending to message history) */
  rawResponse: unknown;
}

export interface NormalizedToolCall {
  /** Unique ID for this tool call (tool_use_id, call_id, toolCall.id) */
  id: string;
  /** Tool name */
  name: string;
  /** Parsed arguments */
  args: Record<string, any>;
  /** Raw arguments string (for logging) */
  rawArgs: string;
}

export interface CompactionResult<T> {
  /** Updated messages array */
  messages: T[];
  /** Whether compaction actually occurred */
  compacted: boolean;
  /** Compaction method used (if any) */
  method?: 'llm' | 'truncation';
}

/**
 * Provider-specific message container.
 * Each adapter defines its own internal message format.
 */
export interface ProviderMessages {
  /** The mutable message array (format depends on provider) */
  messages: any[];
  /** System prompt / instructions (extracted once, reused per call) */
  systemParam?: any;
}

/**
 * Adapter interface that each provider implements.
 * Separates provider-specific API details from shared tool loop logic.
 */
export interface ProviderAdapter {
  readonly name: string;

  /** Build the initial API messages from ChatMessage[] (strip system, format content) */
  buildMessages(messages: ChatMessage[], options: ChatOptions, config: Config): ProviderMessages;

  /** Build tool definitions in provider-native format */
  buildToolDefs(toolDefs: any[], config: Config): any[];

  /** Make one API call with tools. Returns normalized response. */
  call(
    messages: ProviderMessages,
    toolDefs: any[],
    options: ChatOptions,
    config: Config,
  ): Promise<NormalizedResponse>;

  /** Append the assistant's raw response to the message history */
  appendAssistantResponse(messages: ProviderMessages, rawResponse: unknown): void;

  /** Append a single tool result to the message history.
   *  For providers that batch tool results (e.g. Anthropic), use appendToolResults instead. */
  appendToolResult(messages: ProviderMessages, toolCallId: string, result: string, isError?: boolean): void;

  /** Append multiple tool results as a single message (for providers that batch).
   *  Default implementation calls appendToolResult for each. */
  appendToolResults?(messages: ProviderMessages, results: { toolCallId: string; result: string; isError?: boolean }[]): void;

  /** Compact messages when context grows too large */
  compactMessages(
    messages: ProviderMessages,
    config: ContextManagementConfig | undefined,
    iteration: number,
    fullConfig?: Config,
  ): Promise<CompactionResult<any>>;

  /** Record usage/cost to the usage tracking system */
  recordUsage(model: string, usage: unknown, trigger?: string, agentId?: string): void;
}
