// Code Agent Output Parser

import { StringDecoder } from 'node:string_decoder';

export const MAX_STREAM_EVENT_CHARS = 1024 * 1024;
const MAX_OUTPUT_PREVIEW_CHARS = 5000;
const OVERSIZED_EVENT_MESSAGE = '[oversized stream event omitted from in-memory preview]';

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

function appendFirst(current: string, value: string, maxChars: number): string {
  if (!value || current.length >= maxChars) return current;
  const separator = current ? '\n' : '';
  return (current + separator + value).slice(0, maxChars);
}

function appendLast(current: string, value: string, maxChars: number): string {
  if (!value) return current;
  const separator = current ? '\n' : '';
  const combined = current + separator + value;
  return combined.length > maxChars ? combined.slice(-maxChars) : combined;
}

/**
 * Incrementally parses coding-agent JSONL output without retaining the full
 * stream in memory. The on-disk task log remains the full-fidelity archive.
 */
export class CodeAgentOutputCollector {
  private readonly decoder = new StringDecoder('utf8');
  private lineBuffer = '';
  private lineTruncated = false;
  private finished = false;
  private rawPrefix = '';
  private liveOutput = '';
  private claudeText = '';
  private codexText = '';
  private lastResult: Record<string, unknown> | null = null;
  private accumInputTokens = 0;
  private accumOutputTokens = 0;
  private hasTurnUsage = false;
  private sawCodexJsonEvent = false;

  push(chunk: string | Buffer): void {
    if (this.finished) return;
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.consume(text);
  }

  finish(): void {
    if (this.finished) return;
    const remaining = this.decoder.end();
    this.consume(remaining);
    if (this.lineBuffer || this.lineTruncated) this.commitLine();
    this.finished = true;
  }

  getLiveOutput(): string {
    return this.liveOutput;
  }

  getClaudeOutput(): ClaudeOutputResult {
    const costData: Pick<ClaudeOutputResult, 'totalCost' | 'inputTokens' | 'outputTokens'> = {};
    if (this.lastResult) {
      if (typeof this.lastResult.total_cost_usd === 'number') {
        costData.totalCost = this.lastResult.total_cost_usd;
      }
      if (typeof this.lastResult.total_input_tokens === 'number') {
        costData.inputTokens = this.lastResult.total_input_tokens;
      }
      if (typeof this.lastResult.total_output_tokens === 'number') {
        costData.outputTokens = this.lastResult.total_output_tokens;
      }
      if (costData.inputTokens == null || costData.outputTokens == null) {
        const usage = this.lastResult.usage as Record<string, unknown> | undefined;
        if (usage) {
          if (costData.inputTokens == null && typeof usage.input_tokens === 'number') {
            costData.inputTokens = usage.input_tokens;
          }
          if (costData.outputTokens == null && typeof usage.output_tokens === 'number') {
            costData.outputTokens = usage.output_tokens;
          }
        }
      }
    }
    if (this.hasTurnUsage) {
      if (costData.inputTokens == null) costData.inputTokens = this.accumInputTokens;
      if (costData.outputTokens == null) costData.outputTokens = this.accumOutputTokens;
    }

    if (this.claudeText.trim()) {
      return { text: this.claudeText.trim(), metadata: this.lastResult || undefined, ...costData };
    }
    if (this.lastResult) {
      const turns = this.lastResult.num_turns || '?';
      const cost = this.lastResult.total_cost_usd != null
        ? `$${(this.lastResult.total_cost_usd as number).toFixed(2)}`
        : '';
      const duration = this.lastResult.duration_ms
        ? `${Math.round((this.lastResult.duration_ms as number) / 1000)}s`
        : '';
      return {
        text: [`Completed in ${turns} turns`, duration, cost].filter(Boolean).join(', '),
        metadata: this.lastResult,
        ...costData,
      };
    }
    return { text: this.rawPrefix.slice(0, 500) || '(no output)', ...costData };
  }

  getCodexOutput(): string {
    return this.codexText || (this.sawCodexJsonEvent ? '(no text output)' : this.rawPrefix) || '(no output)';
  }

  private consume(text: string): void {
    if (!text) return;
    if (this.rawPrefix.length < MAX_OUTPUT_PREVIEW_CHARS) {
      this.rawPrefix = (this.rawPrefix + text).slice(0, MAX_OUTPUT_PREVIEW_CHARS);
    }

    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      const end = newline === -1 ? text.length : newline;
      this.appendLineSegment(text, start, end);
      if (newline === -1) return;
      this.commitLine();
      start = newline + 1;
    }
  }

  private appendLineSegment(text: string, start: number, end: number): void {
    if (this.lineTruncated || start === end) return;
    const available = MAX_STREAM_EVENT_CHARS - this.lineBuffer.length;
    const length = end - start;
    if (length <= available) {
      this.lineBuffer += text.slice(start, end);
      return;
    }
    if (available > 0) this.lineBuffer += text.slice(start, start + available);
    this.lineTruncated = true;
  }

  private commitLine(): void {
    const line = this.lineBuffer;
    const truncated = this.lineTruncated;
    this.lineBuffer = '';
    this.lineTruncated = false;

    if (truncated) {
      this.liveOutput = appendLast(this.liveOutput, OVERSIZED_EVENT_MESSAGE, MAX_OUTPUT_PREVIEW_CHARS);
      this.claudeText = appendFirst(this.claudeText, OVERSIZED_EVENT_MESSAGE, MAX_OUTPUT_PREVIEW_CHARS);
      this.codexText = appendFirst(this.codexText, OVERSIZED_EVENT_MESSAGE, MAX_OUTPUT_PREVIEW_CHARS);
      return;
    }
    if (!line.trim()) return;

    let event: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        event = parsed as Record<string, unknown>;
      }
    } catch {
      // Handled as plain output below.
    }

    if (!event) {
      if (!line.startsWith('{')) {
        this.liveOutput = appendLast(this.liveOutput, line.trim(), MAX_OUTPUT_PREVIEW_CHARS);
      }
      this.codexText = appendFirst(this.codexText, line, MAX_OUTPUT_PREVIEW_CHARS);
      return;
    }

    const liveParts = extractClaudeEventParts(event, { includeSystem: true, includeTools: true });
    for (const part of liveParts) {
      this.liveOutput = appendLast(this.liveOutput, part, MAX_OUTPUT_PREVIEW_CHARS);
    }

    const finalParts = extractClaudeEventParts(event, { includeSystem: false, includeTools: false });
    for (const part of finalParts) {
      this.claudeText = appendFirst(this.claudeText, part, MAX_OUTPUT_PREVIEW_CHARS);
    }

    if (event.type === 'result') this.lastResult = event;
    if (event.type === 'turn.completed') {
      const usage = event.usage as Record<string, unknown> | undefined;
      if (usage) {
        if (typeof usage.input_tokens === 'number') {
          this.accumInputTokens += usage.input_tokens;
          this.hasTurnUsage = true;
        }
        if (typeof usage.output_tokens === 'number') {
          this.accumOutputTokens += usage.output_tokens;
          this.hasTurnUsage = true;
        }
      }
    }

    if (typeof event.type === 'string') this.sawCodexJsonEvent = true;
    if (event.type === 'output_text' || event.output_text) {
      const output = event.output_text || event.text || '';
      if (output) this.codexText = appendFirst(this.codexText, String(output), MAX_OUTPUT_PREVIEW_CHARS);
    } else if (event.type === 'item.completed') {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === 'agent_message' && item.text) {
        this.codexText = appendFirst(this.codexText, String(item.text), MAX_OUTPUT_PREVIEW_CHARS);
      }
    }
  }
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
