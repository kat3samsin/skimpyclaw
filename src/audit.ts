// Audit log reader/writer for ~/.skimpyclaw/logs/audit/YYYY-MM-DD.jsonl

import { randomUUID } from 'crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AuditTrace, AuditEvent } from './types.js';
import { formatDate, readJsonlDir } from './utils.js';

const AUDIT_DIR = join(homedir(), '.skimpyclaw', 'logs', 'audit');

// --- In-memory trace lifecycle ---

/** Active traces keyed by traceId */
const activeTraces = new Map<string, { trace: AuditTrace; startTime: number }>();

/**
 * Start a new audit trace. Returns a traceId to use with addEvent/endTrace.
 */
export function startTrace(trigger: AuditTrace['trigger']): string {
  const traceId = randomUUID();
  const now = new Date();
  const trace: AuditTrace = {
    traceId,
    trigger,
    status: 'ok',
    startedAt: now.toISOString(),
    endedAt: '',
    durationMs: 0,
    events: [],
  };
  activeTraces.set(traceId, { trace, startTime: Date.now() });
  return traceId;
}

/**
 * Add an event to an active trace.
 */
export function addEvent(traceId: string, event: AuditEvent): void {
  const entry = activeTraces.get(traceId);
  if (!entry) return; // Silently ignore if trace not found
  entry.trace.events.push(event);
}

/**
 * End a trace, write it to disk, and remove from active map.
 */
export async function endTrace(traceId: string, status: 'ok' | 'error'): Promise<void> {
  const entry = activeTraces.get(traceId);
  if (!entry) return;

  entry.trace.status = status;
  entry.trace.endedAt = new Date().toISOString();
  entry.trace.durationMs = Date.now() - entry.startTime;

  activeTraces.delete(traceId);

  await writeAuditTrace(entry.trace);
}

export function getAuditLogPath(date: Date): string {
  return join(AUDIT_DIR, `${formatDate(date)}.jsonl`);
}

export interface ReadAuditOptions {
  limit?: number;
  offset?: number;
  trigger?: string;
  startDate?: Date;
  endDate?: Date;
}

export async function readAuditTraces(options: ReadAuditOptions = {}): Promise<{ traces: AuditTrace[]; total: number }> {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const triggerFilter = options.trigger;

  const endDate = options.endDate ?? new Date();
  const startDate = options.startDate ?? new Date(endDate.getTime() - 90 * 24 * 60 * 60 * 1000);

  const allTraces = readJsonlDir<AuditTrace>(
    AUDIT_DIR,
    formatDate(startDate),
    formatDate(endDate),
    triggerFilter ? (t) => t.trigger === triggerFilter : undefined,
  );

  // Sort newest first by startedAt
  allTraces.sort((a, b) =>
    Date.parse(b.startedAt || b.endedAt) - Date.parse(a.startedAt || a.endedAt)
  );

  const total = allTraces.length;
  const paged = allTraces.slice(offset, offset + limit);

  return { traces: paged, total };
}

export async function writeAuditTrace(trace: AuditTrace): Promise<void> {
  if (!existsSync(AUDIT_DIR)) {
    mkdirSync(AUDIT_DIR, { recursive: true, mode: 0o700 });
  }
  chmodSync(AUDIT_DIR, 0o700);

  const date = new Date(trace.startedAt || trace.endedAt);
  const filePath = getAuditLogPath(date);
  const line = JSON.stringify(trace) + '\n';
  appendFileSync(filePath, line, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(filePath, 0o600);
}
