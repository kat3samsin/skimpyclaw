// Context manager for agentic tool loops.
// When accumulated messages exceed the token threshold, uses an LLM to summarize
// old messages into a concise summary, preserving semantic meaning.
//
// Falls back to mechanical truncation if the LLM call fails.
//
// Uses a generic compactMessages() driven by MessageFormatHelper adapters,
// so the compaction algorithm is written once regardless of provider format.

import type { ContextManagementConfig } from './types.js';
import type { Config, ChatMessage, ChatOptions } from '../types.js';
import type { MessageFormatHelper } from './adapter.js';

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
const KEEP_TAIL = 8;         // preserve the newest N items when they fit the configured ceiling
const RESULT_MAX_CHARS = 200; // fallback truncation length
const SUMMARY_MAX_TOKENS = 1024; // max tokens for summary response
const CONTEXT_TRUNCATION_MARKER = '\n[...truncated for context limit...]\n';

// Preferred compaction models in priority order (cheap & fast).
// Can be overridden via contextManagement.compactionModel in config.
const COMPACTION_MODEL_CANDIDATES = [
  'anthropic/claude-haiku-4-5',
];

/** Rough token estimate: 1 token ≈ 4 chars of JSON. */
export function estimateTokens(data: any[]): number {
  return Math.ceil(JSON.stringify(data).length / 4);
}

// --- LLM Summarization ---

const COMPACTION_SYSTEM_PROMPT = `Summarize this AI coding assistant conversation concisely.
Preserve: file paths, variable names, error messages, decisions, code changes.
Summarize tool results briefly. Note unresolved issues. Use bullet points.
Output ONLY the summary.`;

/**
 * Pick the best available compaction model from candidates.
 * Checks which providers are initialized and returns the first match.
 */
async function pickCompactionModel(_config: Config): Promise<string> {
  const { isAnthropicAvailable } = await import('./anthropic.js');

  for (const candidate of COMPACTION_MODEL_CANDIDATES) {
    const provider = candidate.split('/')[0];
    if (provider === 'anthropic' && isAnthropicAvailable()) return candidate;
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
  abortSignal?: AbortSignal,
  usageContext?: Pick<ChatOptions, 'trigger' | 'agentId'>,
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
      abortSignal,
      ...usageContext,
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

// --- Track whether we already compacted for a given conversation ---
let compactedMarker = new WeakSet<any[]>();

function truncateToolResults<T>(
  items: T[],
  helper: MessageFormatHelper<T>,
): { items: T[]; changed: boolean } {
  let changed = false;
  const truncated = items.map(item => {
    if (!helper.isToolResult(item)) return item;
    const next = helper.truncateToolResult(item, RESULT_MAX_CHARS);
    if (next !== item) changed = true;
    return next;
  });
  return { items: changed ? truncated : items, changed };
}

function mechanicallyCompact<T>(
  head: T[],
  tail: T[],
  helper: MessageFormatHelper<T>,
): T[] {
  const truncatedHead = truncateToolResults(head, helper).items;
  return [...truncatedHead, ...tail];
}

function applyPostCompactionRepair<T>(
  result: T[],
  original: T[],
  helper: MessageFormatHelper<T>,
): T[] {
  return helper.repairCompactedMessages?.(result, original) ?? result;
}

function truncateContextText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 0) return '';
  if (maxChars <= CONTEXT_TRUNCATION_MARKER.length) {
    return CONTEXT_TRUNCATION_MARKER.slice(0, maxChars);
  }
  const retainedChars = maxChars - CONTEXT_TRUNCATION_MARKER.length;
  const headChars = Math.ceil(retainedChars / 2);
  return value.slice(0, headChars)
    + CONTEXT_TRUNCATION_MARKER
    + value.slice(-(retainedChars - headChars));
}

function truncateStructuredContent(content: unknown, maxChars: number): unknown {
  if (typeof content === 'string') return truncateContextText(content, maxChars);
  if (!Array.isArray(content)) return content;
  const stringFieldCount = content.reduce((count, block) => (
    count
    + (typeof block?.text === 'string' ? 1 : 0)
    + (typeof block?.content === 'string' || block?.type === 'tool_result' ? 1 : 0)
  ), 0);
  const perField = Math.floor(maxChars / Math.max(1, stringFieldCount));
  return content.map((block) => {
    let next = block;
    if (typeof block?.text === 'string') {
      next = { ...next, text: truncateContextText(block.text, perField) };
    }
    if (typeof block?.content === 'string' || block?.type === 'tool_result') {
      const raw = typeof block.content === 'string' ? block.content : JSON.stringify(block.content) ?? '';
      next = { ...next, content: truncateContextText(raw, perField) };
    }
    return next;
  });
}

function enforceTokenCeiling<T>(
  seed: T[],
  original: T[],
  helper: MessageFormatHelper<T>,
  maxTokens: number,
  preserveFirst = false,
): T[] {
  let newestCandidate: T[] = [];
  const firstStart = preserveFirst ? 1 : 0;
  for (let start = firstStart; start < seed.length; start++) {
    const suffix = preserveFirst
      ? [seed[0], ...seed.slice(start)]
      : seed.slice(start);
    const candidate = applyPostCompactionRepair(suffix, original, helper);
    if (candidate.length > (preserveFirst ? 1 : 0)) {
      newestCandidate = candidate;
      if (estimateTokens(candidate as any[]) <= maxTokens) return candidate;
    }

    const boundedSuffix = truncateToolResults(suffix, helper).items;
    if (boundedSuffix === suffix) continue;
    const boundedCandidate = applyPostCompactionRepair(boundedSuffix, original, helper);
    if (boundedCandidate.length <= (preserveFirst ? 1 : 0)) continue;
    newestCandidate = boundedCandidate;
    if (estimateTokens(boundedCandidate as any[]) <= maxTokens) return boundedCandidate;
  }

  if (helper.truncateItem && newestCandidate.length > 0) {
    if (preserveFirst) {
      let summaryCharBudget = Math.max(0, maxTokens * 4);
      for (;;) {
        const truncated = [
          helper.truncateItem(newestCandidate[0], summaryCharBudget),
          ...newestCandidate.slice(1),
        ];
        const candidate = applyPostCompactionRepair(truncated, truncated, helper);
        if (candidate.length > 1 && estimateTokens(candidate as any[]) <= maxTokens) return candidate;
        if (summaryCharBudget === 0) break;
        summaryCharBudget = Math.floor(summaryCharBudget / 2);
      }
    }

    let totalCharBudget = Math.max(0, maxTokens * 4);
    for (;;) {
      const perItem = Math.floor(totalCharBudget / newestCandidate.length);
      const truncated = newestCandidate.map(item => helper.truncateItem!(item, perItem));
      const candidate = applyPostCompactionRepair(truncated, truncated, helper);
      if (candidate.length > (preserveFirst ? 1 : 0)
        && estimateTokens(candidate as any[]) <= maxTokens) return candidate;
      if (totalCharBudget === 0) break;
      totalCharBudget = Math.floor(totalCharBudget / 2);
    }
  }

  if (seed.length === 0 && estimateTokens([]) <= maxTokens) return seed;
  throw new Error(`Unable to compact context below ${maxTokens} tokens without dropping the newest item`);
}

// =====================================================================
// Generic compaction — single algorithm, format-agnostic via helper
// =====================================================================

/**
 * Generic compaction function for any message format.
 * Delegates format-specific concerns (truncation, serialization, summary building)
 * to the provided MessageFormatHelper.
 *
 * Does NOT mutate the input array — returns a new array.
 */
export async function compactMessages<T>(
  items: T[],
  helper: MessageFormatHelper<T>,
  config?: ContextManagementConfig,
  iteration: number = 0,
  fullConfig?: Config,
  abortSignal?: AbortSignal,
  usageContext?: Pick<ChatOptions, 'trigger' | 'agentId'>,
): Promise<CompactionResult<T>> {
  if (config?.enabled === false) return { messages: items, compacted: false };
  const maxTokens = config?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const estimated = estimateTokens(items as any[]);
  if (estimated <= maxTokens) return { messages: items, compacted: false };

  const tail = items.slice(-KEEP_TAIL);
  const head = items.slice(0, -KEEP_TAIL);

  // If we already compacted this array, use truncation fallback
  // to progressively shrink rather than re-summarizing repeatedly.
  if (compactedMarker.has(items as any[])) {
    console.log(`[context-manager] Already compacted, using truncation fallback (iteration ${iteration})`);
    const result = enforceTokenCeiling(
      mechanicallyCompact(head, tail, helper),
      items,
      helper,
      maxTokens,
    );
    compactedMarker.add(result as any[]);
    return { messages: result, compacted: true, method: 'truncation', tokensBefore: estimated, tokensAfter: estimateTokens(result as any[]) };
  }

  console.log(
    `[context-manager] Compacting at iteration ${iteration} (~${Math.round(estimated / 1000)}k tokens > ${Math.round(maxTokens / 1000)}k threshold)`,
  );

  // Attempt LLM summarization
  if (fullConfig) {
    const transcript = helper.serialize(head);
    const summary = await llmSummarize(
      transcript,
      fullConfig,
      config?.compactionModel,
      abortSignal,
      usageContext,
    );
    if (summary) {
      const summaryItem = helper.buildSummaryMessage(summary);
      const result = enforceTokenCeiling([summaryItem, ...tail], items, helper, maxTokens, true);
      compactedMarker.add(result as any[]);
      const tokensAfter = estimateTokens(result as any[]);
      return { messages: result, compacted: true, method: 'llm', summary, tokensBefore: estimated, tokensAfter };
    }
  }

  // Fallback: mechanical truncation
  const result = enforceTokenCeiling(
    mechanicallyCompact(head, tail, helper),
    items,
    helper,
    maxTokens,
  );
  compactedMarker.add(result as any[]);
  return { messages: result, compacted: true, method: 'truncation', tokensBefore: estimated, tokensAfter: estimateTokens(result as any[]) };
}

// =====================================================================
// Provider-specific MessageFormatHelper implementations
// =====================================================================

function repairAnthropicToolResults(compacted: any[]): any[] {
  const seenToolUses = new Set<string>();
  const repaired: any[] = [];
  let changed = false;

  for (const item of compacted) {
    if (!Array.isArray(item?.content)) {
      repaired.push(item);
      continue;
    }
    for (const block of item.content) {
      if (block?.type === 'tool_use' && typeof block.id === 'string') {
        seenToolUses.add(block.id);
      }
    }
    const content = item.content.filter((block: any) => (
      block?.type !== 'tool_result'
      || (typeof block.tool_use_id === 'string' && seenToolUses.has(block.tool_use_id))
    ));
    if (content.length === item.content.length) {
      repaired.push(item);
    } else if (content.length > 0) {
      changed = true;
      repaired.push({ ...item, content });
    } else {
      changed = true;
    }
  }

  return changed ? repaired : compacted;
}

function repairOpenAIToolResults(compacted: any[]): any[] {
  const seenToolCalls = new Set<string>();
  const repaired: any[] = [];
  let changed = false;

  for (const item of compacted) {
    if (Array.isArray(item?.tool_calls)) {
      for (const call of item.tool_calls) {
        if (typeof call?.id === 'string') seenToolCalls.add(call.id);
      }
    }
    if (item?.role === 'tool' && (
      typeof item.tool_call_id !== 'string' || !seenToolCalls.has(item.tool_call_id)
    )) {
      changed = true;
      continue;
    }
    repaired.push(item);
  }

  return changed ? repaired : compacted;
}

/** Anthropic message format helper. */
export const anthropicFormatHelper: MessageFormatHelper<any> = {
  isToolResult(item: any): boolean {
    if (!Array.isArray(item.content)) return false;
    return item.content.some((block: any) => block.type === 'tool_result');
  },

  truncateToolResult(item: any, maxChars: number): any {
    if (!Array.isArray(item.content)) return item;
    let changed = false;
    const newContent = item.content.map((block: any) => {
      if (block.type !== 'tool_result') return block;
      const raw = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content);
      if (raw.length <= maxChars) return block;
      changed = true;
      return { ...block, content: raw.slice(0, maxChars) + ' [truncated]' };
    });
    return changed ? { ...item, content: newContent } : item;
  },

  truncateItem(item: any, maxChars: number): any {
    const content = truncateStructuredContent(item?.content, maxChars);
    return content === item?.content ? item : { ...item, content };
  },

  serialize(items: any[]): string {
    return serializeAnthropicMessages(items);
  },

  buildSummaryMessage(summary: string): any {
    return {
      role: 'user',
      content: [{ type: 'text', text: `[Conversation Summary]\n${summary}` }],
    };
  },

  repairCompactedMessages(compacted: any[]): any[] {
    return repairAnthropicToolResults(compacted);
  },
};

/** OpenAI message format helper. */
export const openaiFormatHelper: MessageFormatHelper<any> = {
  isToolResult(item: any): boolean {
    return item.role === 'tool';
  },

  truncateToolResult(item: any, maxChars: number): any {
    if (typeof item.content !== 'string') return item;
    if (item.content.length <= maxChars) return item;
    return { ...item, content: item.content.slice(0, maxChars) + ' [truncated]' };
  },

  truncateItem(item: any, maxChars: number): any {
    const content = truncateStructuredContent(item?.content, maxChars);
    return content === item?.content ? item : { ...item, content };
  },

  serialize(items: any[]): string {
    return serializeOpenAIMessages(items);
  },

  buildSummaryMessage(summary: string): any {
    return {
      role: 'user' as const,
      content: `[Conversation Summary]\n${summary}`,
    };
  },

  repairCompactedMessages(compacted: any[]): any[] {
    return repairOpenAIToolResults(compacted);
  },
};

function getCodexFunctionCallId(item: any): string | undefined {
  if (typeof item?.call_id === 'string' && item.call_id.length > 0) {
    return item.call_id;
  }
  if (item?.type === 'function_call' && typeof item.id === 'string' && item.id.length > 0) {
    return item.id;
  }
  return undefined;
}

function normalizeCodexFunctionCall(item: any): any {
  if (item?.type !== 'function_call' || typeof item.call_id === 'string') {
    return item;
  }
  const callId = getCodexFunctionCallId(item);
  return callId ? { ...item, call_id: callId } : item;
}

export function repairCodexFunctionCallOutputs(compacted: any[], original: any[] = compacted): any[] {
  const originalCalls = new Map<string, any>();
  for (const item of original) {
    if (item?.type !== 'function_call') continue;
    const callId = getCodexFunctionCallId(item);
    if (!callId || originalCalls.has(callId)) continue;
    originalCalls.set(callId, normalizeCodexFunctionCall(item));
  }

  const seenCalls = new Set<string>();
  const repaired: any[] = [];
  let changed = false;

  for (const item of compacted) {
    if (item?.type === 'function_call') {
      const normalized = normalizeCodexFunctionCall(item);
      const callId = getCodexFunctionCallId(normalized);
      if (callId) seenCalls.add(callId);
      if (normalized !== item) changed = true;
      repaired.push(normalized);
      continue;
    }

    if (item?.type === 'function_call_output') {
      const callId = getCodexFunctionCallId(item);
      if (!callId) {
        changed = true;
        continue;
      }
      if (!seenCalls.has(callId)) {
        const originalCall = originalCalls.get(callId);
        if (!originalCall) {
          changed = true;
          continue;
        }
        repaired.push(originalCall);
        seenCalls.add(callId);
        changed = true;
      }
    }

    repaired.push(item);
  }

  return changed ? repaired : compacted;
}

/** Codex message format helper. */
export const codexFormatHelper: MessageFormatHelper<any> = {
  isToolResult(item: any): boolean {
    return item.type === 'function_call_output';
  },

  truncateToolResult(item: any, maxChars: number): any {
    if (typeof item.output !== 'string') return item;
    if (item.output.length <= maxChars) return item;
    return { ...item, output: item.output.slice(0, maxChars) + ' [truncated]' };
  },

  truncateItem(item: any, maxChars: number): any {
    if (item?.type === 'function_call_output' && typeof item.output === 'string') {
      return { ...item, output: truncateContextText(item.output, maxChars) };
    }
    if (item?.type !== 'message') return item;
    const content = truncateStructuredContent(item.content, maxChars);
    return content === item.content ? item : { ...item, content };
  },

  serialize(items: any[]): string {
    return serializeCodexMessages(items);
  },

  buildSummaryMessage(summary: string): any {
    return {
      type: 'message',
      role: 'user',
      content: `[Conversation Summary]\n${summary}`,
    };
  },

  repairCompactedMessages(compacted: any[], original: any[]): any[] {
    return repairCodexFunctionCallOutputs(compacted, original);
  },
};

// =====================================================================
// Serialization helpers (used by format helpers and exported for tests)
// =====================================================================

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

// =====================================================================
// Legacy wrapper functions — delegate to generic compactMessages()
// These preserve backward compatibility for the old provider tool loops
// (anthropic.ts, codex.ts) until Phase 5 removes them.
// =====================================================================

/**
 * Compact Anthropic-format apiMessages when over threshold.
 * @deprecated Use compactMessages() with anthropicFormatHelper instead.
 */
export async function compactAnthropicMessages(
  messages: any[],
  config?: ContextManagementConfig,
  iteration: number = 0,
  fullConfig?: Config,
): Promise<CompactionResult<any>> {
  return compactMessages(messages, anthropicFormatHelper, config, iteration, fullConfig);
}

/**
 * Compact OpenAI-format apiMessages when over threshold.
 * @deprecated Use compactMessages() with openaiFormatHelper instead.
 */
export async function compactOpenAIMessages(
  messages: any[],
  config?: ContextManagementConfig,
  iteration: number = 0,
  fullConfig?: Config,
): Promise<CompactionResult<any>> {
  return compactMessages(messages, openaiFormatHelper, config, iteration, fullConfig);
}

/**
 * Compact Codex-format input items when over threshold.
 * @deprecated Use compactMessages() with codexFormatHelper instead.
 */
export async function compactCodexMessages(
  input: any[],
  config?: ContextManagementConfig,
  iteration: number = 0,
  fullConfig?: Config,
): Promise<CompactionResult<any>> {
  return compactMessages(input, codexFormatHelper, config, iteration, fullConfig);
}

// --- Exported helpers for testing ---
export { serializeAnthropicMessages, serializeOpenAIMessages, serializeCodexMessages };

/** Reset compaction markers (for testing). */
export function resetCompactionState(): void {
  compactedMarker = new WeakSet<any[]>();
}
