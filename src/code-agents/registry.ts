// Code Agent Registry - Task storage and management

import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { CodeAgentTask } from './types.js';
import { cleanupCodeAgentWorktree, type CodeAgentWorktreeConfig } from './worktrees.js';

const CODE_AGENTS_DIR = join(homedir(), '.skimpyclaw', 'logs', 'code-agents');

// In-memory tracking
let codeAgentCounter = 0;
const codeAgentTasks = new Map<string, CodeAgentTask>();
const codeAgentCancellers = new Map<string, () => void>();

export function getCodeAgentsDir(): string {
  return CODE_AGENTS_DIR;
}

export function ensureCodeAgentsDir(): void {
  if (!existsSync(CODE_AGENTS_DIR)) {
    mkdirSync(CODE_AGENTS_DIR, { recursive: true });
  }
}

export function writeCodeAgentTask(task: CodeAgentTask): void {
  try {
    ensureCodeAgentsDir();
    const filePath = join(CODE_AGENTS_DIR, `${task.id}.json`);
    writeFileSync(filePath, JSON.stringify(task, null, 2), 'utf-8');
  } catch { /* best effort */ }
}

export function getNextCodeAgentId(): string {
  return `ca-${++codeAgentCounter}`;
}

export function setCodeAgentCounter(value: number): void {
  codeAgentCounter = value;
}

export function getCodeAgentCounter(): number {
  return codeAgentCounter;
}

/** Get all active (running/validating) code agents. */
export function getActiveCodeAgents(): CodeAgentTask[] {
  return Array.from(codeAgentTasks.values())
    .filter(t => t.status === 'running' || t.status === 'validating');
}

/** Get recent code agents (completed/failed/timeout), newest first. */
export function getRecentCodeAgents(limit = 20): CodeAgentTask[] {
  return Array.from(codeAgentTasks.values())
    .filter(t => t.status !== 'running' && t.status !== 'validating' && t.status !== 'pending')
    .sort((a, b) => (b.endedAt || b.startedAt).localeCompare(a.endedAt || a.startedAt))
    .slice(0, limit);
}

/** Get all code agents (active + recent), newest first. */
export function getAllCodeAgents(): CodeAgentTask[] {
  return Array.from(codeAgentTasks.values())
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Get a single code agent by ID. */
export function getCodeAgent(id: string): CodeAgentTask | null {
  return codeAgentTasks.get(id) || null;
}

/** Store a task in the registry. */
export function storeCodeAgentTask(task: CodeAgentTask): void {
  codeAgentTasks.set(task.id, task);
}

/**
 * Find tasks spawned from a specific chat/channel that don't have a discordThreadId yet.
 * Used by Discord handler to retroactively assign threads after runAgentTurn.
 * Includes non-running tasks to handle fast-completing agents (race condition fix).
 */
export function getUnthreadedTasksForChat(chatId: number): CodeAgentTask[] {
  return Array.from(codeAgentTasks.values()).filter(t =>
    t.chatId === chatId &&
    !t.discordThreadId
  );
}

/** Get the canceller function for a task. */
export function getCodeAgentCanceller(id: string): (() => void) | undefined {
  return codeAgentCancellers.get(id);
}

/** Set the canceller function for a task. */
export function setCodeAgentCanceller(id: string, canceller: () => void): void {
  codeAgentCancellers.set(id, canceller);
}

/** Delete the canceller function for a task. */
export function deleteCodeAgentCanceller(id: string): void {
  codeAgentCancellers.delete(id);
}

/** Cancel a running/pending code agent. */
export function cancelCodeAgent(id: string): CodeAgentTask | null {
  const task = codeAgentTasks.get(id);
  if (!task) return null;

  const isTerminal = ['completed', 'failed', 'timeout', 'cancelled'].includes(task.status);
  if (isTerminal) return task;

  const canceller = codeAgentCancellers.get(id);
  if (canceller) {
    try { canceller(); } catch { /* best effort */ }
  }
  task.status = 'cancelled';
  task.endedAt = new Date().toISOString();
  task.durationSeconds = Math.round((Date.now() - new Date(task.startedAt).getTime()) / 1000);
  task.error = 'Cancelled by user';
  task.liveOutput = undefined;
  writeCodeAgentTask(task);
  return task;
}

/** Restore code agent tasks from disk on startup. */
export function restoreCodeAgentTasks(worktreeConfig?: CodeAgentWorktreeConfig): void {
  try {
    if (!existsSync(CODE_AGENTS_DIR)) return;
    const files = readdirSync(CODE_AGENTS_DIR).filter(f => /^ca-\d+\.json$/.test(f));
    let maxCounter = 0;
    for (const file of files) {
      try {
        const task = JSON.parse(readFileSync(join(CODE_AGENTS_DIR, file), 'utf-8')) as CodeAgentTask;
        // On startup, any task still "running" or "validating" means the managing process died
        if (task.status === 'running' || task.status === 'validating') {
          const elapsed = task.startedAt ? Date.now() - new Date(task.startedAt).getTime() : 0;
          task.status = 'failed';
          task.error = 'Process interrupted (server restarted)';
          task.endedAt = new Date().toISOString();
          task.durationSeconds = Math.round(elapsed / 1000);
          writeCodeAgentTask(task);
        }
        if (
          worktreeConfig &&
          task.worktreePath &&
          !task.worktreeCleanup &&
          !['running', 'validating', 'pending'].includes(task.status)
        ) {
          task.worktreeCleanup = cleanupCodeAgentWorktree({
            sourceWorkdir: task.sourceWorkdir,
            worktreePath: task.worktreePath,
            worktreeRef: task.worktreeRef,
            config: worktreeConfig,
          });
          writeCodeAgentTask(task);
        }
        codeAgentTasks.set(task.id, task);
        const num = parseInt(task.id.replace('ca-', ''), 10);
        if (num > maxCounter) maxCounter = num;
      } catch { /* skip corrupt files */ }
    }
    codeAgentCounter = maxCounter;
  } catch { /* best effort */ }
}
