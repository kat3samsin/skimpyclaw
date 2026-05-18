// Code Agent Utilities

import { existsSync, readFileSync, statSync } from 'fs';
import { resolve, join, sep } from 'path';
import { homedir } from 'os';
import type { BuildCodeAgentArgsInput, CodeAgentTask } from './types.js';
import type { Config } from '../types.js';
import { buildValidationCommand } from './executor.js';
import { getCodeAgent } from './registry.js';
import { findExecutableOnPath, isExecutableOnPath } from '../utils.js';
import { buildArtifactUrl, registerLocalArtifact } from '../artifacts.js';

// Resolve CLI paths once at import time so spawn doesn't get ENOENT
function resolveCliPath(name: string): string {
  return findExecutableOnPath(name) || name;
}

function isCommandAvailable(name: string): boolean {
  return isExecutableOnPath(name);
}

export const CLAUDE_CLI_PATH = resolveCliPath('claude');
const CODEX_CLI_PATH = resolveCliPath('codex');
const DEFAULT_CODEX_HOME = join(homedir(), '.codex');

/**
 * Prepare env for spawning a coding-agent CLI (claude/codex):
 * - Drops CLAUDECODE so nested `claude` invocations start cleanly.
 * - Drops GH_TOKEN/GITHUB_TOKEN so `gh` falls back to keychain auth instead
 *   of a stale process token.
 * - Pins Codex to the standard CLI state directory so auth/config come from ~/.codex.
 */
export function buildCodeAgentSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  env.HOME ||= homedir();
  env.CODEX_HOME = DEFAULT_CODEX_HOME;
  delete env.CLAUDECODE;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

/** Return supported coding CLIs currently available on PATH. */
export function getAvailableCodingCliTools(
  commandChecker: (name: string) => boolean = isCommandAvailable
): Array<'codex' | 'claude'> {
  const available: Array<'codex' | 'claude'> = [];
  if (commandChecker('codex')) available.push('codex');
  if (commandChecker('claude') || commandChecker('claude-code')) available.push('claude');
  return available;
}

/** Return preflight error when no supported coding CLI is installed. */
export function getCodingCliPreflightError(
  commandChecker: (name: string) => boolean = isCommandAvailable
): string | null {
  if (getAvailableCodingCliTools(commandChecker).length > 0) return null;
  return 'Error: No supported coding CLI found on PATH. Install Codex CLI (`codex`) or Claude Code CLI (`claude` or `claude-code`).';
}

/**
 * Normalize legacy/default agent values to supported CLI agent IDs.
 * Accepts strict IDs and older alias-like values (e.g. "claude-coder").
 */
export function normalizeCodeAgent(agent: string | undefined): 'claude' | 'codex' | null {
  if (!agent) return null;
  const value = agent.toLowerCase();
  if (value === 'claude' || value.startsWith('claude-')) return 'claude';
  if (value === 'codex' || value.startsWith('codex')) return 'codex';
  return null;
}

/**
 * Resolve requested/default agent selection to a supported CLI agent ID.
 * Preference order: explicit request -> configured default -> "claude".
 * If no agent is explicit and the model is a GPT/Codex model, auto-select codex.
 */
/**
 * Check if a model string is compatible with a given agent CLI.
 * e.g. gpt-5.3-codex is NOT compatible with 'claude', claude-opus IS.
 */
export function isModelCompatibleWithAgent(model: string, agent: 'claude' | 'codex'): boolean {
  const m = model.toLowerCase();
  if (agent === 'codex') {
    return /^(gpt|codex|o[134]|openai\/)/i.test(m);
  }
  // claude: compatible if NOT a known non-Claude model
  return !/^(gpt|codex|o[134]|openai\/)/i.test(m);
}

export function resolveSelectedCodeAgent(
  requestedAgent: string | undefined,
  defaultAgent: string | undefined,
  model?: string
): 'claude' | 'codex' | null {
  // If no explicit agent was requested, infer from model
  if (!requestedAgent && model) {
    const m = model.toLowerCase();
    if (m.includes('gpt') || m.includes('codex') || m.startsWith('openai/') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) {
      return 'codex';
    }
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

function stripProviderPrefix(model: string): string {
  return model.includes('/') ? model.split('/').slice(1).join('/') : model;
}

/** Read Claude Code's configured default model, if present. */
export function readClaudeCodeDefaultModel(
  settingsPath = join(homedir(), '.claude', 'settings.json')
): string | undefined {
  try {
    if (!existsSync(settingsPath)) return undefined;
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const model = settings?.model;
    return typeof model === 'string' && model.trim() ? model.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the model text shown in dashboards/reports without changing CLI args. */
export function resolveCodeAgentModelLabel(agent: string | undefined, model?: string): string {
  if (model) return stripProviderPrefix(model);

  const normalizedAgent = normalizeCodeAgent(agent);
  if (normalizedAgent === 'claude') {
    const defaultModel = readClaudeCodeDefaultModel();
    return defaultModel ? `${defaultModel} default` : 'claude default';
  }
  if (normalizedAgent === 'codex') return 'codex default';
  return `${agent || 'agent'} default`;
}

export function withCodeAgentModelLabel(task: CodeAgentTask): CodeAgentTask {
  return {
    ...task,
    modelLabel: task.modelLabel || resolveCodeAgentModelLabel(task.agent, task.model),
  };
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
    if (input.effort) args.push('-c', `model_reasoning_effort=${input.effort}`);
    args.push(input.task);
    return { cmd: CODEX_CLI_PATH, args };
  }

  // Default: claude
  // Each --allowedTools flag takes one tool name — repeat the flag per tool
  // --allowedTools restricts which tools are available (not just permissions).
  const allowedTools = ['Edit', 'Read', 'Write', 'Bash', 'Glob', 'Grep'];
  const toolArgs = allowedTools.flatMap(t => ['--allowedTools', t]);

  const args = [
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    ...toolArgs,
    '--max-turns', maxTurns,
    '--append-system-prompt', buildClaudeSystemPrompt(input.workdir || process.cwd()),
  ];
  // Interactive mode: pin this turn to a known session UUID so follow-ups can --resume it.
  if (input.sessionId) {
    args.push('--session-id', input.sessionId);
  }
  // Only pass model to Claude CLI if it's not a known non-Claude model.
  // GPT/Codex/o-series models would be rejected by the Claude CLI.
  if (input.model && !/^(gpt|codex|o[134]|openai\/)/i.test(input.model)) {
    args.push('--model', input.model);
  }
  args.push(input.task);
  return { cmd: CLAUDE_CLI_PATH, args };
}

function buildClaudeSystemPrompt(workdir: string): string {
  const validationCommand = buildValidationCommand(workdir);
  return [
    'You are a SkimpyClaw code_with_agent subagent. If local Claude Code skills or hooks have subagent skip behavior, follow it.',
    'Output text only. Never use say or TTS. Focus on the assigned coding task.',
    'Do not post GitHub comments, PR reviews, issues, messages, or otherwise publish externally unless the assigned task explicitly asks you to post.',
    'For read-only review or artifact tasks, do not edit product/source code; create the requested local artifact and return its absolute path.',
    `Run ${validationCommand} to verify changes when you modify code.`,
  ].join(' ');
}

/** Format duration as human-readable string. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds == null) return '?';
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
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

interface CodeAgentNotificationAttachment {
  name: string;
  content: string;
  description?: string;
  path?: string;
}

interface CodeAgentDiscordNotification {
  content: string;
  attachments?: CodeAgentNotificationAttachment[];
}

const MAX_REVIEW_ARTIFACT_BYTES = 2 * 1024 * 1024;

interface CodeAgentReviewArtifact {
  name: string;
  path: string;
  link: string;
}

function shorten(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 3).trim()}...`;
}

function normalizeOutputPaths(value: string, workdir: string): string {
  if (!value) return value;
  const normalizedWorkdir = workdir.replace(/\/+$/, '');
  if (!normalizedWorkdir) return value;
  return value
    .split(`${normalizedWorkdir}/`).join('')
    .split(normalizedWorkdir).join('.');
}

function isPathInside(path: string, root: string | undefined): boolean {
  if (!root) return false;
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}

function extractHtmlPaths(value: string): string[] {
  const paths = new Set<string>();
  const patterns = [
    /\((\/[^)\n]+?\.html)\)/g,
    /["'](\/[^"'\n]+?\.html)["']/g,
    /\b(\/[^\s<>"')]+?\.html)\b/g,
  ];

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      try {
        paths.add(decodeURIComponent(match[1]));
      } catch {
        paths.add(match[1]);
      }
    }
  }

  return Array.from(paths);
}

function readTaskLog(task: CodeAgentTask): string {
  try {
    const logPath = join(homedir(), '.skimpyclaw', 'logs', 'code-agents', `${task.id}.log`);
    if (!existsSync(logPath)) return '';
    const stat = statSync(logPath);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return '';
    return readFileSync(logPath, 'utf-8');
  } catch {
    return '';
  }
}

function formatLocalMarkdownLink(label: string, path: string): string {
  const escapedLabel = label.replace(/([\\[\]])/g, '\\$1');
  const target = /[\s()<>]/.test(path) ? `<${path.replace(/[<>]/g, '')}>` : path;
  return `[${escapedLabel}](${target})`;
}

function buildHtmlArtifactLinks(task: CodeAgentTask, result: string): CodeAgentReviewArtifact[] {
  const allowedRoots = [
    task.workdir,
    task.sourceWorkdir,
    task.worktreePath,
    join(homedir(), '.skimpyclaw', 'reviews'),
  ];
  const candidates = new Set([
    ...extractHtmlPaths(result),
    ...extractHtmlPaths(readTaskLog(task)),
  ]);
  const artifacts: CodeAgentReviewArtifact[] = [];

  for (const path of candidates) {
    if (!allowedRoots.some(root => isPathInside(path, root))) continue;
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_REVIEW_ARTIFACT_BYTES) continue;
      const artifact = registerLocalArtifact(path);
      if (!artifact) continue;
      const target = buildArtifactUrl(_codeAgentConfig, artifact) || artifact.path;
      artifacts.push({
        name: artifact.name,
        path: artifact.path,
        link: formatLocalMarkdownLink(artifact.name, target),
      });
      if (artifacts.length >= 3) break;
    } catch {
      // The agent may mention stale paths; ignore them.
    }
  }

  return artifacts;
}

function extractStreamJsonText(line: string): string | null {
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }

  if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
    return null;
  }

  if ((event.type === 'output_text' || event.output_text) && (event.output_text || event.text)) {
    return String(event.output_text || event.text).trim() || null;
  }

  if (event.type === 'result' && typeof event.result === 'string') {
    return event.result.trim() || null;
  }

  if ((event.type === 'item.completed' || event.type === 'item.delta') && event.item?.type === 'agent_message' && event.item?.text) {
    return String(event.item.text).trim() || null;
  }

  return '';
}

function looksLikeRawStreamJson(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('{') && /"type"\s*:|"item"\s*:|"thread_id"\s*:/.test(trimmed);
}

function stripStreamJsonNoise(value: string): string {
  const lines = value.split('\n');
  const cleaned: string[] = [];
  let sawStreamJson = false;

  for (const line of lines) {
    const extracted = extractStreamJsonText(line);
    if (extracted !== null) {
      sawStreamJson = true;
      if (extracted) cleaned.push(extracted);
      continue;
    }

    if (looksLikeRawStreamJson(line)) {
      sawStreamJson = true;
      continue;
    }

    cleaned.push(line);
  }

  const result = cleaned.join('\n').trim();
  return sawStreamJson ? result : value.trim();
}

function normalizeHeading(line: string): string | null {
  const normalized = line
    .trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\*\*/, '')
    .replace(/\*\*$/, '')
    .replace(/:$/, '')
    .trim()
    .toLowerCase();
  const allowed = new Set(['decision', 'summary', 'findings', 'risk checks', 'tests', 'recommendation']);
  return allowed.has(normalized) ? normalized : null;
}

function extractReportSections(value: string): Record<string, string> {
  const sections: Record<string, string[]> = {};
  let current = 'summary';
  for (const line of value.split('\n')) {
    const heading = normalizeHeading(line);
    if (heading) {
      current = heading;
      sections[current] ||= [];
      continue;
    }
    sections[current] ||= [];
    sections[current].push(line);
  }
  return Object.fromEntries(
    Object.entries(sections)
      .map(([key, lines]) => [key, lines.join('\n').trim()])
      .filter(([, text]) => text)
  );
}

function firstMeaningfulLines(value: string, maxChars: number): string {
  const lines = value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !looksLikeRawStreamJson(line))
    .filter(line => !/^i('|’)ll\b/i.test(line))
    .filter(line => !/^i am\b/i.test(line));
  return shorten(lines.join('\n'), maxChars);
}

function formatAgentDisplay(task: CodeAgentTask): string {
  const agent = task.agent === 'team-coordinator' ? 'TEAM' : task.agent.toUpperCase();
  const model = task.modelLabel || resolveCodeAgentModelLabel(task.agent, task.model);
  const effort = task.effort ? ` · effort ${task.effort}` : '';
  return `${agent} · ${model}${effort}`;
}

function buildReportMarkdown(task: CodeAgentTask, result: string): string {
  const validation = task.validationPassed === true
    ? 'pass'
    : task.validationPassed === false
      ? 'fail'
      : 'not run';
  return [
    `# Code Agent ${task.id}`,
    '',
    `- Status: ${task.status}`,
    `- Agent: ${task.agent}`,
    `- Model: ${task.modelLabel || resolveCodeAgentModelLabel(task.agent, task.model)}`,
    `- Effort: ${task.effort || 'default'}`,
    `- Duration: ${formatDuration(task.durationSeconds)}`,
    `- Validation: ${validation}`,
    `- Workdir: ${task.workdir}`,
    task.sourceWorkdir ? `- Source Workdir: ${task.sourceWorkdir}` : '',
    task.worktreePath ? `- Worktree: ${task.worktreePath}` : '',
    task.worktreeCleanup ? `- Worktree Cleanup: ${task.worktreeCleanup.status}${task.worktreeCleanup.reason ? ` (${task.worktreeCleanup.reason})` : ''}` : '',
    '',
    '## Task',
    '',
    task.task,
    '',
    '## Result',
    '',
    result || task.error || '(No result captured.)',
    task.validationOutput ? `\n## Validation Output\n\n${task.validationOutput}` : '',
  ].filter(Boolean).join('\n');
}

function buildDiscordResultSummary(task: CodeAgentTask, result: string): string {
  if (!result.trim()) return task.error ? `Error: ${shorten(task.error, 700)}` : '';

  const sections = extractReportSections(result);
  const lines: string[] = [];
  const decision = sections.decision || sections.recommendation;
  if (decision) {
    lines.push(`**Decision**\n${shorten(firstMeaningfulLines(decision, 450), 450)}`);
  }
  if (sections.findings) {
    lines.push(`**Findings**\n${shorten(firstMeaningfulLines(sections.findings, 650), 650)}`);
  }
  if (sections['risk checks']) {
    lines.push(`**Risk Checks**\n${shorten(firstMeaningfulLines(sections['risk checks'], 420), 420)}`);
  }
  if (sections.tests) {
    lines.push(`**Tests**\n${shorten(firstMeaningfulLines(sections.tests, 240), 240)}`);
  }
  if (lines.length > 0) return lines.join('\n\n');
  return shorten(firstMeaningfulLines(result, 950), 950);
}

export function buildCodeAgentDiscordNotification(task: CodeAgentTask): CodeAgentDiscordNotification {
  const dur = formatDuration(task.durationSeconds);
  const icon = task.status === 'completed' ? '✅' : task.status === 'timeout' ? '⏰' : '❌';
  const status = task.status === 'completed'
    ? 'completed'
    : task.status === 'timeout'
      ? 'timed out'
      : 'failed';
  const validation = task.validationPassed === true
    ? 'Build/tests pass'
    : task.validationPassed === false
      ? 'Build/tests failed'
      : task.status === 'completed'
        ? 'Validation not run'
        : undefined;
  const rawResultForArtifacts = stripStreamJsonNoise(task.outputPreview || task.liveOutput || task.validationOutput || task.error || '');
  const rawResult = normalizeOutputPaths(rawResultForArtifacts, task.workdir);
  const taskPreview = normalizeOutputPaths(shorten(task.task, 350), task.workdir);
  const summary = buildDiscordResultSummary(task, rawResult);
  const reviewArtifacts = buildHtmlArtifactLinks(task, rawResultForArtifacts);
  const showReviewListOnly = reviewArtifacts.length > 0 && task.status === 'completed';
  const contentParts = [
    `${icon} \`${task.id}\` ${status} · ${formatAgentDisplay(task)} · ${dur}`,
    validation ? `**Validation:** ${validation}` : undefined,
    task.retryCount ? `**Retries:** ${task.retryCount}` : undefined,
    showReviewListOnly ? undefined : `**Task:** ${taskPreview}`,
    !showReviewListOnly && summary ? `\n${summary}` : undefined,
  ].filter(Boolean);

  const needsReportAttachment = !showReviewListOnly && (rawResult.length > 1_200 || !!task.validationOutput || task.task.length > 350);
  const attachments: CodeAgentNotificationAttachment[] = [
    ...(needsReportAttachment
      ? [{
        name: `${task.id}-report.md`,
        description: `Full report for ${task.id}`,
        content: buildReportMarkdown(task, rawResult),
      }]
      : []),
  ];
  const reviewLinks = reviewArtifacts.map(file => file.link);

  const content = [
    contentParts.join('\n'),
    reviewLinks.length > 0
      ? `\n**Reviews**\n${reviewLinks.map((link, index) => `${index + 1}. ${link}`).join('\n')}`
      : undefined,
    needsReportAttachment ? 'Full report attached.' : undefined,
  ].filter(Boolean).join('\n');

  return { content, attachments: attachments.length > 0 ? attachments : undefined };
}

function resolveDiscordThreadId(task: CodeAgentTask): string | undefined {
  return task.discordThreadId;
}

function resolveDiscordChannelId(task: CodeAgentTask): string | undefined {
  return task.discordChannelId;
}

/**
 * Try to send a notification to a Discord thread associated with this task.
 * Returns true if successfully sent to thread.
 */
async function trySendToDiscordThread(task: CodeAgentTask, notification: CodeAgentDiscordNotification): Promise<boolean> {
  const threadId = resolveDiscordThreadId(task);
  if (!threadId) return false;

  try {
    const { sendToDiscordThread, sendToDiscordThreadWithAttachments } = await import('../channels/discord/index.js');
    const sent = notification.attachments?.length
      ? await sendToDiscordThreadWithAttachments(threadId, notification.content, notification.attachments)
      : await sendToDiscordThread(threadId, notification.content);
    if (sent) {
      console.log(`[code-agent] Notification for ${task.id} sent to thread ${threadId}`);
    }
    return sent;
  } catch (err) {
    console.error(`[code-agent] Failed to send to Discord thread for ${task.id}:`, err);
    return false;
  }
}

/**
 * Try to send a notification to the originating Discord channel for this task.
 * Returns true if successfully sent to channel.
 */
async function trySendToDiscordChannel(task: CodeAgentTask, notification: CodeAgentDiscordNotification): Promise<boolean> {
  const channelId = resolveDiscordChannelId(task);
  if (!channelId) return false;

  try {
    const { sendDiscordProactiveMessage, sendDiscordProactiveMessageWithAttachments } = await import('../channels/discord/index.js');
    if (notification.attachments?.length) {
      await sendDiscordProactiveMessageWithAttachments(channelId, notification.content, notification.attachments);
    } else {
      await sendDiscordProactiveMessage(channelId, notification.content);
    }
    console.log(`[code-agent] Notification for ${task.id} sent to Discord channel ${channelId}`);
    return true;
  } catch (err) {
    console.error(`[code-agent] Failed to send to Discord channel for ${task.id}:`, err);
    return false;
  }
}

function hasDiscordRouting(task: CodeAgentTask): boolean {
  return !!(resolveDiscordThreadId(task) || resolveDiscordChannelId(task));
}

/** Send auto-notification to active channel on completion/failure. */
export async function notifyCodeAgentResult(task: CodeAgentTask): Promise<void> {
  if (!_codeAgentConfig) return;
  const { sendActiveChannelProactiveMessage } = await import('../channels.js');

  const message = buildSoloNotification(task);
  const discordNotification = buildCodeAgentDiscordNotification(task);

  // Prefer task-scoped Discord routing over global active-channel fallback.
  const threadSent = await trySendToDiscordThread(task, discordNotification);
  const channelSent = threadSent ? true : await trySendToDiscordChannel(task, discordNotification);
  if (!threadSent && !channelSent && !hasDiscordRouting(task)) {
    const sent = await sendActiveChannelProactiveMessage(_codeAgentConfig, message).catch((err) => {
      console.error(`[code-agent] Failed to send notification for ${task.id}:`, err);
      return false;
    });
    if (!sent) console.warn(`[code-agent] Notification not delivered for ${task.id} (no active channel or target)`);
  } else if (!threadSent && !channelSent) {
    console.warn(`[code-agent] Notification not delivered for ${task.id} (Discord thread/channel unavailable)`);
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
  // Migrate deprecated Claude model names to current equivalents
  if (/^claude[-.]3[-.]5[-.]sonnet(?:[-_.].*)?$/i.test(model)) {
    return 'claude-sonnet-4-6';
  }
  if (/^claude[-.]3[-.]5[-.]haiku(?:[-_.].*)?$/i.test(model)) {
    return 'claude-haiku-4-5';
  }
  if (/^claude[-.]opus[-.]4[-_.]6$/i.test(model)) {
    return 'claude-opus-4-6';
  }
  return model;
}
