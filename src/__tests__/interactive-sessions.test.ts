import { describe, expect, it, beforeEach, vi } from 'vitest';

// Mock fs before importing the module so the module never touches disk during import.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '[]'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import {
  addSession,
  getSession,
  updateStatus,
  enqueue,
  dequeue,
  markIdle,
  hasPending,
  listSessions,
  _resetForTesting,
} from '../code-agents/interactive-sessions.js';
import type { InteractiveSession } from '../types.js';

function makeSession(threadId = 't1', cliAgent: 'claude' | 'codex' = 'claude'): InteractiveSession {
  return {
    discordThreadId: threadId,
    cliSessionId: 'uuid-' + threadId,
    cliAgent,
    status: 'active',
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    initialTask: 'test task',
  };
}

describe('interactive-sessions state store', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('stores and retrieves a session', () => {
    const s = makeSession();
    addSession(s);
    expect(getSession('t1')).toEqual(s);
    expect(listSessions()).toHaveLength(1);
  });

  it('updates status and activity', () => {
    addSession(makeSession());
    updateStatus('t1', 'errored');
    const s = getSession('t1');
    expect(s?.status).toBe('errored');
  });

  it('returns undefined for unknown thread', () => {
    expect(getSession('nope')).toBeUndefined();
  });

  it('enqueue returns shouldStart=true for first message', () => {
    addSession(makeSession());
    const r = enqueue('t1', 'hello');
    expect(r.shouldStart).toBe(true);
  });

  it('enqueue returns shouldStart=false while in-flight', () => {
    addSession(makeSession());
    enqueue('t1', 'first'); // marks inFlight
    const r = enqueue('t1', 'second');
    expect(r.shouldStart).toBe(false);
  });

  it('dequeue returns messages FIFO', () => {
    addSession(makeSession());
    enqueue('t1', 'one');
    enqueue('t1', 'two');
    enqueue('t1', 'three');
    // First was taken by the "in flight" starter; caller is responsible for
    // processing it. The remaining two should dequeue in order.
    // Our API returns the first via shouldStart=true — the caller then calls
    // dequeue() to consume subsequent ones.
    const first = dequeue('t1');
    expect(first?.content).toBe('one');
    const second = dequeue('t1');
    expect(second?.content).toBe('two');
    const third = dequeue('t1');
    expect(third?.content).toBe('three');
    expect(dequeue('t1')).toBeUndefined();
  });

  it('markIdle allows shouldStart=true on next enqueue', () => {
    addSession(makeSession());
    enqueue('t1', 'first');
    markIdle('t1');
    // Queue is empty AND not in flight → next enqueue starts
    const r = enqueue('t1', 'next');
    expect(r.shouldStart).toBe(true);
  });

  it('hasPending reflects queue state', () => {
    addSession(makeSession());
    expect(hasPending('t1')).toBe(false);
    enqueue('t1', 'one');    // inFlight=true, queue empty (first message is the "flight")
    expect(hasPending('t1')).toBe(true); // we pushed to queue first
    dequeue('t1');
    expect(hasPending('t1')).toBe(false);
  });

  it('per-thread queues are isolated', () => {
    addSession(makeSession('t1'));
    addSession(makeSession('t2'));
    enqueue('t1', 'to t1');
    enqueue('t2', 'to t2');
    expect(dequeue('t1')?.content).toBe('to t1');
    expect(dequeue('t2')?.content).toBe('to t2');
  });
});
