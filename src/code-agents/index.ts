// Code Agents - Public API
// Background multi-agent coding task execution

import { resolve } from 'path';
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
import { runTeamOrchestrator, computeWaves, decomposeTask, synthesizeResults } from './orchestrator.js';
import {
  setCodeAgentConfig,
  getCodeAgentConfig,
  buildCodeAgentArgs,
  resolveSelectedCodeAgent,
  resolveWorkdir,
  resolveModelAlias,
  readTeamState,
} from './utils.js';
import { parseStreamJsonForLive, parseClaudeOutput, parseCodexOutput } from './parser.js';

// Re-export types
export type {
  CodeAgentTask,
  DecomposedSubtask,
  CodeAgentBackgroundOptions,
  BuildCodeAgentArgsInput,
  ValidationResult,
  ChildResult,
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

// Re-export orchestrator functions
export {
  runTeamOrchestrator,
  computeWaves,
  decomposeTask,
  synthesizeResults,
} from './orchestrator.js';

// Re-export utility functions
export {
  setCodeAgentConfig,
  getCodeAgentConfig,
  buildCodeAgentArgs,
  resolveSelectedCodeAgent,
  resolveWorkdir,
  resolveModelAlias,
  readTeamState,
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

  const configDefault = context?.fullConfig?.subagents?.defaultCodeAgent || 'claude';
  const requestedAgent = input.agent as string | undefined;
  const agent = resolveSelectedCodeAgent(requestedAgent, configDefault, resolvedModel);
  if (!agent) {
    return `Error: Invalid agent "${requestedAgent}". Must be claude, codex, or kimi.`;
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

  // Concurrency check — share limit with subagents
  const maxConcurrent = context?.fullConfig?.subagents?.maxConcurrent ?? 5;
  const activeCount = getActiveCodeAgents().length;
  if (activeCount >= maxConcurrent) {
    return `Error: Concurrency limit reached (${activeCount}/${maxConcurrent} coding agents running). Wait for one to finish or increase subagents.maxConcurrent.`;
  }

  const validate = input.validate !== false; // default true

  // Create task with unique ID
  const id = getNextCodeAgentId();
  const startedAt = new Date();
  const caTask: CodeAgentTask = {
    id,
    agent,
    task,
    status: 'running',
    chatId: context?.chatId,
    startedAt: startedAt.toISOString(),
    workdir,
    model: resolvedModel,
  };
  storeCodeAgentTask(caTask);
  writeCodeAgentTask(caTask);

  // Fire-and-forget: spawn background process
  const resolvedInput = { ...input, model: resolvedModel };
  runCodeAgentBackground(id, agent, task, workdir, validate, resolvedInput, startedAt).catch((err) => {
    console.error(`[code-agent] Background error for ${id}:`, err);
  });

  const taskPreview = task.length > 100 ? task.slice(0, 100) + '...' : task;
  return `Started coding agent ${id} (${agent}). Task: ${taskPreview}\n\nUse check_code_agent to poll status.`;
}

/**
 * Execute code_with_team tool - multi-agent team mode.
 */
export async function executeCodeWithTeam(
  input: Record<string, any>,
  config: ToolConfig,
  context?: ExecuteToolContext,
): Promise<string> {
  const task = input.task as string;
  if (!task) return 'Error: task is required';

  // Resolve model alias first so agent auto-selection can inspect it.
  // Fall back to current session model so codex/kimi models auto-select the right CLI.
  let rawTeamModel = input.model as string | undefined;
  if (!rawTeamModel) {
    try {
      const { getCurrentModel } = await import('../gateway.js');
      rawTeamModel = getCurrentModel();
    } catch { /* gateway not running */ }
  }
  const resolvedModel = resolveModelAlias(
    rawTeamModel,
    context?.fullConfig?.models?.aliases
  );

  const configDefault = context?.fullConfig?.subagents?.defaultCodeAgent || 'claude';
  const requestedAgent = input.agent as string | undefined;
  const agent = resolveSelectedCodeAgent(requestedAgent, configDefault, resolvedModel);
  if (!agent) {
    return `Error: Invalid agent "${requestedAgent}". Must be claude, codex, or kimi.`;
  }

  const teamSize = Math.max(2, Math.min(5, (input.team_size as number) || 3));

  const projects = context?.fullConfig?.projects ?? {};
  const rawWorkdir = input.workdir as string | undefined;

  // Resolve project name → path
  const workdir = resolveWorkdir(rawWorkdir, projects, SKIMPYCLAW_ROOT);

  // Project paths are always allowed
  const projectPaths = Object.values(projects).map(p => resolve(p));
  const effectiveAllowedPaths = [...config.allowedPaths, ...projectPaths];

  if (!isPathAllowed(workdir, effectiveAllowedPaths)) {
    const projectNames = Object.keys(projects).length > 0
      ? ` (or project names: ${Object.keys(projects).join(', ')})`
      : '';
    return `Error: Working directory not allowed. Permitted: ${config.allowedPaths.join(', ')}${projectNames}`;
  }

  // Concurrency check — need room for teamSize children
  const maxConcurrent = context?.fullConfig?.subagents?.maxConcurrent ?? 5;
  const activeCount = getActiveCodeAgents().length;
  if (activeCount + teamSize > maxConcurrent) {
    return `Error: Concurrency limit — need ${teamSize} slots but only ${maxConcurrent - activeCount} available (${activeCount}/${maxConcurrent} running). Wait for agents to finish.`;
  }

  const validate = input.validate !== false;

  // Create parent task
  const id = getNextCodeAgentId();
  const startedAt = new Date();
  const caTask: CodeAgentTask = {
    id,
    agent: 'team-coordinator',
    task,
    status: 'running',
    chatId: context?.chatId,
    startedAt: startedAt.toISOString(),
    workdir,
    model: resolvedModel,
    childTaskIds: [],
  };
  storeCodeAgentTask(caTask);
  writeCodeAgentTask(caTask);

  // Fire-and-forget: orchestrator decomposes, spawns children, monitors, synthesizes
  runTeamOrchestrator(id, task, teamSize, workdir, validate, agent, resolvedModel, startedAt, context).catch((err) => {
    console.error(`[code-team] Background error for ${id}:`, err);
  });

  const taskPreview = task.length > 100 ? task.slice(0, 100) + '...' : task;
  return `Started coding team ${id} (${teamSize} parallel ${agent} agents). Task: ${taskPreview}\n\nUse check_code_agent to poll status.`;
}

// Need to import join for the file operations
import { join } from 'path';
