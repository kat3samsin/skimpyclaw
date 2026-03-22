# RL Feedback Learning Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist structured RL feedback trajectories from user corrections, retrieve relevant past corrections at inference time, and scaffold offline preference pair export for future DPO-style training.

**Architecture:** Builds on the existing `personalization.ts` signal detection. New `src/rl-feedback.ts` handles durable JSONL storage of feedback events. New `src/rl-retrieval.ts` retrieves and ranks past corrections for prompt injection. New `src/rl-export.ts` generates preference pairs from trajectories. All wired through `agent.ts` alongside existing personalization hooks.

**Tech Stack:** TypeScript, JSONL append-only storage (following `usage.ts` pattern), Vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/rl-feedback.ts` | Feedback event schema validation, JSONL storage (record/read), directory management |
| `src/rl-retrieval.ts` | Retrieve + rank past corrections, build compact prompt section, token budget control |
| `src/rl-export.ts` | Generate preference pairs (chosen/rejected) from trajectories, reward judge interface, safety filtering |
| `src/types.ts` | New interfaces: `RLFeedbackEvent`, `RLConfig`, `PreferencePair`, `RewardJudgment` + config extension |
| `src/agent.ts` | Wire feedback capture after `processUserTurn`, wire retrieval into system prompt |
| `src/__tests__/rl-feedback.test.ts` | Storage, schema validation, read/write tests |
| `src/__tests__/rl-retrieval.test.ts` | Retrieval ranking, prompt generation, token budget tests |
| `src/__tests__/rl-export.test.ts` | Preference pair generation, safety filtering, reward judge tests |

---

### Task 0: Create Feature Branch

- [ ] **Step 1: Create feature branch from trunk**

```bash
git checkout -b feat/rl-feedback-pipeline
```

All subsequent commits go on this branch.

---

### Task 1: Types and Config

**Files:**
- Modify: `src/types.ts:93` (add `rlFeedback` to Config)
- Modify: `src/types.ts` (add new interfaces at end)

- [ ] **Step 1: Add RLFeedbackEvent interface to types.ts**

Add after the existing `FeedbackSignal` interface (~line 326):

```typescript
/** A durable RL feedback event capturing a full interaction trajectory */
export interface RLFeedbackEvent {
  id: string;                    // randomUUID short
  sessionId: string;
  timestamp: string;             // ISO
  userId: string;
  agentId: string;
  userInput: string;
  assistantOutput: string;
  toolCalls?: string[];          // tool names invoked
  toolResultsSummary?: string;   // brief summary of tool outputs
  feedbackType: 'explicit_correction' | 'approval' | 'implicit';
  directiveText: string;         // what the user wants differently
  evaluativeScore: number;       // -1..1
  tags: string[];
  safetyFlags: string[];         // e.g. 'contains_secret', 'sensitive_topic'
  model?: string;
  trigger?: string;              // telegram, discord, cron, etc.
}

/** Config for the RL feedback persistence system */
export interface RLConfig {
  enableFeedbackCapture?: boolean; // default false — persist feedback events to JSONL
  enableRetrieval?: boolean;       // default false — retrieve past corrections at inference time
  maxRetrievedCorrections?: number; // default 5
  maxPromptTokens?: number;       // token budget for injected corrections (default 500)
  excludeTags?: string[];         // tags to exclude from training export
}

/** A preference pair for DPO-style training */
export interface PreferencePair {
  id: string;
  prompt: string;
  chosen: string;                // the corrected/better response
  rejected: string;              // the original response that was corrected
  reward_chosen: number;
  reward_rejected: number;
  metadata: {
    userId: string;
    sessionId: string;
    timestamp: string;
    feedbackType: string;
    model?: string;
  };
}

/** Reward judgment from the heuristic judge */
export interface RewardJudgment {
  score: number;          // -1..1
  confidence: number;     // 0..1
  reason: string;
}
```

- [ ] **Step 2: Add rlFeedback config field to Config interface**

In `Config` interface, after `personalization?: PersonalizationConfig;` (line 93):

```typescript
  rlFeedback?: RLConfig;
```

- [ ] **Step 3: Verify build passes**

Run: `pnpm build`
Expected: Clean compile with new types available

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat(rl): add RLFeedbackEvent, RLConfig, PreferencePair types"
```

---

### Task 2: Feedback Storage Module

**Files:**
- Create: `src/rl-feedback.ts`
- Create: `src/__tests__/rl-feedback.test.ts`

- [ ] **Step 1: Write failing tests for rl-feedback**

Create `src/__tests__/rl-feedback.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  recordFeedback,
  readFeedbackEvents,
  buildFeedbackEvent,
  validateFeedbackEvent,
  setFeedbackDirForTesting,
} from '../rl-feedback.js';
import type { RLFeedbackEvent } from '../types.js';

const TEST_DIR = join(tmpdir(), `skimpyclaw-rl-test-${Date.now()}`);

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  setFeedbackDirForTesting(TEST_DIR);
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  setFeedbackDirForTesting(null);
});

function makeEvent(overrides: Partial<RLFeedbackEvent> = {}): RLFeedbackEvent {
  return {
    id: 'test-001',
    sessionId: 'sess-1',
    timestamp: '2026-03-22T10:00:00.000Z',
    userId: 'user-1',
    agentId: 'main',
    userInput: 'fix the bug',
    assistantOutput: 'I changed foo.ts',
    feedbackType: 'explicit_correction',
    directiveText: 'No, change bar.ts instead',
    evaluativeScore: -0.6,
    tags: ['coding'],
    safetyFlags: [],
    ...overrides,
  };
}

describe('validateFeedbackEvent', () => {
  it('accepts valid event', () => {
    expect(validateFeedbackEvent(makeEvent())).toBe(true);
  });

  it('rejects missing required fields', () => {
    expect(validateFeedbackEvent({ id: 'x' } as any)).toBe(false);
  });

  it('rejects out-of-range evaluativeScore', () => {
    expect(validateFeedbackEvent(makeEvent({ evaluativeScore: 2.0 }))).toBe(false);
    expect(validateFeedbackEvent(makeEvent({ evaluativeScore: -1.5 }))).toBe(false);
  });

  it('rejects invalid feedbackType', () => {
    expect(validateFeedbackEvent(makeEvent({ feedbackType: 'bogus' as any }))).toBe(false);
  });
});

describe('buildFeedbackEvent', () => {
  it('creates event with auto-generated id and timestamp', () => {
    const event = buildFeedbackEvent({
      sessionId: 'sess-1',
      userId: 'user-1',
      agentId: 'main',
      userInput: 'do X',
      assistantOutput: 'did Y',
      feedbackType: 'explicit_correction',
      directiveText: 'do Z instead',
      evaluativeScore: -0.5,
    });
    expect(event.id).toBeTruthy();
    expect(event.timestamp).toBeTruthy();
    expect(event.tags).toEqual([]);
    expect(event.safetyFlags).toEqual([]);
  });
});

describe('recordFeedback + readFeedbackEvents', () => {
  it('writes and reads back a single event', () => {
    const event = makeEvent();
    recordFeedback(event);

    const { events, total } = readFeedbackEvents({ startDate: '2026-03-22', endDate: '2026-03-22' });
    expect(total).toBe(1);
    expect(events[0].id).toBe('test-001');
  });

  it('appends multiple events to same day file', () => {
    recordFeedback(makeEvent({ id: 'a' }));
    recordFeedback(makeEvent({ id: 'b' }));

    const { total } = readFeedbackEvents({ startDate: '2026-03-22', endDate: '2026-03-22' });
    expect(total).toBe(2);
  });

  it('filters by userId', () => {
    recordFeedback(makeEvent({ id: 'a', userId: 'alice' }));
    recordFeedback(makeEvent({ id: 'b', userId: 'bob' }));

    const { events } = readFeedbackEvents({
      startDate: '2026-03-22',
      endDate: '2026-03-22',
      userId: 'alice',
    });
    expect(events).toHaveLength(1);
    expect(events[0].userId).toBe('alice');
  });

  it('paginates results', () => {
    for (let i = 0; i < 5; i++) {
      recordFeedback(makeEvent({ id: `evt-${i}` }));
    }
    const { events, total } = readFeedbackEvents({
      startDate: '2026-03-22',
      endDate: '2026-03-22',
      limit: 2,
      offset: 1,
    });
    expect(total).toBe(5);
    expect(events).toHaveLength(2);
  });

  it('never throws on write failure (non-existent parent)', () => {
    setFeedbackDirForTesting('/nonexistent/deep/path');
    // Should not throw
    expect(() => recordFeedback(makeEvent())).not.toThrow();
  });

  it('creates directory if needed', () => {
    const subdir = join(TEST_DIR, 'subdir');
    setFeedbackDirForTesting(subdir);
    recordFeedback(makeEvent());
    expect(existsSync(subdir)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm build 2>&1 | head -5`
Expected: FAIL — `rl-feedback.js` module not found

- [ ] **Step 3: Implement rl-feedback.ts**

Create `src/rl-feedback.ts`:

```typescript
// RL Feedback persistence — JSONL append-only storage at ~/.skimpyclaw/logs/rl-feedback/YYYY-MM-DD.jsonl

import { randomUUID } from 'crypto';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { readJsonlDir } from './utils.js';
import type { RLFeedbackEvent } from './types.js';

const FEEDBACK_DIR = join(homedir(), '.skimpyclaw', 'logs', 'rl-feedback');

let feedbackDirOverride: string | null = null;

export function setFeedbackDirForTesting(dir: string | null): void {
  feedbackDirOverride = dir;
}

function getFeedbackDir(): string {
  return feedbackDirOverride ?? FEEDBACK_DIR;
}

const VALID_FEEDBACK_TYPES = new Set(['explicit_correction', 'approval', 'implicit']);

/** Validate an RLFeedbackEvent has all required fields and valid ranges. */
export function validateFeedbackEvent(event: RLFeedbackEvent): boolean {
  if (!event || typeof event !== 'object') return false;
  if (typeof event.id !== 'string' || !event.id) return false;
  if (typeof event.sessionId !== 'string' || !event.sessionId) return false;
  if (typeof event.timestamp !== 'string' || !event.timestamp) return false;
  if (typeof event.userId !== 'string' || !event.userId) return false;
  if (typeof event.agentId !== 'string' || !event.agentId) return false;
  if (typeof event.userInput !== 'string') return false;
  if (typeof event.assistantOutput !== 'string') return false;
  if (!VALID_FEEDBACK_TYPES.has(event.feedbackType)) return false;
  if (typeof event.directiveText !== 'string') return false;
  if (typeof event.evaluativeScore !== 'number') return false;
  if (event.evaluativeScore < -1 || event.evaluativeScore > 1) return false;
  if (!Array.isArray(event.tags)) return false;
  if (!Array.isArray(event.safetyFlags)) return false;
  return true;
}

/** Build an RLFeedbackEvent with auto-generated id and timestamp. */
export function buildFeedbackEvent(opts: {
  sessionId: string;
  userId: string;
  agentId: string;
  userInput: string;
  assistantOutput: string;
  feedbackType: RLFeedbackEvent['feedbackType'];
  directiveText: string;
  evaluativeScore: number;
  toolCalls?: string[];
  toolResultsSummary?: string;
  tags?: string[];
  safetyFlags?: string[];
  model?: string;
  trigger?: string;
}): RLFeedbackEvent {
  return {
    id: randomUUID().slice(0, 8),
    timestamp: new Date().toISOString(),
    sessionId: opts.sessionId,
    userId: opts.userId,
    agentId: opts.agentId,
    userInput: opts.userInput,
    assistantOutput: opts.assistantOutput,
    feedbackType: opts.feedbackType,
    directiveText: opts.directiveText,
    evaluativeScore: opts.evaluativeScore,
    toolCalls: opts.toolCalls,
    toolResultsSummary: opts.toolResultsSummary,
    tags: opts.tags ?? [],
    safetyFlags: opts.safetyFlags ?? [],
    model: opts.model,
    trigger: opts.trigger,
  };
}

/** Record a feedback event. Sync append, never throws. */
export function recordFeedback(event: RLFeedbackEvent): void {
  try {
    const dir = getFeedbackDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const dateStr = event.timestamp.slice(0, 10);
    const filePath = join(dir, `${dateStr}.jsonl`);
    appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8');
  } catch (err) {
    console.warn('[rl-feedback] Failed to record feedback:', err);
  }
}

export interface ReadFeedbackOptions {
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
  userId?: string;
  feedbackType?: RLFeedbackEvent['feedbackType'];
}

/** Read feedback events from JSONL files in a date range. */
export function readFeedbackEvents(options: ReadFeedbackOptions = {}): {
  events: RLFeedbackEvent[];
  total: number;
} {
  const dir = getFeedbackDir();
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  const now = new Date();
  const endDate = options.endDate ?? now.toISOString().slice(0, 10);
  const startDate = options.startDate ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const filterFn = (r: RLFeedbackEvent): boolean => {
    if (options.userId && r.userId !== options.userId) return false;
    if (options.feedbackType && r.feedbackType !== options.feedbackType) return false;
    return true;
  };

  const allEvents = readJsonlDir<RLFeedbackEvent>(dir, startDate, endDate, filterFn);
  allEvents.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  const total = allEvents.length;
  const paged = allEvents.slice(offset, offset + limit);

  return { events: paged, total };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm build && pnpm test src/__tests__/rl-feedback.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/rl-feedback.ts src/__tests__/rl-feedback.test.ts
git commit -m "feat(rl): add feedback event storage with JSONL persistence"
```

---

### Task 3: Correction Parsing and Signal Conversion

**Files:**
- Modify: `src/rl-feedback.ts` (add `convertSignalsToFeedbackEvent`)

- [ ] **Step 1: Write failing tests for signal conversion**

Append to `src/__tests__/rl-feedback.test.ts`:

```typescript
import { convertSignalsToFeedbackEvent } from '../rl-feedback.js';
import type { FeedbackSignal } from '../types.js';

describe('convertSignalsToFeedbackEvent', () => {
  it('converts correction signal to explicit_correction event', () => {
    const signals: FeedbackSignal[] = [{
      type: 'correction',
      reward: -0.6,
      dimensions: { verbosity: -0.4 },
      confidence: 0.8,
      reason: 'User explicitly corrected the response',
    }];
    const event = convertSignalsToFeedbackEvent({
      signals,
      sessionId: 'sess-1',
      userId: 'user-1',
      agentId: 'main',
      userInput: "That's wrong, be shorter",
      assistantOutput: 'Here is a very long explanation...',
    });
    expect(event).not.toBeNull();
    expect(event!.feedbackType).toBe('explicit_correction');
    expect(event!.evaluativeScore).toBeLessThan(0);
    expect(event!.directiveText).toContain('corrected');
  });

  it('converts acceptance signal to approval event', () => {
    const signals: FeedbackSignal[] = [{
      type: 'acceptance',
      reward: 0.3,
      dimensions: {},
      confidence: 0.6,
      reason: 'User accepted the response',
    }];
    const event = convertSignalsToFeedbackEvent({
      signals,
      sessionId: 'sess-1',
      userId: 'user-1',
      agentId: 'main',
      userInput: 'Thanks, perfect!',
      assistantOutput: 'Done.',
    });
    expect(event).not.toBeNull();
    expect(event!.feedbackType).toBe('approval');
    expect(event!.evaluativeScore).toBeGreaterThan(0);
  });

  it('converts implicit acceptance to implicit event', () => {
    const signals: FeedbackSignal[] = [{
      type: 'acceptance',
      reward: 0.1,
      dimensions: {},
      confidence: 0.3,
      reason: 'Smooth follow-up without complaint (implicit acceptance)',
    }];
    const event = convertSignalsToFeedbackEvent({
      signals,
      sessionId: 'sess-1',
      userId: 'user-1',
      agentId: 'main',
      userInput: 'Now do something else',
      assistantOutput: 'Here you go.',
    });
    expect(event).not.toBeNull();
    expect(event!.feedbackType).toBe('implicit');
  });

  it('returns null for empty signals', () => {
    const event = convertSignalsToFeedbackEvent({
      signals: [],
      sessionId: 's', userId: 'u', agentId: 'a',
      userInput: '', assistantOutput: '',
    });
    expect(event).toBeNull();
  });

  it('picks strongest signal when multiple present', () => {
    const signals: FeedbackSignal[] = [
      { type: 'correction', reward: -0.6, dimensions: {}, confidence: 0.8, reason: 'correction' },
      { type: 'acceptance', reward: 0.1, dimensions: {}, confidence: 0.3, reason: 'implicit' },
    ];
    const event = convertSignalsToFeedbackEvent({
      signals,
      sessionId: 's', userId: 'u', agentId: 'a',
      userInput: 'x', assistantOutput: 'y',
    });
    expect(event!.feedbackType).toBe('explicit_correction');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm build 2>&1 | head -5`
Expected: FAIL — `convertSignalsToFeedbackEvent` not exported

- [ ] **Step 3: Implement convertSignalsToFeedbackEvent**

Add to `src/rl-feedback.ts`:

```typescript
import type { RLFeedbackEvent, FeedbackSignal } from './types.js';

/**
 * Convert personalization FeedbackSignals into a single RLFeedbackEvent.
 * Picks the strongest signal to determine feedback type.
 * Returns null if no signals.
 */
export function convertSignalsToFeedbackEvent(opts: {
  signals: FeedbackSignal[];
  sessionId: string;
  userId: string;
  agentId: string;
  userInput: string;
  assistantOutput: string;
  toolCalls?: string[];
  toolResultsSummary?: string;
  model?: string;
  trigger?: string;
}): RLFeedbackEvent | null {
  if (opts.signals.length === 0) return null;

  // Pick strongest signal by absolute reward * confidence
  const ranked = [...opts.signals].sort(
    (a, b) => Math.abs(b.reward) * b.confidence - Math.abs(a.reward) * a.confidence
  );
  const strongest = ranked[0];

  // Map personalization signal types to RL feedback types
  let feedbackType: RLFeedbackEvent['feedbackType'];
  if (strongest.type === 'correction' || strongest.type === 'reask') {
    feedbackType = 'explicit_correction';
  } else if (strongest.confidence >= 0.5) {
    feedbackType = 'approval';
  } else {
    feedbackType = 'implicit';
  }

  // Aggregate evaluative score: weighted average of all signals
  const totalWeight = opts.signals.reduce((sum, s) => sum + s.confidence, 0);
  const evaluativeScore = totalWeight > 0
    ? opts.signals.reduce((sum, s) => sum + s.reward * s.confidence, 0) / totalWeight
    : 0;

  // Build directive from all signal reasons
  const directiveText = opts.signals.map(s => s.reason).join('; ');

  // Collect dimension tags
  const tags: string[] = [];
  for (const s of opts.signals) {
    for (const [dim, val] of Object.entries(s.dimensions)) {
      if (val !== undefined && val !== 0) {
        tags.push(`${dim}:${val > 0 ? 'increase' : 'decrease'}`);
      }
    }
  }

  return buildFeedbackEvent({
    sessionId: opts.sessionId,
    userId: opts.userId,
    agentId: opts.agentId,
    userInput: opts.userInput,
    assistantOutput: opts.assistantOutput,
    feedbackType,
    directiveText,
    evaluativeScore: Math.max(-1, Math.min(1, evaluativeScore)),
    toolCalls: opts.toolCalls,
    toolResultsSummary: opts.toolResultsSummary,
    tags,
    model: opts.model,
    trigger: opts.trigger,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm build && pnpm test src/__tests__/rl-feedback.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/rl-feedback.ts src/__tests__/rl-feedback.test.ts
git commit -m "feat(rl): add signal-to-feedback conversion with strongest-signal ranking"
```

---

### Task 4: Retrieval and Prompt Injection

**Files:**
- Create: `src/rl-retrieval.ts`
- Create: `src/__tests__/rl-retrieval.test.ts`

- [ ] **Step 1: Write failing tests for rl-retrieval**

Create `src/__tests__/rl-retrieval.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  retrieveRelevantCorrections,
  buildCorrectionsPrompt,
  rankCorrections,
} from '../rl-retrieval.js';
import { recordFeedback, setFeedbackDirForTesting } from '../rl-feedback.js';
import type { RLFeedbackEvent } from '../types.js';

const TEST_DIR = join(tmpdir(), `skimpyclaw-rl-retrieval-test-${Date.now()}`);

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  setFeedbackDirForTesting(TEST_DIR);
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  setFeedbackDirForTesting(null);
});

function makeEvent(overrides: Partial<RLFeedbackEvent> = {}): RLFeedbackEvent {
  return {
    id: 'test-001',
    sessionId: 'sess-1',
    timestamp: new Date().toISOString(),
    userId: 'user-1',
    agentId: 'main',
    userInput: 'fix the bug',
    assistantOutput: 'I changed foo.ts',
    feedbackType: 'explicit_correction',
    directiveText: 'No, change bar.ts instead',
    evaluativeScore: -0.6,
    tags: ['coding'],
    safetyFlags: [],
    ...overrides,
  };
}

describe('rankCorrections', () => {
  it('ranks recent corrections higher', () => {
    const old = makeEvent({ id: 'old', timestamp: '2026-03-01T10:00:00Z', evaluativeScore: -0.6 });
    const recent = makeEvent({ id: 'new', timestamp: '2026-03-22T10:00:00Z', evaluativeScore: -0.6 });
    const ranked = rankCorrections([old, recent], 'fix the bug');
    expect(ranked[0].id).toBe('new');
  });

  it('ranks semantically similar corrections higher', () => {
    const relevant = makeEvent({ id: 'relevant', userInput: 'fix the database bug' });
    const irrelevant = makeEvent({ id: 'irrelevant', userInput: 'update the README file' });
    const ranked = rankCorrections([irrelevant, relevant], 'fix the database connection bug');
    expect(ranked[0].id).toBe('relevant');
  });

  it('returns empty for empty input', () => {
    expect(rankCorrections([], 'anything')).toEqual([]);
  });
});

describe('retrieveRelevantCorrections', () => {
  it('retrieves corrections for a user', () => {
    recordFeedback(makeEvent({ id: 'c1', userId: 'alice', feedbackType: 'explicit_correction' }));
    recordFeedback(makeEvent({ id: 'c2', userId: 'alice', feedbackType: 'approval' }));
    recordFeedback(makeEvent({ id: 'c3', userId: 'bob', feedbackType: 'explicit_correction' }));

    const corrections = retrieveRelevantCorrections({
      userId: 'alice',
      currentInput: 'fix something',
      maxResults: 10,
    });
    // Should only get alice's correction (not approval, not bob's)
    expect(corrections).toHaveLength(1);
    expect(corrections[0].userId).toBe('alice');
    expect(corrections[0].feedbackType).toBe('explicit_correction');
  });

  it('respects maxResults', () => {
    for (let i = 0; i < 10; i++) {
      recordFeedback(makeEvent({
        id: `c-${i}`,
        feedbackType: 'explicit_correction',
      }));
    }
    const corrections = retrieveRelevantCorrections({
      userId: 'user-1',
      currentInput: 'fix',
      maxResults: 3,
    });
    expect(corrections).toHaveLength(3);
  });
});

describe('buildCorrectionsPrompt', () => {
  it('returns empty string for no corrections', () => {
    expect(buildCorrectionsPrompt([])).toBe('');
  });

  it('generates compact prompt from corrections', () => {
    const corrections = [
      makeEvent({ directiveText: 'Be more concise', userInput: 'too verbose' }),
      makeEvent({ directiveText: 'Use bar.ts not foo.ts', userInput: 'wrong file' }),
    ];
    const prompt = buildCorrectionsPrompt(corrections);
    expect(prompt).toContain('Prior Corrections');
    expect(prompt).toContain('Be more concise');
    expect(prompt).toContain('Use bar.ts not foo.ts');
  });

  it('respects maxTokens budget (approximate)', () => {
    const corrections = Array.from({ length: 50 }, (_, i) =>
      makeEvent({ id: `c-${i}`, directiveText: 'A'.repeat(200) })
    );
    const prompt = buildCorrectionsPrompt(corrections, { maxTokens: 200 });
    // ~4 chars per token, 200 tokens ≈ 800 chars. Prompt should be bounded.
    expect(prompt.length).toBeLessThan(1500);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm build 2>&1 | head -5`
Expected: FAIL — module not found

- [ ] **Step 3: Implement rl-retrieval.ts**

Create `src/rl-retrieval.ts`:

```typescript
// RL Retrieval — retrieve and rank past corrections for prompt injection

import { readFeedbackEvents } from './rl-feedback.js';
import { computeWordOverlap } from './personalization.js';
import type { RLFeedbackEvent } from './types.js';

/**
 * Rank corrections by relevance: recency * semantic similarity.
 * Returns sorted array (most relevant first).
 */
export function rankCorrections(
  corrections: RLFeedbackEvent[],
  currentInput: string,
): RLFeedbackEvent[] {
  if (corrections.length === 0) return [];

  const now = Date.now();
  const scored = corrections.map(c => {
    // Recency score: exponential decay, half-life of 7 days
    const ageMs = now - Date.parse(c.timestamp);
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    const recencyScore = Math.exp(-ageDays / 7);

    // Semantic similarity via word overlap
    const similarity = computeWordOverlap(currentInput, c.userInput);

    // Combined score: weighted sum
    const score = 0.4 * recencyScore + 0.6 * similarity;

    return { event: c, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.event);
}

/**
 * Retrieve relevant past corrections for a user.
 * Only returns explicit_correction events (not approvals or implicit).
 */
export function retrieveRelevantCorrections(opts: {
  userId: string;
  currentInput: string;
  maxResults?: number;
  lookbackDays?: number;
}): RLFeedbackEvent[] {
  const maxResults = opts.maxResults ?? 5;
  const lookbackDays = opts.lookbackDays ?? 30;

  const now = new Date();
  const startDate = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);

  const { events } = readFeedbackEvents({
    startDate,
    endDate,
    userId: opts.userId,
    feedbackType: 'explicit_correction',
    limit: 1000, // Read more than needed, then rank
  });

  const ranked = rankCorrections(events, opts.currentInput);
  return ranked.slice(0, maxResults);
}

/**
 * Build a compact prompt section from retrieved corrections.
 * Respects an approximate token budget.
 */
export function buildCorrectionsPrompt(
  corrections: RLFeedbackEvent[],
  opts?: { maxTokens?: number },
): string {
  if (corrections.length === 0) return '';

  const maxTokens = opts?.maxTokens ?? 500;
  // Rough approximation: 1 token ≈ 4 characters
  const maxChars = maxTokens * 4;

  const lines: string[] = [
    '',
    '## Prior Corrections (learned from past interactions)',
    'Apply these lessons from previous feedback:',
  ];

  let charCount = lines.join('\n').length;

  for (const c of corrections) {
    const line = `- When asked "${truncate(c.userInput, 60)}": ${c.directiveText}`;
    if (charCount + line.length + 1 > maxChars) break;
    lines.push(line);
    charCount += line.length + 1;
  }

  if (lines.length <= 3) return ''; // Only header, no corrections fit

  lines.push('');
  lines.push('These are prior corrections — apply them when relevant, but use judgment for new situations.');

  return lines.join('\n');
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm build && pnpm test src/__tests__/rl-retrieval.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/rl-retrieval.ts src/__tests__/rl-retrieval.test.ts
git commit -m "feat(rl): add correction retrieval with recency + similarity ranking"
```

---

### Task 5: Wire into Agent Pipeline

**Files:**
- Modify: `src/agent.ts` (~lines 17, 168-180)

- [ ] **Step 1: Add imports to agent.ts**

At the top of `src/agent.ts`, alongside the existing `import { processUserTurn } from './personalization.js'`:

```typescript
import { convertSignalsToFeedbackEvent, recordFeedback } from './rl-feedback.js';
import { retrieveRelevantCorrections, buildCorrectionsPrompt } from './rl-retrieval.js';
import type { FeedbackSignal } from './types.js';
```

- [ ] **Step 2: Restructure the personalization block to hoist variables**

The existing code (lines ~168-180) scopes `userMessageText` and `signals` inside the `if` block. Restructure to hoist them:

**Before** (existing code):
```typescript
  // Inject learned user preferences (personalization)
  if (context?.userId && config.personalization?.enabled !== false) {
    const userMessageText = typeof userMessage === 'string'
      ? userMessage
      : (userMessage.find(b => b.type === 'text') as { type: 'text'; text: string } | undefined)?.text || '';
    const { promptSection } = processUserTurn(
      context.userId,
      userMessageText,
      history || [],
      config.personalization,
    );
```

**After** (restructured):
```typescript
  // Extract user message text (needed by personalization + RL feedback)
  const userMessageText = typeof userMessage === 'string'
    ? userMessage
    : (userMessage.find(b => b.type === 'text') as { type: 'text'; text: string } | undefined)?.text || '';

  let feedbackSignals: FeedbackSignal[] = [];

  // Inject learned user preferences (personalization)
  if (context?.userId && config.personalization?.enabled !== false) {
    const { promptSection, signals } = processUserTurn(
      context.userId,
      userMessageText,
      history || [],
      config.personalization,
    );
    feedbackSignals = signals;
```

The rest of the existing personalization block (where `promptSection` is appended to `systemPrompt`) stays the same.

- [ ] **Step 3: Add RL feedback capture after the personalization block**

```typescript
  // RL feedback: capture signals as durable events
  if (
    config.rlFeedback?.enableFeedbackCapture &&
    feedbackSignals.length > 0 &&
    context?.userId
  ) {
    const lastAssistant = (history || [])
      .filter(m => m.role === 'assistant')
      .pop();
    const lastAssistantText = lastAssistant
      ? (typeof lastAssistant.content === 'string'
        ? lastAssistant.content
        : (lastAssistant.content.find(b => b.type === 'text') as any)?.text || '')
      : '';

    const feedbackEvent = convertSignalsToFeedbackEvent({
      signals: feedbackSignals,
      sessionId: context.sessionId || 'unknown',
      userId: context.userId,
      agentId,
      userInput: userMessageText,
      assistantOutput: lastAssistantText,
      model: modelOverride || agentConfig.model,
      trigger: context.trigger,
    });
    if (feedbackEvent) {
      recordFeedback(feedbackEvent);
    }
  }

  // RL retrieval: inject past corrections into prompt
  if (
    config.rlFeedback?.enableRetrieval &&
    context?.userId
  ) {
    const corrections = retrieveRelevantCorrections({
      userId: context.userId,
      currentInput: userMessageText,
      maxResults: config.rlFeedback.maxRetrievedCorrections ?? 5,
    });
    const correctionsPrompt = buildCorrectionsPrompt(corrections, {
      maxTokens: config.rlFeedback.maxPromptTokens ?? 500,
    });
    if (correctionsPrompt) {
      systemPrompt += correctionsPrompt;
    }
  }
```

- [ ] **Step 4: Run full build and test suite**

Run: `pnpm build && pnpm test`
Expected: All existing + new tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts
git commit -m "feat(rl): wire feedback capture and correction retrieval into agent pipeline"
```

---

### Task 6: Training Export Scaffold

**Files:**
- Create: `src/rl-export.ts`
- Create: `src/__tests__/rl-export.test.ts`

- [ ] **Step 1: Write failing tests for rl-export**

Create `src/__tests__/rl-export.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  generatePreferencePairs,
  heuristicRewardJudge,
  exportPreferencePairs,
} from '../rl-export.js';
import { recordFeedback, setFeedbackDirForTesting } from '../rl-feedback.js';
import type { RLFeedbackEvent, RewardJudgment } from '../types.js';

const TEST_DIR = join(tmpdir(), `skimpyclaw-rl-export-test-${Date.now()}`);

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  setFeedbackDirForTesting(TEST_DIR);
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  setFeedbackDirForTesting(null);
});

function makeEvent(overrides: Partial<RLFeedbackEvent> = {}): RLFeedbackEvent {
  return {
    id: 'test-001',
    sessionId: 'sess-1',
    timestamp: new Date().toISOString(),
    userId: 'user-1',
    agentId: 'main',
    userInput: 'fix the bug in auth.ts',
    assistantOutput: 'I updated foo.ts with the fix.',
    feedbackType: 'explicit_correction',
    directiveText: 'Wrong file — fix auth.ts not foo.ts',
    evaluativeScore: -0.6,
    tags: ['coding'],
    safetyFlags: [],
    ...overrides,
  };
}

describe('heuristicRewardJudge', () => {
  it('returns negative score for corrections', () => {
    const event = makeEvent({ feedbackType: 'explicit_correction', evaluativeScore: -0.6 });
    const judgment = heuristicRewardJudge(event);
    expect(judgment.score).toBeLessThan(0);
    expect(judgment.confidence).toBeGreaterThan(0);
    expect(judgment.reason).toBeTruthy();
  });

  it('returns positive score for approvals', () => {
    const event = makeEvent({ feedbackType: 'approval', evaluativeScore: 0.5 });
    const judgment = heuristicRewardJudge(event);
    expect(judgment.score).toBeGreaterThan(0);
  });

  it('returns low confidence for implicit feedback', () => {
    const event = makeEvent({ feedbackType: 'implicit', evaluativeScore: 0.1 });
    const judgment = heuristicRewardJudge(event);
    expect(judgment.confidence).toBeLessThan(0.5);
  });
});

describe('generatePreferencePairs', () => {
  it('generates pairs from correction events', () => {
    const events = [
      makeEvent({
        id: 'c1',
        feedbackType: 'explicit_correction',
        userInput: 'fix auth',
        assistantOutput: 'Changed foo.ts',
        directiveText: 'Should have changed auth.ts',
        evaluativeScore: -0.6,
      }),
    ];
    const pairs = generatePreferencePairs(events);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].prompt).toContain('fix auth');
    expect(pairs[0].rejected).toContain('Changed foo.ts');
    expect(pairs[0].chosen).toContain('auth.ts');
    expect(pairs[0].reward_chosen).toBeGreaterThan(pairs[0].reward_rejected);
  });

  it('skips events with safety flags', () => {
    const events = [
      makeEvent({ safetyFlags: ['contains_secret'] }),
    ];
    const pairs = generatePreferencePairs(events, { excludeSafetyFlags: ['contains_secret'] });
    expect(pairs).toHaveLength(0);
  });

  it('skips approval events (no rejected sample)', () => {
    const events = [
      makeEvent({ feedbackType: 'approval', evaluativeScore: 0.5 }),
    ];
    const pairs = generatePreferencePairs(events);
    expect(pairs).toHaveLength(0);
  });

  it('skips events with excluded tags', () => {
    const events = [
      makeEvent({ tags: ['sensitive'] }),
    ];
    const pairs = generatePreferencePairs(events, { excludeTags: ['sensitive'] });
    expect(pairs).toHaveLength(0);
  });
});

describe('exportPreferencePairs', () => {
  it('writes JSONL file from stored events', () => {
    recordFeedback(makeEvent({ id: 'e1', feedbackType: 'explicit_correction' }));
    recordFeedback(makeEvent({ id: 'e2', feedbackType: 'approval', evaluativeScore: 0.5 }));

    const outputPath = join(TEST_DIR, 'export.jsonl');
    const count = exportPreferencePairs({
      outputPath,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
    expect(count).toBe(1); // Only the correction generates a pair
    expect(existsSync(outputPath)).toBe(true);

    const lines = readFileSync(outputPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const pair = JSON.parse(lines[0]);
    expect(pair.prompt).toBeTruthy();
    expect(pair.chosen).toBeTruthy();
    expect(pair.rejected).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm build 2>&1 | head -5`
Expected: FAIL — module not found

- [ ] **Step 3: Implement rl-export.ts**

Create `src/rl-export.ts`:

```typescript
// RL Export — generate preference pairs from feedback trajectories for DPO-style training

import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { readFeedbackEvents } from './rl-feedback.js';
import type { RLFeedbackEvent, PreferencePair, RewardJudgment } from './types.js';

/**
 * Heuristic reward judge. Returns a scalar judgment based on feedback signals.
 * This is the simplest possible implementation — replace with model-based judge later.
 */
export function heuristicRewardJudge(event: RLFeedbackEvent): RewardJudgment {
  const confidenceMap: Record<string, number> = {
    explicit_correction: 0.8,
    approval: 0.7,
    implicit: 0.3,
  };

  return {
    score: event.evaluativeScore,
    confidence: confidenceMap[event.feedbackType] ?? 0.3,
    reason: `Heuristic: ${event.feedbackType} with score ${event.evaluativeScore.toFixed(2)}`,
  };
}

export interface GenerateOptions {
  excludeTags?: string[];
  excludeSafetyFlags?: string[];
  rewardJudge?: (event: RLFeedbackEvent) => RewardJudgment;
}

/**
 * Generate preference pairs from feedback events.
 * Only correction events produce pairs (chosen = directive, rejected = original output).
 */
export function generatePreferencePairs(
  events: RLFeedbackEvent[],
  opts?: GenerateOptions,
): PreferencePair[] {
  const excludeTags = new Set(opts?.excludeTags ?? []);
  const excludeSafetyFlags = new Set(opts?.excludeSafetyFlags ?? ['contains_secret']);
  const judge = opts?.rewardJudge ?? heuristicRewardJudge;

  const pairs: PreferencePair[] = [];

  for (const event of events) {
    // Only corrections produce chosen/rejected pairs
    if (event.feedbackType !== 'explicit_correction') continue;

    // Safety filtering
    if (event.safetyFlags.some(f => excludeSafetyFlags.has(f))) continue;
    if (event.tags.some(t => excludeTags.has(t))) continue;

    const judgment = judge(event);

    // The "chosen" response is constructed from the directive (what user wanted)
    // The "rejected" response is the original assistant output
    const chosen = `[Corrected per user feedback] ${event.directiveText}`;
    const rejected = event.assistantOutput;

    pairs.push({
      id: randomUUID().slice(0, 8),
      prompt: event.userInput,
      chosen,
      rejected,
      reward_chosen: Math.abs(judgment.score), // Positive for chosen
      reward_rejected: -Math.abs(judgment.score), // Negative for rejected
      metadata: {
        userId: event.userId,
        sessionId: event.sessionId,
        timestamp: event.timestamp,
        feedbackType: event.feedbackType,
        model: event.model,
      },
    });
  }

  return pairs;
}

export interface ExportOptions {
  outputPath: string;
  startDate?: string;
  endDate?: string;
  excludeTags?: string[];
  excludeSafetyFlags?: string[];
  rewardJudge?: (event: RLFeedbackEvent) => RewardJudgment;
}

/**
 * Export preference pairs from stored feedback events to a JSONL file.
 * Returns the number of pairs written.
 */
export function exportPreferencePairs(opts: ExportOptions): number {
  const now = new Date();
  const endDate = opts.endDate ?? now.toISOString().slice(0, 10);
  const startDate = opts.startDate ?? new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  const { events } = readFeedbackEvents({
    startDate,
    endDate,
    limit: 100000,
  });

  const pairs = generatePreferencePairs(events, {
    excludeTags: opts.excludeTags,
    excludeSafetyFlags: opts.excludeSafetyFlags,
    rewardJudge: opts.rewardJudge,
  });

  const content = pairs.map(p => JSON.stringify(p)).join('\n');
  if (content) {
    writeFileSync(opts.outputPath, content + '\n', 'utf-8');
  }

  return pairs.length;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm build && pnpm test src/__tests__/rl-export.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/rl-export.ts src/__tests__/rl-export.test.ts
git commit -m "feat(rl): add preference pair export scaffold with heuristic reward judge"
```

---

### Task 7: Full Integration Test + All Tests Pass

**Files:**
- All files from previous tasks

- [ ] **Step 1: Run full build and test suite**

Run: `pnpm build && pnpm test`
Expected: ALL tests pass (existing ~500 + new ~30)

- [ ] **Step 2: Fix any failures**

If any tests fail, fix them before proceeding.

- [ ] **Step 3: Verify all commits are on feature branch**

```bash
git log --oneline trunk..HEAD
```
Expected: All task commits are present on `feat/rl-feedback-pipeline`

---

## Config Usage

To enable the RL feedback system, add to `~/.skimpyclaw/config.json`:

```json
{
  "rlFeedback": {
    "enableFeedbackCapture": true,
    "enableRetrieval": true,
    "maxRetrievedCorrections": 5,
    "maxPromptTokens": 500,
    "excludeTags": ["sensitive"]
  }
}
```

Both flags default to `false` — the system is opt-in and does nothing until enabled.

## What's Implemented vs Future

| Feature | Status |
|---------|--------|
| Durable JSONL feedback storage | Implemented |
| Automatic correction detection + capture | Implemented (via personalization signals) |
| Cross-session correction retrieval + prompt injection | Implemented |
| Recency + semantic similarity ranking | Implemented |
| Token budget for injected corrections | Implemented |
| Preference pair export (DPO format) | Scaffold implemented |
| Heuristic reward judge | Implemented |
| Model-based reward judge | Interface defined, not implemented |
| Online RL training loop | Not implemented — requires external trainer |
| Embedding-based semantic retrieval | Not implemented — uses word overlap |
