// Structured context extraction for team agent inter-communication.
// Replaces raw string truncation with a token-efficient structured summary
// that preserves the most useful signal: what files changed and what went wrong.

export interface StructuredAgentOutput {
  summary: string;       // First 500 chars of the agent's output
  files: string[];       // File paths mentioned in the output
  errors: string[];      // Error lines (up to 5)
}

// Matches backtick-quoted paths like `src/foo.ts`
const BACKTICK_PATH_RE = /`([^`\n]{3,200})`/g;
// Matches absolute paths like /Users/katre/Sites/skimpyclaw/src/foo.ts
const ABS_PATH_RE = /(?:^|\s)(\/[^\s,;'"()\n]{3,300})/gm;
// Matches error-like lines
const ERROR_LINE_RE = /^.{0,20}(?:error|failed|failure|exception)[^\n]{0,200}$/gim;

export function parseAgentOutput(raw: string): StructuredAgentOutput {
  const files = new Set<string>();

  // Extract backtick-quoted paths (e.g. `src/agent.ts`, `/abs/path.ts`)
  BACKTICK_PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BACKTICK_PATH_RE.exec(raw)) !== null) {
    const p = m[1].trim();
    // Must look like a file path: contains a dot and no spaces
    if (p.includes('.') && !p.includes(' ')) {
      files.add(p.replace(/[.,;]$/, ''));
    }
  }

  // Extract absolute paths
  ABS_PATH_RE.lastIndex = 0;
  while ((m = ABS_PATH_RE.exec(raw)) !== null) {
    const p = m[1].trim().replace(/[.,;]$/, '');
    if (p.includes('.')) {
      files.add(p);
    }
  }

  // Extract error lines
  const errors: string[] = [];
  ERROR_LINE_RE.lastIndex = 0;
  while ((m = ERROR_LINE_RE.exec(raw)) !== null) {
    const err = m[0].trim().slice(0, 200);
    if (errors.length < 5 && !errors.includes(err)) {
      errors.push(err);
    }
  }

  return {
    summary: raw.slice(0, 500),
    files: [...files].slice(0, 15),
    errors,
  };
}

export function formatStructuredContext(parsed: StructuredAgentOutput): string {
  const parts: string[] = [`Summary: ${parsed.summary}`];
  if (parsed.files.length > 0) {
    parts.push(`Files: ${parsed.files.join(', ')}`);
  }
  if (parsed.errors.length > 0) {
    parts.push(`Errors: ${parsed.errors.join(' | ')}`);
  }
  return parts.join('\n');
}
