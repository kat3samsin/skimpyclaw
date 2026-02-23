// Code Agent Utilities

import { execSync } from 'child_process';
import { resolve } from 'path';
import type { BuildCodeAgentArgsInput, CodeAgentTask, ChildResult } from './types.js';
import type { Config } from '../types.js';

// Resolve CLI paths once at import time so spawn doesn't get ENOENT
function resolveCliPath(name: string): string {
  try {
    return execSync(`which ${name}`, { encoding: 'utf-8' }).trim();
  } catch {
    return name;
  }
}

const CLAUDE_CLI_PATH = resolveCliPath('claude');
const CODEX_CLI_PATH = resolveCliPath('codex');
const KIMI_CLI_PATH = resolveCliPath('kimi');

/**
 * Normalize legacy/default agent values to supported CLI agent IDs.
 * Accepts strict IDs and older alias-like values (e.g. "claude-think").
 */
export function normalizeCodeAgent(agent: string | undefined): 'claude' | 'codex' | 'kimi' | null {
  if (!agent) return null;
  const value = agent.toLowerCase();
  if (value === 'claude' || value.startsWith('claude-')) return 'claude';
  if (value === 'codex' || value.startsWith('codex')) return 'codex';
  if (value === 'kimi' || value.startsWith('kimi')) return 'kimi';
  return null;
}

/**
 * Resolve requested/default agent selection to a supported CLI agent ID.
 * Preference order: explicit request -> configured default -> "claude".
 */
export function resolveSelectedCodeAgent(
  requestedAgent: string | undefined,
  defaultAgent: string | undefined
): 'claude' | 'codex' | 'kimi' | null {
  const candidate = requestedAgent || defaultAgent || 'claude';
  return normalizeCodeAgent(candidate);
}

// Reference to config for notifications — set via setCodeAgentConfig()
let _codeAgentConfig: Config | null = null;

/** Set the config reference used for auto-notifications on completion. */
export function setCodeAgentConfig(config: Config): void {
  _codeAgentConfig = config;
}

export function getCodeAgentConfig(): Config | null {
  return _codeAgentConfig;
}

/** Build CLI args for code_with_agent. Exported for testing. */
export function buildCodeAgentArgs(input: BuildCodeAgentArgsInput): { cmd: string; args: string[] } {
  const agent = input.agent || 'claude';
  const maxTurns = String(input.max_turns || 30);

  if (agent === 'codex') {
    const args = [
      'exec',
      '--full-auto',
      '--json',
      '--color', 'never',
    ];
    if (input.workdir) args.push('-C', input.workdir);
    if (input.model) args.push('-m', input.model);
    args.push(input.task);
    return { cmd: CODEX_CLI_PATH, args };
  }

  if (agent === 'kimi') {
    const args = [
      '--yolo',
      '-p', input.task,
    ];
    if (input.workdir) args.push('-w', input.workdir);
    if (input.model) args.push('-m', input.model);
    return { cmd: KIMI_CLI_PATH, args };
  }

  // Default: claude
  // Each --allowedTools flag takes one tool name — repeat the flag per tool
  const allowedTools = ['Edit', 'Read', 'Write', 'Bash', 'Glob', 'Grep'];
  const toolArgs = allowedTools.flatMap(t => ['--allowedTools', t]);
  const args = [
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    ...toolArgs,
    '--max-turns', maxTurns,
    '--append-system-prompt', 'Output text only. Never use say or TTS. Focus on the coding task. Run pnpm build && pnpm test to verify changes.',
  ];
  if (input.model) args.push('--model', input.model);
  args.push(input.task);
  return { cmd: CLAUDE_CLI_PATH, args };
}

/** Format duration as human-readable string. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds == null) return '?';
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Build notification for a team-coordinator task with child results. */
export function buildTeamNotification(
  task: CodeAgentTask,
  getChildTask: (id: string) => CodeAgentTask | null
): string {
  const dur = formatDuration(task.durationSeconds);
  const taskPreview = task.task.length > 100 ? task.task.slice(0, 100) + '...' : task.task;
  const statusIcon = task.status === 'completed' ? '✅' : task.status === 'timeout' ? '⏰' : '❌';
  const validation = task.validationPassed ? ' Tests pass.' : '';

  const lines: string[] = [];
  lines.push(`${statusIcon} Team ${task.id} ${task.status} (${dur}).${validation}`);
  lines.push(`Task: ${taskPreview}`);

  // Per-child summary
  const childIds = task.childTaskIds || [];
  if (childIds.length > 0) {
    lines.push('');
    for (const childId of childIds) {
      const child = getChildTask(childId);
      if (!child) continue;
      const childIcon = child.status === 'completed' ? '✓' : child.status === 'failed' ? '✗' : child.status === 'timeout' ? '⏰' : '?';
      const childDur = formatDuration(child.durationSeconds);
      const subtask = (child.subtask || child.task || '').slice(0, 80);
      lines.push(`  ${childIcon} ${child.id} (${childDur}): ${subtask}`);
    }
  }

  // Errors
  if (task.error && task.error !== 'Validation failed') {
    lines.push(`\nError: ${task.error}`);
  }
  if (task.validationOutput) {
    lines.push(`\nValidation:\n${task.validationOutput.slice(0, 800)}`);
  }

  return lines.join('\n');
}

/** Build notification for a single code agent. */
export function buildSoloNotification(task: CodeAgentTask): string {
  const dur = formatDuration(task.durationSeconds);
  const taskPreview = task.task.length > 120 ? task.task.slice(0, 120) + '...' : task.task;

  if (task.status === 'completed') {
    const validation = task.validationPassed ? ' Build/tests pass.' : '';
    let message = `✅ Coding agent ${task.id} completed (${dur}).${validation}\n\nTask: ${taskPreview}`;
    if (task.outputPreview) {
      const preview = task.outputPreview.slice(0, 300);
      message += `\n\nResult: ${preview}`;
    }
    return message;
  } else if (task.status === 'timeout') {
    return `⏰ Coding agent ${task.id} timed out after ${dur}.\n\nTask: ${taskPreview}`;
  } else {
    const retryNote = task.retryCount ? ` (retried ${task.retryCount}x)` : '';
    let message = `❌ Coding agent ${task.id} failed (${dur})${retryNote}.\n\nTask: ${taskPreview}`;
    if (task.error) message += `\n\nError: ${task.error}`;
    if (task.validationOutput) {
      message += `\n\nBuild/test output:\n${task.validationOutput.slice(0, 1_500)}`;
    }
    return message;
  }
}

/** Send auto-notification to active channel on completion/failure. */
export async function notifyCodeAgentResult(
  task: CodeAgentTask,
  getChildTask: (id: string) => CodeAgentTask | null
): Promise<void> {
  if (!_codeAgentConfig) return;
  const { sendActiveChannelProactiveMessage } = await import('../channels.js');

  let message: string;

  // Team coordinator gets a structured notification
  if (task.agent === 'team-coordinator') {
    message = buildTeamNotification(task, getChildTask);
    await sendActiveChannelProactiveMessage(_codeAgentConfig, message).catch(() => {});
    return;
  }

  message = buildSoloNotification(task);
  await sendActiveChannelProactiveMessage(_codeAgentConfig, message).catch(() => {});
}

/** Check workdir against allowed paths. */
export function resolveWorkdir(
  rawWorkdir: string | undefined,
  projects: Record<string, string>,
  skimpyclawRoot: string
): string {
  if (rawWorkdir && projects[rawWorkdir]) {
    return resolve(projects[rawWorkdir]);
  }
  return resolve(rawWorkdir || skimpyclawRoot);
}

/** Resolve model alias to real model ID. */
export function resolveModelAlias(
  model: string | undefined,
  aliases: Record<string, string> | undefined
): string | undefined {
  if (!model) return undefined;
  if (aliases?.[model]) {
    return aliases[model];
  }
  // Strip provider prefix for CLI tools
  if (model.includes('/')) {
    return model.split('/').slice(1).join('/');
  }
  return model;
}

/** @deprecated Removed — old Claude CLI team state reader. Kept for backward compat. */
export function readTeamState(): null {
  return null;
}
