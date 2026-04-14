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

import { setWorkRootForTesting, saveWorkItem } from '../code-agents/review-loop-storage.js';
import { createWorkItem, getWorkItem, listWorkItems, appendUserMessage, approvePlan, pauseWorkItem, resumeWorkItem, stopWorkItem } from '../code-agents/review-loop.js';

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

  it('approvePlan transitions awaiting_approval → planning', () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    s.status = 'awaiting_approval';
    s.currentPlan = 'plan body';
    saveWorkItem(s);
    const updated = approvePlan(s.id);
    expect(updated?.status).toBe('planning');
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
    saveWorkItem(s);
    const updated = pauseWorkItem(s.id);
    expect(updated?.status).toBe('paused');
    expect(updated?.previousStatus).toBe('implementing');
  });

  it('resumeWorkItem restores previousStatus', () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    s.status = 'paused';
    s.previousStatus = 'reviewing';
    saveWorkItem(s);
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
