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
