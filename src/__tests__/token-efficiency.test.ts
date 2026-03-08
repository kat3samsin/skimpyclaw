import { describe, it, expect, afterAll, vi } from 'vitest';
import { existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const testHome = fileURLToPath(new URL('../..', import.meta.url));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => testHome };
});
const { truncateToolResult, splitToolResult } = await import('../providers/utils.js');

const scratchDir = join(testHome, '.skimpyclaw', 'scratch');

// Clean up scratch files created during tests
afterAll(() => {
  try {
    if (existsSync(scratchDir)) {
      for (const f of readdirSync(scratchDir)) {
        try { unlinkSync(join(scratchDir, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
});

describe('token efficiency', () => {
  describe('truncateToolResult', () => {
    it('returns short results unchanged', () => {
      const result = 'short result';
      expect(truncateToolResult(result)).toBe(result);
    });

    it('returns results under mask threshold unchanged', () => {
      const result = 'x'.repeat(7_999);
      expect(truncateToolResult(result)).toBe(result);
    });

    it('masks large results to scratch file with summary', () => {
      const result = 'START' + 'x'.repeat(10_000) + 'END';
      const masked = truncateToolResult(result);
      expect(masked.length).toBeLessThan(result.length);
      expect(masked).toContain('[Full output');
      expect(masked).toContain('saved to');
      expect(masked).toContain('.skimpyclaw/scratch/');
      expect(masked).toContain('use Read tool to access');
      // Summary includes head and tail
      expect(masked).toContain('START');
      expect(masked).toContain('END');
    });

    it('includes char count in masked output', () => {
      const result = 'y'.repeat(20_000);
      const masked = truncateToolResult(result);
      expect(masked).toContain('20000 chars');
    });
  });

  describe('splitToolResult', () => {
    it('returns small results unchanged', () => {
      const result = 'short output';
      expect(splitToolResult('Read', { file_path: '/foo.ts' }, result)).toBe(result);
    });

    it('returns results at mask threshold unchanged', () => {
      const result = 'x'.repeat(8_000);
      expect(splitToolResult('Bash', { command: 'echo hi' }, result)).toBe(result);
    });

    describe('scratch file reads', () => {
      it('does not split reads from scratch directory', () => {
        const largeResult = 'x'.repeat(20_000);
        const scratchPath = join(testHome, '.skimpyclaw', 'scratch', '12345-abc.txt');
        const split = splitToolResult('Read', { file_path: scratchPath }, largeResult);
        expect(split).toBe(largeResult);
      });

      it('does not split reads from tilde scratch path', () => {
        const largeResult = 'y'.repeat(20_000);
        const split = splitToolResult('Read', { file_path: '~/.skimpyclaw/scratch/test.txt' }, largeResult);
        expect(split).toBe(largeResult);
      });

      it('does not split read_file from scratch directory', () => {
        const largeResult = 'z'.repeat(20_000);
        const scratchPath = join(testHome, '.skimpyclaw', 'scratch', 'foo.txt');
        const split = splitToolResult('read_file', { path: scratchPath }, largeResult);
        expect(split).toBe(largeResult);
      });
    });

    describe('Read tool', () => {
      it('produces file path, line count, and preview summary', () => {
        const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}: content here`);
        const result = lines.join('\n');
        const split = splitToolResult('Read', { file_path: '/src/app.ts' }, result);

        expect(split).toContain('File: /src/app.ts');
        expect(split).toContain('500 lines');
        expect(split).toContain(`${result.length} bytes`);
        // Preview: first 3 and last 3 lines
        expect(split).toContain('line 1:');
        expect(split).toContain('line 2:');
        expect(split).toContain('line 3:');
        expect(split).toContain('line 500:');
        expect(split).toContain('.skimpyclaw/scratch/');
        expect(split).toContain('use Read tool to access');
        // Much shorter than original
        expect(split.length).toBeLessThan(result.length);
      });

      it('handles read_file tool name', () => {
        const result = 'x\n'.repeat(5000);
        const split = splitToolResult('read_file', { path: '/foo.txt' }, result);
        expect(split).toContain('File: /foo.txt');
      });
    });

    describe('Bash tool', () => {
      it('extracts command and line count', () => {
        const output = Array.from({ length: 400 }, (_, i) => `output line ${i}: ${'x'.repeat(20)}`).join('\n');
        const split = splitToolResult('Bash', { command: 'find . -name "*.ts"' }, output);

        expect(split).toContain('Command: find . -name "*.ts"');
        expect(split).toContain('400 lines output');
        expect(split).toContain('.skimpyclaw/scratch/');
      });

      it('extracts exit code when present', () => {
        const output = 'x\n'.repeat(5000) + 'exit code: 1';
        const split = splitToolResult('bash', { command: 'make build' }, output);
        expect(split).toContain('Exit: 1');
      });

      it('includes stderr lines when present', () => {
        const lines = ['output1', 'error: something failed', 'output2', 'warning: deprecated API'];
        const result = lines.join('\n') + '\n' + 'x'.repeat(9000);
        const split = splitToolResult('Bash', { command: 'npm install' }, result);
        expect(split).toContain('Stderr');
        expect(split).toContain('error: something failed');
        expect(split).toContain('warning: deprecated API');
      });
    });

    describe('Glob tool', () => {
      it('produces entry count summary', () => {
        const entries = Array.from({ length: 300 }, (_, i) => `src/components/deeply/nested/module${i}/file${i}.ts`).join('\n');
        const split = splitToolResult('Glob', { pattern: '**/*.ts' }, entries);

        expect(split).toContain('Directory:');
        expect(split).toContain('300 entries');
        expect(split).toContain('.skimpyclaw/scratch/');
      });
    });

    describe('Fetch tool', () => {
      it('includes URL and content length', () => {
        const result = 'HTTP/1.1 200 OK\n' + 'x'.repeat(10_000);
        const split = splitToolResult('Fetch', { url: 'https://example.com/api' }, result);

        expect(split).toContain('Fetched: https://example.com/api');
        expect(split).toContain('200');
        expect(split).toContain(`${result.length} chars`);
      });
    });

    describe('Browser tools', () => {
      it('produces browser action summary', () => {
        const result = 'x\n'.repeat(5000);
        const split = splitToolResult('browser_snapshot', { action: 'snapshot' }, result);
        expect(split).toContain('Browser action:');
        expect(split).toContain('.skimpyclaw/scratch/');
      });
    });

    describe('MCP tools', () => {
      it('produces MCP summary', () => {
        const result = 'x\n'.repeat(5000);
        const split = splitToolResult('mcp__context_a8c__search', {}, result);
        expect(split).toContain('MCP mcp__context_a8c__search');
        expect(split).toContain('lines output');
      });
    });

    describe('default fallback', () => {
      it('produces char count summary for unknown tools', () => {
        const result = 'z'.repeat(10_000);
        const split = splitToolResult('custom_tool', {}, result);
        expect(split).toContain('custom_tool:');
        expect(split).toContain('10000 chars output');
        expect(split).toContain('.skimpyclaw/scratch/');
      });
    });

    it('creates scratch file for large results', () => {
      const result = 'data'.repeat(3000);
      const split = splitToolResult('Read', { file_path: '/big.txt' }, result);
      // Extract scratch path from the result
      const pathMatch = split.match(/saved to (.+\.txt)/);
      expect(pathMatch).not.toBeNull();
      if (pathMatch) {
        expect(existsSync(pathMatch[1])).toBe(true);
      }
    });
  });

  describe('retry prompt compression', () => {
    it('compresses long prompts', () => {
      const longPrompt = 'x'.repeat(1000);
      const taskSummary = longPrompt.length > 500 ? longPrompt.slice(0, 500) + '...' : longPrompt;
      const retryPrompt = `Retry task (attempt 1).\n\nTask: ${taskSummary}\n\nPrevious error: some error\n\nTry a different approach.`;

      // Should be significantly shorter than original prompt + error
      expect(retryPrompt.length).toBeLessThan(longPrompt.length);
      expect(retryPrompt).toContain('attempt 1');
      expect(retryPrompt).toContain('some error');
    });
  });
});
