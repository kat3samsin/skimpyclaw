import type {
  CreateWorkInput,
  WorkItemState,
  TimelineEvent,
  TimelineEventKind,
  ChatMessage,
} from './review-loop-types.js';
import { buildPlannerPrompt, parsePlannerOutput, buildDevPrompt } from './review-loop-prompts.js';
import { getHeadSha, getChangedFiles } from './review-loop-diff.js';
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
  state.status = 'planning';
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

import {
  getNextCodeAgentId,
  storeCodeAgentTask,
  writeCodeAgentTask,
  getCodeAgent,
} from './registry.js';
import { runCodeAgentBackground } from './executor.js';
import type { CodeAgentTask } from './types.js';

export interface RunAgentStepInput {
  agent: string;
  model?: string;
  task: string;
  workdir: string;
  validate: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
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
    pollIntervalMs: 5,
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

function findPendingDevTask(state: WorkItemState): string | null {
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
    agent: 'claude',
    model: state.devModel,
    task: devPrompt,
    workdir: state.workdir,
    validate: true,
    pollIntervalMs: 5,
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

export async function tickWorkItem(id: string): Promise<WorkItemState | null> {
  const state = loadWorkItem(id);
  if (!state) return null;

  if (['paused', 'done', 'blocked', 'stopped'].includes(state.status)) {
    return state;
  }

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
      return state;
    case 'implementing':
      return runDev(state);
    case 'reviewing':
      return state;  // implemented in Task 10
    default:
      return state;
  }
}
