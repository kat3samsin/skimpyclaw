import { describe, it, expect } from 'vitest';
import { truncateToolResult } from '../providers/utils.js';

describe('token efficiency', () => {
  describe('truncateToolResult', () => {
    it('returns short results unchanged', () => {
      const result = 'short result';
      expect(truncateToolResult(result)).toBe(result);
    });

    it('truncates at exact boundary', () => {
      const result = 'x'.repeat(10_240);
      expect(truncateToolResult(result)).toBe(result); // exactly at limit
    });

    it('truncates over limit with notice', () => {
      const result = 'x'.repeat(20_000);
      const truncated = truncateToolResult(result);
      expect(truncated.length).toBeLessThan(result.length);
      expect(truncated).toContain('[Truncated: 20000 chars total]');
      expect(truncated.startsWith('x'.repeat(10_240))).toBe(true);
    });

    it('respects custom maxBytes', () => {
      const result = 'abcdefghij'; // 10 chars
      const truncated = truncateToolResult(result, 5);
      expect(truncated).toContain('[Truncated: 10 chars total]');
      expect(truncated.startsWith('abcde')).toBe(true);
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
