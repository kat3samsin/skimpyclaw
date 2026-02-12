// In-memory file lock manager for concurrent subagent writes

const LOCK_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;

interface LockEntry {
  holder: string;       // Task ID holding the lock
  acquiredAt: number;   // Date.now() when acquired
}

const locks = new Map<string, LockEntry>();

/**
 * Acquire a lock on a file path. Waits up to LOCK_TIMEOUT_MS if already locked.
 * Returns true if acquired, false if timed out.
 */
export async function acquireLock(filePath: string, taskId: string): Promise<boolean> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const existing = locks.get(filePath);

    if (!existing) {
      locks.set(filePath, { holder: taskId, acquiredAt: Date.now() });
      return true;
    }

    // Same task already holds it
    if (existing.holder === taskId) {
      return true;
    }

    // Check for stale locks (held longer than 2x timeout — likely abandoned)
    if (Date.now() - existing.acquiredAt > LOCK_TIMEOUT_MS * 2) {
      console.warn(`[file-lock] Force-releasing stale lock on ${filePath} (held by ${existing.holder})`);
      locks.delete(filePath);
      continue;
    }

    // Wait and retry
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  console.error(`[file-lock] Timed out acquiring lock on ${filePath} for ${taskId} (held by ${locks.get(filePath)?.holder})`);
  return false;
}

/**
 * Release a lock on a file path. Only the holder can release it.
 */
export function releaseLock(filePath: string, taskId: string): boolean {
  const existing = locks.get(filePath);
  if (!existing) return true;
  if (existing.holder !== taskId) return false;
  locks.delete(filePath);
  return true;
}

/**
 * Release all locks held by a given task ID.
 */
export function releaseAllLocks(taskId: string): number {
  let released = 0;
  for (const [path, entry] of locks) {
    if (entry.holder === taskId) {
      locks.delete(path);
      released++;
    }
  }
  return released;
}

/**
 * Check if a file is currently locked.
 */
export function isLocked(filePath: string): boolean {
  return locks.has(filePath);
}

/**
 * Get the task ID holding the lock on a file, or null.
 */
export function getLockHolder(filePath: string): string | null {
  return locks.get(filePath)?.holder ?? null;
}

/**
 * Get all active locks (for debugging/monitoring).
 */
export function getActiveLocks(): Map<string, LockEntry> {
  return new Map(locks);
}

/**
 * Clear all locks (for testing).
 */
export function clearAllLocks(): void {
  locks.clear();
}
