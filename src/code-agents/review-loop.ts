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
