import { describe, it, expect } from 'vitest';
import { parseAgentOutput, formatStructuredContext } from '../code-agents/structured-context.js';

describe('parseAgentOutput', () => {
  it('returns empty files and errors for plain text', () => {
    const result = parseAgentOutput('Everything looks good.');
    expect(result.summary).toBe('Everything looks good.');
    expect(result.files).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('extracts backtick-quoted file paths', () => {
    const raw = 'Updated `src/agent.ts` and `src/types.ts` to add the new field.';
    const result = parseAgentOutput(raw);
    expect(result.files).toContain('src/agent.ts');
    expect(result.files).toContain('src/types.ts');
  });

  it('extracts absolute file paths', () => {
    const raw = 'Wrote changes to /Users/katre/Sites/skimpyclaw/src/agent.ts successfully.';
    const result = parseAgentOutput(raw);
    expect(result.files).toContain('/Users/katre/Sites/skimpyclaw/src/agent.ts');
  });

  it('ignores backtick tokens without dots (not file paths)', () => {
    const raw = 'Call `myFunction` and `anotherMethod` to do the work.';
    const result = parseAgentOutput(raw);
    expect(result.files).toEqual([]);
  });

  it('ignores backtick tokens with spaces (commands, not paths)', () => {
    const raw = 'Run `pnpm build && pnpm test` to verify.';
    const result = parseAgentOutput(raw);
    expect(result.files).toEqual([]);
  });

  it('extracts error lines', () => {
    const raw = 'Build completed.\nError: Cannot find module src/missing.js\nAll tests passed.';
    const result = parseAgentOutput(raw);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Cannot find module');
  });

  it('caps errors at 5', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Error: problem ${i}`).join('\n');
    const result = parseAgentOutput(lines);
    expect(result.errors.length).toBeLessThanOrEqual(5);
  });

  it('caps files at 15', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Updated \`src/file${i}.ts\`.`).join('\n');
    const result = parseAgentOutput(lines);
    expect(result.files.length).toBeLessThanOrEqual(15);
  });

  it('deduplicates file paths', () => {
    const raw = 'Updated `src/agent.ts`. Also modified `src/agent.ts` again.';
    const result = parseAgentOutput(raw);
    const count = result.files.filter(f => f === 'src/agent.ts').length;
    expect(count).toBe(1);
  });

  it('truncates summary to 500 chars', () => {
    const raw = 'x'.repeat(1000);
    const result = parseAgentOutput(raw);
    expect(result.summary).toHaveLength(500);
  });

  it('strips trailing punctuation from absolute paths', () => {
    const raw = 'Modified /src/foo.ts, and /src/bar.ts.';
    const result = parseAgentOutput(raw);
    expect(result.files).not.toContain('/src/foo.ts,');
    expect(result.files).not.toContain('/src/bar.ts.');
  });
});

describe('formatStructuredContext', () => {
  it('formats summary only when no files or errors', () => {
    const result = formatStructuredContext({ summary: 'Done.', files: [], errors: [] });
    expect(result).toBe('Summary: Done.');
  });

  it('includes files line when files present', () => {
    const result = formatStructuredContext({
      summary: 'Updated auth.',
      files: ['src/auth.ts', 'src/types.ts'],
      errors: [],
    });
    expect(result).toContain('Files: src/auth.ts, src/types.ts');
  });

  it('includes errors line when errors present', () => {
    const result = formatStructuredContext({
      summary: 'Build failed.',
      files: [],
      errors: ['Error: missing export'],
    });
    expect(result).toContain('Errors: Error: missing export');
  });

  it('separates multiple errors with pipe', () => {
    const result = formatStructuredContext({
      summary: 'Done.',
      files: [],
      errors: ['Error: foo', 'Error: bar'],
    });
    expect(result).toContain('Error: foo | Error: bar');
  });

  it('produces a shorter output than raw 1000-char input', () => {
    const raw = 'x'.repeat(1000);
    const parsed = parseAgentOutput(raw);
    const formatted = formatStructuredContext(parsed);
    expect(formatted.length).toBeLessThan(raw.length);
  });
});
