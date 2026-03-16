// Code Agent Utilities

import { execSync } from 'child_process';
import { resolve, join } from 'path';
import { homedir } from 'os';
import type { BuildCodeAgentArgsInput, CodeAgentTask, ChildResult } from './types.js';
import type { Config } from '../types.js';
import { buildValidationCommand } from './executor.js';
import { getCodeAgent } from './registry.js';

// Resolve CLI paths once at import time so spawn doesn't get ENOENT
function resolveCliPath(name: string): string {
  try {
    return execSync(`which ${name}`, { encoding: 'utf-8' }).trim();
  } catch {
    return name;
  }
}

function isCommandAvailable(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const CLAUDE_CLI_PATH = resolveCliPath('claude');
const CODEX_CLI_PATH = resolveCliPath('codex');
const KIMI_CLI_PATH = resolveCliPath('kimi');

/** Return supported coding CLIs currently available on PATH. */
export function getAvailableCodingCliTools(
  commandChecker: (name: string) => boolean = isCommandAvailable
): Array<'codex' | 'claude' | 'kimi'> {
  const available: Array<'codex' | 'claude' | 'kimi'> = [];
  if (commandChecker('codex')) available.push('codex');
  if (commandChecker('claude') || commandChecker('claude-code')) available.push('claude');
  if (commandChecker('kimi')) available.push('kimi');
  return available;
}

/** Return preflight error when no supported coding CLI is installed. */
export function getCodingCliPreflightError(
  commandChecker: (name: string) => boolean = isCommandAvailable
): string | null {
  if (getAvailableCodingCliTools(commandChecker).length > 0) return null;
  return 'Error: No supported coding CLI found on PATH. Install Codex CLI (`codex`), Claude Code CLI (`claude` or `claude-code`), or Kimi CLI (`kimi`).';
}

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
 * If no agent is explicit and the model is a GPT/OpenAI model, auto-select codex.
 * If the model is a kimi model, auto-select kimi.
 */
/**
 * Check if a model string is compatible with a given agent CLI.
 * e.g. gpt-5.3-codex is NOT compatible with 'claude', claude-opus IS.
 */
export function isModelCompatibleWithAgent(model: string, agent: 'claude' | 'codex' | 'kimi'): boolean {
  const m = model.toLowerCase();
  if (agent === 'codex') {
    return /^(gpt|codex|o[134]|openai\/)/i.test(m);
  }
  if (agent === 'kimi') {
    return m.includes('kimi');
  }
  // claude: compatible if NOT a known non-Claude model
  return !/^(gpt|codex|kimi|o[134]|openai\/)/i.test(m);
}

export function resolveSelectedCodeAgent(
  requestedAgent: string | undefined,
  defaultAgent: string | undefined,
  model?: string
): 'claude' | 'codex' | 'kimi' | null {
  // If no explicit agent was requested, infer from model
  if (!requestedAgent && model) {
    const m = model.toLowerCase();
    if (m.includes('gpt') || m.includes('codex') || m.startsWith('openai/') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) {
      return 'codex';
    }
    if (m.includes('kimi')) return 'kimi';
  }
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
  const maxTurns = String(input.max_turns || 50);

  if (agent === 'codex') {
    const args = [
      'exec',
      '--full-auto',
      '--json',
      '--color', 'never',
      '--skip-git-repo-check',
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
  // --allowedTools restricts which tools are available (not just permissions).
  // Include Playwright MCP tools so the agent can use the browser.
  const allowedTools = ['Edit', 'Read', 'Write', 'Bash', 'Glob', 'Grep', 'mcp__playwright__*'];
  const toolArgs = allowedTools.flatMap(t => ['--allowedTools', t]);

  // Pass Playwright MCP server so coding agents share SkimpyClaw's browser profile
  // Must use chromium (not chrome) to match SkimpyClaw's browser-tool.ts persistent context
  const playwrightMcp = JSON.stringify({
    mcpServers: {
      playwright: {
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest', '--browser', 'chromium',
               '--user-data-dir', join(homedir(), '.skimpyclaw', 'browser-profile'),
               '--caps', 'vision'],
      },
    },
  });

  const args = [
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--mcp-config', playwrightMcp,
    ...toolArgs,
    '--max-turns', maxTurns,
    '--append-system-prompt', `Output text only. Never use say or TTS. Focus on the coding task. Run ${buildValidationCommand(input.workdir || process.cwd())} to verify changes.`,
  ];
  // Only pass model to Claude CLI if it's not a known non-Claude model.
  // GPT/Codex/Kimi/o-series models would be rejected by the Claude CLI.
  if (input.model && !/^(gpt|codex|kimi|o[134]|openai\/)/i.test(input.model)) {
    args.push('--model', input.model);
  }
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
      const childIcon = child.status === 'completed' ? '✅' : child.status === 'failed' ? '❌' : child.status === 'timeout' ? '⏰' : '❓';
      const childDur = formatDuration(child.durationSeconds);
      const subtask = (child.subtask || child.task || '').slice(0, 80);
      lines.push(`  ${childIcon} ${child.id} (${childDur}): ${subtask}`);
    }
  }

  // Synthesis result
  if (task.outputPreview) {
    lines.push(`\nResult: ${task.outputPreview}`);
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
      message += `\n\nResult: ${task.outputPreview}`;
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

/**
 * Resolve the Discord thread ID for a task.
 * If the task doesn't have one, check the parent task (for team children).
 */
function resolveDiscordThreadId(task: CodeAgentTask): string | undefined {
  if (task.discordThreadId) return task.discordThreadId;
  // Children inherit thread from parent
  if (task.parentTaskId) {
    const parent = getCodeAgent(task.parentTaskId);
    if (parent?.discordThreadId) return parent.discordThreadId;
  }
  return undefined;
}

/**
 * Try to send a notification to a Discord thread associated with this task.
 * Returns true if successfully sent to thread.
 */
async function trySendToDiscordThread(task: CodeAgentTask, message: string): Promise<boolean> {
  const threadId = resolveDiscordThreadId(task);
  if (!threadId) return false;

  try {
    const { sendToDiscordThread } = await import('../channels/discord/index.js');
    const sent = await sendToDiscordThread(threadId, message);
    if (sent) {
      console.log(`[code-agent] Notification for ${task.id} sent to thread ${threadId}`);
    }
    return sent;
  } catch (err) {
    console.error(`[code-agent] Failed to send to Discord thread for ${task.id}:`, err);
    return false;
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

    // Try Discord thread first, fall back to broadcast channel
    const threadSent = await trySendToDiscordThread(task, message);
    if (!threadSent) {
      const sent = await sendActiveChannelProactiveMessage(_codeAgentConfig, message).catch((err) => {
        console.error(`[code-agent] Failed to send team notification for ${task.id}:`, err);
        return false;
      });
      if (!sent) console.warn(`[code-agent] Team notification not delivered for ${task.id} (no active channel or target)`);
    }
    return;
  }

  message = buildSoloNotification(task);

  // Try Discord thread first, fall back to broadcast channel
  const threadSent = await trySendToDiscordThread(task, message);
  if (!threadSent) {
    const sent = await sendActiveChannelProactiveMessage(_codeAgentConfig, message).catch((err) => {
      console.error(`[code-agent] Failed to send notification for ${task.id}:`, err);
      return false;
    });
    if (!sent) console.warn(`[code-agent] Notification not delivered for ${task.id} (no active channel or target)`);
  }
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
    model = aliases[model];
  }
  // Strip provider prefix for CLI tools
  if (model.includes('/')) {
    model = model.split('/').slice(1).join('/');
  }
  // Resolve common shorthand names to full model IDs
  const SHORTHAND_MAP: Record<string, string> = {
    opus: 'claude-opus-4-6',
    sonnet: 'claude-sonnet-4-6',
    haiku: 'claude-haiku-4-5',
  };
  const lower = model.toLowerCase();
  if (SHORTHAND_MAP[lower]) {
    return SHORTHAND_MAP[lower];
  }
  // Migrate deprecated Claude model names to current equivalents
  if (/^claude[-.]3[-.]5[-.]sonnet(?:[-_.].*)?$/i.test(model)) {
    return 'claude-sonnet-4-6';
  }
  if (/^claude[-.]3[-.]5[-.]haiku(?:[-_.].*)?$/i.test(model)) {
    return 'claude-haiku-4-5';
  }
  return model;
}

/** @deprecated Removed — old Claude CLI team state reader. Kept for backward compat. */
export function readTeamState(): null {
  return null;
}
