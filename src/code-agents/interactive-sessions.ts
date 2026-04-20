// Interactive coding session state store.
//
// Maps Discord thread IDs to running CLI sessions (claude --session-id or
// codex thread_id). Persisted to disk so sessions survive gateway restarts.
// Per-session FIFO queue prevents concurrent --resume subprocesses against
// the same session (which would corrupt history).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { homedir } from 'os';
import { join } from 'path';
import type { InteractiveSession, InteractiveSessionStatus } from '../types.js';

const STORE_PATH = join(homedir(), '.skimpyclaw', 'logs', 'code-agents', 'interactive-sessions.json');

interface PendingMessage {
  content: string;
  receivedAt: string;
}

interface QueueState {
  inFlight: boolean;
  queue: PendingMessage[];
}

const sessions = new Map<string, InteractiveSession>();
const queues = new Map<string, QueueState>();
// Pending sessions created before a Discord thread exists, keyed by coding-agent task ID.
const pendingByTaskId = new Map<string, InteractiveSession>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  if (!existsSync(STORE_PATH)) return;
  try {
    const raw = readFileSync(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as InteractiveSession[];
    for (const s of parsed) {
      sessions.set(s.discordThreadId, s);
    }
  } catch (err) {
    console.error('[interactive-sessions] Failed to load store:', err);
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    const arr = Array.from(sessions.values());
    writeFileSync(STORE_PATH, JSON.stringify(arr, null, 2), 'utf-8');
  } catch (err) {
    console.error('[interactive-sessions] Failed to persist store:', err);
  }
}

export function addSession(s: InteractiveSession): void {
  ensureLoaded();
  sessions.set(s.discordThreadId, s);
  queues.set(s.discordThreadId, { inFlight: false, queue: [] });
  persist();
}

export function getSession(discordThreadId: string): InteractiveSession | undefined {
  ensureLoaded();
  return sessions.get(discordThreadId);
}

export function updateStatus(discordThreadId: string, status: InteractiveSessionStatus): void {
  ensureLoaded();
  const s = sessions.get(discordThreadId);
  if (!s) return;
  s.status = status;
  s.lastActivityAt = new Date().toISOString();
  persist();
}

export function touchActivity(discordThreadId: string): void {
  ensureLoaded();
  const s = sessions.get(discordThreadId);
  if (!s) return;
  s.lastActivityAt = new Date().toISOString();
  persist();
}

export function listSessions(): InteractiveSession[] {
  ensureLoaded();
  return Array.from(sessions.values());
}

// `enqueue` returns shouldStart=true if the caller should begin draining;
// false if a subprocess is already in flight and will pick up this message.
export function enqueue(discordThreadId: string, content: string): { shouldStart: boolean } {
  ensureLoaded();
  let q = queues.get(discordThreadId);
  if (!q) {
    q = { inFlight: false, queue: [] };
    queues.set(discordThreadId, q);
  }
  q.queue.push({ content, receivedAt: new Date().toISOString() });
  if (!q.inFlight) {
    q.inFlight = true;
    return { shouldStart: true };
  }
  return { shouldStart: false };
}

export function dequeue(discordThreadId: string): PendingMessage | undefined {
  const q = queues.get(discordThreadId);
  if (!q) return undefined;
  return q.queue.shift();
}

export function markIdle(discordThreadId: string): void {
  const q = queues.get(discordThreadId);
  if (!q) return;
  q.inFlight = false;
}

export function hasPending(discordThreadId: string): boolean {
  const q = queues.get(discordThreadId);
  if (!q) return false;
  return q.queue.length > 0;
}

// Register a session that doesn't yet have a Discord thread. Keyed by the
// coding-agent task ID; the Discord handler re-keys by threadId via linkThread().
export function addPendingSession(codeAgentTaskId: string, s: Omit<InteractiveSession, 'discordThreadId'>): void {
  ensureLoaded();
  pendingByTaskId.set(codeAgentTaskId, { ...s, discordThreadId: '' });
}

export function linkThread(codeAgentTaskId: string, discordThreadId: string): boolean {
  ensureLoaded();
  const pending = pendingByTaskId.get(codeAgentTaskId);
  if (!pending) return false;
  const full: InteractiveSession = { ...pending, discordThreadId };
  sessions.set(discordThreadId, full);
  queues.set(discordThreadId, { inFlight: false, queue: [] });
  pendingByTaskId.delete(codeAgentTaskId);
  persist();
  return true;
}

export function _resetForTesting(): void {
  sessions.clear();
  queues.clear();
  pendingByTaskId.clear();
  loaded = false;
}
