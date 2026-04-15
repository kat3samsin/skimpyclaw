# Review Loop API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the review-loop engine over HTTP under `/api/dashboard/work/*`, with Bearer auth matching existing dashboard routes. Add a background ticker that advances non-terminal work items, plus a safe ID allocator that doesn't race on concurrent POSTs. This plan depends on plan 1 (review-loop engine) being complete and merged on `trunk`.

**Architecture:** A new module `src/api-work.ts` defines `registerWorkAPI(fastify, config)` and is wired from `src/gateway.ts`. Routes are thin — they validate inputs, call into the engine, and serialize. A per-work-item in-memory mutex prevents concurrent ticks on the same id. A background interval (`src/work-ticker.ts`) ticks all tickable items every 3 seconds. The race-prone `nextWorkItemId` is replaced with an atomic allocator using `O_EXCL` file creation.

**Tech Stack:** TypeScript ESM, Fastify, vitest.

---

## File Structure

- `src/code-agents/review-loop-storage.ts` — modify `nextWorkItemId` + add `allocateWorkItemId` using `O_EXCL`
- `src/code-agents/review-loop.ts` — add per-id mutex around `tickWorkItem`
- `src/api-work.ts` — Fastify routes, input validation, JSON serialization
- `src/work-ticker.ts` — background interval scheduler (start/stop hooks)
- `src/gateway.ts` — wire `registerWorkAPI` + start/stop ticker
- `src/__tests__/api-work.test.ts` — route-level integration tests (inject requests)
- `src/__tests__/work-ticker.test.ts` — scheduler lifecycle + skip-rules
- `src/__tests__/review-loop-storage.test.ts` — extend with concurrent-allocation test

---

## Task 1: Concurrency-safe work item ID allocator

**Files:**
- Modify: `src/code-agents/review-loop-storage.ts`
- Modify: `src/__tests__/review-loop-storage.test.ts`

- [ ] **Step 1: Extend the storage test file with a concurrency test.**

Add to `src/__tests__/review-loop-storage.test.ts`:

```ts
import { allocateWorkItemId } from '../code-agents/review-loop-storage.js';

describe('allocateWorkItemId — concurrent-safe', () => {
  it('two parallel calls produce distinct ids', async () => {
    // Simulate concurrency with Promise.all on the synchronous allocator.
    const ids = await Promise.all(
      Array.from({ length: 10 }, () => Promise.resolve(allocateWorkItemId())),
    );
    const unique = new Set(ids);
    expect(unique.size).toBe(10);
    for (const id of ids) expect(id).toMatch(/^RL-\d{3,}$/);
  });

  it('allocateWorkItemId creates a placeholder file so the id cannot be re-used', () => {
    const a = allocateWorkItemId();
    const b = allocateWorkItemId();
    expect(a).not.toBe(b);
    // Saving a state under id `a` should not throw — placeholder was only a reservation.
    const state = makeState(a);
    saveWorkItem(state);
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL (function not exported).**

```
pnpm vitest run src/__tests__/review-loop-storage.test.ts -t allocateWorkItemId
```

- [ ] **Step 3: Implement `allocateWorkItemId`.**

Modify `src/code-agents/review-loop-storage.ts`:

Add import: `openSync, closeSync` to the fs import.

Add this function below `nextWorkItemId`:

```ts
/**
 * Atomically reserve the next RL-NNN id by creating a zero-byte placeholder
 * file with O_EXCL. Two racing callers will never get the same id.
 * The placeholder is overwritten by the first subsequent `saveWorkItem`.
 */
export function allocateWorkItemId(): string {
  const root = ensureRoot();
  let candidate = nextWorkItemId();
  // Retry up to a small number of times if another allocator beat us to the punch.
  for (let attempts = 0; attempts < 32; attempts++) {
    const file = join(root, `${candidate}.json`);
    try {
      const fd = openSync(file, 'wx', 0o600); // 'wx' = O_WRONLY | O_CREAT | O_EXCL
      closeSync(fd);
      return candidate;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      // Bump and retry.
      const m = /^RL-(\d+)$/.exec(candidate);
      const n = m ? parseInt(m[1]!, 10) : 0;
      candidate = `RL-${String(n + 1).padStart(3, '0')}`;
    }
  }
  throw new Error('allocateWorkItemId: exceeded retry budget');
}
```

- [ ] **Step 4: Update `review-loop.ts` `createWorkItem` to use `allocateWorkItemId` instead of `nextWorkItemId`.**

In `src/code-agents/review-loop.ts`, change the line `const id = nextWorkItemId();` to:

```ts
const id = allocateWorkItemId();
```

Update the import from `./review-loop-storage.js` to include `allocateWorkItemId`:

```ts
import {
  loadWorkItem,
  saveWorkItem,
  listWorkItems as storageList,
  allocateWorkItemId,
} from './review-loop-storage.js';
```

Remove `nextWorkItemId` from the import list since it's now only used internally by `allocateWorkItemId`.

- [ ] **Step 5: Run all storage + review-loop tests.**

```
pnpm vitest run src/__tests__/review-loop-storage.test.ts src/__tests__/review-loop.test.ts
```
Expected: all pass (prior counts + 2 new concurrency tests).

- [ ] **Step 6: Commit.**

```bash
git add src/code-agents/review-loop-storage.ts src/code-agents/review-loop.ts src/__tests__/review-loop-storage.test.ts
git commit -m "feat(review-loop): concurrency-safe work item ID allocator"
```

---

## Task 2: Per-id tick mutex

**Files:**
- Modify: `src/code-agents/review-loop.ts`
- Modify: `src/__tests__/review-loop.test.ts`

When the API layer or background ticker calls `tickWorkItem(id)` twice in rapid succession, two agent invocations must not run concurrently on the same item. Guard with an in-memory `Map<string, Promise>` that serializes ticks per id.

- [ ] **Step 1: Add the failing test.**

Append to `src/__tests__/review-loop.test.ts`:

```ts
describe('tickWorkItem: concurrency', () => {
  beforeEach(() => {
    (registryMock.getNextCodeAgentId as any).mockReturnValue('ca-plan');
    (executorMock.runCodeAgentBackground as any).mockResolvedValue(undefined);
  });

  it('parallel ticks for same id serialize — runCodeAgentBackground called once per real tick', async () => {
    const s = createWorkItem({ prompt: 'Fix login', workdir: '/r' });

    let callCount = 0;
    (registryMock.getCodeAgent as any).mockImplementation(() => ({
      id: `ca-plan-${++callCount}`,
      status: 'completed',
      outputPreview: '{"status":"awaiting_approval","summary":"s","plan":"P"}',
      agent: 'claude', task: 't', startedAt: new Date().toISOString(), workdir: '/r',
    }));

    const [a, b] = await Promise.all([tickWorkItem(s.id), tickWorkItem(s.id)]);
    // Both callers get the same resulting state; only one planner run was launched.
    expect(a?.status).toBe('awaiting_approval');
    expect(b?.status).toBe('awaiting_approval');
    // runCodeAgentBackground should have been invoked exactly once.
    expect((executorMock.runCodeAgentBackground as any).mock.calls.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (likely 2 runCodeAgentBackground calls).**

```
pnpm vitest run src/__tests__/review-loop.test.ts -t "concurrency"
```

- [ ] **Step 3: Implement the mutex.**

In `src/code-agents/review-loop.ts`, rename the current `tickWorkItem` to `tickWorkItemInternal` (keep it unexported) and add a new exported `tickWorkItem`:

```ts
const inflightTicks = new Map<string, Promise<WorkItemState | null>>();

export function tickWorkItem(id: string): Promise<WorkItemState | null> {
  const existing = inflightTicks.get(id);
  if (existing) return existing;
  const p = tickWorkItemInternal(id).finally(() => {
    inflightTicks.delete(id);
  });
  inflightTicks.set(id, p);
  return p;
}

async function tickWorkItemInternal(id: string): Promise<WorkItemState | null> {
  // ... existing body of the old tickWorkItem ...
}
```

- [ ] **Step 4: Run tests, all pass.**

```
pnpm vitest run src/__tests__/review-loop.test.ts
```

- [ ] **Step 5: Commit.**

```bash
git add src/code-agents/review-loop.ts src/__tests__/review-loop.test.ts
git commit -m "feat(review-loop): per-id tick mutex to serialize concurrent calls"
```

---

## Task 3: `work-ticker.ts` — background scheduler

**Files:**
- Create: `src/work-ticker.ts`
- Create: `src/__tests__/work-ticker.test.ts`

Interval-driven scheduler that ticks all non-terminal, non-paused, non-`awaiting_approval` work items. Exported `startWorkTicker(opts)` returns a stop function.

- [ ] **Step 1: Write the failing test.**

```ts
// src/__tests__/work-ticker.test.ts
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
      { id: 'RL-003', status: 'awaiting_approval' }, // skipped
      { id: 'RL-004', status: 'done' },              // skipped
      { id: 'RL-005', status: 'paused' },            // skipped
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
    // Still running after two failed ticks
    expect((engine.tickWorkItem as any).mock.calls.length).toBeGreaterThanOrEqual(2);
    stop();
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module not found).**

```
pnpm vitest run src/__tests__/work-ticker.test.ts
```

- [ ] **Step 3: Implement.**

```ts
// src/work-ticker.ts
import { listWorkItems, tickWorkItem } from './code-agents/review-loop.js';
import type { WorkStatus } from './code-agents/review-loop-types.js';

const TICKABLE: WorkStatus[] = ['planning', 'revising', 'implementing', 'reviewing'];

export interface WorkTickerOptions {
  intervalMs?: number;
}

export function startWorkTicker(opts: WorkTickerOptions = {}): () => void {
  const interval = opts.intervalMs ?? 3000;

  async function tickAll() {
    try {
      const items = listWorkItems();
      const tickable = items.filter(i => TICKABLE.includes(i.status as WorkStatus));
      await Promise.allSettled(
        tickable.map(i => tickWorkItem(i.id).catch(err => {
          console.error(`[work-ticker] ${i.id} tick failed:`, err);
        })),
      );
    } catch (err) {
      console.error('[work-ticker] list failed:', err);
    }
  }

  const handle = setInterval(() => { void tickAll(); }, interval);
  return () => clearInterval(handle);
}
```

- [ ] **Step 4: Run tests, expect PASS (3 tests).**

```
pnpm vitest run src/__tests__/work-ticker.test.ts
```

- [ ] **Step 5: Commit.**

```bash
git add src/work-ticker.ts src/__tests__/work-ticker.test.ts
git commit -m "feat(work-ticker): interval scheduler that advances tickable work items"
```

---

## Task 4: REST routes — list and detail

**Files:**
- Create: `src/api-work.ts`
- Create: `src/__tests__/api-work.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// src/__tests__/api-work.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { setWorkRootForTesting } from '../code-agents/review-loop-storage.js';
import { createWorkItem } from '../code-agents/review-loop.js';
import { registerWorkAPI } from '../api-work.js';

// Stub out the agent executor and registry so createWorkItem can run without real I/O beyond our tmp dir.
vi.mock('../code-agents/executor.js', () => ({
  runCodeAgentBackground: vi.fn(async () => {}),
}));
vi.mock('../code-agents/registry.js', () => ({
  getNextCodeAgentId: vi.fn(() => 'ca-1'),
  storeCodeAgentTask: vi.fn(() => {}),
  writeCodeAgentTask: vi.fn(() => {}),
  getCodeAgent: vi.fn(() => ({ id: 'ca-1', status: 'completed', outputPreview: 'x', agent: 'claude', task: 't', startedAt: new Date().toISOString(), workdir: '/r' })),
}));

const AUTH = { authorization: 'Bearer test-token' };
let app: FastifyInstance;
let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'api-work-'));
  setWorkRootForTesting(tmp);
  app = Fastify();
  registerWorkAPI(app, { dashboard: { token: 'test-token' } } as any);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(tmp, { recursive: true, force: true });
  setWorkRootForTesting(null);
});

describe('GET /api/dashboard/work', () => {
  it('401 without auth', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/dashboard/work' });
    expect(r.statusCode).toBe(401);
  });

  it('returns empty list initially', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/dashboard/work', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ items: [] });
  });

  it('returns created items', async () => {
    createWorkItem({ prompt: 'X', workdir: '/r' });
    createWorkItem({ prompt: 'Y', workdir: '/r' });
    const r = await app.inject({ method: 'GET', url: '/api/dashboard/work', headers: AUTH });
    const body = JSON.parse(r.payload);
    expect(body.items).toHaveLength(2);
    expect(body.items[0].id).toMatch(/^RL-/);
    expect(body.items[0].status).toBe('planning');
  });

  it('filter ?status=active excludes terminal items', async () => {
    // Create items and manipulate state via direct save — test-only manipulation.
    const a = createWorkItem({ prompt: 'A', workdir: '/r' });
    const b = createWorkItem({ prompt: 'B', workdir: '/r' });
    const { saveWorkItem, loadWorkItem } = await import('../code-agents/review-loop-storage.js');
    const doneItem = loadWorkItem(b.id)!;
    doneItem.status = 'done';
    saveWorkItem(doneItem);

    const r = await app.inject({ method: 'GET', url: '/api/dashboard/work?status=active', headers: AUTH });
    const body = JSON.parse(r.payload);
    expect(body.items.map((i: any) => i.id)).toEqual([a.id]);
  });
});

describe('GET /api/dashboard/work/:id', () => {
  it('404 for missing', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/dashboard/work/RL-999', headers: AUTH });
    expect(r.statusCode).toBe(404);
  });

  it('returns full state for existing', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    const r = await app.inject({ method: 'GET', url: `/api/dashboard/work/${s.id}`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.id).toBe(s.id);
    expect(body.status).toBe('planning');
    expect(body.timeline).toHaveLength(1);
  });

  it('rejects malformed ids', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/dashboard/work/../../etc/passwd', headers: AUTH });
    expect([400, 404]).toContain(r.statusCode);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module not found).**

```
pnpm vitest run src/__tests__/api-work.test.ts
```

- [ ] **Step 3: Implement the list and detail routes.**

```ts
// src/api-work.ts
import type { FastifyInstance } from 'fastify';
import { validateBearerToken } from './utils.js';
import type { Config } from './types.js';
import {
  listWorkItems,
  getWorkItem,
} from './code-agents/review-loop.js';
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from './code-agents/review-loop-types.js';

const WORK_ID_RE = /^RL-\d{3,}$/;

function isValidWorkId(id: string): boolean {
  return WORK_ID_RE.test(id);
}

export function registerWorkAPI(fastify: FastifyInstance, config: Config): void {
  const runtimeConfig = config;

  // Auth hook (scoped to /api/dashboard/work/*)
  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/dashboard/work')) return;
    const token = runtimeConfig.dashboard?.token;
    if (!token) return;
    if (!validateBearerToken(token, request.headers.authorization)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  fastify.get('/api/dashboard/work', async (request) => {
    const q = request.query as { status?: string };
    const all = listWorkItems();
    let filtered = all;
    if (q.status === 'active') {
      filtered = all.filter(i => ACTIVE_STATUSES.includes(i.status));
    } else if (q.status === 'done') {
      filtered = all.filter(i => TERMINAL_STATUSES.includes(i.status));
    }
    return { items: filtered };
  });

  fastify.get('/api/dashboard/work/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidWorkId(id)) {
      return reply.code(400).send({ error: 'invalid id format' });
    }
    const item = getWorkItem(id);
    if (!item) return reply.code(404).send({ error: 'not found' });
    return item;
  });
}
```

- [ ] **Step 4: Run tests.**

```
pnpm vitest run src/__tests__/api-work.test.ts
```
Expected: GET tests pass (7 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/api-work.ts src/__tests__/api-work.test.ts
git commit -m "feat(api-work): GET /work and GET /work/:id with auth"
```

---

## Task 5: REST routes — create, chat, approve

**Files:**
- Modify: `src/api-work.ts`
- Modify: `src/__tests__/api-work.test.ts`

- [ ] **Step 1: Add tests.**

Append to `src/__tests__/api-work.test.ts`:

```ts
describe('POST /api/dashboard/work', () => {
  it('creates a work item with required fields', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/dashboard/work',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { prompt: 'Fix login', workdir: '/r' },
    });
    expect(r.statusCode).toBe(201);
    const body = JSON.parse(r.payload);
    expect(body.id).toMatch(/^RL-/);
    expect(body.status).toBe('planning');
    expect(body.prompt).toBe('Fix login');
  });

  it('400 on missing prompt', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/dashboard/work',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { workdir: '/r' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('400 on missing workdir', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/dashboard/work',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { prompt: 'X' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('accepts optional fields', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/dashboard/work',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: {
        prompt: 'X', workdir: '/r',
        plannerModel: 'alt-p', devModel: 'alt-d', reviewerModel: 'alt-r',
        baseRef: 'main', maxIterations: 3,
      },
    });
    const body = JSON.parse(r.payload);
    expect(body.plannerModel).toBe('alt-p');
    expect(body.maxIterations).toBe(3);
  });
});

describe('POST /api/dashboard/work/:id/chat', () => {
  it('appends a message', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    const r = await app.inject({
      method: 'POST', url: `/api/dashboard/work/${s.id}/chat`,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { content: 'prefer minimal diff' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.chatMessages).toHaveLength(1);
    expect(body.chatMessages[0].content).toBe('prefer minimal diff');
  });

  it('400 on empty content', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    const r = await app.inject({
      method: 'POST', url: `/api/dashboard/work/${s.id}/chat`,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { content: '' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('404 on missing item', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/dashboard/work/RL-999/chat',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { content: 'x' },
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('POST /api/dashboard/work/:id/approve', () => {
  it('transitions awaiting_approval to planning', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    const { saveWorkItem, loadWorkItem } = await import('../code-agents/review-loop-storage.js');
    const state = loadWorkItem(s.id)!;
    state.status = 'awaiting_approval';
    state.currentPlan = 'plan';
    saveWorkItem(state);

    const r = await app.inject({
      method: 'POST', url: `/api/dashboard/work/${s.id}/approve`,
      headers: AUTH,
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.status).toBe('planning');
  });

  it('409 if not awaiting_approval', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    const r = await app.inject({
      method: 'POST', url: `/api/dashboard/work/${s.id}/approve`,
      headers: AUTH,
    });
    expect(r.statusCode).toBe(409);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

```
pnpm vitest run src/__tests__/api-work.test.ts
```

- [ ] **Step 3: Implement the routes.**

Add these imports to `src/api-work.ts`:

```ts
import {
  createWorkItem,
  appendUserMessage,
  approvePlan,
  tickWorkItem,
} from './code-agents/review-loop.js';
```

Append inside `registerWorkAPI`:

```ts
fastify.post('/api/dashboard/work', async (request, reply) => {
  const body = request.body as any;
  if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return reply.code(400).send({ error: 'prompt is required' });
  }
  if (typeof body.workdir !== 'string' || !body.workdir.trim()) {
    return reply.code(400).send({ error: 'workdir is required' });
  }
  const state = createWorkItem({
    prompt: body.prompt,
    workdir: body.workdir,
    baseRef: typeof body.baseRef === 'string' ? body.baseRef : undefined,
    plannerModel: typeof body.plannerModel === 'string' ? body.plannerModel : undefined,
    devModel: typeof body.devModel === 'string' ? body.devModel : undefined,
    reviewerModel: typeof body.reviewerModel === 'string' ? body.reviewerModel : undefined,
    maxIterations: typeof body.maxIterations === 'number' ? body.maxIterations : undefined,
  });
  // Fire a background tick so the planner starts running right away.
  void tickWorkItem(state.id).catch(err => console.error('[api-work] tick error:', err));
  return reply.code(201).send(state);
});

fastify.post('/api/dashboard/work/:id/chat', async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!isValidWorkId(id)) return reply.code(400).send({ error: 'invalid id' });
  const body = request.body as any;
  if (!body || typeof body.content !== 'string' || !body.content.trim()) {
    return reply.code(400).send({ error: 'content is required' });
  }
  const state = appendUserMessage(id, body.content);
  if (!state) return reply.code(404).send({ error: 'not found' });
  void tickWorkItem(id).catch(err => console.error('[api-work] tick error:', err));
  return state;
});

fastify.post('/api/dashboard/work/:id/approve', async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!isValidWorkId(id)) return reply.code(400).send({ error: 'invalid id' });
  const state = approvePlan(id);
  if (!state) {
    // Null means either missing (unlikely since we just created it), or wrong state.
    // Check which to pick the right code.
    const existing = getWorkItem(id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    return reply.code(409).send({ error: `cannot approve from status ${existing.status}` });
  }
  void tickWorkItem(id).catch(err => console.error('[api-work] tick error:', err));
  return state;
});
```

- [ ] **Step 4: Run tests.**

```
pnpm vitest run src/__tests__/api-work.test.ts
```
Expected: all pass (16+ tests now).

- [ ] **Step 5: Commit.**

```bash
git add src/api-work.ts src/__tests__/api-work.test.ts
git commit -m "feat(api-work): POST /work, /chat, /approve"
```

---

## Task 6: REST routes — pause, resume, stop

**Files:**
- Modify: `src/api-work.ts`
- Modify: `src/__tests__/api-work.test.ts`

- [ ] **Step 1: Add tests.**

Append to `src/__tests__/api-work.test.ts`:

```ts
describe('POST /api/dashboard/work/:id/pause|resume|stop', () => {
  it('pause transitions active item to paused', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    const { saveWorkItem, loadWorkItem } = await import('../code-agents/review-loop-storage.js');
    const state = loadWorkItem(s.id)!;
    state.status = 'implementing';
    saveWorkItem(state);

    const r = await app.inject({
      method: 'POST', url: `/api/dashboard/work/${s.id}/pause`, headers: AUTH,
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.status).toBe('paused');
    expect(body.previousStatus).toBe('implementing');
  });

  it('resume restores previous state', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    const { saveWorkItem, loadWorkItem } = await import('../code-agents/review-loop-storage.js');
    const state = loadWorkItem(s.id)!;
    state.status = 'paused';
    state.previousStatus = 'reviewing';
    saveWorkItem(state);

    const r = await app.inject({
      method: 'POST', url: `/api/dashboard/work/${s.id}/resume`, headers: AUTH,
    });
    const body = JSON.parse(r.payload);
    expect(body.status).toBe('reviewing');
  });

  it('stop transitions to stopped with reason', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    const r = await app.inject({
      method: 'POST', url: `/api/dashboard/work/${s.id}/stop`,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { reason: 'cancelled' },
    });
    const body = JSON.parse(r.payload);
    expect(body.status).toBe('stopped');
    expect(body.stoppedReason).toBe('cancelled');
  });

  it('stop without body still works', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    const r = await app.inject({
      method: 'POST', url: `/api/dashboard/work/${s.id}/stop`, headers: AUTH,
    });
    expect(r.statusCode).toBe(200);
  });

  it('404 on missing id for all three', async () => {
    for (const action of ['pause', 'resume', 'stop']) {
      const r = await app.inject({
        method: 'POST', url: `/api/dashboard/work/RL-999/${action}`, headers: AUTH,
      });
      expect(r.statusCode).toBe(404);
    }
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.**

Add imports to `src/api-work.ts`:

```ts
import { pauseWorkItem, resumeWorkItem, stopWorkItem } from './code-agents/review-loop.js';
```

Append inside `registerWorkAPI`:

```ts
fastify.post('/api/dashboard/work/:id/pause', async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!isValidWorkId(id)) return reply.code(400).send({ error: 'invalid id' });
  const state = pauseWorkItem(id);
  if (!state) return reply.code(404).send({ error: 'not found' });
  return state;
});

fastify.post('/api/dashboard/work/:id/resume', async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!isValidWorkId(id)) return reply.code(400).send({ error: 'invalid id' });
  const state = resumeWorkItem(id);
  if (!state) return reply.code(404).send({ error: 'not found' });
  void tickWorkItem(id).catch(err => console.error('[api-work] tick error:', err));
  return state;
});

fastify.post('/api/dashboard/work/:id/stop', async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!isValidWorkId(id)) return reply.code(400).send({ error: 'invalid id' });
  const body = request.body as any;
  const reason = body && typeof body.reason === 'string' ? body.reason : undefined;
  const state = stopWorkItem(id, reason);
  if (!state) return reply.code(404).send({ error: 'not found' });
  return state;
});
```

- [ ] **Step 4: Run tests; all pass.**

- [ ] **Step 5: Commit.**

```bash
git add src/api-work.ts src/__tests__/api-work.test.ts
git commit -m "feat(api-work): POST /work/:id/pause, /resume, /stop"
```

---

## Task 7: Wire into gateway

**Files:**
- Modify: `src/gateway.ts`

- [ ] **Step 1: Find the `registerDashboardAPI` call and add below it.**

Near line 168 in `src/gateway.ts` (where `registerDashboardAPI(fastify, config);` lives), add:

```ts
import { registerWorkAPI } from './api-work.js';
import { startWorkTicker } from './work-ticker.js';
```

(The imports go at the top of the file alongside the existing imports.)

After the `registerDashboardAPI(fastify, config);` line, add:

```ts
registerWorkAPI(fastify, config);
```

Then find where the gateway starts or exports its start function, and add near the startup (look for `fastify.listen` or an exported `startGateway`):

```ts
const stopWorkTicker = startWorkTicker({ intervalMs: 3000 });
```

Also track the stop handle so shutdown cleans it up. In whatever cleanup/stop path exists (search for `fastify.close` or `stopHeartbeat`), add `stopWorkTicker();` alongside it.

**If uncertain where to place the ticker start/stop, find the pattern used for `initCron` / `initHeartbeat` and mirror it.**

- [ ] **Step 2: Build the project to confirm no type errors in our new files.**

```
pnpm exec tsc --noEmit 2>&1 | grep -E "api-work|work-ticker|gateway" | grep -v "src/newspaper" || echo "clean"
```

- [ ] **Step 3: Run the full test suite.**

```
pnpm test
```
Expected: all prior tests pass, plus the new api-work and work-ticker tests.

- [ ] **Step 4: Commit.**

```bash
git add src/gateway.ts
git commit -m "feat(gateway): wire review-loop work API and background ticker"
```

---

## Task 8: Self-review

Read through the committed code. Verify:
- All endpoints are auth-gated.
- No user-controlled path segments flow into filesystem calls (IDs are regex-validated).
- `tickWorkItem` is never `await`ed inside a request handler (all ticks are `void`-fire-and-forget so mutations return fast).
- The ticker's stop hook is called on gateway shutdown.

If any issues found, fix and commit separately.

---

## Self-Review Notes

**Spec coverage:**
- `GET /work[?status=active|done]` — Task 4 ✓
- `GET /work/:id` — Task 4 ✓
- `POST /work` — Task 5 ✓
- `POST /work/:id/chat` — Task 5 ✓
- `POST /work/:id/approve` — Task 5 ✓
- `POST /work/:id/pause|resume|stop` — Task 6 ✓
- Background ticker (spec calls for 3s polling) — Task 3 ✓
- Bearer auth on all routes — Task 4 auth hook ✓
- Concurrency safety (fix deferred from plan 1) — Tasks 1 & 2 ✓

**Type consistency:** All engine functions used here (`listWorkItems`, `getWorkItem`, `createWorkItem`, `appendUserMessage`, `approvePlan`, `pauseWorkItem`, `resumeWorkItem`, `stopWorkItem`, `tickWorkItem`) were exported from plan 1. `WorkItemState`, `ACTIVE_STATUSES`, `TERMINAL_STATUSES` match the plan-1 types.

**No placeholders:** Every step has exact code or exact commands.

## Deferred to Plan 3

- UI (`Work.tsx`, sidebar entry, live polling consumer of these routes).
- The UI will call `POST /work` to create, poll `GET /work/:id` for updates, and issue control actions via the action endpoints.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-14-review-loop-api.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks
**2. Inline Execution** — execute tasks in this session

Which approach?
