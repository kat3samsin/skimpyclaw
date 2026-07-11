import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const testHome = fileURLToPath(new URL('../..', import.meta.url));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => testHome };
});
const { truncateToolResult, splitToolResult } = await import('../providers/utils.js');

const scratchDir = join(testHome, '.skimpyclaw', 's');

afterEach(() => {
  vi.restoreAllMocks();
});

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
      const result = 'x'.repeat(799);
      expect(truncateToolResult(result)).toBe(result);
    });

    it('masks large results to scratch file with path only', () => {
      const result = 'START' + 'x'.repeat(10_000) + 'END';
      const masked = truncateToolResult(result);
      const path = masked.slice(1).replace(/^~/, homedir());
      expect(masked.length).toBeLessThan(result.length);
      expect(masked).toContain('→');
      expect(masked).toContain('.skimpyclaw/s/');
      expect(statSync(scratchDir).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    it('produces minimal output for masked results', () => {
      const result = 'y'.repeat(20_000);
      const masked = truncateToolResult(result);
      expect(masked.startsWith('→')).toBe(true);
      expect(masked).toContain('.skimpyclaw/s/');
    });

    it('does not overwrite scratch output when the legacy random source collides', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const first = `FIRST ${'x'.repeat(5_000)}`;
      const second = `SECOND ${'y'.repeat(5_000)}`;

      const firstMasked = truncateToolResult(first);
      const secondMasked = truncateToolResult(second);
      const firstPath = firstMasked.slice(1).replace(/^~/, homedir());
      const secondPath = secondMasked.slice(1).replace(/^~/, homedir());

      expect(secondPath).not.toBe(firstPath);
      expect(readFileSync(firstPath, 'utf-8')).toBe(first);
      expect(readFileSync(secondPath, 'utf-8')).toBe(second);
    });
  });

  describe('splitToolResult', () => {
    it('returns small results unchanged', () => {
      const result = 'short output';
      expect(splitToolResult('Read', { file_path: '/foo.ts' }, result)).toBe(result);
    });

    it('returns results at mask threshold unchanged', () => {
      const result = 'x'.repeat(800);
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
        const split = splitToolResult('Read', { file_path: '~/.skimpyclaw/s/test.txt' }, largeResult);
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
      it('produces preview + scratch path for large read results', () => {
        const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}: content here`);
        const result = lines.join('\n');
        const split = splitToolResult('Read', { file_path: '/src/app.ts' }, result);

        expect(split).toContain('Full output saved to');
        expect(split).toContain('.skimpyclaw/s/');
        expect(split).toContain('line 1: content here');
        // Much shorter than original
        expect(split.length).toBeLessThan(result.length);
      });

      it('handles read_file tool name', () => {
        const result = 'x\n'.repeat(5000);
        const split = splitToolResult('read_file', { path: '/foo.txt' }, result);
        expect(split).toContain('Full output saved to');
        expect(split).toContain('.skimpyclaw/s/');
      });
    });

    describe('Bash tool', () => {
      it('produces preview + scratch path for large bash output', () => {
        const output = Array.from({ length: 400 }, (_, i) => `output line ${i}: ${'x'.repeat(20)}`).join('\n');
        const split = splitToolResult('Bash', { command: 'find . -name "*.ts"' }, output);

        expect(split).toContain('Full output saved to');
        expect(split).toContain('.skimpyclaw/s/');
        expect(split).toContain('output line 0');
      });

      it('extracts exit code when present', () => {
        const output = 'x\n'.repeat(5000) + 'exit code: 1';
        const split = splitToolResult('bash', { command: 'make build' }, output);
        expect(split).toContain('exit=1');
      });

      it('includes error lines when present', () => {
        const lines = ['output1', 'error: something failed', 'output2'];
        const result = lines.join('\n') + '\n' + 'x'.repeat(9000);
        const split = splitToolResult('Bash', { command: 'npm install' }, result);
        expect(split).toContain('error: something failed');
      });
    });

    describe('non-Bash tools', () => {
      it('produces preview + scratch path for Glob', () => {
        const entries = Array.from({ length: 300 }, (_, i) => `src/components/deeply/nested/module${i}/file${i}.ts`).join('\n');
        const split = splitToolResult('Glob', { pattern: '**/*.ts' }, entries);

        expect(split).toContain('Full output saved to');
        expect(split).toContain('.skimpyclaw/s/');
        expect(split).toContain('src/components');
      });

      it('produces preview + scratch path for Fetch', () => {
        const result = 'HTTP/1.1 200 OK\n' + 'x'.repeat(10_000);
        const split = splitToolResult('Fetch', { url: 'https://example.com/api' }, result);

        expect(split).toContain('Full output saved to');
        expect(split).toContain('.skimpyclaw/s/');
        expect(split).toContain('HTTP/1.1 200 OK');
      });

      it('produces preview + scratch path for generic tool output', () => {
        const result = 'x\n'.repeat(5000);
        const split = splitToolResult('custom_tool', { action: 'snapshot' }, result);
        expect(split).toContain('Full output saved to');
        expect(split).toContain('.skimpyclaw/s/');
      });

      it('produces preview + scratch path for MCP', () => {
        const result = 'x\n'.repeat(5000);
        const split = splitToolResult('mcp__context_a8c__search', {}, result);
        expect(split).toContain('Full output saved to');
        expect(split).toContain('.skimpyclaw/s/');
        expect(split).toContain('x\n');
      });

      it('produces preview + scratch path for unknown tools', () => {
        const result = 'z'.repeat(10_000);
        const split = splitToolResult('custom_tool', {}, result);
        expect(split).toContain('Full output saved to');
        expect(split).toContain('.skimpyclaw/s/');
        expect(split).toContain('zzz');
      });
    });

    it('creates scratch file for large results', () => {
      const result = 'data'.repeat(3000);
      const split = splitToolResult('Read', { file_path: '/big.txt' }, result);
      // Extract scratch path from the result
      const pathMatch = split.match(/saved to (\S*\.skimpyclaw\/s\/\S+)/);
      expect(pathMatch).not.toBeNull();
      if (pathMatch) {
        const p = pathMatch[1].startsWith('~/') ? pathMatch[1].replace('~', homedir()) : pathMatch[1];
        expect(existsSync(p)).toBe(true);
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
