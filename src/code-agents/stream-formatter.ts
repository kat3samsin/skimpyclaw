// Stream formatter for interactive coding sessions.
//
// Converts raw CLI stdout into Discord-postable message chunks.
// - Claude: plain text; strip ANSI; paragraph-aware chunking at <=1900 chars
// - Codex: JSONL stream; emit agent_message text as messages; condense tool calls

const MAX_CHUNK = 1900; // Discord hard limit is 2000; 100 char safety margin

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

// Paragraph-aware chunking: splits on blank-line runs, packs up to max, and
// hard-splits any paragraph that alone exceeds the limit.
export function chunkForDiscord(raw: string, max = MAX_CHUNK): string[] {
  const text = stripAnsi(raw).replace(/\r\n/g, '\n').trimEnd();
  if (!text) return [];
  if (text.length <= max) return [text];

  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';

  for (const p of paragraphs) {
    if (p.length > max) {
      // Paragraph too big by itself — flush current, then hard-split this paragraph.
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < p.length; i += max) {
        chunks.push(p.slice(i, i + max));
      }
      continue;
    }
    const candidate = current ? current + '\n\n' + p : p;
    if (candidate.length > max) {
      chunks.push(current);
      current = p;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Parse Codex --json stdout and emit a sequence of Discord-ready messages.
// Returns the thread_id (session id) captured from `thread.started` if present.
export interface CodexParseResult {
  threadId?: string;
  messages: string[];
}

export function parseCodexJsonl(stdout: string): CodexParseResult {
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
  const messages: string[] = [];
  let threadId: string | undefined;

  for (const line of lines) {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }

    if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') {
      threadId = ev.thread_id;
      continue;
    }

    if (ev.type === 'item.completed' && ev.item) {
      const item = ev.item;
      if (item.type === 'agent_message' && typeof item.text === 'string' && item.text) {
        messages.push(item.text);
        continue;
      }
      if (item.type === 'command_execution') {
        const cmd = typeof item.command === 'string' ? item.command : 'command';
        const status = item.status === 'completed' ? '✓' : item.status === 'failed' ? '✗' : '…';
        const trimmed = cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd;
        messages.push(`\`[${status} ${trimmed}]\``);
        continue;
      }
      if (item.type === 'file_change' && Array.isArray(item.changes)) {
        const paths = item.changes.map((c: any) => c?.path).filter(Boolean).join(', ');
        messages.push(`\`[edit ✓ ${paths}]\``);
        continue;
      }
    }

    // Ignore turn.started, turn.completed, and other low-signal events
  }

  return { threadId, messages };
}

export function formatCodexOutput(messages: string[]): string[] {
  const chunks: string[] = [];
  for (const m of messages) {
    chunks.push(...chunkForDiscord(m));
  }
  return chunks;
}
