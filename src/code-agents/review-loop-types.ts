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
  id: string;
  severity: FindingSeverity;
  summary: string;
  file?: string;
  line?: number;
  status: 'open' | 'resolved' | 'disputed';
  iterationRaised: number;
  iterationResolved?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'planner';
  content: string;
  createdAt: string;
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
  id: string;
  kind: TimelineEventKind;
  iteration: number;
  at: string;
  summary: string;
  changedFiles?: string[];
  findingsSnapshot?: ReviewFinding[];
  codeAgentTaskId?: string;
  note?: string;
}

export interface LiveActivity {
  agent: 'planner' | 'dev' | 'reviewer';
  codeAgentTaskId: string;
  startedAt: string;
}

export interface WorkItemState {
  id: string;
  title: string;
  prompt: string;
  workdir: string;
  baseRef: string;
  plannerModel: string;
  devModel: string;
  reviewerModel: string;
  maxIterations: number;
  iteration: number;
  status: WorkStatus;
  previousStatus?: WorkStatus;
  findings: ReviewFinding[];
  chatMessages: ChatMessage[];
  timeline: TimelineEvent[];
  liveActivity?: LiveActivity;
  lastReviewCommit?: string;
  currentPlan?: string;
  pendingUserMessage?: boolean;
  /** Set when user approves the current plan; cleared after planner consumes it to emit next_dev_task. */
  planApproved?: boolean;
  /** Skip the awaiting_approval gate — treat every plan as pre-approved. */
  autoApprove?: boolean;
  createdAt: string;
  updatedAt: string;
  cost?: number;
  blockedReason?: string;
  stoppedReason?: string;
}

export interface CreateWorkInput {
  prompt: string;
  workdir: string;
  baseRef?: string;
  plannerModel?: string;
  devModel?: string;
  reviewerModel?: string;
  maxIterations?: number;
  autoApprove?: boolean;
}

export interface PlannerOutput {
  status: 'awaiting_approval' | 'revising' | 'blocked';
  summary: string;
  plan: string;
  next_dev_task?: string;
  blocked_reason?: string;
  resolved_finding_ids?: string[];
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
