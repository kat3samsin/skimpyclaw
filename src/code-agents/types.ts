// Code Agent Type Definitions

import type { ToolConfig, SandboxConfig } from '../types.js';

export interface CodeAgentTask {
  id: string;                    // "ca-1", "ca-2"
  agent: string;                 // "claude" | "codex" | "team-coordinator"
  task: string;                  // full prompt
  status: 'running' | 'validating' | 'completed' | 'failed' | 'timeout' | 'pending' | 'cancelled';
  chatId?: number;               // for notification delivery
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
  // Team coordination fields
  parentTaskId?: string;         // child points to parent
  childTaskIds?: string[];       // parent tracks children
  subtask?: string;              // child's specific subtask description
  synthesisResult?: string;      // parent's final synthesized output
  // Dependency tracking
  dependsOn?: number[];          // indices of subtasks this depends on
  wave?: number;                 // which execution wave (0-based)
}

export interface DecomposedSubtask {
  description: string;
  dependsOn: number[];  // indices of subtasks this depends on
}

export interface CodeAgentBackgroundOptions {
  /** Extra env vars to set (e.g. CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) */
  env?: Record<string, string>;
  /** Override args builder (returns { cmd, args } instead of buildCodeAgentArgs) */
  buildArgs?: () => { cmd: string; args: string[] };
  /** Default timeout in minutes (overrides 10min default) */
  defaultTimeoutMinutes?: number;
  /** Max timeout in minutes (overrides 30min cap) */
  maxTimeoutMinutes?: number;
  /** Skip sending notification on completion (parent handles it) */
  skipNotification?: boolean;
  /** Per-project validation command overrides from config */
  validationCommands?: Record<string, string>;
  /** Sandbox configuration — when enabled, run CLI inside container */
  sandboxConfig?: SandboxConfig;
  /** Paths to mount into the sandbox container */
  allowedPaths?: string[];
}

export interface BuildCodeAgentArgsInput {
  task: string;
  agent?: string;
  workdir?: string;
  model?: string;
  max_turns?: number;
}

export interface ValidationResult {
  passed: boolean;
  output: string;
}

export interface ChildResult {
  subtask: string;
  status: string;
  output?: string;
  error?: string;
}

// Timeout constants
export const CODE_AGENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const VALIDATE_TIMEOUT_MS = 60 * 1000; // 60 seconds
