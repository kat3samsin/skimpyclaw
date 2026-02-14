// Audit log reader/writer for ~/.skimpyclaw/logs/audit/YYYY-MM-DD.jsonl

import { randomUUID } from 'crypto';
import { readFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AuditTrace, AuditEvent } from './types.js';

const AUDIT_DIR = join(homedir(), '.skimpyclaw', 'logs', 'audit');

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

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

  // Determine date range
  const endDate = options.endDate ?? new Date();
  const startDate = options.startDate ?? new Date(endDate.getTime() - 90 * 24 * 60 * 60 * 1000); // 90 days back

  // Get all audit JSONL files in the directory
  if (!existsSync(AUDIT_DIR)) {
    return { traces: [], total: 0 };
  }

  const files = readdirSync(AUDIT_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .reverse(); // Newest first

  const startStr = formatDate(startDate);
  const endStr = formatDate(endDate);

  // Collect all matching traces
  const allTraces: AuditTrace[] = [];

  for (const file of files) {
    const dateStr = file.replace('.jsonl', '');
    if (dateStr < startStr || dateStr > endStr) continue;

    const filePath = join(AUDIT_DIR, file);
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      // Parse lines in reverse (newest first within file)
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const trace = JSON.parse(lines[i]) as AuditTrace;
          if (triggerFilter && trace.trigger !== triggerFilter) continue;
          allTraces.push(trace);
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Sort newest first by startedAt
  allTraces.sort((a, b) => {
    const dateA = new Date(b.startedAt || b.endedAt).getTime();
    const dateB = new Date(a.startedAt || a.endedAt).getTime();
    return dateA - dateB;
  });

  const total = allTraces.length;
  const paged = allTraces.slice(offset, offset + limit);

  return { traces: paged, total };
}

export async function writeAuditTrace(trace: AuditTrace): Promise<void> {
  if (!existsSync(AUDIT_DIR)) {
    mkdirSync(AUDIT_DIR, { recursive: true });
  }

  const date = new Date(trace.startedAt || trace.endedAt);
  const filePath = getAuditLogPath(date);
  const line = JSON.stringify(trace) + '\n';
  appendFileSync(filePath, line, 'utf-8');
}
