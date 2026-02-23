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
export function parseClaudeOutput(stdout: string): { text: string; metadata?: Record<string, unknown> } {
  const lines = stdout.trim().split('\n');
  let resultText = '';
  let lastResult: Record<string, unknown> | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const extracted = extractClaudeEventParts(event, { includeSystem: false, includeTools: false });
      if (extracted.length > 0) {
        resultText += extracted.join('\n') + '\n';
      }
      // The final "result" event may include metadata
      if (event.type === 'result') {
        lastResult = event;
      }
    } catch { /* skip non-JSON lines */ }
  }

  if (resultText.trim()) {
    return { text: resultText.trim(), metadata: lastResult || undefined };
  } else if (lastResult) {
    // No text output — build summary from result metadata
    const turns = lastResult.num_turns || '?';
    const cost = lastResult.total_cost_usd != null ? `$${(lastResult.total_cost_usd as number).toFixed(2)}` : '';
    const duration = lastResult.duration_ms ? `${Math.round((lastResult.duration_ms as number) / 1000)}s` : '';
    const parts = [`Completed in ${turns} turns`, duration, cost].filter(Boolean);
    return { text: parts.join(', '), metadata: lastResult };
  }

  return { text: stdout.slice(0, 500) || '(no output)' };
}

/**
 * Parse Codex JSON output to extract text responses.
 */
export function parseCodexOutput(stdout: string): string {
  const lines = stdout.trim().split('\n');
  const outputs: string[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'output_text' || obj.output_text) {
        outputs.push(obj.output_text || obj.text || '');
      }
    } catch {
      if (line.trim()) outputs.push(line);
    }
  }
  return outputs.join('\n') || stdout || '(no output)';
}
