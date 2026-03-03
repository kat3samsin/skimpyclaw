// Context manager for agentic tool loops.
// When accumulated messages exceed the token threshold, uses an LLM to summarize
// old messages into a concise summary, preserving semantic meaning.
//
// Falls back to mechanical truncation if the LLM call fails.
//
// Key constraint: tool_use/tool_result pairs (Anthropic) and
// function_call/function_call_output pairs (Codex) must stay structurally intact.

import type { ContextManagementConfig } from './types.js';
import type { Config, ChatMessage } from '../types.js';

export type { ContextManagementConfig };

/** Result of a compaction attempt, including metadata about what happened. */
export interface CompactionResult<T> {
  messages: T[];
  /** Whether any compaction was performed */
  compacted: boolean;
  /** 'llm' if LLM summarized, 'truncation' if mechanically truncated, undefined if no compaction */
  method?: 'llm' | 'truncation';
  /** The summary text (only when method === 'llm') */
  summary?: string;
  /** Estimated tokens before compaction */
  tokensBefore?: number;
  /** Estimated tokens after compaction */
  tokensAfter?: number;
}

const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
const KEEP_TAIL = 8;         // always keep last N messages/items untouched
const RESULT_MAX_CHARS = 500; // fallback truncation length
const SUMMARY_MAX_TOKENS = 2048; // max tokens for summary response

// Preferred compaction models in priority order (cheap & fast).
// Can be overridden via contextManagement.compactionModel in config.
const COMPACTION_MODEL_CANDIDATES = [
  'anthropic/claude-haiku-3-5',
  'openai/gpt-4o-mini',
  'groq/llama-3.1-8b-instant',
];

/** Rough token estimate: 1 token ≈ 4 chars of JSON. */
export function estimateTokens(data: any[]): number {
  return Math.ceil(JSON.stringify(data).length / 4);
}

// --- LLM Summarization ---

const COMPACTION_SYSTEM_PROMPT = `You are a conversation summarizer for an AI coding assistant. Your job is to produce a concise summary of a conversation between a user and an assistant that used tools (file reads, bash commands, file writes, etc.).

Rules:
- Preserve ALL important context: file paths, variable names, error messages, decisions made, code changes
- Summarize tool results (e.g. "Read package.json — found dependencies X, Y, Z") rather than reproducing full output
- Keep the summary structured with bullet points or short paragraphs
- Note any unresolved issues or ongoing tasks
- Be concise but don't lose critical information that the assistant needs to continue working
- Output ONLY the summary, no preamble`;

/**
 * Serialize Anthropic-format messages into a human-readable conversation transcript
 * suitable for LLM summarization.
 */
function serializeAnthropicMessages(messages: any[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'Assistant' : 'User';
    if (typeof msg.content === 'string') {
      lines.push(`[${role}]: ${msg.content}`);
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'text') {
        lines.push(`[${role}]: ${block.text}`);
      } else if (block.type === 'tool_use') {
        const inputStr = typeof block.input === 'string'
          ? block.input
          : JSON.stringify(block.input);
        const truncatedInput = inputStr.length > 500 ? inputStr.slice(0, 500) + '...' : inputStr;
        lines.push(`[Assistant Tool Call: ${block.name}]: ${truncatedInput}`);
      } else if (block.type === 'tool_result') {
        const raw = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content);
        const truncatedResult = raw.length > 1000 ? raw.slice(0, 1000) + '...' : raw;
        lines.push(`[Tool Result]: ${truncatedResult}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Serialize OpenAI-format messages into a human-readable transcript.
 */
function serializeOpenAIMessages(messages: any[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'tool') {
      const raw = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const truncated = raw.length > 1000 ? raw.slice(0, 1000) + '...' : raw;
      lines.push(`[Tool Result (${msg.tool_call_id})]: ${truncated}`);
    } else if (msg.role === 'assistant') {
      if (msg.content) {
        lines.push(`[Assistant]: ${msg.content}`);
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const args = tc.function?.arguments || '';
          const truncatedArgs = args.length > 500 ? args.slice(0, 500) + '...' : args;
          lines.push(`[Assistant Tool Call: ${tc.function?.name}]: ${truncatedArgs}`);
        }
      }
    } else {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      lines.push(`[${msg.role === 'user' ? 'User' : msg.role}]: ${content}`);
    }
  }
  return lines.join('\n');
}

/**
 * Serialize Codex-format input items into a human-readable transcript.
 */
function serializeCodexMessages(items: any[]): string {
  const lines: string[] = [];
  for (const item of items) {
    if (item.type === 'message') {
      const role = item.role === 'assistant' ? 'Assistant' : 'User';
      const content = typeof item.content === 'string'
        ? item.content
        : Array.isArray(item.content)
          ? item.content.map((c: any) => c.text || JSON.stringify(c)).join(' ')
          : JSON.stringify(item.content);
      lines.push(`[${role}]: ${content}`);
    } else if (item.type === 'function_call') {
      const args = item.arguments || '';
      const truncated = args.length > 500 ? args.slice(0, 500) + '...' : args;
      lines.push(`[Assistant Tool Call: ${item.name}]: ${truncated}`);
    } else if (item.type === 'function_call_output') {
      const raw = item.output || '';
      const truncated = raw.length > 1000 ? raw.slice(0, 1000) + '...' : raw;
      lines.push(`[Tool Result]: ${truncated}`);
    }
  }
  return lines.join('\n');
}

/**
 * Pick the best available compaction model from candidates.
 * Checks which providers are initialized and returns the first match.
 */
async function pickCompactionModel(config: Config): Promise<string> {
  const { isAnthropicAvailable } = await import('./anthropic.js');
  const { isOpenAIAvailable } = await import('./openai.js');

  for (const candidate of COMPACTION_MODEL_CANDIDATES) {
    const provider = candidate.split('/')[0];
    if (provider === 'anthropic' && isAnthropicAvailable()) return candidate;
    if (isOpenAIAvailable(provider)) return candidate;
  }
  // Last resort: return the first candidate and let chat() fail → fallback to truncation
  return COMPACTION_MODEL_CANDIDATES[0];
}

/**
 * Call the LLM to summarize a conversation transcript.
 * Returns the summary text, or null if the call fails.
 */
async function llmSummarize(
  transcript: string,
  config: Config,
  compactionModel?: string,
): Promise<string | null> {
  try {
    // Dynamically import to avoid circular dependency
    const { chat } = await import('./index.js');

    const model = compactionModel || await pickCompactionModel(config);
    const messages: ChatMessage[] = [
      { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Summarize the following conversation between an AI coding assistant and a user. This summary will replace the old messages in the context window so the assistant can continue working.\n\n---\n${transcript}\n---`,
      },
    ];

    console.log(`[context-manager] Requesting LLM summary via ${model}`);
    const summary = await chat(messages, {
      model,
      maxTokens: SUMMARY_MAX_TOKENS,
    }, config);

    if (!summary || summary.trim().length === 0) {
      console.warn('[context-manager] LLM returned empty summary, falling back to truncation');
      return null;
    }

    console.log(`[context-manager] LLM summary: ${summary.length} chars`);
    return summary.trim();
  } catch (err) {
    console.warn(`[context-manager] LLM summarization failed, falling back to truncation: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// --- Fallback truncation (original mechanical approach) ---

function truncateAnthropicHead(head: any[]): any[] {
  return head.map(msg => {
    if (!Array.isArray(msg.content)) return msg;
    let changed = false;
    const newContent = msg.content.map((block: any) => {
      if (block.type !== 'tool_result') return block;
      const raw = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content);
      if (raw.length <= RESULT_MAX_CHARS) return block;
      changed = true;
      return { ...block, content: raw.slice(0, RESULT_MAX_CHARS) + ' [truncated]' };
    });
    return changed ? { ...msg, content: newContent } : msg;
  });
}

function truncateOpenAIHead(head: any[]): any[] {
  return head.map(msg => {
    if (msg.role !== 'tool') return msg;
    if (typeof msg.content !== 'string') return msg;
    if (msg.content.length <= RESULT_MAX_CHARS) return msg;
    return { ...msg, content: msg.content.slice(0, RESULT_MAX_CHARS) + ' [truncated]' };
  });
}

function truncateCodexHead(head: any[]): any[] {
  return head.map(item => {
    if (item.type !== 'function_call_output') return item;
    if (typeof item.output !== 'string') return item;
    if (item.output.length <= RESULT_MAX_CHARS) return item;
    return { ...item, output: item.output.slice(0, RESULT_MAX_CHARS) + ' [truncated]' };
  });
}

// --- Track whether we already compacted for a given conversation ---
// Key: a hash of the tail messages to avoid re-summarizing the same head repeatedly.
// This is a WeakMap so we don't leak memory across conversations.
const compactedMarker = new WeakSet<any[]>();

/**
 * Compact Anthropic-format apiMessages when over threshold.
 * Uses LLM summarization for old messages; falls back to truncation on failure.
 * Does NOT mutate the input array — returns a new array.
 */
export async function compactAnthropicMessages(
  messages: any[],
  config?: ContextManagementConfig,
  iteration: number = 0,
  fullConfig?: Config,
): Promise<CompactionResult<any>> {
  if (config?.enabled === false) return { messages, compacted: false };
  const maxTokens = config?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const estimated = estimateTokens(messages);
  if (estimated <= maxTokens) return { messages, compacted: false };

  // If we already compacted this array (it has a summary message), use truncation fallback
  // to progressively shrink rather than re-summarizing repeatedly.
  if (compactedMarker.has(messages)) {
    console.log(`[context-manager] Already compacted, using truncation fallback (iteration ${iteration})`);
    const tail = messages.slice(-KEEP_TAIL);
    const head = messages.slice(0, -KEEP_TAIL);
    const result = [...truncateAnthropicHead(head), ...tail];
    return { messages: result, compacted: true, method: 'truncation', tokensBefore: estimated, tokensAfter: estimateTokens(result) };
  }

  console.log(
    `[context-manager] Compacting at iteration ${iteration} (~${Math.round(estimated / 1000)}k tokens > ${Math.round(maxTokens / 1000)}k threshold)`,
  );

  const tail = messages.slice(-KEEP_TAIL);
  const head = messages.slice(0, -KEEP_TAIL);

  // Attempt LLM summarization
  if (fullConfig) {
    const transcript = serializeAnthropicMessages(head);
    const summary = await llmSummarize(transcript, fullConfig, config?.compactionModel);
    if (summary) {
      const summaryMessage = {
        role: 'user',
        content: [{ type: 'text', text: `[Conversation Summary]\n${summary}` }],
      };
      const result = [summaryMessage, ...tail];
      compactedMarker.add(result);
      const tokensAfter = estimateTokens(result);
      return { messages: result, compacted: true, method: 'llm', summary, tokensBefore: estimated, tokensAfter };
    }
  }

  // Fallback: mechanical truncation
  const result = [...truncateAnthropicHead(head), ...tail];
  return { messages: result, compacted: true, method: 'truncation', tokensBefore: estimated, tokensAfter: estimateTokens(result) };
}

/**
 * Compact OpenAI-format apiMessages when over threshold.
 * Uses LLM summarization for old messages; falls back to truncation on failure.
 * Does NOT mutate the input array — returns a new array.
 */
export async function compactOpenAIMessages(
  messages: any[],
  config?: ContextManagementConfig,
  iteration: number = 0,
  fullConfig?: Config,
): Promise<CompactionResult<any>> {
  if (config?.enabled === false) return { messages, compacted: false };
  const maxTokens = config?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const estimated = estimateTokens(messages);
  if (estimated <= maxTokens) return { messages, compacted: false };

  if (compactedMarker.has(messages)) {
    console.log(`[context-manager] Already compacted, using truncation fallback (iteration ${iteration})`);
    const tail = messages.slice(-KEEP_TAIL);
    const head = messages.slice(0, -KEEP_TAIL);
    const result = [...truncateOpenAIHead(head), ...tail];
    return { messages: result, compacted: true, method: 'truncation', tokensBefore: estimated, tokensAfter: estimateTokens(result) };
  }

  console.log(
    `[context-manager] Compacting OpenAI messages at iteration ${iteration} (~${Math.round(estimated / 1000)}k tokens > ${Math.round(maxTokens / 1000)}k threshold)`,
  );

  const tail = messages.slice(-KEEP_TAIL);
  const head = messages.slice(0, -KEEP_TAIL);

  // Attempt LLM summarization
  if (fullConfig) {
    const transcript = serializeOpenAIMessages(head);
    const summary = await llmSummarize(transcript, fullConfig, config?.compactionModel);
    if (summary) {
      const summaryMessage = {
        role: 'user' as const,
        content: `[Conversation Summary]\n${summary}`,
      };
      const result = [summaryMessage, ...tail];
      compactedMarker.add(result);
      const tokensAfter = estimateTokens(result);
      return { messages: result, compacted: true, method: 'llm', summary, tokensBefore: estimated, tokensAfter };
    }
  }

  // Fallback: mechanical truncation
  const result = [...truncateOpenAIHead(head), ...tail];
  return { messages: result, compacted: true, method: 'truncation', tokensBefore: estimated, tokensAfter: estimateTokens(result) };
}

/**
 * Compact Codex-format input items when over threshold.
 * Uses LLM summarization for old items; falls back to truncation on failure.
 * Does NOT mutate the input array — returns a new array.
 */
export async function compactCodexMessages(
  input: any[],
  config?: ContextManagementConfig,
  iteration: number = 0,
  fullConfig?: Config,
): Promise<CompactionResult<any>> {
  if (config?.enabled === false) return { messages: input, compacted: false };
  const maxTokens = config?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const estimated = estimateTokens(input);
  if (estimated <= maxTokens) return { messages: input, compacted: false };

  if (compactedMarker.has(input)) {
    console.log(`[context-manager] Already compacted, using truncation fallback (iteration ${iteration})`);
    const tail = input.slice(-KEEP_TAIL);
    const head = input.slice(0, -KEEP_TAIL);
    const result = [...truncateCodexHead(head), ...tail];
    return { messages: result, compacted: true, method: 'truncation', tokensBefore: estimated, tokensAfter: estimateTokens(result) };
  }

  console.log(
    `[context-manager] Compacting Codex input at iteration ${iteration} (~${Math.round(estimated / 1000)}k tokens > ${Math.round(maxTokens / 1000)}k threshold)`,
  );

  const tail = input.slice(-KEEP_TAIL);
  const head = input.slice(0, -KEEP_TAIL);

  // Attempt LLM summarization
  if (fullConfig) {
    const transcript = serializeCodexMessages(head);
    const summary = await llmSummarize(transcript, fullConfig, config?.compactionModel);
    if (summary) {
      const summaryItem = {
        type: 'message',
        role: 'user',
        content: `[Conversation Summary]\n${summary}`,
      };
      const result = [summaryItem, ...tail];
      compactedMarker.add(result);
      const tokensAfter = estimateTokens(result);
      return { messages: result, compacted: true, method: 'llm', summary, tokensBefore: estimated, tokensAfter };
    }
  }

  // Fallback: mechanical truncation
  const result = [...truncateCodexHead(head), ...tail];
  return { messages: result, compacted: true, method: 'truncation', tokensBefore: estimated, tokensAfter: estimateTokens(result) };
}

// --- Exported helpers for testing ---
export { serializeAnthropicMessages, serializeOpenAIMessages, serializeCodexMessages };

/** Reset compaction markers (for testing). */
export function resetCompactionState(): void {
  // WeakSet doesn't support clearing, so we replace it
  // This is a no-op in production; tests should create fresh arrays
}
