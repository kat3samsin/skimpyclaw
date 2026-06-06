import { describe, it, expect, vi } from 'vitest';
import {
  isRetryableCronAgentError,
  killScriptProcessTree,
  parseDualOutput,
  runAgentTurnWithTimeout,
} from '../cron.js';

describe('parseDualOutput', () => {
  it('returns full response as text when no delimiters present', () => {
    const response = 'Hello, this is a regular response with no delimiters.';
    const result = parseDualOutput(response);
    expect(result.voice).toBeNull();
    expect(result.text).toBe(response);
  });

  it('parses voice and text portions correctly', () => {
    const response = `Some preamble
---VOICE---
Good morning Katrina. You have three meetings today.
---TEXT---
## Morning Briefing

- **9am** standup
- **11am** [PR review](https://github.com/...)
- **2pm** 1:1 with manager`;

    const result = parseDualOutput(response);
    expect(result.voice).toBe('Good morning Katrina. You have three meetings today.');
    expect(result.text).toContain('## Morning Briefing');
    expect(result.text).toContain('[PR review]');
  });

  it('returns null voice when voice section is empty', () => {
    const response = `---VOICE---
---TEXT---
Some text content here.`;

    const result = parseDualOutput(response);
    expect(result.voice).toBeNull();
    expect(result.text).toBe('Some text content here.');
  });

  it('handles only VOICE marker without TEXT marker', () => {
    const response = `---VOICE---
Just voice content here, no text marker.`;

    const result = parseDualOutput(response);
    expect(result.voice).toBeNull();
    expect(result.text).toBe(response);
  });

  it('handles only TEXT marker without VOICE marker', () => {
    const response = `---TEXT---
Just text content here, no voice marker.`;

    const result = parseDualOutput(response);
    expect(result.voice).toBeNull();
    expect(result.text).toBe(response);
  });

  it('handles multiline voice content', () => {
    const response = `---VOICE---
Good morning Katrina.
You have three meetings today.
The first one is at nine.
---TEXT---
Full detailed text here.`;

    const result = parseDualOutput(response);
    expect(result.voice).toBe(
      'Good morning Katrina.\nYou have three meetings today.\nThe first one is at nine.'
    );
    expect(result.text).toBe('Full detailed text here.');
  });

  it('falls back to full response if text portion is empty', () => {
    const fullResponse = `---VOICE---
Voice content here
---TEXT---`;

    const result = parseDualOutput(fullResponse);
    expect(result.voice).toBe('Voice content here');
    expect(result.text).toBe(fullResponse);
  });
});

describe('cron job tool injection', () => {
  it('isCronJob field exists on ExecuteToolContext', () => {
    // Verify the field is part of the type (compile-time check via assignment)
    const ctx: import('../tools/execute-context.js').ExecuteToolContext = {
      isCronJob: true,
    };
    expect(ctx.isCronJob).toBe(true);
  });

  it('isCronJob defaults to undefined when not set', () => {
    const ctx: import('../tools/execute-context.js').ExecuteToolContext = {};
    expect(ctx.isCronJob).toBeUndefined();
  });
});

describe('isRetryableCronAgentError', () => {
  it('matches transient Codex and provider connectivity failures', () => {
    expect(isRetryableCronAgentError(new Error('Codex API 503: upstream connect error'))).toBe(true);
    expect(isRetryableCronAgentError(new Error('remote connection failure: Connection refused'))).toBe(true);
    expect(isRetryableCronAgentError(new Error('529 {"type":"error","error":{"type":"overloaded_error"}}'))).toBe(true);
  });

  it('does not match normal validation errors', () => {
    expect(isRetryableCronAgentError(new Error('Tool use loop reached maximum iterations'))).toBe(false);
    expect(isRetryableCronAgentError(new Error('Invalid model selection'))).toBe(false);
  });
});

describe('runAgentTurnWithTimeout', () => {
  it('runs without an abort signal and returns the result when timeoutMs is unset', async () => {
    let receivedSignal: unknown = 'unset';
    let calls = 0;
    const result = await runAgentTurnWithTimeout(undefined, (signal) => {
      calls++;
      receivedSignal = signal;
      return Promise.resolve('ok');
    });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
    expect(receivedSignal).toBeUndefined();
  });

  it('treats timeoutMs <= 0 as no timeout (default behavior unchanged)', async () => {
    let receivedSignal: unknown = 'unset';
    const result = await runAgentTurnWithTimeout(0, (signal) => {
      receivedSignal = signal;
      return Promise.resolve('ok');
    });
    expect(result).toBe('ok');
    expect(receivedSignal).toBeUndefined();
  });

  it('passes an abort signal and returns the result when the run finishes in time', async () => {
    let onTimeoutCalled = false;
    let abortedDuringRun = true;
    const result = await runAgentTurnWithTimeout(
      10_000,
      (signal) => {
        abortedDuringRun = signal?.aborted ?? true;
        return Promise.resolve('done');
      },
      () => {
        onTimeoutCalled = true;
      },
    );
    expect(result).toBe('done');
    expect(abortedDuringRun).toBe(false);
    expect(onTimeoutCalled).toBe(false);
  });

  it('aborts the signal and throws a timeout error when the run exceeds timeoutMs', async () => {
    let onTimeoutCalled = false;
    let observedAbort = false;
    // Mirror the tool loop: on abort it returns a "[Cancelled ...]" string rather
    // than throwing, so the helper must detect the timeout after the run resolves.
    const run = (signal?: { aborted: boolean }) =>
      new Promise<string>((resolve) => {
        const check = () => {
          if (signal?.aborted) {
            observedAbort = true;
            resolve('[Cancelled after 2 tool calls]');
          } else {
            setTimeout(check, 2);
          }
        };
        check();
      });

    await expect(
      runAgentTurnWithTimeout(20, run, () => {
        onTimeoutCalled = true;
      }),
    ).rejects.toThrow('Agent turn timed out after 20ms');
    expect(onTimeoutCalled).toBe(true);
    expect(observedAbort).toBe(true);
  });

  it('reports a timeout even when the aborted run rejects', async () => {
    const run = (signal?: { aborted: boolean }) =>
      new Promise<string>((_, reject) => {
        const check = () => {
          if (signal?.aborted) reject(new Error('fetch failed'));
          else setTimeout(check, 2);
        };
        check();
      });

    await expect(runAgentTurnWithTimeout(20, run)).rejects.toThrow(
      'Agent turn timed out after 20ms',
    );
  });

  it('propagates the original error when the run fails before timing out', async () => {
    await expect(
      runAgentTurnWithTimeout(10_000, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
  });
});

describe('killScriptProcessTree', () => {
  it('targets the process group before falling back to the shell process', () => {
    const killSpy = vi.spyOn(process, 'kill')
      .mockImplementationOnce(() => {
        throw new Error('missing process group');
      })
      .mockImplementationOnce(() => true);

    killScriptProcessTree(1234, 'SIGTERM');

    expect(killSpy).toHaveBeenNthCalledWith(1, -1234, 'SIGTERM');
    expect(killSpy).toHaveBeenNthCalledWith(2, 1234, 'SIGTERM');
    killSpy.mockRestore();
  });
});
