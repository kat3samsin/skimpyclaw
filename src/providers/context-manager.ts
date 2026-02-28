// Context manager for agentic tool loops.
// When accumulated messages exceed the token threshold, compacts old tool results
// to keep context size bounded without breaking message structure.
//
// Key constraint: tool_use/tool_result pairs (Anthropic) and
// function_call/function_call_output pairs (Codex) must stay structurally intact.
// We truncate the CONTENT of old results — never remove blocks entirely.

import type { ContextManagementConfig } from './types.js';

export type { ContextManagementConfig };

const DEFAULT_MAX_CONTEXT_TOKENS = 100_000;
const KEEP_TAIL = 8;         // always keep last N messages/items untouched
const RESULT_MAX_CHARS = 500; // compact old results to this length

/** Rough token estimate: 1 token ≈ 4 chars of JSON. */
export function estimateTokens(data: any[]): number {
  return Math.ceil(JSON.stringify(data).length / 4);
}

/**
 * Compact Anthropic-format apiMessages when over threshold.
 * Truncates content of old tool_result blocks; leaves last KEEP_TAIL messages intact.
 * Does NOT mutate the input array — returns a new array.
 */
export function compactAnthropicMessages(
  messages: any[],
  config?: ContextManagementConfig,
  iteration: number = 0,
): any[] {
  if (config?.enabled === false) return messages;
  const maxTokens = config?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const estimated = estimateTokens(messages);
  if (estimated <= maxTokens) return messages;

  console.log(
    `[context-manager] Compacting at iteration ${iteration} (~${Math.round(estimated / 1000)}k tokens > ${Math.round(maxTokens / 1000)}k threshold)`,
  );

  const tail = messages.slice(-KEEP_TAIL);
  const head = messages.slice(0, -KEEP_TAIL);

  const compacted = head.map(msg => {
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

  return [...compacted, ...tail];
}

/**
 * Compact Codex-format input items when over threshold.
 * Truncates output of old function_call_output items; leaves last KEEP_TAIL items intact.
 * Does NOT mutate the input array — returns a new array.
 */
export function compactCodexMessages(
  input: any[],
  config?: ContextManagementConfig,
  iteration: number = 0,
): any[] {
  if (config?.enabled === false) return input;
  const maxTokens = config?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const estimated = estimateTokens(input);
  if (estimated <= maxTokens) return input;

  console.log(
    `[context-manager] Compacting Codex input at iteration ${iteration} (~${Math.round(estimated / 1000)}k tokens > ${Math.round(maxTokens / 1000)}k threshold)`,
  );

  const tail = input.slice(-KEEP_TAIL);
  const head = input.slice(0, -KEEP_TAIL);

  const compacted = head.map(item => {
    if (item.type !== 'function_call_output') return item;
    if (typeof item.output !== 'string') return item;
    if (item.output.length <= RESULT_MAX_CHARS) return item;
    return { ...item, output: item.output.slice(0, RESULT_MAX_CHARS) + ' [truncated]' };
  });

  return [...compacted, ...tail];
}
