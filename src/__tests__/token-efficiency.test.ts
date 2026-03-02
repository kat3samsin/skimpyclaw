import { describe, it, expect, afterAll } from 'vitest';
import { truncateToolResult } from '../providers/utils.js';
import { existsSync, readdirSync, unlinkSync, rmdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const scratchDir = join(homedir(), '.skimpyclaw', 'scratch');

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
