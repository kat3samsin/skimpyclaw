// SkimpyClaw Type Definitions

export interface Config {
  gateway: {
    port: number;
    mode: 'local' | 'remote';
  };
  agents: {
    default: string;
    list: Record<string, AgentConfig>;
  };
  models: {
    providers: {
      [key: string]: { apiKey?: string; authToken?: string; baseURL?: string; authPath?: string } | undefined;
    };
    aliases: Record<string, string>;
  };
  channels: ChannelsConfig;
  cron: {
    jobs: CronJob[];
  };
  heartbeat: {
    intervalMs: number;
    prompt: string;
    model?: string;
    tools?: ToolConfig;
  };
  dashboard?: {
    token?: string;
  };
  subagents?: {
    maxConcurrent?: number;   // Max parallel subagents (default 5)
    maxRetries?: number;      // Max retries on failure (default 2)
  };
  langfuse?: {
    enabled?: boolean;
    publicKey?: string;
    secretKey?: string;
    baseUrl?: string;
    environment?: string;
    release?: string;
    exportMode?: 'immediate' | 'batched';
  };
}

export interface AgentConfig {
  identity: {
    name: string;
    emoji: string;
  };
  model: string;
  thinking?: 'none' | 'low' | 'medium' | 'high';
}

export type AllowlistEntry = string | number;

export type ChannelId = 'telegram' | 'discord';

export interface TelegramChannelConfig {
  enabled: boolean;
  token: string;
  allowFrom: AllowlistEntry[];
  tools?: ToolConfig;
  dailyNotesDir?: string;
  defaultAllowedPaths?: string[];
}

export interface DiscordChannelConfig {
  enabled: boolean;
  token: string;
  allowFrom: AllowlistEntry[];
  tools?: ToolConfig;
  defaultAllowedPaths?: string[];
  defaultChannelId?: string;
}

export interface ChannelsConfig {
  // Single active channel preference. If unset, runtime picks the first enabled channel.
  active?: ChannelId;
  telegram: TelegramChannelConfig;
  discord?: DiscordChannelConfig;
}

export interface CronJob {
  id: string;
  name: string;
  schedule: CronSchedule;
  payload: CronPayload;
  model?: string;
}

export interface CronSchedule {
  kind: 'cron' | 'interval';
  expr?: string; // For cron
  ms?: number;   // For interval
  tz?: string;
}

export interface CronPayload {
  kind: 'agentTurn' | 'http' | 'script';
  message?: string;
  url?: string;
  script?: string;
  cwd?: string;
  timeoutMs?: number;
  tools?: ToolConfig;
}

export interface ToolConfig {
  enabled: boolean;
  allowedPaths: string[];
  maxIterations?: number;  // Max tool use rounds (default: 20)
  bashTimeout?: number;    // Bash command timeout in ms (default: 30000)
  browser?: {
    enabled?: boolean;
    type?: 'chromium' | 'firefox' | 'webkit';
    headless?: boolean;
    allowFile?: boolean;
    slowMoMs?: number;
    userAgent?: string;
    viewport?: { width: number; height: number };
    profileDir?: string;
    executablePath?: string;
  };
}

export interface AgentTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface Session {
  id: string;
  agentId: string;
  model: string;
  turns: AgentTurn[];
  createdAt: Date;
  updatedAt: Date;
}

export interface GatewayStatus {
  status: 'ok' | 'error';
  uptime: number;
  agent: string;
  model: string;
  lastMessage?: Date;
  cronJobs: { id: string; name: string; nextRun?: Date }[];
}

export interface ModelProvider {
  name: string;
  chat(messages: ChatMessage[], options: ChatOptions): Promise<string>;
}

export type SubagentType = 'coding' | 'research' | 'general';
export type SubagentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SubagentTask {
  id: string;               // "t1", "t2", etc.
  type: SubagentType;
  prompt: string;
  status: SubagentStatus;
  chatId: number;
  model: string;
  label?: string;           // Short label for status display
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  result?: string;
  error?: string;
  retryCount?: number;      // Current retry attempt (0-based)
  maxRetries?: number;      // Max retries on failure (default 2)
  abortController: AbortController;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  thinking?: 'none' | 'low' | 'medium' | 'high';
}

export interface AgentRunContext {
  userId?: string;
  sessionId?: string;
  channel?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  /** Audit trigger label (e.g. "telegram", "cron", "discord", "system") */
  trigger?: AuditTrace['trigger'];
}

export interface AuditEvent {
  type: string;
  summary: string;
  durationMs: number;
  detail?: Record<string, unknown>;
}

export interface AuditTrace {
  traceId: string;
  trigger: 'telegram' | 'cron' | 'api' | 'system' | 'discord';
  status: 'ok' | 'error';
  startedAt: string;
  endedAt: string;
  durationMs: number;
  events: AuditEvent[];
}

