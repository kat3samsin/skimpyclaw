// Code Agent Type Definitions

import type { ToolConfig } from '../types.js';

export interface CodeAgentTask {
  id: string;                    // "ca-1", "ca-2"
  agent: string;                 // "claude" | "codex"
  task: string;                  // full prompt
  status: 'running' | 'validating' | 'completed' | 'failed' | 'timeout' | 'pending' | 'cancelled';
  chatId?: number;               // for notification delivery
  discordThreadId?: string;      // Discord thread ID for threaded status updates
  discordChannelId?: string;     // Discord channel ID where the task was triggered
  startedAt: string;
  endedAt?: string;
  durationSeconds?: number;
  exitCode?: number | null;
  validationPassed?: boolean;
  validationOutput?: string;     // pnpm build/test output on failure (first 8KB)
  outputPreview?: string;        // first 500 chars of result
  liveOutput?: string;           // last 5KB for streaming
  error?: string;
  workdir: string;
  model?: string;
  retryCount?: number;           // how many internal validation retries have run
  // Cost / token tracking (from Claude CLI result event)
  totalCost?: number;
  inputTokens?: number;
  outputTokens?: number;
  // Interactive coding session (Discord thread bidirectional; claude/codex only).
  interactive?: boolean;
  cliSessionId?: string;         // claude --session-id UUID; set at spawn time
}

export interface CodeAgentBackgroundOptions {
  /** Extra env vars to set on the spawned CLI process */
  env?: Record<string, string>;
  /** Override args builder (returns { cmd, args } instead of buildCodeAgentArgs) */
  buildArgs?: () => { cmd: string; args: string[] };
  /** Default timeout in minutes (overrides 10min default) */
  defaultTimeoutMinutes?: number;
  /** Max timeout in minutes (overrides 30min cap) */
  maxTimeoutMinutes?: number;
  /** Per-project validation command overrides from config */
  validationCommands?: Record<string, string>;
}

export interface BuildCodeAgentArgsInput {
  task: string;
  agent?: string;
  workdir?: string;
  model?: string;
  max_turns?: number;
  sessionId?: string;            // claude --session-id UUID for interactive mode first turn
}

export interface ValidationResult {
  passed: boolean;
  output: string;
}

// Timeout constants
export const CODE_AGENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const VALIDATE_TIMEOUT_MS = 60 * 1000; // 60 seconds
