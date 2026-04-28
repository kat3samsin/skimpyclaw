// Code Agent Output Parser

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pushText(parts: string[], value: unknown): void {
  const text = asString(value);
  if (text) parts.push(text);
}

function extractContentBlocks(
  content: unknown,
  parts: string[],
  options?: { includeTools?: boolean },
): void {
  if (!Array.isArray(content)) return;
  for (const block of content as ClaudeContentBlock[]) {
    if (block?.type === 'text') {
      pushText(parts, block.text);
      continue;
    }
    if (options?.includeTools && block?.type === 'tool_use') {
      const name = block.name || 'tool';
      const inputPreview = block.input ? JSON.stringify(block.input).slice(0, 120) : '';
      parts.push(`[${name}] ${inputPreview}`.trim());
    }
  }
}

function extractClaudeEventParts(
  event: Record<string, unknown>,
  options?: { includeSystem?: boolean; includeTools?: boolean },
): string[] {
  const parts: string[] = [];
  const type = event.type;

  // Legacy Claude CLI stream-json format
  if (type === 'assistant') {
    const message = event.message as Record<string, unknown> | undefined;
    extractContentBlocks(message?.content, parts, { includeTools: options?.includeTools !== false });
    return parts;
  }
  if (type === 'result') {
    pushText(parts, event.result);
    return parts;
  }
  if (type === 'system' && options?.includeSystem && event.message != null) {
    if (typeof event.message === 'string') {
      parts.push(`[system] ${event.message}`);
    } else {
      parts.push(`[system] ${JSON.stringify(event.message).slice(0, 200)}`);
    }
    return parts;
  }

  // Newer Claude stream events: item.completed with item.type === "agent_message"
  if (type === 'item.completed' || type === 'item.delta') {
    const item = (event.item || event.delta) as Record<string, unknown> | undefined;
    if (!item) return parts;
    const itemType = item.type;

    if (itemType === 'agent_message') {
      pushText(parts, item.text);
      const message = item.message as Record<string, unknown> | undefined;
      extractContentBlocks(message?.content, parts, { includeTools: options?.includeTools !== false });
      extractContentBlocks(item.content, parts, { includeTools: options?.includeTools !== false });
      return parts;
    }

    if (options?.includeTools && itemType === 'tool_use') {
      const name = typeof item.name === 'string' ? item.name : 'tool';
      const inputPreview = item.input ? JSON.stringify(item.input).slice(0, 120) : '';
      parts.push(`[${name}] ${inputPreview}`.trim());
    }
  }

  return parts;
}

/**
 * Parse stream-json stdout into human-readable live output.
 * Extracts assistant text, tool use summaries, and system messages.
 * Returns the last `maxChars` of readable output.
 */
export function parseStreamJsonForLive(raw: string, maxChars = 5000): string {
  const lines = raw.split('\n');
  const parts: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      parts.push(...extractClaudeEventParts(event, { includeSystem: true, includeTools: true }));
    } catch {
      // Non-JSON line — include if it looks like meaningful output
      if (line.trim().length > 0 && !line.startsWith('{')) {
        parts.push(line.trim());
      }
    }
  }

  const output = parts.join('\n');
  return output.length > maxChars ? output.slice(-maxChars) : output;
}

/**
 * Parse Claude's stream-json output to extract the final result.
 */
export interface ClaudeOutputResult {
  text: string;
  metadata?: Record<string, unknown>;
  totalCost?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export function parseClaudeOutput(stdout: string): ClaudeOutputResult {
  const lines = stdout.trim().split('\n');
  let resultText = '';
  let lastResult: Record<string, unknown> | null = null;
  // Accumulate token counts from turn.completed events (newer CLI format)
  let accumInputTokens = 0;
  let accumOutputTokens = 0;
  let hasTurnUsage = false;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const extracted = extractClaudeEventParts(event, { includeSystem: false, includeTools: false });
      if (extracted.length > 0) {
        resultText += extracted.join('\n') + '\n';
      }
      // The final "result" event may include metadata (legacy format)
      if (event.type === 'result') {
        lastResult = event;
      }
      // Newer Claude CLI emits turn.completed with per-turn usage
      if (event.type === 'turn.completed') {
        const usage = event.usage as Record<string, unknown> | undefined;
        if (usage) {
          if (typeof usage.input_tokens === 'number') { accumInputTokens += usage.input_tokens; hasTurnUsage = true; }
          if (typeof usage.output_tokens === 'number') { accumOutputTokens += usage.output_tokens; hasTurnUsage = true; }
        }
      }
    } catch { /* skip non-JSON lines */ }
  }

  // Extract cost/token data — try multiple formats:
  // 1. Legacy: result.total_cost_usd, result.total_input_tokens, result.total_output_tokens
  // 2. Legacy nested: result.usage.input_tokens, result.usage.output_tokens
  // 3. Newer: accumulated from turn.completed events
  const costData: Pick<ClaudeOutputResult, 'totalCost' | 'inputTokens' | 'outputTokens'> = {};
  if (lastResult) {
    if (typeof lastResult.total_cost_usd === 'number') costData.totalCost = lastResult.total_cost_usd;
    // Try top-level fields first
    if (typeof lastResult.total_input_tokens === 'number') costData.inputTokens = lastResult.total_input_tokens;
    if (typeof lastResult.total_output_tokens === 'number') costData.outputTokens = lastResult.total_output_tokens;
    // Fall back to nested usage object
    if (costData.inputTokens == null || costData.outputTokens == null) {
      const usage = lastResult.usage as Record<string, unknown> | undefined;
      if (usage) {
        if (costData.inputTokens == null && typeof usage.input_tokens === 'number') costData.inputTokens = usage.input_tokens;
        if (costData.outputTokens == null && typeof usage.output_tokens === 'number') costData.outputTokens = usage.output_tokens;
      }
    }
  }
  // Fall back to accumulated turn.completed data (newest format — no result event)
  if (hasTurnUsage) {
    if (costData.inputTokens == null) costData.inputTokens = accumInputTokens;
    if (costData.outputTokens == null) costData.outputTokens = accumOutputTokens;
  }

  if (resultText.trim()) {
    return { text: resultText.trim(), metadata: lastResult || undefined, ...costData };
  } else if (lastResult) {
    // No text output — build summary from result metadata
    const turns = lastResult.num_turns || '?';
    const cost = lastResult.total_cost_usd != null ? `$${(lastResult.total_cost_usd as number).toFixed(2)}` : '';
    const duration = lastResult.duration_ms ? `${Math.round((lastResult.duration_ms as number) / 1000)}s` : '';
    const parts = [`Completed in ${turns} turns`, duration, cost].filter(Boolean);
    return { text: parts.join(', '), metadata: lastResult, ...costData };
  }

  return { text: stdout.slice(0, 500) || '(no output)', ...costData };
}

/**
 * Parse Codex JSON output to extract text responses.
 */
export function parseCodexOutput(stdout: string): string {
  const lines = stdout.trim().split('\n');
  const outputs: string[] = [];
  let sawJsonEvent = false;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && typeof obj.type === 'string') {
        sawJsonEvent = true;
      }
      // Standard output_text events
      if (obj.type === 'output_text' || obj.output_text) {
        outputs.push(obj.output_text || obj.text || '');
      }
      // Codex stream-json: item.completed with agent_message
      else if (obj.type === 'item.completed' && obj.item?.type === 'agent_message' && obj.item?.text) {
        outputs.push(obj.item.text);
      }
    } catch {
      if (line.trim()) outputs.push(line);
    }
  }
  return outputs.join('\n') || (sawJsonEvent ? '(no text output)' : stdout) || '(no output)';
}
