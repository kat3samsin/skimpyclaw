// src/code-agents/review-loop-storage.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { WorkItemState } from './review-loop-types.js';

const DEFAULT_WORK_ROOT = join(homedir(), '.skimpyclaw', 'work');
let workRootOverride: string | null = null;

export function setWorkRootForTesting(root: string | null): void {
  workRootOverride = root;
}

export function getWorkRoot(): string {
  return workRootOverride ?? DEFAULT_WORK_ROOT;
}

function ensureRoot(): string {
  const root = getWorkRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return root;
}

function workItemPath(id: string): string {
  return join(getWorkRoot(), `${id}.json`);
}

export function loadWorkItem(id: string): WorkItemState | null {
  const path = workItemPath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as WorkItemState;
  } catch (err) {
    console.error(`[review-loop] Failed to parse ${path}:`, err);
    return null;
  }
}

export function saveWorkItem(state: WorkItemState): void {
  const root = ensureRoot();
  const final = join(root, `${state.id}.json`);
  const tmp = `${final}.tmp`;
  const payload = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2);
  writeFileSync(tmp, payload, { mode: 0o600 });
  try {
    renameSync(tmp, final);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export function listWorkItems(): WorkItemState[] {
  const root = getWorkRoot();
  if (!existsSync(root)) return [];
  const entries = readdirSync(root).filter(f => f.endsWith('.json') && !f.endsWith('.tmp'));
  const items: WorkItemState[] = [];
  for (const file of entries) {
    try {
      const raw = readFileSync(join(root, file), 'utf-8');
      items.push(JSON.parse(raw) as WorkItemState);
    } catch { /* skip corrupt */ }
  }
  items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return items;
}

export function nextWorkItemId(): string {
  const ids = listWorkItems().map(w => w.id);
  let max = 0;
  for (const id of ids) {
    const m = /^RL-(\d+)$/.exec(id);
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  const next = max + 1;
  return `RL-${String(next).padStart(3, '0')}`;
}

/**
 * Atomically reserve the next RL-NNN id by creating a zero-byte placeholder
 * file with O_EXCL. Two racing callers will never get the same id. The
 * placeholder is overwritten by the first subsequent saveWorkItem call.
 */
export function allocateWorkItemId(): string {
  const root = ensureRoot();
  let candidate = nextWorkItemId();
  for (let attempts = 0; attempts < 32; attempts++) {
    const file = join(root, `${candidate}.json`);
    try {
      const fd = openSync(file, 'wx', 0o600); // 'wx' = O_WRONLY | O_CREAT | O_EXCL
      closeSync(fd);
      return candidate;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      const m = /^RL-(\d+)$/.exec(candidate);
      const n = m ? parseInt(m[1]!, 10) : 0;
      candidate = `RL-${String(n + 1).padStart(3, '0')}`;
    }
  }
  throw new Error('allocateWorkItemId: exceeded retry budget');
}
