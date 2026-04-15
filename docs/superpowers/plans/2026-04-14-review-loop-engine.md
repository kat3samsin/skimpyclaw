# Review Loop Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend review-loop engine (planner → dev → reviewer state machine) that drives Work items to completion, with persisted state under `~/.skimpyclaw/work/`. No HTTP API, no UI — just the engine and its tests. The API (plan 2) and UI (plan 3) will consume this.

**Architecture:** New module `src/code-agents/review-loop.ts` owning a tick-based state machine. Each `tickWorkItem(id)` call advances the machine by at most one agent invocation (planner, dev, or reviewer) using the existing `runCodeAgentBackground` infrastructure, then persists the updated state atomically. State lives in per-item JSON files at `~/.skimpyclaw/work/<id>.json`. Planner and reviewer return strict JSON; a parser extracts structured output and falls through to `blocked` on contract violation. Diff-scoped review uses `git diff <lastReviewCommit|baseRef>..HEAD` so the reviewer only sees the latest delta.

**Tech Stack:** TypeScript, Node fs, existing `runCodeAgentBackground` (Claude/Codex CLI subprocess), vitest with `vi.mock`.

---

## File Structure

- `src/code-agents/review-loop-types.ts` — all types (findings, state, timeline, chat, status)
- `src/code-agents/review-loop-storage.ts` — load/save/list state files, ID generation
- `src/code-agents/review-loop-prompts.ts` — planner/dev/reviewer prompt builders + JSON parsers
- `src/code-agents/review-loop-diff.ts` — git diff helpers (base..HEAD, last_review_commit..HEAD, changed-files)
- `src/code-agents/review-loop.ts` — tick-based state machine; exports `createWorkItem`, `tickWorkItem`, `getWorkItem`, `listWorkItems`, `appendUserMessage`, `approvePlan`, `pauseWorkItem`, `resumeWorkItem`, `stopWorkItem`
- `src/__tests__/review-loop-storage.test.ts`
- `src/__tests__/review-loop-prompts.test.ts`
- `src/__tests__/review-loop-diff.test.ts`
- `src/__tests__/review-loop.test.ts`

Each file has one clear responsibility. The main `review-loop.ts` orchestrates; helpers are pure and easily mockable. No file should exceed ~500 lines.

---

## Task 1: Define types

**Files:**
- Create: `src/code-agents/review-loop-types.ts`

- [ ] **Step 1: Write the types file**

```ts
// Review Loop — type definitions

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

export const ACTIVE_STATUSES: WorkStatus[] = [
  'planning',
  'awaiting_approval',
  'implementing',
  'reviewing',
  'revising',
  'paused',
];

export const TERMINAL_STATUSES: WorkStatus[] = ['done', 'blocked', 'stopped'];

export type FindingSeverity = 'low' | 'medium' | 'high';

export interface ReviewFinding {
  id: string;                   // stable within the work item: "f-<iteration>-<index>"
  severity: FindingSeverity;
  summary: string;
  file?: string;
  line?: number;
  status: 'open' | 'resolved' | 'disputed';
  iterationRaised: number;      // which iteration surfaced it
  iterationResolved?: number;
}

export interface ChatMessage {
  id: string;                   // "m-<n>"
  role: 'user' | 'planner';
  content: string;
  createdAt: string;            // ISO
}

export type TimelineEventKind =
  | 'created'
  | 'plan-produced'
  | 'plan-approved'
  | 'dev-started'
  | 'dev-completed'
  | 'review-started'
  | 'review-completed'
  | 'paused'
  | 'resumed'
  | 'stopped'
  | 'blocked'
  | 'done';

export interface TimelineEvent {
  id: string;                   // "t-<n>"
  kind: TimelineEventKind;
  iteration: number;
  at: string;                   // ISO
  summary: string;
  // Optional structured data depending on kind
  changedFiles?: string[];
  findingsSnapshot?: ReviewFinding[];
  codeAgentTaskId?: string;     // link to CodeAgentTask when kind is dev/review started|completed
  note?: string;
}

export interface LiveActivity {
  agent: 'planner' | 'dev' | 'reviewer';
  codeAgentTaskId: string;
  startedAt: string;
}

export interface WorkItemState {
  id: string;                   // "RL-031"
  title: string;                // derived from prompt (first ~60 chars) or planner summary
  prompt: string;
  workdir: string;
  baseRef: string;
  plannerModel: string;
  devModel: string;
  reviewerModel: string;
  maxIterations: number;
  iteration: number;            // 0 until first dev run, then 1, 2, ...
  status: WorkStatus;
  previousStatus?: WorkStatus;  // used to restore from `paused`
  findings: ReviewFinding[];
  chatMessages: ChatMessage[];
  timeline: TimelineEvent[];
  liveActivity?: LiveActivity;
  lastReviewCommit?: string;    // HEAD after most recent dev run the reviewer inspected
  currentPlan?: string;         // planner's latest approved (or pending) plan text
  pendingUserMessage?: boolean; // set true when user sends chat; planner consumes on next tick
  createdAt: string;
  updatedAt: string;
  cost?: number;                // cumulative USD
  blockedReason?: string;       // populated when status === 'blocked'
  stoppedReason?: string;       // populated when status === 'stopped'
}

export interface CreateWorkInput {
  prompt: string;
  workdir: string;
  baseRef?: string;             // default 'HEAD'
  plannerModel?: string;        // default 'claude-opus'
  devModel?: string;            // default 'skimpyclaw'
  reviewerModel?: string;       // default 'claude-sonnet'
  maxIterations?: number;       // default 5
}

// Planner/reviewer JSON contracts (the shapes they must return)

export interface PlannerOutput {
  status: 'awaiting_approval' | 'revising' | 'blocked';
  summary: string;
  plan: string;                 // markdown text shown to the user
  next_dev_task?: string;       // required when status is 'revising'
  blocked_reason?: string;      // required when status is 'blocked'
  resolved_finding_ids?: string[]; // findings the planner believes were addressed
}

export interface ReviewerOutput {
  verdict: 'approved' | 'changes_requested';
  findings: Array<{
    severity: FindingSeverity;
    summary: string;
    file?: string;
    line?: number;
  }>;
  note?: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/code-agents/review-loop-types.ts
git commit -m "feat(review-loop): add type definitions"
```

---

## Task 2: Storage — load, save, list, ID generation

**Files:**
- Create: `src/code-agents/review-loop-storage.ts`
- Test: `src/__tests__/review-loop-storage.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/review-loop-storage.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual };
});

import {
  setWorkRootForTesting,
  saveWorkItem,
  loadWorkItem,
  listWorkItems,
  nextWorkItemId,
} from '../code-agents/review-loop-storage.js';
import type { WorkItemState } from '../code-agents/review-loop-types.js';

let tmp: string;

function makeState(id: string): WorkItemState {
  const now = new Date().toISOString();
  return {
    id,
    title: 'example',
    prompt: 'do the thing',
    workdir: '/tmp',
    baseRef: 'HEAD',
    plannerModel: 'claude-opus',
    devModel: 'skimpyclaw',
    reviewerModel: 'claude-sonnet',
    maxIterations: 5,
    iteration: 0,
    status: 'planning',
    findings: [],
    chatMessages: [],
    timeline: [],
    createdAt: now,
    updatedAt: now,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'work-storage-'));
  setWorkRootForTesting(tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  setWorkRootForTesting(null);
});

describe('review-loop-storage', () => {
  it('nextWorkItemId returns RL-001 when empty', () => {
    expect(nextWorkItemId()).toBe('RL-001');
  });

  it('increments id after save', () => {
    const s = makeState(nextWorkItemId());
    saveWorkItem(s);
    expect(nextWorkItemId()).toBe('RL-002');
  });

  it('saveWorkItem writes atomically and loadWorkItem round-trips', () => {
    const s = makeState('RL-042');
    saveWorkItem(s);
    const path = join(tmp, 'RL-042.json');
    expect(existsSync(path)).toBe(true);
    const loaded = loadWorkItem('RL-042');
    expect(loaded).toEqual(s);
  });

  it('loadWorkItem returns null for missing', () => {
    expect(loadWorkItem('RL-999')).toBeNull();
  });

  it('listWorkItems returns newest first', () => {
    const a = { ...makeState('RL-001'), updatedAt: '2026-04-14T10:00:00.000Z' };
    const b = { ...makeState('RL-002'), updatedAt: '2026-04-14T11:00:00.000Z' };
    saveWorkItem(a);
    saveWorkItem(b);
    const list = listWorkItems();
    expect(list.map(w => w.id)).toEqual(['RL-002', 'RL-001']);
  });

  it('saveWorkItem is atomic — corrupt tmp does not clobber existing file', () => {
    const s = makeState('RL-007');
    saveWorkItem(s);
    const file = join(tmp, 'RL-007.json');
    const original = readFileSync(file, 'utf-8');
    // Simulate failure mid-write by passing a state that fails JSON.stringify
    const bad: any = { ...s };
    bad.self = bad;  // circular
    expect(() => saveWorkItem(bad)).toThrow();
    expect(readFileSync(file, 'utf-8')).toBe(original);
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL (module not found)**

Run: `pnpm vitest run src/__tests__/review-loop-storage.test.ts`
Expected: FAIL — "Cannot find module '../code-agents/review-loop-storage.js'"

- [ ] **Step 3: Implement the storage module**

```ts
// src/code-agents/review-loop-storage.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { WorkItemState } from './review-loop-types.js';

const DEFAULT_WORK_ROOT = join(homedir(), '.skimpyclaw', 'work');
let workRootOverride: string | null = null;

/** Testing hook — pass null to reset. */
export function setWorkRootForTesting(root: string | null): void {
  workRootOverride = root;
}

export function getWorkRoot(): string {
  return workRootOverride ?? DEFAULT_WORK_ROOT;
}

function ensureRoot(): string {
  const root = getWorkRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return root;
}

function workItemPath(id: string): string {
  return join(getWorkRoot(), `${id}.json`);
}

export function loadWorkItem(id: string): WorkItemState | null {
  const path = workItemPath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as WorkItemState;
  } catch (err) {
    console.error(`[review-loop] Failed to parse ${path}:`, err);
    return null;
  }
}

export function saveWorkItem(state: WorkItemState): void {
  const root = ensureRoot();
  const final = join(root, `${state.id}.json`);
  const tmp = `${final}.tmp`;
  const payload = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2);
  writeFileSync(tmp, payload, { mode: 0o600 });
  try {
    renameSync(tmp, final);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export function listWorkItems(): WorkItemState[] {
  const root = getWorkRoot();
  if (!existsSync(root)) return [];
  const entries = readdirSync(root).filter(f => f.endsWith('.json') && !f.endsWith('.tmp'));
  const items: WorkItemState[] = [];
  for (const file of entries) {
    try {
      const raw = readFileSync(join(root, file), 'utf-8');
      items.push(JSON.parse(raw) as WorkItemState);
    } catch { /* skip corrupt */ }
  }
  items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return items;
}

export function nextWorkItemId(): string {
  const ids = listWorkItems().map(w => w.id);
  let max = 0;
  for (const id of ids) {
    const m = /^RL-(\d+)$/.exec(id);
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  const next = max + 1;
  return `RL-${String(next).padStart(3, '0')}`;
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `pnpm vitest run src/__tests__/review-loop-storage.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/code-agents/review-loop-storage.ts src/__tests__/review-loop-storage.test.ts
git commit -m "feat(review-loop): add per-item JSON storage with atomic writes"
```

---

## Task 3: Git diff helpers

**Files:**
- Create: `src/code-agents/review-loop-diff.ts`
- Test: `src/__tests__/review-loop-diff.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/review-loop-diff.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import {
  getHeadSha,
  getChangedFiles,
  getReviewDiff,
} from '../code-agents/review-loop-diff.js';

const execMock = execSync as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  execMock.mockReset();
});

describe('review-loop-diff', () => {
  it('getHeadSha returns trimmed sha', () => {
    execMock.mockReturnValueOnce(Buffer.from('abc1234\n'));
    expect(getHeadSha('/x')).toBe('abc1234');
    expect(execMock).toHaveBeenCalledWith('git rev-parse HEAD', { cwd: '/x', encoding: 'buffer' });
  });

  it('getChangedFiles returns array split on newline', () => {
    execMock.mockReturnValueOnce(Buffer.from('a.ts\nb.ts\n'));
    expect(getChangedFiles('/x', 'abc', 'def')).toEqual(['a.ts', 'b.ts']);
    expect(execMock).toHaveBeenCalledWith('git diff --name-only abc..def', { cwd: '/x', encoding: 'buffer' });
  });

  it('getChangedFiles handles empty output', () => {
    execMock.mockReturnValueOnce(Buffer.from(''));
    expect(getChangedFiles('/x', 'abc', 'def')).toEqual([]);
  });

  it('getReviewDiff returns git diff content between refs', () => {
    execMock.mockReturnValueOnce(Buffer.from('--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n'));
    const diff = getReviewDiff('/x', 'abc', 'def');
    expect(diff).toContain('+y');
    expect(execMock).toHaveBeenCalledWith('git diff abc..def', { cwd: '/x', encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 });
  });

  it('getReviewDiff returns null on git failure', () => {
    execMock.mockImplementationOnce(() => { throw new Error('not a git repo'); });
    expect(getReviewDiff('/x', 'abc', 'def')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL**

Run: `pnpm vitest run src/__tests__/review-loop-diff.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// src/code-agents/review-loop-diff.ts
import { execSync } from 'child_process';

const MAX_DIFF_BYTES = 10 * 1024 * 1024;

export function getHeadSha(workdir: string): string | null {
  try {
    const out = execSync('git rev-parse HEAD', { cwd: workdir, encoding: 'buffer' });
    return out.toString('utf-8').trim();
  } catch {
    return null;
  }
}

export function getChangedFiles(workdir: string, fromRef: string, toRef: string): string[] {
  try {
    const out = execSync(`git diff --name-only ${fromRef}..${toRef}`, { cwd: workdir, encoding: 'buffer' });
    const text = out.toString('utf-8').trim();
    if (!text) return [];
    return text.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function getReviewDiff(workdir: string, fromRef: string, toRef: string): string | null {
  try {
    const out = execSync(`git diff ${fromRef}..${toRef}`, { cwd: workdir, encoding: 'buffer', maxBuffer: MAX_DIFF_BYTES });
    return out.toString('utf-8');
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `pnpm vitest run src/__tests__/review-loop-diff.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/code-agents/review-loop-diff.ts src/__tests__/review-loop-diff.test.ts
git commit -m "feat(review-loop): add git diff helpers for scoped reviewer input"
```

---

## Task 4: Prompt builders and JSON parsers

**Files:**
- Create: `src/code-agents/review-loop-prompts.ts`
- Test: `src/__tests__/review-loop-prompts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/review-loop-prompts.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildPlannerPrompt,
  buildDevPrompt,
  buildReviewerPrompt,
  parsePlannerOutput,
  parseReviewerOutput,
} from '../code-agents/review-loop-prompts.js';
import type { WorkItemState, ReviewFinding } from '../code-agents/review-loop-types.js';

function baseState(): WorkItemState {
  return {
    id: 'RL-010',
    title: 'X',
    prompt: 'Fix the login redirect.',
    workdir: '/repo',
    baseRef: 'HEAD',
    plannerModel: 'claude-opus',
    devModel: 'skimpyclaw',
    reviewerModel: 'claude-sonnet',
    maxIterations: 5,
    iteration: 0,
    status: 'planning',
    findings: [],
    chatMessages: [],
    timeline: [],
    createdAt: '2026-04-14T00:00:00Z',
    updatedAt: '2026-04-14T00:00:00Z',
  };
}

describe('review-loop-prompts', () => {
  it('buildPlannerPrompt includes prompt, chat, and findings', () => {
    const s = baseState();
    s.chatMessages = [
      { id: 'm-1', role: 'user', content: 'Prefer minimal diff.', createdAt: '2026-04-14T00:01Z' },
    ];
    s.findings = [
      { id: 'f-1-0', severity: 'medium', summary: 'X', status: 'open', iterationRaised: 1 },
    ];
    const p = buildPlannerPrompt(s);
    expect(p).toContain('Fix the login redirect.');
    expect(p).toContain('Prefer minimal diff.');
    expect(p).toContain('f-1-0');
    expect(p).toContain('JSON object');
  });

  it('buildDevPrompt includes only the current task and open findings', () => {
    const s = baseState();
    const task = 'Rewrite auth/login.ts to use the new helper.';
    const findings: ReviewFinding[] = [
      { id: 'f-1-0', severity: 'high', summary: 'missing null check', file: 'auth/login.ts', line: 42, status: 'open', iterationRaised: 1 },
    ];
    const p = buildDevPrompt(s, task, findings);
    expect(p).toContain('auth/login.ts');
    expect(p).toContain('missing null check');
    expect(p).toContain('Rewrite auth/login.ts');
  });

  it('buildReviewerPrompt includes diff and instructions', () => {
    const s = baseState();
    const p = buildReviewerPrompt(s, '+++ b/foo\n+new line', ['foo']);
    expect(p).toContain('+new line');
    expect(p).toContain('"verdict"');
    expect(p).toContain('foo');
  });

  it('parsePlannerOutput extracts JSON from fenced block', () => {
    const raw = 'thinking...\n```json\n{"status":"awaiting_approval","summary":"s","plan":"p"}\n```';
    const out = parsePlannerOutput(raw);
    expect(out).toEqual({ status: 'awaiting_approval', summary: 's', plan: 'p' });
  });

  it('parsePlannerOutput extracts JSON from raw object', () => {
    const raw = '{"status":"blocked","summary":"s","plan":"p","blocked_reason":"stuck"}';
    const out = parsePlannerOutput(raw);
    expect(out?.status).toBe('blocked');
    expect(out?.blocked_reason).toBe('stuck');
  });

  it('parsePlannerOutput returns null on invalid JSON', () => {
    expect(parsePlannerOutput('nope')).toBeNull();
  });

  it('parsePlannerOutput returns null when required fields missing', () => {
    expect(parsePlannerOutput('{"status":"awaiting_approval"}')).toBeNull();
  });

  it('parseReviewerOutput approved with empty findings', () => {
    const out = parseReviewerOutput('{"verdict":"approved","findings":[]}');
    expect(out).toEqual({ verdict: 'approved', findings: [] });
  });

  it('parseReviewerOutput changes_requested with findings', () => {
    const raw = '```json\n{"verdict":"changes_requested","findings":[{"severity":"low","summary":"nit"}]}\n```';
    const out = parseReviewerOutput(raw);
    expect(out?.findings).toHaveLength(1);
    expect(out?.findings[0]!.severity).toBe('low');
  });

  it('parseReviewerOutput rejects invalid severity', () => {
    expect(parseReviewerOutput('{"verdict":"changes_requested","findings":[{"severity":"xxx","summary":"s"}]}')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm vitest run src/__tests__/review-loop-prompts.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement prompts and parsers**

```ts
// src/code-agents/review-loop-prompts.ts
import type {
  WorkItemState,
  ReviewFinding,
  PlannerOutput,
  ReviewerOutput,
  FindingSeverity,
} from './review-loop-types.js';

const VALID_SEVERITIES: FindingSeverity[] = ['low', 'medium', 'high'];

export function buildPlannerPrompt(state: WorkItemState): string {
  const chat = state.chatMessages.length
    ? state.chatMessages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n')
    : '(none)';
  const findings = state.findings.length
    ? state.findings.map(f => `- [${f.id}] (${f.severity}) ${f.summary}${f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ''}` : ''} [${f.status}]`).join('\n')
    : '(none)';
  return [
    'You are the PLANNER for an iterative review loop. You decompose the user goal into one concrete dev task per iteration, or declare the work blocked.',
    '',
    `ORIGINAL GOAL:\n${state.prompt}`,
    '',
    `ITERATION: ${state.iteration} of ${state.maxIterations}`,
    '',
    `USER CHAT HISTORY:\n${chat}`,
    '',
    `OPEN FINDINGS:\n${findings}`,
    '',
    state.currentPlan ? `PREVIOUS PLAN:\n${state.currentPlan}\n` : '',
    'Return ONLY a JSON object matching this shape (no prose outside the JSON):',
    '```json',
    '{',
    '  "status": "awaiting_approval" | "revising" | "blocked",',
    '  "summary": "one-paragraph state summary",',
    '  "plan": "markdown plan shown to the user",',
    '  "next_dev_task": "concrete task for the dev agent (required when status=revising)",',
    '  "blocked_reason": "why the work cannot proceed (required when status=blocked)",',
    '  "resolved_finding_ids": ["f-1-0"]',
    '}',
    '```',
    'Rules:',
    '- Use "awaiting_approval" on the very first plan or after substantive user chat changes the plan.',
    '- Use "revising" to issue a dev task in response to reviewer findings.',
    '- Use "blocked" if you cannot make progress (conflicting findings, external dependency, etc.).',
  ].join('\n');
}

export function buildDevPrompt(state: WorkItemState, task: string, findings: ReviewFinding[]): string {
  const findingsBlock = findings.length
    ? findings.map(f => `- [${f.id}] (${f.severity}) ${f.summary}${f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ''}` : ''}`).join('\n')
    : '(no open findings — this is the initial implementation)';
  return [
    'You are the DEV agent for an iterative review loop.',
    '',
    `ORIGINAL GOAL:\n${state.prompt}`,
    '',
    `YOUR TASK FOR THIS ITERATION (${state.iteration + 1} of ${state.maxIterations}):\n${task}`,
    '',
    `OPEN REVIEWER FINDINGS:\n${findingsBlock}`,
    '',
    `WORKDIR: ${state.workdir}`,
    '',
    'Constraints:',
    '- Modify code and tests.',
    '- Do NOT change unrelated files.',
    '- When done, ensure the repo builds and tests pass.',
    '- Report the list of files you changed in your final message.',
  ].join('\n');
}

export function buildReviewerPrompt(state: WorkItemState, diff: string, changedFiles: string[]): string {
  const filesList = changedFiles.length ? changedFiles.join('\n') : '(none)';
  return [
    'You are the REVIEWER for an iterative review loop. You review ONLY the delta shown below — do not re-litigate code outside this diff.',
    '',
    `ORIGINAL GOAL:\n${state.prompt}`,
    '',
    `CHANGED FILES:\n${filesList}`,
    '',
    `DIFF:\n${diff}`,
    '',
    'Return ONLY a JSON object matching this shape (no prose outside the JSON):',
    '```json',
    '{',
    '  "verdict": "approved" | "changes_requested",',
    '  "findings": [',
    '    { "severity": "low" | "medium" | "high", "summary": "...", "file": "path", "line": 42 }',
    '  ],',
    '  "note": "optional overall comment"',
    '}',
    '```',
    'If you have no findings, return verdict="approved" with findings=[].',
    'Do not suggest fixes — only describe the problem, file, and line.',
  ].join('\n');
}

function extractJsonBlock(raw: string): string | null {
  // 1. Try fenced ```json ... ``` block
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence) return fence[1]!.trim();
  // 2. Try to find first { ... matching } at top level
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

export function parsePlannerOutput(raw: string): PlannerOutput | null {
  const block = extractJsonBlock(raw);
  if (!block) return null;
  let obj: any;
  try { obj = JSON.parse(block); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (!['awaiting_approval', 'revising', 'blocked'].includes(obj.status)) return null;
  if (typeof obj.summary !== 'string' || typeof obj.plan !== 'string') return null;
  if (obj.status === 'revising' && typeof obj.next_dev_task !== 'string') return null;
  if (obj.status === 'blocked' && typeof obj.blocked_reason !== 'string') return null;
  return {
    status: obj.status,
    summary: obj.summary,
    plan: obj.plan,
    next_dev_task: typeof obj.next_dev_task === 'string' ? obj.next_dev_task : undefined,
    blocked_reason: typeof obj.blocked_reason === 'string' ? obj.blocked_reason : undefined,
    resolved_finding_ids: Array.isArray(obj.resolved_finding_ids)
      ? obj.resolved_finding_ids.filter((x: unknown) => typeof x === 'string')
      : undefined,
  };
}

export function parseReviewerOutput(raw: string): ReviewerOutput | null {
  const block = extractJsonBlock(raw);
  if (!block) return null;
  let obj: any;
  try { obj = JSON.parse(block); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (!['approved', 'changes_requested'].includes(obj.verdict)) return null;
  if (!Array.isArray(obj.findings)) return null;
  const findings: ReviewerOutput['findings'] = [];
  for (const f of obj.findings) {
    if (!f || typeof f !== 'object') return null;
    if (!VALID_SEVERITIES.includes(f.severity)) return null;
    if (typeof f.summary !== 'string') return null;
    findings.push({
      severity: f.severity,
      summary: f.summary,
      file: typeof f.file === 'string' ? f.file : undefined,
      line: typeof f.line === 'number' ? f.line : undefined,
    });
  }
  return {
    verdict: obj.verdict,
    findings,
    note: typeof obj.note === 'string' ? obj.note : undefined,
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `pnpm vitest run src/__tests__/review-loop-prompts.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/code-agents/review-loop-prompts.ts src/__tests__/review-loop-prompts.test.ts
git commit -m "feat(review-loop): add prompt builders and strict JSON contract parsers"
```

---

## Task 5: State-machine scaffolding — `createWorkItem`, `getWorkItem`, `listWorkItems`

**Files:**
- Create: `src/code-agents/review-loop.ts`
- Test: `src/__tests__/review-loop.test.ts`

- [ ] **Step 1: Write the failing test (creation only)**

```ts
// src/__tests__/review-loop.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../code-agents/review-loop-diff.js', () => ({
  getHeadSha: vi.fn(() => 'abc123'),
  getChangedFiles: vi.fn(() => []),
  getReviewDiff: vi.fn(() => ''),
}));

// runCodeAgentBackground will be mocked in later tasks; stub now so import works
vi.mock('../code-agents/executor.js', () => ({
  runCodeAgentBackground: vi.fn(async () => {}),
}));

import { setWorkRootForTesting } from '../code-agents/review-loop-storage.js';
import { createWorkItem, getWorkItem, listWorkItems } from '../code-agents/review-loop.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'work-'));
  setWorkRootForTesting(tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  setWorkRootForTesting(null);
});

describe('review-loop: create/get/list', () => {
  it('createWorkItem initializes planning state with defaults', () => {
    const s = createWorkItem({ prompt: 'Fix auth', workdir: '/repo' });
    expect(s.id).toBe('RL-001');
    expect(s.status).toBe('planning');
    expect(s.iteration).toBe(0);
    expect(s.plannerModel).toBe('claude-opus');
    expect(s.devModel).toBe('skimpyclaw');
    expect(s.reviewerModel).toBe('claude-sonnet');
    expect(s.maxIterations).toBe(5);
    expect(s.baseRef).toBe('HEAD');
    expect(s.title).toContain('Fix auth');
    expect(s.timeline).toHaveLength(1);
    expect(s.timeline[0]!.kind).toBe('created');
  });

  it('createWorkItem records an initial timeline event', () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    expect(s.timeline[0]!.kind).toBe('created');
    expect(s.timeline[0]!.iteration).toBe(0);
  });

  it('createWorkItem accepts overrides', () => {
    const s = createWorkItem({
      prompt: 'X', workdir: '/r',
      plannerModel: 'alt-planner', devModel: 'alt-dev',
      reviewerModel: 'alt-reviewer', maxIterations: 2, baseRef: 'main',
    });
    expect(s.plannerModel).toBe('alt-planner');
    expect(s.devModel).toBe('alt-dev');
    expect(s.reviewerModel).toBe('alt-reviewer');
    expect(s.maxIterations).toBe(2);
    expect(s.baseRef).toBe('main');
  });

  it('getWorkItem returns persisted state; listWorkItems returns it', () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    expect(getWorkItem(s.id)).toMatchObject({ id: s.id, status: 'planning' });
    expect(listWorkItems().map(w => w.id)).toContain(s.id);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm vitest run src/__tests__/review-loop.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the scaffold**

```ts
// src/code-agents/review-loop.ts
import type {
  CreateWorkInput,
  WorkItemState,
  TimelineEvent,
  TimelineEventKind,
  ChatMessage,
} from './review-loop-types.js';
import {
  loadWorkItem,
  saveWorkItem,
  listWorkItems as storageList,
  nextWorkItemId,
} from './review-loop-storage.js';

const DEFAULT_PLANNER = 'claude-opus';
const DEFAULT_DEV = 'skimpyclaw';
const DEFAULT_REVIEWER = 'claude-sonnet';
const DEFAULT_MAX_ITERATIONS = 5;
const DEFAULT_BASE_REF = 'HEAD';

function deriveTitle(prompt: string): string {
  const first = prompt.trim().split('\n')[0] ?? '';
  return first.length > 60 ? first.slice(0, 60) + '…' : first;
}

function nextTimelineId(state: WorkItemState): string {
  return `t-${state.timeline.length + 1}`;
}

export function appendTimelineEvent(
  state: WorkItemState,
  kind: TimelineEventKind,
  summary: string,
  extra?: Partial<TimelineEvent>,
): TimelineEvent {
  const ev: TimelineEvent = {
    id: nextTimelineId(state),
    kind,
    iteration: state.iteration,
    at: new Date().toISOString(),
    summary,
    ...extra,
  };
  state.timeline.push(ev);
  return ev;
}

export function createWorkItem(input: CreateWorkInput): WorkItemState {
  const id = nextWorkItemId();
  const now = new Date().toISOString();
  const state: WorkItemState = {
    id,
    title: deriveTitle(input.prompt),
    prompt: input.prompt,
    workdir: input.workdir,
    baseRef: input.baseRef ?? DEFAULT_BASE_REF,
    plannerModel: input.plannerModel ?? DEFAULT_PLANNER,
    devModel: input.devModel ?? DEFAULT_DEV,
    reviewerModel: input.reviewerModel ?? DEFAULT_REVIEWER,
    maxIterations: input.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    iteration: 0,
    status: 'planning',
    findings: [],
    chatMessages: [],
    timeline: [],
    createdAt: now,
    updatedAt: now,
  };
  appendTimelineEvent(state, 'created', `Work item created: ${state.title}`);
  saveWorkItem(state);
  return state;
}

export function getWorkItem(id: string): WorkItemState | null {
  return loadWorkItem(id);
}

export function listWorkItems(): WorkItemState[] {
  return storageList();
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `pnpm vitest run src/__tests__/review-loop.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/code-agents/review-loop.ts src/__tests__/review-loop.test.ts
git commit -m "feat(review-loop): scaffold state-machine module with create/get/list"
```

---

## Task 6: User chat and control actions (approve/pause/resume/stop)

**Files:**
- Modify: `src/code-agents/review-loop.ts`
- Modify: `src/__tests__/review-loop.test.ts`

- [ ] **Step 1: Extend test file with control-action tests**

Add to `src/__tests__/review-loop.test.ts`:

```ts
import {
  appendUserMessage,
  approvePlan,
  pauseWorkItem,
  resumeWorkItem,
  stopWorkItem,
} from '../code-agents/review-loop.js';

describe('review-loop: user actions', () => {
  it('appendUserMessage adds to chat and flags pendingUserMessage', () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    const updated = appendUserMessage(s.id, 'prefer minimal diff');
    expect(updated?.chatMessages).toHaveLength(1);
    expect(updated?.chatMessages[0]!.content).toBe('prefer minimal diff');
    expect(updated?.chatMessages[0]!.role).toBe('user');
    expect(updated?.pendingUserMessage).toBe(true);
  });

  it('appendUserMessage returns null if item missing', () => {
    expect(appendUserMessage('RL-999', 'hi')).toBeNull();
  });

  it('approvePlan transitions awaiting_approval → implementing', () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    // simulate planner having run
    s.status = 'awaiting_approval';
    s.currentPlan = 'plan body';
    (require('../code-agents/review-loop-storage.js') as any).saveWorkItem(s);
    const updated = approvePlan(s.id);
    expect(updated?.status).toBe('implementing');
    expect(updated?.timeline.some(t => t.kind === 'plan-approved')).toBe(true);
  });

  it('approvePlan rejects when not awaiting_approval', () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    const updated = approvePlan(s.id);
    expect(updated).toBeNull();
  });

  it('pauseWorkItem saves previousStatus and transitions to paused', () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    s.status = 'implementing';
    (require('../code-agents/review-loop-storage.js') as any).saveWorkItem(s);
    const updated = pauseWorkItem(s.id);
    expect(updated?.status).toBe('paused');
    expect(updated?.previousStatus).toBe('implementing');
  });

  it('resumeWorkItem restores previousStatus', () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    s.status = 'paused';
    s.previousStatus = 'reviewing';
    (require('../code-agents/review-loop-storage.js') as any).saveWorkItem(s);
    const updated = resumeWorkItem(s.id);
    expect(updated?.status).toBe('reviewing');
    expect(updated?.previousStatus).toBeUndefined();
  });

  it('stopWorkItem transitions to terminal stopped', () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    const updated = stopWorkItem(s.id, 'user requested');
    expect(updated?.status).toBe('stopped');
    expect(updated?.stoppedReason).toBe('user requested');
    expect(updated?.timeline.some(t => t.kind === 'stopped')).toBe(true);
  });

  it('stopWorkItem is idempotent on already-stopped items', () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    stopWorkItem(s.id);
    const second = stopWorkItem(s.id);
    expect(second?.status).toBe('stopped');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `pnpm vitest run src/__tests__/review-loop.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement the control actions**

Append to `src/code-agents/review-loop.ts`:

```ts
function nextChatId(state: WorkItemState): string {
  return `m-${state.chatMessages.length + 1}`;
}

export function appendUserMessage(id: string, content: string): WorkItemState | null {
  const state = loadWorkItem(id);
  if (!state) return null;
  const msg: ChatMessage = {
    id: nextChatId(state),
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
  };
  state.chatMessages.push(msg);
  state.pendingUserMessage = true;
  saveWorkItem(state);
  return state;
}

export function approvePlan(id: string): WorkItemState | null {
  const state = loadWorkItem(id);
  if (!state) return null;
  if (state.status !== 'awaiting_approval') return null;
  state.status = 'implementing';
  appendTimelineEvent(state, 'plan-approved', 'Plan approved by user');
  saveWorkItem(state);
  return state;
}

export function pauseWorkItem(id: string): WorkItemState | null {
  const state = loadWorkItem(id);
  if (!state) return null;
  if (state.status === 'paused' || state.status === 'done' || state.status === 'blocked' || state.status === 'stopped') {
    return state;
  }
  state.previousStatus = state.status;
  state.status = 'paused';
  appendTimelineEvent(state, 'paused', 'Paused by user');
  saveWorkItem(state);
  return state;
}

export function resumeWorkItem(id: string): WorkItemState | null {
  const state = loadWorkItem(id);
  if (!state) return null;
  if (state.status !== 'paused') return state;
  const restore = state.previousStatus ?? 'planning';
  state.status = restore;
  state.previousStatus = undefined;
  appendTimelineEvent(state, 'resumed', `Resumed to ${restore}`);
  saveWorkItem(state);
  return state;
}

export function stopWorkItem(id: string, reason?: string): WorkItemState | null {
  const state = loadWorkItem(id);
  if (!state) return null;
  if (state.status === 'stopped') return state;
  state.status = 'stopped';
  state.stoppedReason = reason;
  state.liveActivity = undefined;
  appendTimelineEvent(state, 'stopped', reason ?? 'Stopped by user');
  saveWorkItem(state);
  return state;
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `pnpm vitest run src/__tests__/review-loop.test.ts`
Expected: PASS (all previous + 8 new)

- [ ] **Step 5: Commit**

```bash
git add src/code-agents/review-loop.ts src/__tests__/review-loop.test.ts
git commit -m "feat(review-loop): add user actions (chat, approve, pause, resume, stop)"
```

---

## Task 7: Agent invocation helper — spawn a one-shot `runCodeAgentBackground` and await completion

The engine needs a helper that spawns `runCodeAgentBackground`, then blocks until the underlying `CodeAgentTask` reaches a terminal status, and returns the task's `outputPreview` plus exit metadata. This lets the tick function treat each agent invocation as a synchronous step from the caller's perspective, while still using the existing background infrastructure (worktrees, streaming output, live status file, usage tracking).

**Files:**
- Modify: `src/code-agents/review-loop.ts`
- Modify: `src/__tests__/review-loop.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/review-loop.test.ts`:

```ts
import * as executor from '../code-agents/executor.js';
import * as registry from '../code-agents/registry.js';
import { runAgentStep } from '../code-agents/review-loop.js';

describe('review-loop: runAgentStep', () => {
  it('spawns runCodeAgentBackground and polls registry until completion', async () => {
    const mockTask = {
      id: 'ca-99',
      agent: 'claude',
      status: 'completed' as const,
      outputPreview: '{"verdict":"approved","findings":[]}',
      task: 't',
      startedAt: new Date().toISOString(),
      workdir: '/r',
    };
    vi.spyOn(registry, 'getCodeAgent').mockReturnValue(mockTask as any);
    vi.spyOn(registry, 'getNextCodeAgentId').mockReturnValue('ca-99');
    vi.spyOn(registry, 'storeCodeAgentTask').mockImplementation(() => {});
    vi.spyOn(registry, 'writeCodeAgentTask').mockImplementation(() => {});
    vi.spyOn(executor, 'runCodeAgentBackground').mockResolvedValue(undefined);

    const result = await runAgentStep({
      agent: 'claude',
      model: 'claude-sonnet',
      task: 'review this',
      workdir: '/r',
      validate: false,
      pollIntervalMs: 5,
    });
    expect(result.status).toBe('completed');
    expect(result.outputPreview).toContain('approved');
    expect(result.codeAgentTaskId).toBe('ca-99');
  });

  it('times out if polling never sees terminal status', async () => {
    const running = { id: 'ca-1', status: 'running', task: 't', agent: 'claude', startedAt: new Date().toISOString(), workdir: '/r' };
    vi.spyOn(registry, 'getCodeAgent').mockReturnValue(running as any);
    vi.spyOn(registry, 'getNextCodeAgentId').mockReturnValue('ca-1');
    vi.spyOn(registry, 'storeCodeAgentTask').mockImplementation(() => {});
    vi.spyOn(registry, 'writeCodeAgentTask').mockImplementation(() => {});
    vi.spyOn(executor, 'runCodeAgentBackground').mockResolvedValue(undefined);

    await expect(runAgentStep({
      agent: 'claude', model: 'm', task: 't', workdir: '/r', validate: false,
      pollIntervalMs: 5, timeoutMs: 20,
    })).rejects.toThrow(/timed out/i);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm vitest run src/__tests__/review-loop.test.ts -t runAgentStep`
Expected: FAIL — `runAgentStep` not exported

- [ ] **Step 3: Implement `runAgentStep`**

Append to `src/code-agents/review-loop.ts`:

```ts
import {
  getNextCodeAgentId,
  storeCodeAgentTask,
  writeCodeAgentTask,
  getCodeAgent,
} from './registry.js';
import { runCodeAgentBackground } from './executor.js';
import type { CodeAgentTask } from './types.js';

export interface RunAgentStepInput {
  agent: string;               // 'claude' | 'codex' | 'skimpyclaw' — matches existing resolution
  model?: string;
  task: string;
  workdir: string;
  validate: boolean;
  timeoutMs?: number;          // default 30 min
  pollIntervalMs?: number;     // default 1500 ms
}

export interface RunAgentStepResult {
  codeAgentTaskId: string;
  status: CodeAgentTask['status'];
  outputPreview?: string;
  error?: string;
  totalCost?: number;
}

const TERMINAL_CA_STATUSES: Array<CodeAgentTask['status']> = [
  'completed', 'failed', 'timeout', 'cancelled',
];

export async function runAgentStep(input: RunAgentStepInput): Promise<RunAgentStepResult> {
  const id = getNextCodeAgentId();
  const startedAt = new Date();
  const task: CodeAgentTask = {
    id,
    agent: input.agent,
    task: input.task,
    status: 'running',
    startedAt: startedAt.toISOString(),
    workdir: input.workdir,
    model: input.model,
  };
  storeCodeAgentTask(task);
  writeCodeAgentTask(task);

  await runCodeAgentBackground(
    id,
    input.agent,
    input.task,
    input.workdir,
    input.validate,
    { model: input.model, task: input.task },
    startedAt,
    { defaultTimeoutMinutes: Math.ceil((input.timeoutMs ?? 30 * 60 * 1000) / 60000) },
  );

  // runCodeAgentBackground returns once it has kicked off; the registry is
  // updated as the subprocess progresses. Poll until terminal.
  const poll = input.pollIntervalMs ?? 1500;
  const deadline = Date.now() + (input.timeoutMs ?? 30 * 60 * 1000);

  while (Date.now() < deadline) {
    const current = getCodeAgent(id);
    if (current && TERMINAL_CA_STATUSES.includes(current.status)) {
      return {
        codeAgentTaskId: id,
        status: current.status,
        outputPreview: current.outputPreview,
        error: current.error,
        totalCost: current.totalCost,
      };
    }
    await new Promise(r => setTimeout(r, poll));
  }
  throw new Error(`Agent step ${id} timed out`);
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `pnpm vitest run src/__tests__/review-loop.test.ts -t runAgentStep`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/code-agents/review-loop.ts src/__tests__/review-loop.test.ts
git commit -m "feat(review-loop): add runAgentStep wrapper for synchronous agent invocations"
```

---

## Task 8: `tickWorkItem` — planning step

The tick function is the single entry point that advances the machine. On this task we implement only the `planning` branch: run planner, parse its JSON, either park in `awaiting_approval`, emit a dev task (→ `implementing`), or go `blocked`.

**Files:**
- Modify: `src/code-agents/review-loop.ts`
- Modify: `src/__tests__/review-loop.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/review-loop.test.ts`:

```ts
import * as reviewLoop from '../code-agents/review-loop.js';
import { tickWorkItem } from '../code-agents/review-loop.js';

describe('tickWorkItem: planning', () => {
  it('transitions planning → awaiting_approval with plan text', async () => {
    const s = createWorkItem({ prompt: 'Fix login', workdir: '/r' });

    vi.spyOn(reviewLoop, 'runAgentStep').mockResolvedValue({
      codeAgentTaskId: 'ca-10',
      status: 'completed',
      outputPreview: '{"status":"awaiting_approval","summary":"sum","plan":"PLAN BODY"}',
    });

    const updated = await tickWorkItem(s.id);
    expect(updated?.status).toBe('awaiting_approval');
    expect(updated?.currentPlan).toBe('PLAN BODY');
    expect(updated?.chatMessages.find(m => m.role === 'planner')?.content).toBe('PLAN BODY');
    expect(updated?.timeline.some(t => t.kind === 'plan-produced')).toBe(true);
    expect(updated?.pendingUserMessage).toBe(false);
  });

  it('planning + revising output → transitions to implementing and records next_dev_task', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });

    vi.spyOn(reviewLoop, 'runAgentStep').mockResolvedValue({
      codeAgentTaskId: 'ca-11',
      status: 'completed',
      outputPreview: '{"status":"revising","summary":"s","plan":"P","next_dev_task":"Do X"}',
    });

    const updated = await tickWorkItem(s.id);
    expect(updated?.status).toBe('implementing');
    expect(updated?.currentPlan).toBe('P');
  });

  it('planner output blocked → transitions to blocked', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });

    vi.spyOn(reviewLoop, 'runAgentStep').mockResolvedValue({
      codeAgentTaskId: 'ca-12',
      status: 'completed',
      outputPreview: '{"status":"blocked","summary":"s","plan":"P","blocked_reason":"no creds"}',
    });

    const updated = await tickWorkItem(s.id);
    expect(updated?.status).toBe('blocked');
    expect(updated?.blockedReason).toBe('no creds');
  });

  it('invalid planner JSON → blocked with reason', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    vi.spyOn(reviewLoop, 'runAgentStep').mockResolvedValue({
      codeAgentTaskId: 'ca-13',
      status: 'completed',
      outputPreview: 'not json at all',
    });
    const updated = await tickWorkItem(s.id);
    expect(updated?.status).toBe('blocked');
    expect(updated?.blockedReason).toMatch(/planner/i);
  });

  it('agent step failed → blocked', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    vi.spyOn(reviewLoop, 'runAgentStep').mockResolvedValue({
      codeAgentTaskId: 'ca-14',
      status: 'failed',
      error: 'network',
    });
    const updated = await tickWorkItem(s.id);
    expect(updated?.status).toBe('blocked');
    expect(updated?.blockedReason).toContain('network');
  });

  it('tick on paused item is a no-op', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    s.status = 'paused';
    (require('../code-agents/review-loop-storage.js') as any).saveWorkItem(s);
    const spy = vi.spyOn(reviewLoop, 'runAgentStep');
    const updated = await tickWorkItem(s.id);
    expect(updated?.status).toBe('paused');
    expect(spy).not.toHaveBeenCalled();
  });

  it('tick on done/blocked/stopped items is a no-op', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    const spy = vi.spyOn(reviewLoop, 'runAgentStep');
    for (const status of ['done', 'blocked', 'stopped'] as const) {
      s.status = status;
      (require('../code-agents/review-loop-storage.js') as any).saveWorkItem(s);
      const u = await tickWorkItem(s.id);
      expect(u?.status).toBe(status);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm vitest run src/__tests__/review-loop.test.ts -t "tickWorkItem: planning"`
Expected: FAIL — `tickWorkItem` not exported.

- [ ] **Step 3: Implement `tickWorkItem` (planning branch only)**

Append to `src/code-agents/review-loop.ts`:

```ts
import { buildPlannerPrompt, parsePlannerOutput } from './review-loop-prompts.js';

function markBlocked(state: WorkItemState, reason: string): void {
  state.status = 'blocked';
  state.blockedReason = reason;
  state.liveActivity = undefined;
  appendTimelineEvent(state, 'blocked', reason);
}

async function runPlanner(state: WorkItemState): Promise<WorkItemState> {
  const prompt = buildPlannerPrompt(state);
  state.liveActivity = {
    agent: 'planner',
    codeAgentTaskId: '(pending)',
    startedAt: new Date().toISOString(),
  };
  saveWorkItem(state);

  const result = await runAgentStep({
    agent: 'claude',
    model: state.plannerModel,
    task: prompt,
    workdir: state.workdir,
    validate: false,
  });
  state.liveActivity = undefined;

  if (result.status !== 'completed' || !result.outputPreview) {
    markBlocked(state, `planner step ${result.status}: ${result.error ?? 'no output'}`);
    saveWorkItem(state);
    return state;
  }

  const parsed = parsePlannerOutput(result.outputPreview);
  if (!parsed) {
    markBlocked(state, 'planner returned invalid JSON');
    saveWorkItem(state);
    return state;
  }

  state.currentPlan = parsed.plan;
  state.chatMessages.push({
    id: nextChatId(state),
    role: 'planner',
    content: parsed.plan,
    createdAt: new Date().toISOString(),
  });
  state.pendingUserMessage = false;
  appendTimelineEvent(state, 'plan-produced', parsed.summary, { codeAgentTaskId: result.codeAgentTaskId });

  if (parsed.status === 'awaiting_approval') {
    state.status = 'awaiting_approval';
  } else if (parsed.status === 'revising') {
    if (!parsed.next_dev_task) {
      markBlocked(state, 'planner status=revising but no next_dev_task');
    } else {
      // stash next dev task on the latest timeline event note for Task 9 to consume
      const lastEvent = state.timeline[state.timeline.length - 1]!;
      lastEvent.note = parsed.next_dev_task;
      state.status = 'implementing';
    }
  } else {
    markBlocked(state, parsed.blocked_reason ?? 'planner returned blocked');
  }

  saveWorkItem(state);
  return state;
}

export async function tickWorkItem(id: string): Promise<WorkItemState | null> {
  const state = loadWorkItem(id);
  if (!state) return null;

  // No-op on terminal or paused
  if (['paused', 'done', 'blocked', 'stopped'].includes(state.status)) {
    return state;
  }

  // Iteration cap
  if (state.iteration >= state.maxIterations && state.status !== 'planning') {
    markBlocked(state, `max iterations (${state.maxIterations}) reached`);
    saveWorkItem(state);
    return state;
  }

  switch (state.status) {
    case 'planning':
    case 'revising':
      return runPlanner(state);
    case 'awaiting_approval':
      // nothing to do automatically — user must approve via approvePlan()
      return state;
    case 'implementing':
      // implemented in Task 9
      return state;
    case 'reviewing':
      // implemented in Task 10
      return state;
    default:
      return state;
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `pnpm vitest run src/__tests__/review-loop.test.ts -t "tickWorkItem: planning"`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/code-agents/review-loop.ts src/__tests__/review-loop.test.ts
git commit -m "feat(review-loop): tickWorkItem planning branch with structured planner output"
```

---

## Task 9: `tickWorkItem` — implementing branch (dev agent)

**Files:**
- Modify: `src/code-agents/review-loop.ts`
- Modify: `src/__tests__/review-loop.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/review-loop.test.ts`:

```ts
import * as diff from '../code-agents/review-loop-diff.js';

describe('tickWorkItem: implementing', () => {
  it('runs dev agent, captures changed files, transitions to reviewing, increments iteration', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    // prime: planner produced a revising plan with next_dev_task
    s.status = 'implementing';
    s.timeline.push({
      id: 't-2', kind: 'plan-produced', iteration: 0, at: new Date().toISOString(),
      summary: 's', note: 'Do the thing',
    });
    s.lastReviewCommit = 'base123';
    (require('../code-agents/review-loop-storage.js') as any).saveWorkItem(s);

    vi.spyOn(diff, 'getHeadSha').mockReturnValue('head456');
    vi.spyOn(diff, 'getChangedFiles').mockReturnValue(['a.ts', 'b.ts']);

    vi.spyOn(reviewLoop, 'runAgentStep').mockResolvedValue({
      codeAgentTaskId: 'ca-20',
      status: 'completed',
      outputPreview: 'done',
    });

    const updated = await tickWorkItem(s.id);
    expect(updated?.status).toBe('reviewing');
    expect(updated?.iteration).toBe(1);
    const devEvent = updated?.timeline.find(t => t.kind === 'dev-completed');
    expect(devEvent?.changedFiles).toEqual(['a.ts', 'b.ts']);
    expect(devEvent?.codeAgentTaskId).toBe('ca-20');
  });

  it('dev failure → blocked', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    s.status = 'implementing';
    s.timeline.push({ id: 't-2', kind: 'plan-produced', iteration: 0, at: '', summary: '', note: 'task' });
    (require('../code-agents/review-loop-storage.js') as any).saveWorkItem(s);

    vi.spyOn(reviewLoop, 'runAgentStep').mockResolvedValue({
      codeAgentTaskId: 'ca-21', status: 'failed', error: 'boom',
    });
    const updated = await tickWorkItem(s.id);
    expect(updated?.status).toBe('blocked');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm vitest run src/__tests__/review-loop.test.ts -t "tickWorkItem: implementing"`
Expected: FAIL — branch not implemented; test returns state with status='implementing'.

- [ ] **Step 3: Implement the implementing branch**

Modify `src/code-agents/review-loop.ts`:

Add import at top:
```ts
import { getHeadSha, getChangedFiles } from './review-loop-diff.js';
import { buildDevPrompt } from './review-loop-prompts.js';
```

Add function:
```ts
function findPendingDevTask(state: WorkItemState): string | null {
  // Walk timeline backwards for most recent plan-produced event with a note
  for (let i = state.timeline.length - 1; i >= 0; i--) {
    const ev = state.timeline[i]!;
    if (ev.kind === 'plan-produced' && ev.note) return ev.note;
  }
  return null;
}

async function runDev(state: WorkItemState): Promise<WorkItemState> {
  const task = findPendingDevTask(state);
  if (!task) {
    markBlocked(state, 'no pending dev task found for implementing state');
    saveWorkItem(state);
    return state;
  }

  const openFindings = state.findings.filter(f => f.status === 'open');
  const devPrompt = buildDevPrompt(state, task, openFindings);

  state.liveActivity = {
    agent: 'dev',
    codeAgentTaskId: '(pending)',
    startedAt: new Date().toISOString(),
  };
  appendTimelineEvent(state, 'dev-started', 'Dev agent started');
  saveWorkItem(state);

  const result = await runAgentStep({
    agent: 'claude',           // provider adapter resolves skimpyclaw model to claude CLI
    model: state.devModel,
    task: devPrompt,
    workdir: state.workdir,
    validate: true,
  });
  state.liveActivity = undefined;

  if (result.status !== 'completed') {
    markBlocked(state, `dev step ${result.status}: ${result.error ?? 'no output'}`);
    saveWorkItem(state);
    return state;
  }

  const fromRef = state.lastReviewCommit ?? state.baseRef;
  const headSha = getHeadSha(state.workdir) ?? 'HEAD';
  const changedFiles = getChangedFiles(state.workdir, fromRef, headSha);

  state.iteration += 1;
  state.status = 'reviewing';
  appendTimelineEvent(state, 'dev-completed', `Dev agent produced ${changedFiles.length} file changes`, {
    changedFiles,
    codeAgentTaskId: result.codeAgentTaskId,
  });
  if (typeof result.totalCost === 'number') {
    state.cost = (state.cost ?? 0) + result.totalCost;
  }
  saveWorkItem(state);
  return state;
}
```

Update switch in `tickWorkItem`:
```ts
case 'implementing':
  return runDev(state);
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `pnpm vitest run src/__tests__/review-loop.test.ts -t "tickWorkItem: implementing"`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/code-agents/review-loop.ts src/__tests__/review-loop.test.ts
git commit -m "feat(review-loop): tickWorkItem implementing branch — spawn dev, collect changed files"
```

---

## Task 10: `tickWorkItem` — reviewing branch

**Files:**
- Modify: `src/code-agents/review-loop.ts`
- Modify: `src/__tests__/review-loop.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/review-loop.test.ts`:

```ts
describe('tickWorkItem: reviewing', () => {
  function primedReviewingState() {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    s.status = 'reviewing';
    s.iteration = 1;
    s.lastReviewCommit = 'base';
    s.timeline.push({
      id: 't-2', kind: 'dev-completed', iteration: 1,
      at: '', summary: '', changedFiles: ['a.ts'], codeAgentTaskId: 'ca-dev',
    });
    (require('../code-agents/review-loop-storage.js') as any).saveWorkItem(s);
    return s;
  }

  it('approved verdict → status done, lastReviewCommit updated, timeline records done', async () => {
    const s = primedReviewingState();

    vi.spyOn(diff, 'getHeadSha').mockReturnValue('new-sha');
    vi.spyOn(diff, 'getReviewDiff').mockReturnValue('+++ diff');
    vi.spyOn(diff, 'getChangedFiles').mockReturnValue(['a.ts']);
    vi.spyOn(reviewLoop, 'runAgentStep').mockResolvedValue({
      codeAgentTaskId: 'ca-rev-1',
      status: 'completed',
      outputPreview: '{"verdict":"approved","findings":[]}',
    });

    const updated = await tickWorkItem(s.id);
    expect(updated?.status).toBe('done');
    expect(updated?.lastReviewCommit).toBe('new-sha');
    expect(updated?.timeline.some(t => t.kind === 'done')).toBe(true);
  });

  it('changes_requested → status revising, findings appended with iteration tag', async () => {
    const s = primedReviewingState();

    vi.spyOn(diff, 'getHeadSha').mockReturnValue('new-sha');
    vi.spyOn(diff, 'getReviewDiff').mockReturnValue('diff');
    vi.spyOn(diff, 'getChangedFiles').mockReturnValue(['a.ts']);
    vi.spyOn(reviewLoop, 'runAgentStep').mockResolvedValue({
      codeAgentTaskId: 'ca-rev-2',
      status: 'completed',
      outputPreview: '{"verdict":"changes_requested","findings":[{"severity":"high","summary":"broken","file":"a.ts","line":10}]}',
    });

    const updated = await tickWorkItem(s.id);
    expect(updated?.status).toBe('revising');
    expect(updated?.findings).toHaveLength(1);
    expect(updated?.findings[0]!.id).toBe('f-1-0');
    expect(updated?.findings[0]!.iterationRaised).toBe(1);
    expect(updated?.findings[0]!.status).toBe('open');
  });

  it('iteration cap reached on changes_requested → blocked', async () => {
    const s = primedReviewingState();
    s.maxIterations = 1;
    (require('../code-agents/review-loop-storage.js') as any).saveWorkItem(s);

    vi.spyOn(diff, 'getHeadSha').mockReturnValue('new-sha');
    vi.spyOn(diff, 'getReviewDiff').mockReturnValue('diff');
    vi.spyOn(diff, 'getChangedFiles').mockReturnValue(['a.ts']);
    vi.spyOn(reviewLoop, 'runAgentStep').mockResolvedValue({
      codeAgentTaskId: 'ca-rev-3',
      status: 'completed',
      outputPreview: '{"verdict":"changes_requested","findings":[{"severity":"low","summary":"x"}]}',
    });

    const updated = await tickWorkItem(s.id);
    expect(updated?.status).toBe('blocked');
    expect(updated?.blockedReason).toMatch(/max iterations/i);
  });

  it('reviewer returns bad JSON → blocked', async () => {
    const s = primedReviewingState();
    vi.spyOn(diff, 'getHeadSha').mockReturnValue('new-sha');
    vi.spyOn(diff, 'getReviewDiff').mockReturnValue('diff');
    vi.spyOn(diff, 'getChangedFiles').mockReturnValue(['a.ts']);
    vi.spyOn(reviewLoop, 'runAgentStep').mockResolvedValue({
      codeAgentTaskId: 'ca-rev-4', status: 'completed', outputPreview: 'nope',
    });
    const updated = await tickWorkItem(s.id);
    expect(updated?.status).toBe('blocked');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm vitest run src/__tests__/review-loop.test.ts -t "tickWorkItem: reviewing"`
Expected: FAIL — branch not implemented.

- [ ] **Step 3: Implement the reviewing branch**

Add imports at top of `review-loop.ts`:
```ts
import { getReviewDiff } from './review-loop-diff.js';
import { buildReviewerPrompt, parseReviewerOutput } from './review-loop-prompts.js';
import type { ReviewFinding } from './review-loop-types.js';
```

Add functions:
```ts
function latestChangedFiles(state: WorkItemState): string[] {
  for (let i = state.timeline.length - 1; i >= 0; i--) {
    const ev = state.timeline[i]!;
    if (ev.kind === 'dev-completed' && ev.changedFiles) return ev.changedFiles;
  }
  return [];
}

async function runReviewer(state: WorkItemState): Promise<WorkItemState> {
  const fromRef = state.lastReviewCommit ?? state.baseRef;
  const headSha = getHeadSha(state.workdir) ?? 'HEAD';
  const diffText = getReviewDiff(state.workdir, fromRef, headSha) ?? '';
  const changedFiles = latestChangedFiles(state);

  const reviewerPrompt = buildReviewerPrompt(state, diffText, changedFiles);

  state.liveActivity = {
    agent: 'reviewer',
    codeAgentTaskId: '(pending)',
    startedAt: new Date().toISOString(),
  };
  appendTimelineEvent(state, 'review-started', 'Reviewer started');
  saveWorkItem(state);

  const result = await runAgentStep({
    agent: 'claude',
    model: state.reviewerModel,
    task: reviewerPrompt,
    workdir: state.workdir,
    validate: false,
  });
  state.liveActivity = undefined;

  if (result.status !== 'completed' || !result.outputPreview) {
    markBlocked(state, `reviewer step ${result.status}: ${result.error ?? 'no output'}`);
    saveWorkItem(state);
    return state;
  }

  const parsed = parseReviewerOutput(result.outputPreview);
  if (!parsed) {
    markBlocked(state, 'reviewer returned invalid JSON');
    saveWorkItem(state);
    return state;
  }

  state.lastReviewCommit = headSha;

  if (parsed.verdict === 'approved') {
    state.status = 'done';
    appendTimelineEvent(state, 'review-completed', parsed.note ?? 'Approved', {
      codeAgentTaskId: result.codeAgentTaskId,
    });
    appendTimelineEvent(state, 'done', 'Reviewer approved');
    saveWorkItem(state);
    return state;
  }

  // changes_requested
  const newFindings: ReviewFinding[] = parsed.findings.map((f, idx) => ({
    id: `f-${state.iteration}-${idx}`,
    severity: f.severity,
    summary: f.summary,
    file: f.file,
    line: f.line,
    status: 'open',
    iterationRaised: state.iteration,
  }));
  state.findings.push(...newFindings);
  appendTimelineEvent(state, 'review-completed',
    `${newFindings.length} finding(s)`,
    {
      codeAgentTaskId: result.codeAgentTaskId,
      findingsSnapshot: newFindings,
    });

  if (state.iteration >= state.maxIterations) {
    markBlocked(state, `max iterations (${state.maxIterations}) reached with ${newFindings.length} open finding(s)`);
    saveWorkItem(state);
    return state;
  }

  state.status = 'revising';
  saveWorkItem(state);
  return state;
}
```

Update switch in `tickWorkItem`:
```ts
case 'reviewing':
  return runReviewer(state);
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `pnpm vitest run src/__tests__/review-loop.test.ts -t "tickWorkItem: reviewing"`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/code-agents/review-loop.ts src/__tests__/review-loop.test.ts
git commit -m "feat(review-loop): tickWorkItem reviewing branch — diff-scoped review, finding ingestion"
```

---

## Task 11: End-to-end happy path integration test

**Files:**
- Modify: `src/__tests__/review-loop.test.ts`

- [ ] **Step 1: Write the integration test**

Add to `src/__tests__/review-loop.test.ts`:

```ts
describe('review-loop: end-to-end happy path', () => {
  it('planning → approval → implementing → reviewing (approved) → done', async () => {
    const s = createWorkItem({ prompt: 'Add feature Z', workdir: '/r' });

    vi.spyOn(diff, 'getHeadSha').mockReturnValue('head-abc');
    vi.spyOn(diff, 'getChangedFiles').mockReturnValue(['z.ts']);
    vi.spyOn(diff, 'getReviewDiff').mockReturnValue('+++ diff');

    const stepSpy = vi.spyOn(reviewLoop, 'runAgentStep');

    // Tick 1: planner returns awaiting_approval
    stepSpy.mockResolvedValueOnce({
      codeAgentTaskId: 'ca-p1',
      status: 'completed',
      outputPreview: '{"status":"awaiting_approval","summary":"s","plan":"PLAN-v1"}',
    });
    let u = await tickWorkItem(s.id);
    expect(u?.status).toBe('awaiting_approval');

    // User approves
    u = approvePlan(s.id);
    expect(u?.status).toBe('implementing');

    // Planner hasn't been asked for a dev task yet. A user can either (a) tick again so the planner emits a revising plan, or (b) we can require planner to always emit next_dev_task on approval. Here: we simulate the realistic flow — caller ticks, which re-enters planning from implementing with no dev task, so we short-circuit: for the happy-path test, we seed a plan-produced event with a note before ticking implementing.
    const seeded = getWorkItem(s.id)!;
    seeded.timeline.push({
      id: 't-seed', kind: 'plan-produced', iteration: 0, at: new Date().toISOString(),
      summary: 'seed', note: 'Implement feature Z',
    });
    (require('../code-agents/review-loop-storage.js') as any).saveWorkItem(seeded);

    // Tick 2: dev runs, goes to reviewing
    stepSpy.mockResolvedValueOnce({
      codeAgentTaskId: 'ca-d1',
      status: 'completed',
      outputPreview: 'dev done',
    });
    u = await tickWorkItem(s.id);
    expect(u?.status).toBe('reviewing');
    expect(u?.iteration).toBe(1);

    // Tick 3: reviewer approves → done
    stepSpy.mockResolvedValueOnce({
      codeAgentTaskId: 'ca-r1',
      status: 'completed',
      outputPreview: '{"verdict":"approved","findings":[]}',
    });
    u = await tickWorkItem(s.id);
    expect(u?.status).toBe('done');

    // Terminal: subsequent ticks are no-op
    u = await tickWorkItem(s.id);
    expect(u?.status).toBe('done');
    expect(stepSpy).toHaveBeenCalledTimes(3);
  });
});
```

The comment inside the test calls out a design subtlety: after the user approves the plan, the state is `implementing`, but there's no `next_dev_task` yet because the first planner output was `awaiting_approval`. In production, the planner will need a second invocation on approval to produce the dev task — or we can have `approvePlan` transition to `planning` instead. **Resolve now before the e2e test:** `approvePlan` should transition `awaiting_approval` → `planning` (not `implementing`). Update Task 6's `approvePlan` to match, and adjust the tests in Task 6 and this one accordingly.

- [ ] **Step 2: Revise `approvePlan` to go to `planning`**

In `src/code-agents/review-loop.ts`:

```ts
export function approvePlan(id: string): WorkItemState | null {
  const state = loadWorkItem(id);
  if (!state) return null;
  if (state.status !== 'awaiting_approval') return null;
  state.status = 'planning';      // re-enter planner so it can emit next_dev_task
  appendTimelineEvent(state, 'plan-approved', 'Plan approved by user');
  saveWorkItem(state);
  return state;
}
```

Update the Task 6 test `approvePlan transitions awaiting_approval → implementing`:

```ts
it('approvePlan transitions awaiting_approval → planning (planner emits dev task next)', () => {
  const s = createWorkItem({ prompt: 'X', workdir: '/r' });
  s.status = 'awaiting_approval';
  s.currentPlan = 'plan body';
  (require('../code-agents/review-loop-storage.js') as any).saveWorkItem(s);
  const updated = approvePlan(s.id);
  expect(updated?.status).toBe('planning');
  expect(updated?.timeline.some(t => t.kind === 'plan-approved')).toBe(true);
});
```

Update this task's e2e test to drop the manual `seeded.timeline.push` hack — instead, the planner's second invocation produces the revising plan:

```ts
it('planning → approval → replan → implementing → reviewing (approved) → done', async () => {
  const s = createWorkItem({ prompt: 'Add feature Z', workdir: '/r' });
  vi.spyOn(diff, 'getHeadSha').mockReturnValue('head-abc');
  vi.spyOn(diff, 'getChangedFiles').mockReturnValue(['z.ts']);
  vi.spyOn(diff, 'getReviewDiff').mockReturnValue('+++ diff');
  const stepSpy = vi.spyOn(reviewLoop, 'runAgentStep');

  // Tick 1: planner → awaiting_approval
  stepSpy.mockResolvedValueOnce({
    codeAgentTaskId: 'ca-p1', status: 'completed',
    outputPreview: '{"status":"awaiting_approval","summary":"s","plan":"PLAN-v1"}',
  });
  let u = await tickWorkItem(s.id);
  expect(u?.status).toBe('awaiting_approval');

  // User approves → planning
  u = approvePlan(s.id);
  expect(u?.status).toBe('planning');

  // Tick 2: planner → revising with dev task
  stepSpy.mockResolvedValueOnce({
    codeAgentTaskId: 'ca-p2', status: 'completed',
    outputPreview: '{"status":"revising","summary":"s","plan":"PLAN-v2","next_dev_task":"Implement Z"}',
  });
  u = await tickWorkItem(s.id);
  expect(u?.status).toBe('implementing');

  // Tick 3: dev → reviewing
  stepSpy.mockResolvedValueOnce({
    codeAgentTaskId: 'ca-d1', status: 'completed', outputPreview: 'dev done',
  });
  u = await tickWorkItem(s.id);
  expect(u?.status).toBe('reviewing');
  expect(u?.iteration).toBe(1);

  // Tick 4: reviewer approves → done
  stepSpy.mockResolvedValueOnce({
    codeAgentTaskId: 'ca-r1', status: 'completed',
    outputPreview: '{"verdict":"approved","findings":[]}',
  });
  u = await tickWorkItem(s.id);
  expect(u?.status).toBe('done');

  // Terminal no-op
  u = await tickWorkItem(s.id);
  expect(u?.status).toBe('done');
  expect(stepSpy).toHaveBeenCalledTimes(4);
});
```

- [ ] **Step 3: Run all tests**

Run: `pnpm build && pnpm test`
Expected: all tests PASS (500+ existing + new review-loop tests).

- [ ] **Step 4: Commit**

```bash
git add src/code-agents/review-loop.ts src/__tests__/review-loop.test.ts
git commit -m "feat(review-loop): end-to-end happy path + approval flow correction"
```

---

## Task 12: Export public surface from code-agents index

**Files:**
- Modify: `src/code-agents/index.ts`

- [ ] **Step 1: Add re-exports**

Append to `src/code-agents/index.ts`:

```ts
// Review-loop public surface
export {
  createWorkItem,
  getWorkItem,
  listWorkItems,
  tickWorkItem,
  appendUserMessage,
  approvePlan,
  pauseWorkItem,
  resumeWorkItem,
  stopWorkItem,
  runAgentStep,
} from './review-loop.js';

export type {
  WorkStatus,
  WorkItemState,
  ReviewFinding,
  ChatMessage,
  TimelineEvent,
  TimelineEventKind,
  LiveActivity,
  CreateWorkInput,
  PlannerOutput,
  ReviewerOutput,
  FindingSeverity,
} from './review-loop-types.js';

export { ACTIVE_STATUSES, TERMINAL_STATUSES } from './review-loop-types.js';
```

- [ ] **Step 2: Verify build + tests still pass**

Run: `pnpm build && pnpm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/code-agents/index.ts
git commit -m "feat(review-loop): export public surface from code-agents index"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** All Phase 1 backend concerns in the spec (engine state machine, persistence at `~/.skimpyclaw/work/`, JSON contracts, diff-scoped review, pause/resume/stop, cumulative cost, timeline, chat) are covered. API endpoints (`POST /api/dashboard/work`, etc.) and UI are intentionally deferred to plans 2 and 3.
- **Design decisions resolved from spec's open questions:**
  - *Finding shape:* finalized in Task 1 — severity/summary/file/line/status/id/iterationRaised/iterationResolved.
  - *Timeline:* inline array on state; kinds enumerated; consumers filter.
  - *Loop engine:* tick-based (discrete `tickWorkItem` calls), not in-process long-lived loop. Matches plan.md's guidance ("discrete turns, not a background watcher").
  - *Concurrency cap:* deferred to API layer (plan 2). Engine itself has no concurrency concept.
- **Approval flow correction** in Task 11 (`approvePlan` → `planning`, not `implementing`) is the only design-level change from the spec; called out explicitly and applied.
- **Type consistency:** All types referenced in later tasks match Task 1 definitions. `ReviewFinding.id` format `f-<iter>-<idx>` is used consistently.
- **No placeholders:** Every step contains exact code or exact commands.

## Deferred to Plans 2 and 3

- Plan 2 (API): Fastify routes under `/api/dashboard/work`, Bearer auth, periodic tick scheduler (e.g. called from poll endpoint or a lightweight interval).
- Plan 3 (UI): `web/dashboard/src/pages/Work.tsx`, sidebar entry, client types, chat feed, approval gate, live activity banner, 3s polling.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-14-review-loop-engine.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
