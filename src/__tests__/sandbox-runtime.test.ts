import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSpawn, mockSpawnSync } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockSpawnSync: vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' }),
}));
vi.mock('child_process', () => ({ spawn: mockSpawn, spawnSync: mockSpawnSync }));

import {
  createContainer,
  execInContainer,
  removeContainer,
  isContainerRunning,
  cleanupOrphans,
  setRuntime,
  resetRuntime,
} from '../sandbox/runtime.js';

function fakeChild(
  exitCode: number,
  stdout = '',
  stderr = '',
  opts?: { stdinNeeded?: boolean },
) {
  const stdoutCallbacks: Array<(chunk: Buffer) => void> = [];
  const stderrCallbacks: Array<(chunk: Buffer) => void> = [];
  const eventCallbacks: Record<string, Array<(...args: unknown[]) => void>> = {};

  const child = {
    stdout: { on: (_e: string, cb: (chunk: Buffer) => void) => stdoutCallbacks.push(cb) },
    stderr: { on: (_e: string, cb: (chunk: Buffer) => void) => stderrCallbacks.push(cb) },
    stdin: opts?.stdinNeeded ? { write: vi.fn(), end: vi.fn() } : null,
    on(event: string, cb: (...args: unknown[]) => void) {
      if (!eventCallbacks[event]) eventCallbacks[event] = [];
      eventCallbacks[event].push(cb);
      return child;
    },
  };

  // Emit data and close on next tick (setTimeout ensures listeners are attached first)
  setTimeout(() => {
    if (stdout) for (const cb of stdoutCallbacks) cb(Buffer.from(stdout));
    if (stderr) for (const cb of stderrCallbacks) cb(Buffer.from(stderr));
    for (const cb of eventCallbacks['close'] ?? []) cb(exitCode);
  }, 0);

  return child;
}

describe('sandbox/runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntime();
    setRuntime('container'); // skip auto-detection in tests
  });

  describe('createContainer', () => {
    it('builds correct docker args', async () => {
      mockSpawn.mockReturnValue(fakeChild(0));
      await createContainer('test-ctr', {
        image: 'myimg',
        cpus: 2,
        memory: '1G',
        network: 'none',
        user: '501:20',
        mounts: [{ host: '/a', container: '/b', readOnly: true }],
      });
      const args = mockSpawn.mock.calls[0][1];
      expect(args).toContain('--name');
      expect(args).toContain('test-ctr');
      expect(args).toContain('--cpus');
      expect(args).toContain('2');
      expect(args).toContain('--memory');
      expect(args).toContain('1G');
      expect(args).toContain('--network');
      expect(args).toContain('none');
      expect(args).toContain('--user');
      expect(args).toContain('501:20');
      expect(args.some((a: string) => a.includes('type=bind,src=/a,dst=/b,ro'))).toBe(true);
      expect(args).toContain('myimg');
    });

    it('throws on non-zero exit', async () => {
      mockSpawn.mockReturnValue(fakeChild(1, '', 'boom'));
      await expect(createContainer('c1', { image: 'img' })).rejects.toThrow('Failed to create container');
    });
  });

  describe('execInContainer', () => {
    it('builds sh -c command', async () => {
      mockSpawn.mockReturnValue(fakeChild(0, 'hello'));
      const result = await execInContainer('ctr', ['echo hello']);
      expect(result.stdout).toBe('hello');
      const args = mockSpawn.mock.calls[0][1];
      expect(args).toContain('sh');
      expect(args).toContain('-c');
    });

    it('handles stdin', async () => {
      mockSpawn.mockReturnValue(fakeChild(0, '', '', { stdinNeeded: true }));
      await execInContainer('ctr', ['cat'], { stdin: 'data' });
      const args = mockSpawn.mock.calls[0][1];
      expect(args).toContain('-i');
    });

    it('handles env vars', async () => {
      mockSpawn.mockReturnValue(fakeChild(0));
      await execInContainer('ctr', ['cmd'], { env: { FOO: 'bar' } });
      const args = mockSpawn.mock.calls[0][1];
      expect(args).toContain('-e');
      expect(args).toContain('FOO=bar');
    });
  });

  describe('removeContainer', () => {
    it('calls stop then rm', async () => {
      mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
        return fakeChild(0);
      });
      await removeContainer('ctr');
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(mockSpawn.mock.calls[0][1]).toContain('stop');
      expect(mockSpawn.mock.calls[1][1]).toContain('rm');
    }, 10_000);

    it('does not throw on failure', async () => {
      mockSpawn.mockImplementation(() => fakeChild(1, '', 'fail'));
      await expect(removeContainer('ctr')).resolves.toBeUndefined();
    }, 10_000);
  });

  describe('isContainerRunning', () => {
    it('returns true on exit 0', async () => {
      mockSpawn.mockReturnValue(fakeChild(0));
      expect(await isContainerRunning('ctr')).toBe(true);
    });

    it('returns false otherwise', async () => {
      mockSpawn.mockReturnValue(fakeChild(1));
      expect(await isContainerRunning('ctr')).toBe(false);
    });
  });

  describe('cleanupOrphans', () => {
    it('lists containers, filters by prefix, removes matches', async () => {
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // ps call
          return fakeChild(0, 'skimpyclaw-sbx-abc\nother-ctr\nskimpyclaw-sbx-def\n');
        }
        // stop/rm calls
        return fakeChild(0);
      });
      const count = await cleanupOrphans();
      expect(count).toBe(2);
    });

    it('returns 0 on ps failure', async () => {
      mockSpawn.mockImplementation(() => fakeChild(1));
      expect(await cleanupOrphans()).toBe(0);
    });
  });
});
