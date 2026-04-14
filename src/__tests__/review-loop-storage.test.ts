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
    // updatedAt is rewritten by saveWorkItem; compare other fields
    expect(loaded?.id).toBe(s.id);
    expect(loaded?.title).toBe(s.title);
    expect(loaded?.status).toBe(s.status);
  });

  it('loadWorkItem returns null for missing', () => {
    expect(loadWorkItem('RL-999')).toBeNull();
  });

  it('listWorkItems returns newest first', () => {
    const a = { ...makeState('RL-001'), updatedAt: '2026-04-14T10:00:00.000Z' };
    const b = { ...makeState('RL-002'), updatedAt: '2026-04-14T11:00:00.000Z' };
    // saveWorkItem overwrites updatedAt — bypass by writing directly through save twice with delay
    saveWorkItem(a);
    // Sleep 10ms so b gets a later updatedAt from saveWorkItem
    const start = Date.now();
    while (Date.now() - start < 10) { /* spin */ }
    saveWorkItem(b);
    const list = listWorkItems();
    expect(list.map(w => w.id)).toEqual(['RL-002', 'RL-001']);
  });

  it('saveWorkItem is atomic — corrupt tmp does not clobber existing file', () => {
    const s = makeState('RL-007');
    saveWorkItem(s);
    const file = join(tmp, 'RL-007.json');
    const original = readFileSync(file, 'utf-8');
    const bad: any = { ...s };
    bad.self = bad;  // circular → JSON.stringify throws
    expect(() => saveWorkItem(bad)).toThrow();
    expect(readFileSync(file, 'utf-8')).toBe(original);
  });
});
