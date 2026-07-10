// SkimpyClaw Type Definitions

import type { SkillConfig } from './skills-types.js';
export type { SkillConfig } from './skills-types.js';

export interface VoiceProviderConfig {
  apiKey?: string;
  baseURL?: string;
  tts?: {
    model?: string;
    voice?: string;
    speed?: number;
    voiceId?: string;  // ElevenLabs
  };
  stt?: {
    model?: string;
  };
}

export interface VoiceChannelConfig {
  enabled?: boolean;
  acceptVoice?: boolean;
  sendVoice?: boolean;
}

export interface VoiceConfig {
  enabled?: boolean;
  providers?: Record<string, VoiceProviderConfig>;
  defaultProvider?: string;
  channels?: Record<string, VoiceChannelConfig>;
}

export interface Config {
  /** Global allowed paths. Channels, cron, and heartbeat inherit these
   *  unless they specify their own tools.allowedPaths override. */
  allowedPaths?: string[];
  gateway: {
    port: number;
    host?: string;  // Bind address (default: '127.0.0.1')
    publicHost?: string; // Host used in generated links when bind host is local/all-interfaces
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
    promptCaching?: boolean;  // Enable Anthropic prompt caching (default true)
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
    frontend?: 'framework';
  };
  codeAgents?: {
    maxConcurrent?: number;   // Max parallel coding agents (default 5)
    defaultAgent?: string;    // Default coding agent CLI: "claude" | "codex" (default: "claude")
    timeoutMinutes?: number;  // Default timeout for code_with_agent (default: 30, max: 60)
    maxTurns?: number;        // Max tool-use turns per agent (default: 50)
    worktrees?: {
      enabled?: boolean;       // Enable isolated git worktrees for safe parallel work (default true)
      mode?: 'off' | 'auto' | 'always'; // auto isolates review/rebase tasks
      root?: string;           // Worktree parent directory (default: ~/.skimpyclaw/worktrees)
      cleanup?: boolean;       // Remove clean/unchanged worktrees after completion (default true)
    };
    /** Per-project validation commands. Keys match project names from `projects` config.
     *  Values are shell commands run in the project dir. Overrides auto-detected build+test. */
    validationCommands?: Record<string, string>;
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
  voice?: VoiceConfig;
  skills?: SkillConfig;
  /** Named project paths. Keys are short names (e.g. "skimpyclaw"), values are absolute paths.
   *  Project paths are automatically added to tool allowedPaths and available to code_with_agent by name. */
  projects?: Record<string, string>;
}

export interface AgentConfig {
  identity: {
    name: string;
    emoji: string;
  };
  model: string;
  thinking?: ThinkingLevel;
}

export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

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
  /** Route coding agent status updates to a thread on the triggering message (default: true) */
  threadedReplies?: boolean;
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
  agent?: string;
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
  sendAsVoice?: boolean;
  /** Discord thread ID for routing notifications. Invalid/unavailable thread targets fall back to default channel delivery. */
  discordThreadId?: string;
}

export interface ToolConfig {
  enabled: boolean;
  allowedPaths: string[];
  maxIterations?: number;  // Legacy finalization checkpoint interval; does not cap tool loops
  bashTimeout?: number;    // Bash command timeout in ms (default: 30000)
  maxTurnTokens?: number;  // Cumulative provider tokens before text-only finalization (default: 200000)
  toolProfile?: 'minimal' | 'coding' | 'full';  // Tool set to expose (default: 'full')
  contextManagement?: {
    enabled?: boolean;          // default true
    maxContextTokens?: number;  // token threshold before compaction triggers (default: 100000)
    compactionModel?: string;   // model for LLM summarization (default: anthropic/claude-haiku-4-5)
  };
  execApproval?: {
    enabled?: boolean;       // default true
    ttlMs?: number;          // default 5 min (300000ms)
    requireForTiers?: number[]; // default [2, 3]
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

export type InteractiveSessionStatus = 'active' | 'errored' | 'archived';

export interface InteractiveSession {
  discordThreadId: string;
  cliSessionId: string;               // UUID for claude, thread_id for codex
  cliAgent: 'claude' | 'codex';
  status: InteractiveSessionStatus;
  createdAt: string;                  // ISO 8601
  lastActivityAt: string;             // ISO 8601
  initialTask: string;
}

export interface GatewayStatus {
  status: 'ok' | 'error';
  uptime: number;
  agent: string;
  model: string;
  thinking?: ThinkingLevel;
  lastMessage?: Date;
  activeChannel?: ChannelId | null;
  cronJobs: { id: string; name: string; nextRun?: Date }[];
}

export interface ModelProvider {
  name: string;
  chat(messages: ChatMessage[], options: ChatOptions): Promise<string>;
}


export type ImageContentBlock = {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
};

export type TextContentBlock = {
  type: 'text';
  text: string;
};

export type ContentBlock = TextContentBlock | ImageContentBlock;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface FeedbackSignal {
  type: 'correction' | 'acceptance';
  reward: number;
  confidence: number;
  reason: string;
  dimensions: Partial<Record<string, number>>;
}

export interface ChatOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  thinking?: ThinkingLevel;
}

export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener?: (...args: any[]) => void;
  removeEventListener?: (...args: any[]) => void;
}

export interface AgentRunContext {
  userId?: string;
  sessionId?: string;
  channel?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  abortSignal?: AbortSignalLike;
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
  trigger: 'telegram' | 'cron' | 'api' | 'system' | 'discord' | 'code_agent' | 'code_team';
  status: 'ok' | 'error';
  startedAt: string;
  endedAt: string;
  durationMs: number;
  events: AuditEvent[];
}
