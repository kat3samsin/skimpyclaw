import { describe, it, expect, beforeEach } from 'vitest';
import {
  acquireLock,
  releaseLock,
  releaseAllLocks,
  isLocked,
  getLockHolder,
  getActiveLocks,
  clearAllLocks,
} from '../file-lock.js';

describe('file-lock', () => {
  beforeEach(() => {
    clearAllLocks();
  });

  describe('acquireLock', () => {
    it('acquires an unlocked file', async () => {
      const result = await acquireLock('/tmp/test.txt', 't1');
      expect(result).toBe(true);
      expect(isLocked('/tmp/test.txt')).toBe(true);
      expect(getLockHolder('/tmp/test.txt')).toBe('t1');
    });

    it('allows same task to re-acquire', async () => {
      await acquireLock('/tmp/test.txt', 't1');
      const result = await acquireLock('/tmp/test.txt', 't1');
      expect(result).toBe(true);
    });

    it('blocks a different task from acquiring', async () => {
      await acquireLock('/tmp/test.txt', 't1');

      // Start a competing acquire with very short timeout expectation
      // We'll release quickly so it can proceed
      const acquirePromise = acquireLock('/tmp/test.txt', 't2');

      // Release after a short delay
      setTimeout(() => releaseLock('/tmp/test.txt', 't1'), 200);

      const result = await acquirePromise;
      expect(result).toBe(true);
      expect(getLockHolder('/tmp/test.txt')).toBe('t2');
    });

    it('handles multiple files independently', async () => {
      await acquireLock('/tmp/a.txt', 't1');
      await acquireLock('/tmp/b.txt', 't2');
      expect(getLockHolder('/tmp/a.txt')).toBe('t1');
      expect(getLockHolder('/tmp/b.txt')).toBe('t2');
    });
  });

  describe('releaseLock', () => {
    it('releases a held lock', async () => {
      await acquireLock('/tmp/test.txt', 't1');
      const result = releaseLock('/tmp/test.txt', 't1');
      expect(result).toBe(true);
      expect(isLocked('/tmp/test.txt')).toBe(false);
    });

    it('returns true for non-existent lock', () => {
      const result = releaseLock('/tmp/nonexistent.txt', 't1');
      expect(result).toBe(true);
    });

    it('refuses to release lock held by another task', async () => {
      await acquireLock('/tmp/test.txt', 't1');
      const result = releaseLock('/tmp/test.txt', 't2');
      expect(result).toBe(false);
      expect(isLocked('/tmp/test.txt')).toBe(true);
    });
  });

  describe('releaseAllLocks', () => {
    it('releases all locks for a task', async () => {
      await acquireLock('/tmp/a.txt', 't1');
      await acquireLock('/tmp/b.txt', 't1');
      await acquireLock('/tmp/c.txt', 't2');

      const released = releaseAllLocks('t1');
      expect(released).toBe(2);
      expect(isLocked('/tmp/a.txt')).toBe(false);
      expect(isLocked('/tmp/b.txt')).toBe(false);
      expect(isLocked('/tmp/c.txt')).toBe(true);
    });

    it('returns 0 when no locks held', () => {
      const released = releaseAllLocks('t99');
      expect(released).toBe(0);
    });
  });

  describe('getActiveLocks', () => {
    it('returns all active locks', async () => {
      await acquireLock('/tmp/a.txt', 't1');
      await acquireLock('/tmp/b.txt', 't2');

      const active = getActiveLocks();
      expect(active.size).toBe(2);
      expect(active.get('/tmp/a.txt')?.holder).toBe('t1');
      expect(active.get('/tmp/b.txt')?.holder).toBe('t2');
    });

    it('returns empty map when no locks', () => {
      expect(getActiveLocks().size).toBe(0);
    });
  });

  describe('clearAllLocks', () => {
    it('removes all locks', async () => {
      await acquireLock('/tmp/a.txt', 't1');
      await acquireLock('/tmp/b.txt', 't2');
      clearAllLocks();
      expect(getActiveLocks().size).toBe(0);
    });
  });
});
