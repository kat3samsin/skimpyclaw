import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockCreateContainer,
  mockRemoveContainer,
  mockIsContainerRunning,
  mockValidateMountPaths,
} = vi.hoisted(() => ({
  mockCreateContainer: vi.fn(),
  mockRemoveContainer: vi.fn(),
  mockIsContainerRunning: vi.fn(),
  mockValidateMountPaths: vi.fn(),
}));

vi.mock('../sandbox/runtime.js', () => ({
  createContainer: mockCreateContainer,
  removeContainer: mockRemoveContainer,
  isContainerRunning: mockIsContainerRunning,
}));

vi.mock('../sandbox/mount-security.js', () => ({
  validateMountPaths: mockValidateMountPaths,
}));

import {
  ensureContainer,
  releaseContainer,
  pruneIdle,
  releaseAll,
  resetForTesting,
  SANDBOX_DEFAULTS,
} from '../sandbox/manager.js';
import type { SandboxConfig } from '../types.js';

const testConfig: SandboxConfig = { ...SANDBOX_DEFAULTS, enabled: true };

describe('sandbox/manager', () => {
  beforeEach(() => {
    resetForTesting();
    vi.clearAllMocks();
    mockValidateMountPaths.mockReturnValue([
      { host: '/home/user/project', container: '/workspace/project', readOnly: false },
    ]);
    mockCreateContainer.mockResolvedValue(undefined);
    mockRemoveContainer.mockResolvedValue(undefined);
  });

  describe('ensureContainer', () => {
    it('creates container on first call', async () => {
      const name = await ensureContainer('sess1', testConfig, ['/home/user/project']);
      expect(name).toBe('skimpyclaw-sbx-sess1');
      expect(mockCreateContainer).toHaveBeenCalledTimes(1);
    });

    it('reuses on second call if running', async () => {
      mockIsContainerRunning
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      await ensureContainer('sess1', testConfig, ['/p']);
      const name = await ensureContainer('sess1', testConfig, ['/p']);
      expect(name).toBe('skimpyclaw-sbx-sess1');
      expect(mockCreateContainer).toHaveBeenCalledTimes(1); // only first call
    });

    it('recreates if container died', async () => {
      mockIsContainerRunning.mockResolvedValue(false);
      await ensureContainer('sess1', testConfig, ['/p']);
      // Second call — container exists in map but isContainerRunning returns false
      await ensureContainer('sess1', testConfig, ['/p']);
      expect(mockCreateContainer).toHaveBeenCalledTimes(2);
    });

    it('adopts existing running container after process restart', async () => {
      mockIsContainerRunning.mockResolvedValue(true);
      const name = await ensureContainer('default', testConfig, ['/p']);
      expect(name).toBe('skimpyclaw-sbx-default');
      expect(mockCreateContainer).not.toHaveBeenCalled();
      expect(mockRemoveContainer).not.toHaveBeenCalled();
    });

    it('removes stale named container before creating', async () => {
      mockIsContainerRunning.mockResolvedValue(false);
      const name = await ensureContainer('default', testConfig, ['/p']);
      expect(name).toBe('skimpyclaw-sbx-default');
      expect(mockRemoveContainer).toHaveBeenCalledWith('skimpyclaw-sbx-default');
      expect(mockCreateContainer).toHaveBeenCalledTimes(1);
    });
  });

  describe('releaseContainer', () => {
    it('removes container and clears from map', async () => {
      await ensureContainer('sess1', testConfig, ['/p']);
      await releaseContainer('sess1');
      expect(mockRemoveContainer).toHaveBeenCalledWith('skimpyclaw-sbx-sess1');

      // Next ensureContainer should create fresh
      await ensureContainer('sess1', testConfig, ['/p']);
      expect(mockCreateContainer).toHaveBeenCalledTimes(2);
    });

    it('no-ops for unknown session', async () => {
      await expect(releaseContainer('unknown')).resolves.toBeUndefined();
      expect(mockRemoveContainer).not.toHaveBeenCalled();
    });
  });

  describe('pruneIdle', () => {
    it('removes containers older than threshold', async () => {
      vi.useFakeTimers();
      try {
        await ensureContainer('old', testConfig, ['/p']);
        // Advance time by 10 seconds so the container is idle
        vi.advanceTimersByTime(10_000);
        const pruned = await pruneIdle(5_000);
        expect(pruned).toBe(1);
        expect(mockRemoveContainer).toHaveBeenCalledWith('skimpyclaw-sbx-old');
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps recent containers', async () => {
      await ensureContainer('new', testConfig, ['/p']);
      const pruned = await pruneIdle(60_000);
      expect(pruned).toBe(0);
    });
  });

  describe('releaseAll', () => {
    it('removes all containers', async () => {
      mockIsContainerRunning.mockResolvedValue(true);
      await ensureContainer('a', testConfig, ['/p']);
      await ensureContainer('b', testConfig, ['/p']);
      await releaseAll();
      expect(mockRemoveContainer).toHaveBeenCalledTimes(2);
    });
  });

  describe('resetForTesting', () => {
    it('clears state without removing containers', async () => {
      mockIsContainerRunning.mockResolvedValue(false);
      await ensureContainer('x', testConfig, ['/p']);
      resetForTesting();
      // Next call should create fresh (map is empty)
      await ensureContainer('x', testConfig, ['/p']);
      expect(mockCreateContainer).toHaveBeenCalledTimes(2);
    });
  });
});
