import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../code-agents/review-loop.js', () => ({
  listWorkItems: vi.fn(() => []),
  tickWorkItem: vi.fn(async () => null),
}));

import * as engine from '../code-agents/review-loop.js';
import { startWorkTicker } from '../work-ticker.js';

beforeEach(() => {
  (engine.listWorkItems as any).mockReset();
  (engine.tickWorkItem as any).mockReset();
  (engine.tickWorkItem as any).mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('work-ticker', () => {
  it('ticks each tickable item on each interval', async () => {
    (engine.listWorkItems as any).mockReturnValue([
      { id: 'RL-001', status: 'planning' },
      { id: 'RL-002', status: 'implementing' },
      { id: 'RL-003', status: 'awaiting_approval' },
      { id: 'RL-004', status: 'done' },
      { id: 'RL-005', status: 'paused' },
    ]);
    vi.useFakeTimers();
    const stop = startWorkTicker({ intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(105);
    const calls = (engine.tickWorkItem as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.sort()).toEqual(['RL-001', 'RL-002']);
    stop();
  });

  it('stop halts further ticks', async () => {
    (engine.listWorkItems as any).mockReturnValue([{ id: 'RL-001', status: 'planning' }]);
    vi.useFakeTimers();
    const stop = startWorkTicker({ intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(105);
    stop();
    (engine.tickWorkItem as any).mockClear();
    await vi.advanceTimersByTimeAsync(500);
    expect((engine.tickWorkItem as any).mock.calls.length).toBe(0);
  });

  it('errors from tickWorkItem do not crash the ticker', async () => {
    (engine.listWorkItems as any).mockReturnValue([{ id: 'RL-001', status: 'planning' }]);
    (engine.tickWorkItem as any).mockRejectedValue(new Error('boom'));
    vi.useFakeTimers();
    const stop = startWorkTicker({ intervalMs: 50 });
    await vi.advanceTimersByTimeAsync(55);
    await vi.advanceTimersByTimeAsync(55);
    expect((engine.tickWorkItem as any).mock.calls.length).toBeGreaterThanOrEqual(2);
    stop();
  });
});
