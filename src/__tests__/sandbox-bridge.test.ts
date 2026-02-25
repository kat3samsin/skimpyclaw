import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecInContainer } = vi.hoisted(() => ({
  mockExecInContainer: vi.fn(),
}));
vi.mock('../sandbox/runtime.js', () => ({
  execInContainer: mockExecInContainer,
}));

import {
  sandboxBash,
  sandboxReadFile,
  sandboxWriteFile,
  sandboxListDir,
  sandboxGlob,
} from '../sandbox/bridge.js';

describe('sandbox/bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sandboxBash', () => {
    it('passes command through', async () => {
      mockExecInContainer.mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });
      const result = await sandboxBash('ctr', 'echo hi');
      expect(result).toBe('ok');
      expect(mockExecInContainer).toHaveBeenCalledWith('ctr', ['echo hi'], expect.any(Object));
    });

    it('handles cwd', async () => {
      mockExecInContainer.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
      await sandboxBash('ctr', 'ls', '/workspace');
      const args = mockExecInContainer.mock.calls[0][1][0];
      expect(args).toContain('cd');
      expect(args).toContain('/workspace');
    });

    it('handles timeout', async () => {
      mockExecInContainer.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
      await sandboxBash('ctr', 'sleep 1', undefined, 5000);
      const opts = mockExecInContainer.mock.calls[0][2];
      expect(opts.timeout).toBe(5000);
    });

    it('truncates long output', async () => {
      const longOutput = 'x'.repeat(60 * 1024);
      mockExecInContainer.mockResolvedValue({ stdout: longOutput, stderr: '', exitCode: 0 });
      const result = await sandboxBash('ctr', 'cmd');
      expect(result.length).toBeLessThan(longOutput.length);
      expect(result).toContain('truncated');
    });

    it('includes exit code on failure', async () => {
      mockExecInContainer.mockResolvedValue({ stdout: 'out', stderr: 'err', exitCode: 42 });
      const result = await sandboxBash('ctr', 'bad');
      expect(result).toContain('[exit code: 42]');
    });

    it('returns (no output) when empty', async () => {
      mockExecInContainer.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
      const result = await sandboxBash('ctr', 'true');
      expect(result).toBe('(no output)');
    });
  });

  describe('sandboxReadFile', () => {
    it('calls cat with path', async () => {
      mockExecInContainer.mockResolvedValue({ stdout: 'content', stderr: '', exitCode: 0 });
      const result = await sandboxReadFile('ctr', '/workspace/file.txt');
      expect(result).toBe('content');
      expect(mockExecInContainer.mock.calls[0][1][0]).toContain('cat');
    });

    it('truncates large files', async () => {
      const big = 'y'.repeat(120 * 1024);
      mockExecInContainer.mockResolvedValue({ stdout: big, stderr: '', exitCode: 0 });
      const result = await sandboxReadFile('ctr', '/f');
      expect(result.length).toBeLessThan(big.length);
      expect(result).toContain('truncated');
    });

    it('throws on failure', async () => {
      mockExecInContainer.mockResolvedValue({ stdout: '', stderr: 'not found', exitCode: 1 });
      await expect(sandboxReadFile('ctr', '/missing')).rejects.toThrow('Failed to read');
    });
  });

  describe('sandboxWriteFile', () => {
    it('sends content via stdin', async () => {
      mockExecInContainer.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
      const result = await sandboxWriteFile('ctr', '/workspace/f.txt', 'hello');
      expect(result).toContain('Written');
      expect(result).toContain('5 bytes');
      const opts = mockExecInContainer.mock.calls[0][2];
      expect(opts.stdin).toBe('hello');
    });

    it('creates parent dirs', async () => {
      mockExecInContainer.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
      await sandboxWriteFile('ctr', '/workspace/a/b/c.txt', 'data');
      expect(mockExecInContainer.mock.calls[0][1][0]).toContain('mkdir -p');
    });

    it('throws on failure', async () => {
      mockExecInContainer.mockResolvedValue({ stdout: '', stderr: 'perm denied', exitCode: 1 });
      await expect(sandboxWriteFile('ctr', '/f', 'x')).rejects.toThrow('Failed to write');
    });
  });

  describe('sandboxListDir', () => {
    it('calls ls -la', async () => {
      mockExecInContainer.mockResolvedValue({ stdout: 'drwxr-xr-x ...', stderr: '', exitCode: 0 });
      const result = await sandboxListDir('ctr', '/workspace');
      expect(result).toBe('drwxr-xr-x ...');
      expect(mockExecInContainer.mock.calls[0][1][0]).toContain('ls -la');
    });

    it('throws on failure', async () => {
      mockExecInContainer.mockResolvedValue({ stdout: '', stderr: 'no such dir', exitCode: 1 });
      await expect(sandboxListDir('ctr', '/bad')).rejects.toThrow('Failed to list');
    });
  });

  describe('sandboxGlob', () => {
    it('calls find with correct args', async () => {
      mockExecInContainer.mockResolvedValue({ stdout: '/workspace/a.ts\n', stderr: '', exitCode: 0 });
      const result = await sandboxGlob('ctr', '/workspace', '*.ts');
      expect(result).toContain('/workspace/a.ts');
      const cmd = mockExecInContainer.mock.calls[0][1][0];
      expect(cmd).toContain('find');
      expect(cmd).toContain('-name');
      expect(cmd).toContain('-maxdepth');
    });

    it('throws on failure', async () => {
      mockExecInContainer.mockResolvedValue({ stdout: '', stderr: 'err', exitCode: 1 });
      await expect(sandboxGlob('ctr', '/x', '*.js')).rejects.toThrow('Failed to glob');
    });
  });
});
