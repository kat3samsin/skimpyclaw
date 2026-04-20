// Code Agents - Public API
// Background multi-agent coding task execution

import { resolve } from 'path';
import { randomUUID } from 'crypto';
import type { ToolConfig } from '../types.js';
import type { ExecuteToolContext } from '../tools/execute-context.js';
import { isPathAllowed } from '../tools/path-utils.js';
import type { CodeAgentTask, CodeAgentBackgroundOptions } from './types.js';
import { CODE_AGENT_TIMEOUT_MS } from './types.js';
import {
  getNextCodeAgentId,
  storeCodeAgentTask,
  writeCodeAgentTask,
  getActiveCodeAgents,
  getRecentCodeAgents,
  getAllCodeAgents,
  getCodeAgent,
  cancelCodeAgent,
  restoreCodeAgentTasks,
  getCodeAgentsDir,
} from './registry.js';
import { runCodeAgentBackground, runValidation } from './executor.js';
import { addPendingSession } from './interactive-sessions.js';
import {
  setCodeAgentConfig,
  getCodeAgentConfig,
  buildCodeAgentArgs,
  resolveSelectedCodeAgent,
  isModelCompatibleWithAgent,
  resolveWorkdir,
  resolveModelAlias,
  getCodingCliPreflightError,
} from './utils.js';
import { parseStreamJsonForLive, parseClaudeOutput, parseCodexOutput } from './parser.js';

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
  resolveWorkdir,
  resolveModelAlias,
} from './utils.js';

// Re-export parser functions
export { parseStreamJsonForLive, parseClaudeOutput, parseCodexOutput } from './parser.js';
export type { ClaudeOutputResult } from './parser.js';

// SKIMPYCLAW_ROOT for workdir default
const SKIMPYCLAW_ROOT = resolve(import.meta.dirname || process.cwd(), '..', '..');

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
      model: task.model,
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
    return `${t.id}: ${t.status.toUpperCase()} (${t.agent}, ${elapsed}) — ${taskPreview}`;
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
  // Fall back to current session model so codex/kimi models auto-select the right CLI.
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
    return `Error: Invalid agent "${requestedAgent}". Must be claude, codex, or kimi.`;
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

  const validate = input.validate !== false; // default true

  // Create task with unique ID
  const id = getNextCodeAgentId();
  const startedAt = new Date();
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
    workdir,
    model: modelForAgent,
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
  const resolvedInput = { ...input, model: modelForAgent, timeout_minutes: soloTimeout };
  runCodeAgentBackground(id, agent, task, workdir, validate, resolvedInput, startedAt, {
    defaultTimeoutMinutes: soloTimeout,
    maxTimeoutMinutes: 60,
    validationCommands: context?.fullConfig?.codeAgents?.validationCommands,
  }).catch((err) => {
    console.error(`[code-agent] Background error for ${id}:`, err);
  });

  const taskPreview = task.length > 100 ? task.slice(0, 100) + '...' : task;
  return `Started coding agent ${id} (${agent}). Task: ${taskPreview}\n\nUse check_code_agent to poll status.`;
}

// Need to import join for the file operations
import { join } from 'path';
