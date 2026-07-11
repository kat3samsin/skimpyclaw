// Dashboard API types — mirror backend response shapes

export interface StatusResponse {
  uptime: number;
  agent: string;
  model: string;
  lastMessage?: string;
  activeChannel?: 'telegram' | 'discord' | null;
  cronJobs: CronJobSummary[];
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
  modelLabel?: string;
  effort?: string;
  validationPassed?: boolean;
  validationOutput?: string;
  workdir?: string;
  sourceWorkdir?: string;
  worktreePath?: string;
  worktreeRef?: string;
  worktreeCleanup?: {
    status: 'removed' | 'preserved' | 'skipped' | 'failed';
    path?: string;
    reason?: string;
    at: string;
  };
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

export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'ultra';

export interface AgentProfile {
  alias: string;
  agentId: string;
  model?: string;
  thinking?: ThinkingLevel;
  promptOverlay?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfileBinding {
  threadId: string;
  profileAlias: string;
  guildId?: string;
  channelId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConfiguredAgentSummary {
  name: string;
  emoji: string;
  model: string;
  thinking?: ThinkingLevel;
}

export interface AgentProfilesResponse {
  profiles: AgentProfile[];
  bindings: AgentProfileBinding[];
  configuredAgents: Record<string, ConfiguredAgentSummary>;
  modelAliases: Record<string, string>;
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
