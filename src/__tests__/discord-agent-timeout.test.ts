import { describe, expect, it } from 'vitest';
import { _runWithAgentTimeoutForTesting } from '../channels/discord/handlers.js';

describe('Discord agent timeout wrapper', () => {
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
});
