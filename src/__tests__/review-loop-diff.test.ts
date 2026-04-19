import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import {
  getHeadSha,
  getChangedFiles,
  getReviewDiff,
} from '../code-agents/review-loop-diff.js';

const execMock = execSync as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  execMock.mockReset();
});

describe('review-loop-diff', () => {
  it('getHeadSha returns trimmed sha', () => {
    execMock.mockReturnValueOnce(Buffer.from('abc1234\n'));
    expect(getHeadSha('/x')).toBe('abc1234');
    expect(execMock).toHaveBeenCalledWith('git rev-parse HEAD', { cwd: '/x', encoding: 'buffer' });
  });

  it('getChangedFiles returns array split on newline', () => {
    execMock.mockReturnValueOnce(Buffer.from('a.ts\nb.ts\n'));
    expect(getChangedFiles('/x', 'abc', 'def')).toEqual(['a.ts', 'b.ts']);
    expect(execMock).toHaveBeenCalledWith('git diff --name-only abc..def', { cwd: '/x', encoding: 'buffer' });
  });

  it('getChangedFiles handles empty output', () => {
    execMock.mockReturnValueOnce(Buffer.from(''));
    expect(getChangedFiles('/x', 'abc', 'def')).toEqual([]);
  });

  it('getReviewDiff returns git diff content between refs', () => {
    execMock.mockReturnValueOnce(Buffer.from('--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n'));
    const diff = getReviewDiff('/x', 'abc', 'def');
    expect(diff).toContain('+y');
    expect(execMock).toHaveBeenCalledWith('git diff abc..def', { cwd: '/x', encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 });
  });

  it('getReviewDiff returns null on git failure', () => {
    execMock.mockImplementationOnce(() => { throw new Error('not a git repo'); });
    expect(getReviewDiff('/x', 'abc', 'def')).toBeNull();
  });
});
