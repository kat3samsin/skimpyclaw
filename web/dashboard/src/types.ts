// Dashboard API types — mirror backend response shapes

export interface StatusResponse {
  uptime: number;
  agent: string;
  model: string;
  lastMessage?: string;
  activeChannel?: 'telegram' | 'discord' | null;
  cronJobs: CronJobSummary[];
  sandbox?: {
    enabled: boolean;
    runtime?: string;
    image?: string;
  };
  subagents?: {
    maxConcurrent: number;
    active: number;
    running: number;
    pending: number;
    recentTotal: number;
    recentCompleted: number;
    recentFailed: number;
    recentCancelled: number;
  };
  activeSubagents?: Array<{
    id: string;
    type: string;
    status: string;
    model?: string;
    label?: string;
    promptPreview: string;
    retryCount: number;
    maxRetries: number;
    createdAt: string;
    startedAt?: string;
    elapsedSeconds: number;
  }>;
}

export interface CronJobSummary {
  id: string;
  name: string;
  nextRun?: string;
}

export interface CronJob extends CronJobSummary {
  schedule: string;
  enabled: boolean;
  lastRun?: string;
  lastStatus?: string;
}

export interface AuditEvent {
  type: string;
  summary: string;
  durationMs?: number;
  timestamp?: string;
  detail?: Record<string, unknown> | string;
}

export interface AuditTrace {
  traceId: string;
  trigger: string;
  status: 'success' | 'error' | 'running';
  startedAt: string;
  endedAt?: string;
  events: AuditEvent[];
}

export interface AuditResponse {
  traces: AuditTrace[];
  total: number;
}

export interface ApprovalChannelMeta {
  channel: 'telegram' | 'discord' | 'dashboard' | string;
  chatId?: number | string;
  userId?: string;
  username?: string;
}

export interface Approval {
  id: string;
  command: string;
  cwd?: string;
  reason?: string;
  tier: number;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  approvedBy?: string;
  deniedBy?: string;
  channelMeta?: ApprovalChannelMeta;
}

export interface ApprovalsResponse {
  pending: Approval[];
  recent: Approval[];
  now: string;
}

export interface HealthCheck {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message?: string;
}

export interface DoctorCheck {
  name: string;
  category?: string;
  ok: boolean;
  detail?: string;
  remedy?: string;
  fatal?: boolean;
}

export interface DoctorResponse {
  report: {
    ok: boolean;
    checks: DoctorCheck[];
  };
}

export interface HealthResponse {
  ok: boolean;
  checks: DoctorCheck[];
  features?: Record<string, boolean>;
  envVars?: Array<{ name: string; set: boolean }>;
}

export interface MemoryFile {
  name: string;
  size: number;
  date: string;
}

export interface MemoryResponse {
  agentId: string;
  files: MemoryFile[];
}

export interface MemoryFileResponse {
  content: string;
}

export interface Template {
  name: string;
  content: string;
}

export interface TemplateListItem {
  name: string;
  exists: boolean;
  size: number;
}

export interface TemplateListResponse {
  templates: TemplateListItem[];
}

export interface LogFile {
  name: string;
  size: number;
  modified: string;
}

export interface LogListResponse {
  files: LogFile[];
}

export interface CodeAgent {
  id: string;
  agent: string;
  status: 'running' | 'completed' | 'failed' | 'validating' | 'timeout' | 'pending' | 'cancelled';
  task: string;
  startedAt: string;
  endedAt?: string;
  durationSeconds?: number;
  outputPreview?: string;
  liveOutput?: string;
  error?: string;
  model?: string;
  parentTaskId?: string;
  childTaskIds?: string[];
  subtask?: string;
  synthesisResult?: string;
  validationPassed?: boolean;
  validationOutput?: string;
  workdir?: string;
  wave?: number;
  retryCount?: number;
  totalCost?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface CodeAgentsResponse {
  agents: CodeAgent[];
}

export interface ConfigResponse {
  config: Record<string, unknown>;
}

export interface ModelResponse {
  current: string;
  aliases: Record<string, string>;
  agents: Record<string, string>;
}

export interface SetModelResponse {
  model: string;
}

export interface Digest {
  id: string;
  jobId: string;
  jobName: string;
  createdAt: string;
  articleCount: number;
  preview: string[];
}

export interface DigestsResponse {
  digests: Digest[];
}

export interface DigestArticle {
  id: string;
  title: string;
  source: string;
  url: string;
  score?: number;
  comments?: number;
  summary?: string;
  sourceUrl?: string;
  read?: boolean;
}

export interface DigestResponse {
  id: string;
  jobId: string;
  jobName: string;
  createdAt: string;
  summary?: string;
  articles: DigestArticle[];
}

export interface Skill {
  name: string;
  description?: string;
  emoji?: string;
  tags?: string[];
  enabled?: boolean;
  eligible?: boolean;
  reason?: string;
  priority?: number;
  contexts?: string[];
  requires?: Record<string, unknown>;
}

export interface SkillsResponse {
  skills: Skill[];
}

export interface SkillResponse {
  name: string;
  description?: string;
  emoji?: string;
  tags?: string[];
  enabled?: boolean;
  eligible?: boolean;
  reason?: string;
  priority?: number;
  contexts?: string[];
  requires?: Record<string, unknown>;
  body?: string;
  rawContent?: string;
}

// --- Usage ---

export interface UsageModelBreakdown {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface UsageAggregation {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCalls: number;
  byModel: Record<string, UsageModelBreakdown>;
}

export interface UsageSummaryResponse {
  today: UsageAggregation;
  week: UsageAggregation;
  month: UsageAggregation;
}

export interface UsageRecord {
  id: string;
  timestamp: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  trigger: string;
  agentId?: string;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface UsageRecordsResponse {
  records: UsageRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface ConversationSummary {
  id: string;
  channel: 'telegram' | 'discord';
  chatId: string;
  updatedAt: string;
  messageCount: number;
  preview?: string;
}

export interface ConversationMessage {
  ts: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface ConversationDetail {
  id: string;
  messages: ConversationMessage[];
  total: number;
  hasMore: boolean;
}

// ── Review-loop Work items ────────────────────────────────────────────

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

export interface ReviewFinding {
  id: string;
  severity: 'low' | 'medium' | 'high';
  summary: string;
  file?: string;
  line?: number;
  status: 'open' | 'resolved' | 'disputed';
  iterationRaised: number;
  iterationResolved?: number;
}

export interface WorkChatMessage {
  id: string;
  role: 'user' | 'planner';
  content: string;
  createdAt: string;
}

export type TimelineEventKind =
  | 'created' | 'plan-produced' | 'plan-approved'
  | 'dev-started' | 'dev-completed'
  | 'review-started' | 'review-completed'
  | 'paused' | 'resumed' | 'stopped' | 'blocked' | 'done';

export interface WorkTimelineEvent {
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

export interface WorkLiveActivity {
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
  chatMessages: WorkChatMessage[];
  timeline: WorkTimelineEvent[];
  liveActivity?: WorkLiveActivity;
  lastReviewCommit?: string;
  currentPlan?: string;
  pendingUserMessage?: boolean;
  createdAt: string;
  updatedAt: string;
  cost?: number;
  blockedReason?: string;
  stoppedReason?: string;
}

export interface WorkListResponse {
  items: WorkItemState[];
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
