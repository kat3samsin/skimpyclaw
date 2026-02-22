// Code Agent Output Parser

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
      const event = JSON.parse(line);

      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text) {
            parts.push(block.text);
          } else if (block.type === 'tool_use') {
            const name = block.name || 'tool';
            const inputPreview = block.input
              ? JSON.stringify(block.input).slice(0, 120)
              : '';
            parts.push(`[${name}] ${inputPreview}`);
          }
        }
      } else if (event.type === 'result') {
        if (event.result) parts.push(event.result);
      } else if (event.type === 'system' && event.message) {
        parts.push(`[system] ${typeof event.message === 'string' ? event.message : JSON.stringify(event.message).slice(0, 200)}`);
      }
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
      const event = JSON.parse(line);
      // Capture assistant text messages
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text) {
            resultText += block.text + '\n';
          }
        }
      }
      // The final "result" event has metadata
      if (event.type === 'result') {
        lastResult = event;
        if (event.result) resultText += event.result;
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
