# Review Loop UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Work" dashboard page that consumes the plan-2 API. Master-detail layout: a list of work items on the left, a chat-primary detail pane on the right with approval gate, live activity banner, and pause/resume/stop controls. This is Phase 1 of the UI spec (`docs/superpowers/specs/2026-04-14-work-ui-design.md`); later phases (diff viewer, overview cards, keyboard shortcuts) are out of scope.

**Architecture:** Preact + TypeScript, matching the existing dashboard. New file `web/dashboard/src/pages/Work.tsx`. Polls `GET /api/dashboard/work` and `GET /api/dashboard/work/:id` every 3s. Uses existing `api/client.ts` pattern. Routing via the existing hash-based `PageId` enum. No new dependencies.

**Tech Stack:** Preact 10, TypeScript, `react-icons/lu`, existing dashboard CSS variables.

---

## File Structure

- `web/dashboard/src/types.ts` — add `WorkItemState`, `ReviewFinding`, `ChatMessage`, `TimelineEvent`, `WorkStatus`
- `web/dashboard/src/api/client.ts` — add `getWorkItems`, `getWorkItem`, `createWork`, `sendWorkChat`, `approveWork`, `pauseWork`, `resumeWork`, `stopWork`
- `web/dashboard/src/components/Sidebar.tsx` — add `'work'` to `PageId` + nav entry
- `web/dashboard/src/pages/Work.tsx` — new page (master list + detail pane)
- `web/dashboard/src/pages/index.ts` — re-export `Work`
- `web/dashboard/src/App.tsx` — route `'work'` to `<Work />`

---

## Task 1: Types + API client helpers

**Files:**
- Modify: `web/dashboard/src/types.ts`
- Modify: `web/dashboard/src/api/client.ts`

- [ ] **Step 1: Add types to `web/dashboard/src/types.ts`.**

Append:

```ts
// ── Review-loop Work items ────────────────────────────────────────────

export type WorkStatus =
  | 'planning'
  | 'awaiting_approval'
  | 'implementing'
  | 'reviewing'
  | 'revising'
  | 'paused'
  | 'done'
  | 'blocked'
  | 'stopped';

export interface ReviewFinding {
  id: string;
  severity: 'low' | 'medium' | 'high';
  summary: string;
  file?: string;
  line?: number;
  status: 'open' | 'resolved' | 'disputed';
  iterationRaised: number;
  iterationResolved?: number;
}

export interface WorkChatMessage {
  id: string;
  role: 'user' | 'planner';
  content: string;
  createdAt: string;
}

export type TimelineEventKind =
  | 'created' | 'plan-produced' | 'plan-approved'
  | 'dev-started' | 'dev-completed'
  | 'review-started' | 'review-completed'
  | 'paused' | 'resumed' | 'stopped' | 'blocked' | 'done';

export interface WorkTimelineEvent {
  id: string;
  kind: TimelineEventKind;
  iteration: number;
  at: string;
  summary: string;
  changedFiles?: string[];
  findingsSnapshot?: ReviewFinding[];
  codeAgentTaskId?: string;
  note?: string;
}

export interface WorkLiveActivity {
  agent: 'planner' | 'dev' | 'reviewer';
  codeAgentTaskId: string;
  startedAt: string;
}

export interface WorkItemState {
  id: string;
  title: string;
  prompt: string;
  workdir: string;
  baseRef: string;
  plannerModel: string;
  devModel: string;
  reviewerModel: string;
  maxIterations: number;
  iteration: number;
  status: WorkStatus;
  previousStatus?: WorkStatus;
  findings: ReviewFinding[];
  chatMessages: WorkChatMessage[];
  timeline: WorkTimelineEvent[];
  liveActivity?: WorkLiveActivity;
  lastReviewCommit?: string;
  currentPlan?: string;
  pendingUserMessage?: boolean;
  createdAt: string;
  updatedAt: string;
  cost?: number;
  blockedReason?: string;
  stoppedReason?: string;
}

export interface WorkListResponse {
  items: WorkItemState[];
}

export interface CreateWorkInput {
  prompt: string;
  workdir: string;
  baseRef?: string;
  plannerModel?: string;
  devModel?: string;
  reviewerModel?: string;
  maxIterations?: number;
}
```

- [ ] **Step 2: Add API client helpers to `web/dashboard/src/api/client.ts`.**

Append after the existing helpers:

```ts
// ── Review-loop Work ─────────────────────────────────────────────────

import type { WorkItemState, WorkListResponse, CreateWorkInput } from '../types.js';

export function getWorkItems(status?: 'active' | 'done' | 'all'): Promise<WorkListResponse> {
  const q = status && status !== 'all' ? `?status=${status}` : '';
  return request<WorkListResponse>(`work${q}`);
}

export function getWorkItem(id: string): Promise<WorkItemState> {
  return request<WorkItemState>(`work/${encodeURIComponent(id)}`);
}

export function createWork(input: CreateWorkInput): Promise<WorkItemState> {
  return request<WorkItemState>('work', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function sendWorkChat(id: string, content: string): Promise<WorkItemState> {
  return request<WorkItemState>(`work/${encodeURIComponent(id)}/chat`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

export function approveWork(id: string): Promise<WorkItemState> {
  return request<WorkItemState>(`work/${encodeURIComponent(id)}/approve`, { method: 'POST' });
}

export function pauseWork(id: string): Promise<WorkItemState> {
  return request<WorkItemState>(`work/${encodeURIComponent(id)}/pause`, { method: 'POST' });
}

export function resumeWork(id: string): Promise<WorkItemState> {
  return request<WorkItemState>(`work/${encodeURIComponent(id)}/resume`, { method: 'POST' });
}

export function stopWork(id: string, reason?: string): Promise<WorkItemState> {
  return request<WorkItemState>(`work/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
    body: reason ? JSON.stringify({ reason }) : undefined,
  });
}
```

- [ ] **Step 3: Verify dashboard type-checks.**

```
cd web/dashboard && pnpm exec tsc --noEmit 2>&1 | grep -v "node_modules" | head -20
```

Expected: no errors in types.ts or client.ts.

- [ ] **Step 4: Commit.**

```bash
git add web/dashboard/src/types.ts web/dashboard/src/api/client.ts
git commit -m "feat(dashboard): add Work types and API client helpers"
```

---

## Task 2: Sidebar entry

**Files:**
- Modify: `web/dashboard/src/components/Sidebar.tsx`
- Modify: `web/dashboard/src/App.tsx`

- [ ] **Step 1: Add `'work'` to the `PageId` union in `Sidebar.tsx`.**

Find the `PageId` type (line ~23) and add `'work'`:

```ts
export type PageId =
  | 'overview'
  | 'history'
  | 'cron'
  | 'memory'
  | 'model'
  | 'work'
  | 'coding'
  | 'logs'
  | 'audit'
  | 'digests'
  | 'skills'
  | 'approvals'
  | 'health'
  | 'usage'
  | 'config'
  | 'templates';
```

- [ ] **Step 2: Add nav entry.**

Find `NAV_ITEMS` and insert a `'work'` entry between `coding` and `memory`:

```ts
{ id: 'work', label: 'Work', icon: LuLayers, section: 'dashboard' },
```

(Use whichever Lu* icon fits. If `LuLayers` isn't imported at the top of Sidebar.tsx, add it to the `from 'react-icons/lu'` imports. If unsure which icon is available, fall back to `LuBriefcase` or `LuListChecks` — any icon already used in the dashboard is acceptable.)

- [ ] **Step 3: Update `App.tsx` to include `'work'` in `PAGE_IDS`.**

Add `'work'` to the `PAGE_IDS` array:

```ts
const PAGE_IDS: PageId[] = [
  'overview',
  'history',
  'cron',
  'memory',
  'model',
  'work',
  'coding',
  // ...rest
];
```

**Do not** yet add the `case 'work':` in `renderPage()` — that happens in Task 5 once `<Work />` exists.

- [ ] **Step 4: Verify build still succeeds.**

```
cd web/dashboard && pnpm exec tsc --noEmit 2>&1 | grep -v "node_modules" | head -20
```

- [ ] **Step 5: Commit.**

```bash
git add web/dashboard/src/components/Sidebar.tsx web/dashboard/src/App.tsx
git commit -m "feat(dashboard): add Work sidebar entry and page id"
```

---

## Task 3: Work.tsx list view (master pane) + create form

**Files:**
- Create: `web/dashboard/src/pages/Work.tsx`
- Modify: `web/dashboard/src/pages/index.ts`

- [ ] **Step 1: Create `Work.tsx` with the list view and a stubbed detail pane placeholder.**

```tsx
// web/dashboard/src/pages/Work.tsx
import { useEffect, useMemo, useState } from 'preact/hooks';
import { LuPlus, LuRefreshCw } from 'react-icons/lu';
import {
  getWorkItems, createWork,
} from '../api/client.js';
import type { WorkItemState, WorkStatus, CreateWorkInput } from '../types.js';

const ACTIVE: WorkStatus[] = ['planning', 'awaiting_approval', 'implementing', 'reviewing', 'revising', 'paused'];
const DONE: WorkStatus[] = ['done', 'blocked', 'stopped'];

type Filter = 'all' | 'active' | 'done';

function statusColor(status: WorkStatus): string {
  switch (status) {
    case 'planning': case 'reviewing': case 'revising': return '#4a90b8';
    case 'awaiting_approval': case 'implementing': return '#c49a3a';
    case 'paused': return '#888';
    case 'done': return '#4a9b5a';
    case 'blocked': return '#c15c4f';
    case 'stopped': return '#888';
  }
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function readSelectedFromHash(): string | null {
  const m = /^#work\/(RL-\d+)/.exec(window.location.hash);
  return m ? m[1]! : null;
}

interface CreateFormState {
  prompt: string;
  workdir: string;
  advanced: boolean;
  plannerModel: string;
  devModel: string;
  reviewerModel: string;
  baseRef: string;
  maxIterations: number;
}

function defaultFormState(): CreateFormState {
  return {
    prompt: '',
    workdir: '',
    advanced: false,
    plannerModel: 'claude-opus',
    devModel: 'skimpyclaw',
    reviewerModel: 'claude-sonnet',
    baseRef: 'HEAD',
    maxIterations: 5,
  };
}

export function Work() {
  const [items, setItems] = useState<WorkItemState[]>([]);
  const [filter, setFilter] = useState<Filter>('active');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<CreateFormState>(defaultFormState);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => readSelectedFromHash());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await getWorkItems(filter === 'all' ? 'all' : filter);
        if (!alive) return;
        setItems(r.items);
      } catch (err: any) {
        if (!alive) return;
        setError(err?.message ?? 'failed to load work items');
      }
    }
    load();
    const interval = setInterval(load, 3000);
    return () => { alive = false; clearInterval(interval); };
  }, [filter]);

  useEffect(() => {
    function onHash() { setSelectedId(readSelectedFromHash()); }
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  function selectItem(id: string) {
    window.location.hash = `#work/${id}`;
  }

  async function onSubmit(e: Event) {
    e.preventDefault();
    if (!form.prompt.trim() || !form.workdir.trim()) {
      setError('prompt and workdir are required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload: CreateWorkInput = {
        prompt: form.prompt,
        workdir: form.workdir,
      };
      if (form.advanced) {
        payload.plannerModel = form.plannerModel;
        payload.devModel = form.devModel;
        payload.reviewerModel = form.reviewerModel;
        payload.baseRef = form.baseRef;
        payload.maxIterations = form.maxIterations;
      }
      const created = await createWork(payload);
      setCreating(false);
      setForm(defaultFormState());
      setItems(prev => [created, ...prev]);
      selectItem(created.id);
    } catch (err: any) {
      setError(err?.message ?? 'failed to create work item');
    } finally {
      setSubmitting(false);
    }
  }

  const visible = useMemo(() => {
    if (filter === 'all') return items;
    const allowed = filter === 'active' ? ACTIVE : DONE;
    return items.filter(i => (allowed as string[]).includes(i.status));
  }, [items, filter]);

  return (
    <div class="work-page" style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 420px) 1fr', gap: 16, height: '100%' }}>
      <div class="work-list" style={{ borderRight: '1px solid var(--border)', overflow: 'auto' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Work</h2>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{visible.length}</span>
          <div style={{ flex: 1 }} />
          <button class="btn btn-primary" onClick={() => setCreating(v => !v)} style={{ fontSize: 12, padding: '4px 10px' }}>
            <LuPlus size={12} /> New
          </button>
        </div>
        <div style={{ display: 'flex', gap: 4, padding: '8px 16px', borderBottom: '1px solid var(--border)' }}>
          {(['all', 'active', 'done'] as Filter[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              class={`btn${filter === f ? ' btn-primary' : ''}`}
              style={{ fontSize: 11, padding: '2px 8px', textTransform: 'capitalize' }}
            >
              {f}
            </button>
          ))}
        </div>
        {creating && (
          <form onSubmit={onSubmit} style={{ padding: 12, borderBottom: '1px solid var(--border)', background: 'var(--surface-alt)' }}>
            <textarea
              placeholder="Describe what the work should accomplish"
              value={form.prompt}
              onInput={e => setForm(s => ({ ...s, prompt: (e.target as HTMLTextAreaElement).value }))}
              required
              rows={3}
              style={{ width: '100%', fontSize: 12, padding: 6, marginBottom: 8, boxSizing: 'border-box' }}
            />
            <input
              placeholder="Workdir (absolute path or project alias)"
              value={form.workdir}
              onInput={e => setForm(s => ({ ...s, workdir: (e.target as HTMLInputElement).value }))}
              required
              style={{ width: '100%', fontSize: 12, padding: 6, marginBottom: 8, boxSizing: 'border-box' }}
            />
            <div style={{ marginBottom: 8 }}>
              <button type="button" onClick={() => setForm(s => ({ ...s, advanced: !s.advanced }))} class="btn" style={{ fontSize: 11, padding: '2px 6px' }}>
                {form.advanced ? 'Hide advanced' : 'Show advanced'}
              </button>
            </div>
            {form.advanced && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 8 }}>
                <label style={{ fontSize: 11 }}>Planner <input value={form.plannerModel} onInput={e => setForm(s => ({ ...s, plannerModel: (e.target as HTMLInputElement).value }))} style={{ width: '100%' }} /></label>
                <label style={{ fontSize: 11 }}>Dev <input value={form.devModel} onInput={e => setForm(s => ({ ...s, devModel: (e.target as HTMLInputElement).value }))} style={{ width: '100%' }} /></label>
                <label style={{ fontSize: 11 }}>Reviewer <input value={form.reviewerModel} onInput={e => setForm(s => ({ ...s, reviewerModel: (e.target as HTMLInputElement).value }))} style={{ width: '100%' }} /></label>
                <label style={{ fontSize: 11 }}>Base ref <input value={form.baseRef} onInput={e => setForm(s => ({ ...s, baseRef: (e.target as HTMLInputElement).value }))} style={{ width: '100%' }} /></label>
                <label style={{ fontSize: 11 }}>Max iter <input type="number" min={1} max={20} value={form.maxIterations} onInput={e => setForm(s => ({ ...s, maxIterations: parseInt((e.target as HTMLInputElement).value, 10) || 5 }))} style={{ width: '100%' }} /></label>
              </div>
            )}
            {error && <div style={{ color: 'var(--error)', fontSize: 12, marginBottom: 8 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" class="btn btn-primary" disabled={submitting} style={{ fontSize: 12 }}>
                {submitting ? 'Creating…' : 'Create'}
              </button>
              <button type="button" class="btn" onClick={() => { setCreating(false); setError(null); }} style={{ fontSize: 12 }}>Cancel</button>
            </div>
          </form>
        )}
        {error && !creating && <div style={{ color: 'var(--error)', fontSize: 12, padding: 12 }}>{error}</div>}
        {visible.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            No work items yet.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {visible.map(item => (
              <li
                key={item.id}
                onClick={() => selectItem(item.id)}
                style={{
                  padding: '10px 16px',
                  borderBottom: '1px solid var(--border)',
                  cursor: 'pointer',
                  borderLeft: selectedId === item.id ? '3px solid var(--accent, #4a90b8)' : '3px solid transparent',
                  background: selectedId === item.id ? 'var(--surface-alt)' : 'transparent',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-muted)' }}>{item.id}</span>
                  <span style={{ fontSize: 11, padding: '2px 6px', background: statusColor(item.status), color: 'white', borderRadius: 3 }}>
                    {item.status}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{relativeTime(item.updatedAt)}</span>
                </div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{item.title}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  iter {item.iteration}/{item.maxIterations}
                  {item.findings.filter(f => f.status === 'open').length > 0 && (
                    <span style={{ color: 'var(--error)', marginLeft: 8 }}>
                      {item.findings.filter(f => f.status === 'open').length} open
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Detail pane — implemented in Task 4 */}
      <div class="work-detail" style={{ overflow: 'auto' }}>
        {selectedId ? (
          <WorkDetail id={selectedId} />
        ) : (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
            Select a work item from the list
          </div>
        )}
      </div>
    </div>
  );
}

// Stub for Task 4 — real implementation lands there.
function WorkDetail({ id }: { id: string }) {
  return <div style={{ padding: 24 }}>Detail for {id} — coming in Task 4</div>;
}
```

- [ ] **Step 2: Add `Work` to `pages/index.ts`.**

Append:
```ts
export { Work } from './Work.js';
```

- [ ] **Step 3: Verify tsc passes.**

```
cd web/dashboard && pnpm exec tsc --noEmit 2>&1 | grep -v "node_modules" | head -20
```

- [ ] **Step 4: Commit.**

```bash
git add web/dashboard/src/pages/Work.tsx web/dashboard/src/pages/index.ts
git commit -m "feat(dashboard): Work page list view with create form and filter tabs"
```

---

## Task 4: Work detail pane — feed, approval gate, controls

**Files:**
- Modify: `web/dashboard/src/pages/Work.tsx`

Replace the `WorkDetail` stub with the full implementation.

- [ ] **Step 1: Replace the stub.**

```tsx
import { LuPause, LuPlay, LuSquare, LuSend, LuCheckCircle2, LuMessageSquare } from 'react-icons/lu';
import {
  getWorkItem, sendWorkChat, approveWork, pauseWork, resumeWork, stopWork,
} from '../api/client.js';
import type { WorkTimelineEvent } from '../types.js';
```
(Merge these imports with the existing ones at the top of Work.tsx.)

Replace the stub `WorkDetail` with:

```tsx
function WorkDetail({ id }: { id: string }) {
  const [state, setState] = useState<WorkItemState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [actionPending, setActionPending] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const s = await getWorkItem(id);
        if (alive) setState(s);
      } catch (err: any) {
        if (alive) setError(err?.message ?? 'failed to load');
      }
    }
    load();
    const interval = setInterval(load, 3000);
    return () => { alive = false; clearInterval(interval); };
  }, [id]);

  if (error) return <div style={{ padding: 24, color: 'var(--error)' }}>{error}</div>;
  if (!state) return <div style={{ padding: 24 }}>Loading…</div>;

  async function runAction(key: string, fn: () => Promise<WorkItemState>) {
    setActionPending(key);
    try {
      const next = await fn();
      setState(next);
    } catch (err: any) {
      setError(err?.message ?? `${key} failed`);
    } finally {
      setActionPending(null);
    }
  }

  async function onSendChat(e: Event) {
    e.preventDefault();
    const msg = chatInput.trim();
    if (!msg) return;
    setChatInput('');
    await runAction('chat', () => sendWorkChat(id, msg));
  }

  const terminal = ['done', 'blocked', 'stopped'].includes(state.status);
  const paused = state.status === 'paused';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Sticky header */}
      <div style={{
        padding: '12px 16px', borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-muted)' }}>{state.id}</span>
        <span style={{ fontSize: 11, padding: '2px 6px', background: statusColor(state.status), color: 'white', borderRadius: 3 }}>{state.status}</span>
        <span style={{ fontSize: 12 }}>iter {state.iteration}/{state.maxIterations}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          planner: {state.plannerModel} · dev: {state.devModel} · reviewer: {state.reviewerModel}
        </span>
        <div style={{ flex: 1 }} />
        {!terminal && !paused && (
          <button class="btn" disabled={actionPending === 'pause'} onClick={() => runAction('pause', () => pauseWork(id))} style={{ fontSize: 12 }}>
            <LuPause size={12} /> Pause
          </button>
        )}
        {paused && (
          <button class="btn btn-primary" disabled={actionPending === 'resume'} onClick={() => runAction('resume', () => resumeWork(id))} style={{ fontSize: 12 }}>
            <LuPlay size={12} /> Resume
          </button>
        )}
        {!terminal && (
          <button class="btn" disabled={actionPending === 'stop'} onClick={() => runAction('stop', () => stopWork(id))} style={{ fontSize: 12 }}>
            <LuSquare size={12} /> Stop
          </button>
        )}
      </div>

      {/* Feed */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        <Feed state={state} onApprove={() => runAction('approve', () => approveWork(id))} approvePending={actionPending === 'approve'} />
      </div>

      {/* Chat input */}
      {!terminal && (
        <form onSubmit={onSendChat} style={{ padding: 12, borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}>
          <input
            type="text"
            placeholder="Message the planner…"
            value={chatInput}
            onInput={e => setChatInput((e.target as HTMLInputElement).value)}
            style={{ flex: 1, fontSize: 13, padding: 8 }}
          />
          <button type="submit" class="btn btn-primary" disabled={!chatInput.trim() || actionPending === 'chat'}>
            <LuSend size={14} />
          </button>
        </form>
      )}

      {(state.blockedReason || state.stoppedReason) && (
        <div style={{ padding: 12, borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)' }}>
          {state.blockedReason && <>Blocked: {state.blockedReason}</>}
          {state.stoppedReason && <>Stopped: {state.stoppedReason}</>}
        </div>
      )}
    </div>
  );
}

function Feed({ state, onApprove, approvePending }: { state: WorkItemState; onApprove: () => void; approvePending: boolean }) {
  // Build a chronological merged feed of chat messages and iteration-summary events.
  const entries = useMemo(() => {
    type Entry =
      | { kind: 'chat'; at: string; role: 'user' | 'planner'; content: string; id: string }
      | { kind: 'iter'; at: string; iteration: number; ev: WorkTimelineEvent; id: string };
    const out: Entry[] = [];
    for (const m of state.chatMessages) {
      out.push({ kind: 'chat', at: m.createdAt, role: m.role, content: m.content, id: m.id });
    }
    for (const ev of state.timeline) {
      if (ev.kind === 'dev-completed' || ev.kind === 'review-completed') {
        out.push({ kind: 'iter', at: ev.at, iteration: ev.iteration, ev, id: ev.id });
      }
    }
    out.sort((a, b) => a.at.localeCompare(b.at));
    return out;
  }, [state]);

  return (
    <div>
      {entries.map(e => {
        if (e.kind === 'chat') {
          const isUser = e.role === 'user';
          return (
            <div key={e.id} style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', marginBottom: 12 }}>
              <div style={{
                maxWidth: '80%', padding: '8px 12px', borderRadius: 8,
                background: isUser ? 'var(--accent, #4a90b8)' : 'var(--surface-alt)',
                color: isUser ? 'white' : 'inherit',
                fontSize: 13, whiteSpace: 'pre-wrap',
              }}>
                {!isUser && <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4, color: '#4a9b5a' }}>PLANNER</div>}
                {e.content}
                {!isUser && state.status === 'awaiting_approval' && isLatestPlannerMessage(state, e.id) && (
                  <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                    <button class="btn btn-primary" disabled={approvePending} onClick={onApprove} style={{ fontSize: 12 }}>
                      <LuCheckCircle2 size={12} /> Approve
                    </button>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center' }}>
                      or refine via chat below
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        }
        return <IterationRow key={e.id} ev={e.ev} />;
      })}

      {state.liveActivity && (
        <div style={{ padding: 10, background: 'var(--surface-alt)', borderRadius: 6, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <LuMessageSquare size={14} />
          <strong>{state.liveActivity.agent}</strong> running…
          <span style={{ color: 'var(--text-muted)' }}>
            {Math.round((Date.now() - new Date(state.liveActivity.startedAt).getTime()) / 1000)}s
          </span>
        </div>
      )}
    </div>
  );
}

function isLatestPlannerMessage(state: WorkItemState, msgId: string): boolean {
  const plannerMsgs = state.chatMessages.filter(m => m.role === 'planner');
  return plannerMsgs.length > 0 && plannerMsgs[plannerMsgs.length - 1]!.id === msgId;
}

function IterationRow({ ev }: { ev: WorkTimelineEvent }) {
  const [open, setOpen] = useState(false);
  const label = ev.kind === 'dev-completed'
    ? `iter ${ev.iteration} · dev → ${ev.changedFiles?.length ?? 0} files`
    : `iter ${ev.iteration} · reviewer → ${ev.findingsSnapshot?.length ?? 0} findings`;
  return (
    <div style={{ borderTop: '1px dashed var(--border)', padding: '8px 0', fontSize: 12, color: 'var(--text-muted)' }}>
      <button onClick={() => setOpen(v => !v)} class="btn" style={{ fontSize: 12, padding: '2px 6px' }}>
        {open ? '▾' : '▸'} {label}
      </button>
      {open && (
        <div style={{ padding: '8px 16px', fontSize: 12 }}>
          {ev.changedFiles && ev.changedFiles.length > 0 && (
            <div><strong>Files:</strong>
              <ul style={{ margin: '4px 0 8px 20px' }}>{ev.changedFiles.map(f => <li key={f}>{f}</li>)}</ul>
            </div>
          )}
          {ev.findingsSnapshot && ev.findingsSnapshot.length > 0 && (
            <div><strong>Findings:</strong>
              <ul style={{ margin: '4px 0 0 20px' }}>
                {ev.findingsSnapshot.map(f => (
                  <li key={f.id}>
                    <span style={{ fontWeight: 600, color: f.severity === 'high' ? 'var(--error)' : f.severity === 'medium' ? '#c49a3a' : 'inherit' }}>
                      [{f.severity}]
                    </span>{' '}
                    {f.summary}
                    {f.file && <span style={{ color: 'var(--text-muted)' }}> — {f.file}{f.line ? `:${f.line}` : ''}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify tsc passes.**

```
cd web/dashboard && pnpm exec tsc --noEmit 2>&1 | grep -v "node_modules" | head -20
```

- [ ] **Step 3: Commit.**

```bash
git add web/dashboard/src/pages/Work.tsx
git commit -m "feat(dashboard): Work detail pane with chat feed, approval gate, and controls"
```

---

## Task 5: Wire `<Work />` into `App.tsx` routing

**Files:**
- Modify: `web/dashboard/src/App.tsx`

- [ ] **Step 1: Add `Work` to the imports at the top of `App.tsx`.**

Update the import block from `./pages/index.js`:

```ts
import {
  Overview, History, Cron, Coding, Audit, Approvals, Memory, Model, Logs,
  Config, Digests, Skills, Health, Templates, Usage, Work,
} from './pages/index.js';
```

- [ ] **Step 2: Add a `case 'work':` in `renderPage()`.**

Add this case inside the switch (alongside the existing cases):

```ts
case 'work':
  return <Work />;
```

- [ ] **Step 3: Handle `#work/RL-NNN` hash in the `isPageId` predicate / `readPageFromHash`.**

The existing `readPageFromHash` strips the leading `#` and checks against `PAGE_IDS`. If the hash is `#work/RL-001`, the raw value is `work/RL-001`, which will not match `'work'`. Fix by splitting on `/` before the check:

Replace the existing `readPageFromHash`:

```ts
function readPageFromHash(): PageId {
  const raw = window.location.hash.replace(/^#/, '').split('/')[0]!.trim();
  return isPageId(raw) ? raw : 'overview';
}
```

- [ ] **Step 4: Run the dashboard build.**

```
cd web/dashboard && pnpm build 2>&1 | tail -20
```
Expected: clean build (or whatever the preexisting baseline is — no new errors from our code).

- [ ] **Step 5: Commit.**

```bash
git add web/dashboard/src/App.tsx
git commit -m "feat(dashboard): route 'work' page id and support nested work hash"
```

---

## Task 6: Manual smoke test

**Files:** (none — runtime check only)

- [ ] **Step 1: Start the dev gateway.**

```
pnpm dev
```

Wait a few seconds for the gateway to come up.

- [ ] **Step 2: Open the dashboard in a browser.**

Visit `http://localhost:18790/dashboard/` and log in with the dashboard token (from `~/.skimpyclaw/config.json` → `dashboard.token`).

- [ ] **Step 3: Navigate to the Work tab. Verify:**

- Sidebar has a "Work" entry.
- Clicking it shows the empty list placeholder.
- Clicking "+ New" opens the inline create form.
- Submitting with an invalid workdir (outside allowed paths) surfaces a 400 error in the form.
- Submitting with a valid workdir (e.g. `skimpyclaw` project alias, or the repo root if in `tools.allowedPaths`) creates an item and navigates to its detail.
- The planner will start running in the background; within a few seconds the status transitions to `awaiting_approval` and a planner message appears in the feed with an "Approve" button.
- Clicking Approve moves status back to `planning` (then `implementing` on the next tick).

If any of these fail, diagnose (check `pnpm logs` and browser devtools network tab) and fix before proceeding.

Do not commit anything for this task — it's validation-only.

---

## Self-Review Notes

**Spec coverage:**
- New page at `/dashboard/work` with hash `#work` and `#work/:id` — Tasks 2, 3, 5 ✓
- Sidebar entry between Coding and Memory — Task 2 ✓
- Inline creation form with Advanced panel — Task 3 ✓
- Master-detail with chat-primary feed — Tasks 3, 4 ✓
- 3s polling on both panes — Tasks 3, 4 ✓
- Status pills, iteration counter, findings count — Tasks 3, 4 ✓
- Plan approval gate with Approve + Refine via chat — Task 4 ✓
- Pause / Stop controls in header — Task 4 ✓
- Live activity banner in feed — Task 4 ✓
- Iteration summary rows with expansion — Task 4 ✓
- Sticky chat input — Task 4 ✓
- Bearer auth via existing client — Task 1 ✓

**Not covered (explicitly out of scope per spec Phase 1):**
- Overview page cards, Telegram/Discord triggers, diff viewer, cost analytics, archive/delete UX, keyboard shortcuts.
- Per-finding resolve tracking (findings are rendered but not clickable to individual resolve actions beyond what the planner emits).

**Type consistency:** All API shapes in `types.ts` mirror the engine types from plan 1 exactly. `WorkStatus` is identical. Field names (`plannerModel`, `chatMessages`, `timeline`, `liveActivity`, `iterationRaised`) match.

**No placeholders:** Every task has exact code or exact commands.

## Execution Handoff

Plan complete. Two options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks
**2. Inline** — execute tasks in this session with checkpoints

Which approach?
