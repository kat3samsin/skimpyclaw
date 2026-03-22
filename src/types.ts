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
    defaultAgent?: string;    // Default coding agent CLI: "claude" | "codex" | "kimi" (default: "claude")
    timeoutMinutes?: number;  // Default timeout for solo code_with_agent (default: 30, max: 60)
    teamTimeoutMinutes?: number; // Default timeout for code_with_team (default: 60, max: 120)
    maxTurns?: number;        // Max tool-use turns per agent (default: 50, team children: 25)
    skipPlaywright?: boolean; // Skip Playwright MCP for coding agents (default: false)
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
  sandbox?: SandboxConfig;
  personalization?: PersonalizationConfig;
  rlFeedback?: RLConfig;
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

export interface SandboxConfig {
  enabled: boolean;
  runtime?: 'container' | 'docker';  // default: auto-detect
  image?: string;           // default 'skimpyclaw-sandbox'
  cpus?: number;            // default 2
  memory?: string;          // default '2G'
  network?: string;         // default 'none'
  idleTimeoutMs?: number;   // default 3600000 (1h)
  env?: Record<string, string>;  // extra env vars injected into containers
}

export interface ToolConfig {
  enabled: boolean;
  allowedPaths: string[];
  maxIterations?: number;  // Max tool use rounds (default: 20)
  bashTimeout?: number;    // Bash command timeout in ms (default: 30000)
  maxTurnTokens?: number;  // Max tokens per agent turn (default: 200000)
  toolProfile?: 'minimal' | 'coding' | 'full';  // Tool set to expose (default: 'full')
  contextManagement?: {
    enabled?: boolean;          // default true
    maxContextTokens?: number;  // token threshold before compaction triggers (default: 100000)
    compactionModel?: string;   // model for LLM summarization (default: anthropic/claude-haiku-3-5)
  };
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

export interface GatewayStatus {
  status: 'ok' | 'error';
  uptime: number;
  agent: string;
  model: string;
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
  thinking?: 'none' | 'low' | 'medium' | 'high';
}

export interface AbortSignalLike {
  readonly aborted: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener?: (...args: any[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// --- Personalization Types ---

/** Dimensions of user preference tracked by the personalization system */
export interface PreferenceDimensions {
  /** How verbose responses should be (-1 = terse, 0 = neutral, 1 = detailed) */
  verbosity: number;
  /** How direct/blunt vs. diplomatic (-1 = diplomatic, 0 = neutral, 1 = blunt) */
  directness: number;
  /** Preference for structured formatting like lists, headers (-1 = prose, 0 = neutral, 1 = structured) */
  formatting: number;
  /** How proactive the assistant should be (-1 = reactive, 0 = neutral, 1 = proactive) */
  initiative: number;
  /** Technical detail level (-1 = high-level, 0 = neutral, 1 = deep-dive) */
  technicalDepth: number;
}

/** A single feedback signal detected from a user turn */
export interface FeedbackSignal {
  type: 'correction' | 'reask' | 'acceptance';
  /** Reward value: negative for correction/reask, positive for acceptance */
  reward: number;
  /** Which preference dimensions this signal affects */
  dimensions: Partial<PreferenceDimensions>;
  /** Confidence in this detection (0-1) */
  confidence: number;
  /** Human-readable reason for the signal */
  reason: string;
}

/** Persisted per-user preference profile */
export interface UserProfile {
  userId: string;
  preferences: PreferenceDimensions;
  /** Number of interactions that shaped this profile */
  interactionCount: number;
  /** Confidence per dimension (0-1), grows with consistent signals */
  confidence: PreferenceDimensions;
  /** Whether personalization is enabled for this user */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A durable RL feedback event capturing a full interaction trajectory */
export interface RLFeedbackEvent {
  id: string;
  sessionId: string;
  timestamp: string;
  userId: string;
  agentId: string;
  userInput: string;
  assistantOutput: string;
  toolCalls?: string[];
  toolResultsSummary?: string;
  feedbackType: 'explicit_correction' | 'approval' | 'implicit';
  directiveText: string;
  evaluativeScore: number;       // -1..1
  tags: string[];
  safetyFlags: string[];
  model?: string;
  trigger?: string;
}

/** Config for the RL feedback persistence system */
export interface RLConfig {
  enableFeedbackCapture?: boolean;
  enableRetrieval?: boolean;
  maxRetrievedCorrections?: number;
  maxPromptTokens?: number;
  excludeTags?: string[];
}

/** A preference pair for DPO-style training */
export interface PreferencePair {
  id: string;
  prompt: string;
  chosen: string;
  rejected: string;
  reward_chosen: number;
  reward_rejected: number;
  metadata: {
    userId: string;
    sessionId: string;
    timestamp: string;
    feedbackType: string;
    model?: string;
  };
}

/** Reward judgment from the heuristic judge */
export interface RewardJudgment {
  score: number;
  confidence: number;
  reason: string;
}

/** Config for the personalization system */
export interface PersonalizationConfig {
  enabled?: boolean;
  /** Learning rate for preference updates (default 0.15) */
  learningRate?: number;
  /** Minimum confidence to inject a preference (default 0.3) */
  confidenceThreshold?: number;
  /** Decay factor applied each turn to pull preferences toward neutral (default 0.98) */
  decayFactor?: number;
  /** Max absolute value for any preference dimension (default 0.85) */
  maxDimensionValue?: number;
}
