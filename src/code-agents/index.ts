// Code Agents - Public API
// Background multi-agent coding task execution

import { resolve } from 'path';
import { randomUUID } from 'crypto';
import type { ToolConfig } from '../types.js';
import type { ExecuteToolContext } from '../tools/execute-context.js';
import { isPathAllowed } from '../tools/path-utils.js';
import type { CodeAgentTask } from './types.js';
import {
  getNextCodeAgentId,
  storeCodeAgentTask,
  writeCodeAgentTask,
  getActiveCodeAgents,
  getRecentCodeAgents,
  getCodeAgent,
} from './registry.js';
import { runCodeAgentBackground } from './executor.js';
import { addPendingSession } from './interactive-sessions.js';
import {
  resolveSelectedCodeAgent,
  resolveCodeAgentModelLabel,
  isModelCompatibleWithAgent,
  resolveWorkdir,
  resolveModelAlias,
  getCodingCliPreflightError,
} from './utils.js';
import {
  normalizeWorktreeRequest,
  prepareCodeAgentWorktree,
  shouldAutoWorktreeTask,
  shouldUseCodeAgentWorktree,
} from './worktrees.js';

// Re-export types
export type {
  CodeAgentTask,
  CodeAgentBackgroundOptions,
  BuildCodeAgentArgsInput,
  ValidationResult,
} from './types.js';

// Re-export timeout constants
export { CODE_AGENT_TIMEOUT_MS, VALIDATE_TIMEOUT_MS } from './types.js';

// Re-export registry functions
export {
  getActiveCodeAgents,
  getRecentCodeAgents,
  getAllCodeAgents,
  getCodeAgent,
  cancelCodeAgent,
  restoreCodeAgentTasks,
  getCodeAgentsDir,
} from './registry.js';

// Re-export executor functions
export { runCodeAgentBackground, runValidation } from './executor.js';

// Re-export utility functions
export {
  setCodeAgentConfig,
  getCodeAgentConfig,
  buildCodeAgentArgs,
  resolveSelectedCodeAgent,
  resolveCodeAgentModelLabel,
  resolveWorkdir,
  resolveModelAlias,
} from './utils.js';

// Re-export parser functions
export { parseStreamJsonForLive, parseClaudeOutput, parseCodexOutput } from './parser.js';
export type { ClaudeOutputResult } from './parser.js';

// SKIMPYCLAW_ROOT for workdir default
const SKIMPYCLAW_ROOT = resolve(import.meta.dirname || process.cwd(), '..', '..');
const EFFORT_LEVELS = new Set(['none', 'low', 'medium', 'high', 'xhigh']);

/**
 * Execute check_code_agent tool — list all or get details for one agent.
 */
export function executeCheckCodeAgent(input: Record<string, any>): string {
  const id = input.id as string | undefined;

  if (id) {
    const task = getCodeAgent(id);
    if (!task) return `No coding agent found with ID "${id}".`;
    return JSON.stringify({
      id: task.id,
      agent: task.agent,
      status: task.status,
      task: task.task,
      workdir: task.workdir,
      sourceWorkdir: task.sourceWorkdir,
      worktreePath: task.worktreePath,
      worktreeRef: task.worktreeRef,
      model: task.model,
      modelLabel: task.modelLabel || resolveCodeAgentModelLabel(task.agent, task.model),
      effort: task.effort,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      durationSeconds: task.durationSeconds,
      exitCode: task.exitCode,
      validationPassed: task.validationPassed,
      validationOutput: task.validationOutput,
      outputPreview: task.outputPreview,
      error: task.error,
      retryCount: task.retryCount,
    }, null, 2);
  }

  // List all agents (active first, then recent)
  const active = getActiveCodeAgents();
  const recent = getRecentCodeAgents(10);
  const all = [...active, ...recent];

  if (all.length === 0) return 'No coding agents have run yet.';

  const lines = all.map(t => {
    const elapsed = t.durationSeconds != null
      ? (t.durationSeconds < 60 ? `${t.durationSeconds}s` : `${Math.floor(t.durationSeconds / 60)}m`)
      : (Math.round((Date.now() - new Date(t.startedAt).getTime()) / 1000) + 's');
    const taskPreview = t.task.length > 60 ? t.task.slice(0, 60) + '...' : t.task;
    const model = `, ${t.modelLabel || resolveCodeAgentModelLabel(t.agent, t.model)}`;
    const effort = t.effort ? `, effort ${t.effort}` : '';
    return `${t.id}: ${t.status.toUpperCase()} (${t.agent}${model}${effort}, ${elapsed}) — ${taskPreview}`;
  });

  return lines.join('\n');
}

/**
 * Execute code_with_agent tool - single agent mode.
 */
export async function executeCodeWithAgent(
  input: Record<string, any>,
  config: ToolConfig,
  context?: ExecuteToolContext,
): Promise<string> {
  const task = input.task as string;
  if (!task) return 'Error: task is required';

  // Resolve model alias first so agent auto-selection can inspect it.
  // Fall back to current session model so Codex models auto-select the right CLI.
  let rawModel = input.model as string | undefined;
  if (!rawModel) {
    try {
      const { getCurrentModel } = await import('../gateway.js');
      rawModel = getCurrentModel();
    } catch { /* gateway not running */ }
  }
  const resolvedModel = resolveModelAlias(
    rawModel,
    context?.fullConfig?.models?.aliases
  );

  const configDefault = context?.fullConfig?.codeAgents?.defaultAgent || 'claude';
  const requestedAgent = input.agent as string | undefined;
  const agent = resolveSelectedCodeAgent(requestedAgent, configDefault, resolvedModel);
  if (!agent) {
    return `Error: Invalid agent "${requestedAgent}". Must be claude or codex.`;
  }

  // Interactive mode prerequisites: Discord server channel (NOT DM) + claude only.
  // Discord DMs do not support threads, which interactive mode requires.
  const isInteractive = input.interactive === true;
  if (isInteractive) {
    if (context?.channel !== 'discord') {
      return 'Error: interactive mode requires Discord. Telegram and other channels are not supported yet.';
    }
    if (context?.isDm === true) {
      return 'Error: interactive mode requires a Discord server channel. Direct messages do not support threads. Please move to a server channel and try again.';
    }
    if (agent !== 'claude' && agent !== 'codex') {
      return `Error: interactive mode supports claude and codex only (requested: ${agent}).`;
    }
    if (agent === 'codex') {
      return 'Error: interactive mode for codex is not yet implemented. Use claude for now.';
    }
  }

  // Don't pass a non-matching session model to a different agent CLI.
  // e.g. if session is gpt-5.3-codex but agent is claude, let claude use its own default.
  const isModelFromSession = !input.model;
  const modelIncompatible = isModelFromSession && resolvedModel && !isModelCompatibleWithAgent(resolvedModel, agent);
  const modelForAgent = modelIncompatible ? undefined : resolvedModel;
  const effortInput = typeof input.effort === 'string'
    ? input.effort
    : typeof input.thinking === 'string'
      ? input.thinking
      : typeof input.reasoning_effort === 'string'
        ? input.reasoning_effort
        : undefined;
  const effort = effortInput
    ? effortInput.trim().toLowerCase().replace(/^x[-_ ]?high$/, 'xhigh')
    : undefined;
  if (effort && !EFFORT_LEVELS.has(effort)) {
    return `Error: Invalid effort "${effortInput}". Use none, low, medium, high, or xhigh.`;
  }

  const projects = context?.fullConfig?.projects ?? {};
  const rawWorkdir = input.workdir as string | undefined;

  // Resolve project name → path
  const workdir = resolveWorkdir(rawWorkdir, projects, SKIMPYCLAW_ROOT);

  // Project paths are always allowed in addition to configured allowedPaths
  const projectPaths = Object.values(projects).map(p => resolve(p));
  const effectiveAllowedPaths = [...config.allowedPaths, ...projectPaths];

  if (!isPathAllowed(workdir, effectiveAllowedPaths)) {
    const projectNames = Object.keys(projects).length > 0
      ? ` (or project names: ${Object.keys(projects).join(', ')})`
      : '';
    return `Error: Working directory not allowed. Permitted: ${config.allowedPaths.join(', ')}${projectNames}`;
  }

  // Concurrency check
  const maxConcurrent = context?.fullConfig?.codeAgents?.maxConcurrent ?? 5;
  const activeCount = getActiveCodeAgents().length;
  if (activeCount >= maxConcurrent) {
    return `Error: Concurrency limit reached (${activeCount}/${maxConcurrent} coding agents running). Wait for one to finish or increase codeAgents.maxConcurrent.`;
  }

  const cliPreflightError = getCodingCliPreflightError();
  if (cliPreflightError) return cliPreflightError;

  // Default: validate. Skip automatically for review/rebase-style tasks (read-only by intent),
  // unless the caller explicitly set validate. Reuses the same heuristic as auto-worktree.
  const validateExplicit = input.validate !== undefined;
  const validate = validateExplicit
    ? input.validate !== false
    : !shouldAutoWorktreeTask(task);

  // Create task with unique ID
  const id = getNextCodeAgentId();
  const startedAt = new Date();
  const worktreeRequest = normalizeWorktreeRequest(input.worktree);
  const worktreeConfig = context?.fullConfig?.codeAgents?.worktrees;
  const useWorktree = shouldUseCodeAgentWorktree(task, worktreeRequest, worktreeConfig);
  const worktreeRequired = worktreeRequest === true || worktreeConfig?.mode === 'always';
  let executionWorkdir = workdir;
  let sourceWorkdir: string | undefined;
  let worktreePath: string | undefined;
  let worktreeRef: string | undefined;
  let agentTask = task;

  if (useWorktree) {
    try {
      const worktree = prepareCodeAgentWorktree({
        id,
        sourceWorkdir: workdir,
        config: worktreeConfig,
        required: worktreeRequired,
      });
      if (worktree) {
        executionWorkdir = worktree.runWorkdir;
        sourceWorkdir = worktree.sourceWorkdir;
        worktreePath = worktree.worktreePath;
        worktreeRef = worktree.worktreeRef;
        agentTask = `${task}\n\nSkimpyClaw worktree isolation:\n- Source checkout: ${sourceWorkdir}\n- Isolated worktree: ${worktreePath}\n- Run all repository commands from the isolated worktree, not the source checkout.\n- For read-only review or report tasks, write generated artifacts outside the worktree, for example under ~/.skimpyclaw/reviews, so the worktree stays clean for cleanup.\n- If rebasing a branch that is already checked out elsewhere, create a temporary branch in this worktree and report before pushing.`;
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Interactive mode: generate session UUID up-front so --session-id can pin it.
  const cliSessionId = (isInteractive && agent === 'claude') ? randomUUID() : undefined;
  const caTask: CodeAgentTask = {
    id,
    agent,
    task,
    status: 'running',
    chatId: context?.chatId,
    discordThreadId: context?.discordThreadId,
    discordChannelId: context?.discordChannelId,
    startedAt: startedAt.toISOString(),
    workdir: executionWorkdir,
    sourceWorkdir,
    worktreePath,
    worktreeRef,
    model: modelForAgent,
    modelLabel: resolveCodeAgentModelLabel(agent, modelForAgent),
    effort,
    interactive: isInteractive || undefined,
    cliSessionId,
  };
  storeCodeAgentTask(caTask);
  writeCodeAgentTask(caTask);

  // Register a pending interactive session keyed by the task ID.
  // The Discord thread-creation handler will call linkThread(taskId, threadId)
  // to promote it into the threadId-keyed map so follow-up messages work.
  if (isInteractive && cliSessionId) {
    addPendingSession(id, {
      cliSessionId,
      cliAgent: agent as 'claude' | 'codex',
      status: 'active',
      createdAt: startedAt.toISOString(),
      lastActivityAt: startedAt.toISOString(),
      initialTask: task,
    });
  }

  // Fire-and-forget: spawn background process
  const configTimeout = context?.fullConfig?.codeAgents?.timeoutMinutes ?? 30;
  const soloTimeout = Math.min(input.timeout_minutes || configTimeout, 60);
  const resolvedInput = { ...input, model: modelForAgent, effort, timeout_minutes: soloTimeout };
  runCodeAgentBackground(id, agent, agentTask, executionWorkdir, validate, resolvedInput, startedAt, {
    defaultTimeoutMinutes: soloTimeout,
    maxTimeoutMinutes: 60,
    validationCommands: context?.fullConfig?.codeAgents?.validationCommands,
    worktreeConfig,
  }).catch((err) => {
    console.error(`[code-agent] Background error for ${id}:`, err);
  });

  const taskPreview = task.length > 100 ? task.slice(0, 100) + '...' : task;
  const worktreeLine = worktreePath ? `\nWorktree: ${worktreePath}` : '';
  return `Started coding agent ${id} (${agent}). Task: ${taskPreview}${worktreeLine}\n\nUse check_code_agent to poll status.`;
}
