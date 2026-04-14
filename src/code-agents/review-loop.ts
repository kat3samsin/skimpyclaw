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
