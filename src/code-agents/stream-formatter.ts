// Stream formatter for interactive coding sessions.
// Converts raw CLI stdout into Discord-postable message chunks.

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
