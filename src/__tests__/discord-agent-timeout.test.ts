import { afterEach, describe, expect, it, vi } from 'vitest';
import { _runWithAgentTimeoutForTesting } from '../channels/discord/handlers.js';

describe('Discord agent timeout wrapper', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the agent operation exactly once when it completes before timeout', async () => {
    let calls = 0;

    const result = await _runWithAgentTimeoutForTesting('@chief', async (abortSignal) => {
      calls++;
      expect(abortSignal.aborted).toBe(false);
      return 'done';
    });

    expect(result).toBe('done');
    expect(calls).toBe(1);
  });

  it('aborts on timeout but waits for the agent operation to clean up', async () => {
    vi.useFakeTimers();
    let releaseCleanup = () => {};
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let sawAbort = false;
    let settled = false;

    const run = _runWithAgentTimeoutForTesting('@chief', async (abortSignal) => {
      await new Promise<void>((resolve) => {
        abortSignal.addEventListener('abort', () => {
          sawAbort = true;
          resolve();
        }, { once: true });
      });
      await cleanupGate;
      return 'late result';
    });
    const observed = run.then(
      () => { settled = true; },
      (error: unknown) => {
        settled = true;
        throw error;
      },
    );

    await vi.advanceTimersByTimeAsync(12 * 60_000);
    expect(sawAbort).toBe(true);
    expect(settled).toBe(false);

    releaseCleanup();
    await expect(observed).rejects.toThrow('Agent run timed out after 12 minutes');
  });
});
