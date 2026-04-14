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

vi.mock('../code-agents/registry.js', () => ({
  getNextCodeAgentId: vi.fn(() => 'ca-mock'),
  storeCodeAgentTask: vi.fn(() => {}),
  writeCodeAgentTask: vi.fn(() => {}),
  getCodeAgent: vi.fn(() => ({
    id: 'ca-mock', status: 'completed', outputPreview: 'ok',
    agent: 'claude', task: 't', startedAt: new Date().toISOString(), workdir: '/r',
  })),
}));

import * as executorMock from '../code-agents/executor.js';
import * as registryMock from '../code-agents/registry.js';
import * as diffMock from '../code-agents/review-loop-diff.js';
import { runAgentStep } from '../code-agents/review-loop.js';
import { setWorkRootForTesting, saveWorkItem } from '../code-agents/review-loop-storage.js';
import { createWorkItem, getWorkItem, listWorkItems, appendUserMessage, approvePlan, pauseWorkItem, resumeWorkItem, stopWorkItem, tickWorkItem } from '../code-agents/review-loop.js';

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

describe('review-loop: runAgentStep', () => {
  beforeEach(() => {
    (registryMock.getNextCodeAgentId as any).mockReturnValue('ca-99');
    (registryMock.storeCodeAgentTask as any).mockImplementation(() => {});
    (registryMock.writeCodeAgentTask as any).mockImplementation(() => {});
    (executorMock.runCodeAgentBackground as any).mockResolvedValue(undefined);
  });

  it('spawns runCodeAgentBackground and polls registry until completion', async () => {
    (registryMock.getCodeAgent as any).mockReturnValue({
      id: 'ca-99',
      agent: 'claude',
      status: 'completed',
      outputPreview: '{"verdict":"approved","findings":[]}',
      task: 't',
      startedAt: new Date().toISOString(),
      workdir: '/r',
    });

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
    (registryMock.getCodeAgent as any).mockReturnValue({
      id: 'ca-1', status: 'running', task: 't', agent: 'claude',
      startedAt: new Date().toISOString(), workdir: '/r',
    });

    await expect(runAgentStep({
      agent: 'claude', model: 'm', task: 't', workdir: '/r', validate: false,
      pollIntervalMs: 5, timeoutMs: 20,
    })).rejects.toThrow(/timed out/i);
  });
});

describe('tickWorkItem: planning', () => {
  beforeEach(() => {
    (registryMock.getNextCodeAgentId as any).mockReturnValue('ca-plan');
    (executorMock.runCodeAgentBackground as any).mockResolvedValue(undefined);
  });

  function mockPlannerResponse(output: string, status: 'completed' | 'failed' = 'completed', error?: string) {
    (registryMock.getCodeAgent as any).mockReturnValue({
      id: 'ca-plan', status, outputPreview: output, error,
      agent: 'claude', task: 't', startedAt: new Date().toISOString(), workdir: '/r',
    });
  }

  it('transitions planning → awaiting_approval with plan text', async () => {
    const s = createWorkItem({ prompt: 'Fix login', workdir: '/r' });
    mockPlannerResponse('{"status":"awaiting_approval","summary":"sum","plan":"PLAN BODY"}');

    const updated = await tickWorkItem(s.id);
    expect(updated?.status).toBe('awaiting_approval');
    expect(updated?.currentPlan).toBe('PLAN BODY');
    expect(updated?.chatMessages.find(m => m.role === 'planner')?.content).toBe('PLAN BODY');
    expect(updated?.timeline.some(t => t.kind === 'plan-produced')).toBe(true);
    expect(updated?.pendingUserMessage).toBe(false);
  });

  it('revising output → transitions to implementing and stores next_dev_task', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    mockPlannerResponse('{"status":"revising","summary":"s","plan":"P","next_dev_task":"Do X"}');

    const updated = await tickWorkItem(s.id);
    expect(updated?.status).toBe('implementing');
    expect(updated?.currentPlan).toBe('P');
    const planEvent = updated?.timeline.find(t => t.kind === 'plan-produced');
    expect(planEvent?.note).toBe('Do X');
  });

  it('planner output blocked → transitions to blocked', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    mockPlannerResponse('{"status":"blocked","summary":"s","plan":"P","blocked_reason":"no creds"}');

    const updated = await tickWorkItem(s.id);
    expect(updated?.status).toBe('blocked');
    expect(updated?.blockedReason).toBe('no creds');
  });

  it('invalid planner JSON → blocked with reason', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    mockPlannerResponse('not json at all');
    const updated = await tickWorkItem(s.id);
    expect(updated?.status).toBe('blocked');
    expect(updated?.blockedReason).toMatch(/planner/i);
  });

  it('agent step failed → blocked', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    mockPlannerResponse('', 'failed', 'network');
    const updated = await tickWorkItem(s.id);
    expect(updated?.status).toBe('blocked');
    expect(updated?.blockedReason).toContain('network');
  });

  it('tick on paused item is a no-op', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    s.status = 'paused';
    saveWorkItem(s);
    (executorMock.runCodeAgentBackground as any).mockClear();
    const updated = await tickWorkItem(s.id);
    expect(updated?.status).toBe('paused');
    expect((executorMock.runCodeAgentBackground as any).mock.calls.length).toBe(0);
  });

  it('tick on done/blocked/stopped items is a no-op', async () => {
    for (const status of ['done', 'blocked', 'stopped'] as const) {
      const s = createWorkItem({ prompt: 'X', workdir: '/r' });
      s.status = status;
      saveWorkItem(s);
      (executorMock.runCodeAgentBackground as any).mockClear();
      const u = await tickWorkItem(s.id);
      expect(u?.status).toBe(status);
      expect((executorMock.runCodeAgentBackground as any).mock.calls.length).toBe(0);
    }
  });
});

describe('tickWorkItem: implementing', () => {
  beforeEach(() => {
    (registryMock.getNextCodeAgentId as any).mockReturnValue('ca-dev');
    (executorMock.runCodeAgentBackground as any).mockResolvedValue(undefined);
  });

  it('runs dev agent, captures changed files, transitions to reviewing, increments iteration', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    s.status = 'implementing';
    s.timeline.push({
      id: 't-2', kind: 'plan-produced', iteration: 0, at: new Date().toISOString(),
      summary: 's', note: 'Do the thing',
    });
    s.lastReviewCommit = 'base123';
    saveWorkItem(s);

    (diffMock.getHeadSha as any).mockReturnValue('head456');
    (diffMock.getChangedFiles as any).mockReturnValue(['a.ts', 'b.ts']);

    (registryMock.getCodeAgent as any).mockReturnValue({
      id: 'ca-dev', status: 'completed', outputPreview: 'done',
      agent: 'claude', task: 't', startedAt: new Date().toISOString(), workdir: '/r',
    });

    const updated = await tickWorkItem(s.id);
    expect(updated?.status).toBe('reviewing');
    expect(updated?.iteration).toBe(1);
    const devEvent = updated?.timeline.find(t => t.kind === 'dev-completed');
    expect(devEvent?.changedFiles).toEqual(['a.ts', 'b.ts']);
    expect(devEvent?.codeAgentTaskId).toBe('ca-dev');
  });

  it('dev failure → blocked', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    s.status = 'implementing';
    s.timeline.push({
      id: 't-2', kind: 'plan-produced', iteration: 0,
      at: new Date().toISOString(), summary: 's', note: 'task',
    });
    saveWorkItem(s);

    (registryMock.getCodeAgent as any).mockReturnValue({
      id: 'ca-dev', status: 'failed', error: 'boom',
      agent: 'claude', task: 't', startedAt: new Date().toISOString(), workdir: '/r',
    });
    const updated = await tickWorkItem(s.id);
    expect(updated?.status).toBe('blocked');
    expect(updated?.blockedReason).toContain('boom');
  });
});
