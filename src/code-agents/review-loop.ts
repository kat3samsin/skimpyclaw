import type {
  CreateWorkInput,
  WorkItemState,
  TimelineEvent,
  TimelineEventKind,
  ChatMessage,
  ReviewFinding,
} from './review-loop-types.js';
import { buildPlannerPrompt, parsePlannerOutput, buildDevPrompt, buildReviewerPrompt, parseReviewerOutput } from './review-loop-prompts.js';
import { getHeadSha, getChangedFiles, getReviewDiff } from './review-loop-diff.js';
import {
  loadWorkItem,
  saveWorkItem,
  listWorkItems as storageList,
  allocateWorkItemId,
} from './review-loop-storage.js';
import { resolveSelectedCodeAgent, resolveModelAlias, getCodeAgentConfig } from './utils.js';

function agentForModel(model: string): 'claude' | 'codex' | 'kimi' {
  return resolveSelectedCodeAgent(undefined, 'claude', model) ?? 'claude';
}

function resolveModel(model: string): string {
  const aliases = getCodeAgentConfig()?.models?.aliases;
  return resolveModelAlias(model, aliases) ?? model;
}

const DEFAULT_PLANNER = 'claude-opus';
const DEFAULT_DEV = 'claude-think';
const DEFAULT_REVIEWER = 'codex';
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
  const id = allocateWorkItemId();
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
  state.planApproved = true;
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

  let result;
  try {
    result = await runAgentStep({
      agent: agentForModel(state.plannerModel),
      model: resolveModel(state.plannerModel),
      task: prompt,
      workdir: state.workdir,
      validate: false,
      pollIntervalMs: 5,
    });
  } catch (err) {
    state.liveActivity = undefined;
    markBlocked(state, `planner step threw: ${err instanceof Error ? err.message : String(err)}`);
    saveWorkItem(state);
    return state;
  }
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

  const wasApproved = state.planApproved === true;
  state.planApproved = false;  // consumed

  // If user already approved a plan, coerce an awaiting_approval response
  // into revising — we already have user consent to proceed.
  const effectiveStatus = (wasApproved && parsed.status === 'awaiting_approval')
    ? 'revising' : parsed.status;

  if (effectiveStatus === 'awaiting_approval') {
    state.status = 'awaiting_approval';
  } else if (effectiveStatus === 'revising') {
    const devTask = parsed.next_dev_task
      ?? (wasApproved ? parsed.plan : undefined);
    if (!devTask) {
      markBlocked(state, 'planner status=revising but no next_dev_task');
    } else {
      const lastEvent = state.timeline[state.timeline.length - 1]!;
      lastEvent.note = devTask;
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

  let result;
  try {
    result = await runAgentStep({
      agent: agentForModel(state.devModel),
      model: resolveModel(state.devModel),
      task: devPrompt,
      workdir: state.workdir,
      validate: true,
      pollIntervalMs: 5,
    });
  } catch (err) {
    state.liveActivity = undefined;
    markBlocked(state, `dev step threw: ${err instanceof Error ? err.message : String(err)}`);
    saveWorkItem(state);
    return state;
  }
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

  let result;
  try {
    result = await runAgentStep({
      agent: agentForModel(state.reviewerModel),
      model: resolveModel(state.reviewerModel),
      task: reviewerPrompt,
      workdir: state.workdir,
      validate: false,
      pollIntervalMs: 5,
    });
  } catch (err) {
    state.liveActivity = undefined;
    markBlocked(state, `reviewer step threw: ${err instanceof Error ? err.message : String(err)}`);
    saveWorkItem(state);
    return state;
  }
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
  const state = loadWorkItem(id);
  if (!state) return null;

  if (['paused', 'done', 'blocked', 'stopped'].includes(state.status)) {
    return state;
  }

  if (state.status === 'implementing' && state.iteration >= state.maxIterations) {
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
      return runReviewer(state);
    default:
      return state;
  }
}
