// Runtime log retention and trimming.

import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { basename, join, relative, resolve, sep } from 'path';
import { trimSessionFileForRetention } from './sessions.js';
import type { InteractiveSession } from './types.js';

const DEFAULT_LOG_RETENTION_DAYS = 30;
const DEFAULT_SCRATCH_RETENTION_HOURS = 24;
const TERMINAL_CODE_AGENT_STATUSES = new Set(['completed', 'failed', 'timeout', 'cancelled']);

export interface LogCleanupOptions {
  homeDir?: string;
  now?: Date;
  dryRun?: boolean;
  logRetentionDays?: number;
  scratchRetentionHours?: number;
}

export interface LogCleanupSummary {
  dryRun: boolean;
  scannedFiles: number;
  deletedFiles: number;
  deletedDirs: number;
  trimmedEntries: number;
  freedBytes: number;
  errors: string[];
}

function emptySummary(dryRun: boolean): LogCleanupSummary {
  return {
    dryRun,
    scannedFiles: 0,
    deletedFiles: 0,
    deletedDirs: 0,
    trimmedEntries: 0,
    freedBytes: 0,
    errors: [],
  };
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join('/');
}

function recordError(summary: LogCleanupSummary, path: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  summary.errors.push(`${path}: ${message}`);
}

function safeStat(path: string, summary: LogCleanupSummary) {
  try {
    return statSync(path);
  } catch (err) {
    recordError(summary, path, err);
    return null;
  }
}

function walkFiles(root: string, summary: LogCleanupSummary): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];

  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      recordError(summary, dir, err);
      return;
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };

  visit(root);
  return files;
}

function deleteFile(path: string, size: number, summary: LogCleanupSummary): void {
  if (summary.dryRun) {
    summary.deletedFiles++;
    summary.freedBytes += size;
    return;
  }

  try {
    unlinkSync(path);
    summary.deletedFiles++;
    summary.freedBytes += size;
  } catch (err) {
    recordError(summary, path, err);
  }
}

function isPrunableLogArtifact(relPath: string): boolean {
  const normalized = normalizeRelativePath(relPath);
  const name = basename(normalized);

  if (!normalized.includes('/') && /^.+\.log\.\d+$/.test(normalized)) return true;
  if (normalized.startsWith('audit/') && name.endsWith('.jsonl')) return true;
  if (normalized.startsWith('usage/') && name.endsWith('.jsonl')) return true;
  if (normalized.startsWith('cron/') && name.endsWith('.log')) return true;
  if (normalized.startsWith('digests/') && name.endsWith('.json') && name !== 'index.json') return true;
  if (normalized.startsWith('code-agents/') && /^ca-\d+\.json$/.test(name)) return true;
  if (normalized.startsWith('code-agents/') && /^ca-\d+\.log$/.test(name)) return true;
  if (normalized.startsWith('review-loop/') && /\.(json|jsonl|log|txt|md)$/i.test(name)) return true;
  return false;
}

function getCodeAgentStatus(path: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { status?: unknown };
    return typeof parsed.status === 'string' ? parsed.status : undefined;
  } catch {
    return undefined;
  }
}

function shouldDeleteCodeAgentArtifact(path: string, relPath: string): boolean {
  const name = basename(relPath);
  if (/^ca-\d+\.json$/.test(name)) {
    const status = getCodeAgentStatus(path);
    return typeof status === 'string' && TERMINAL_CODE_AGENT_STATUSES.has(status);
  }

  if (/^ca-\d+\.log$/.test(name)) {
    const statePath = path.replace(/\.log$/, '.json');
    const status = existsSync(statePath) ? getCodeAgentStatus(statePath) : undefined;
    return typeof status === 'string' ? TERMINAL_CODE_AGENT_STATUSES.has(status) : true;
  }

  return false;
}

function trimInteractiveSessions(storePath: string, cutoffMs: number, summary: LogCleanupSummary): void {
  if (!existsSync(storePath)) return;

  summary.scannedFiles++;
  const stat = safeStat(storePath, summary);
  if (!stat) return;

  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf-8')) as unknown;
    if (!Array.isArray(parsed)) return;

    const kept = parsed.filter((session: Partial<InteractiveSession>) => {
      const timestamp = Date.parse(session.lastActivityAt || session.createdAt || '');
      return !Number.isFinite(timestamp) || timestamp >= cutoffMs;
    });
    const removed = parsed.length - kept.length;
    if (removed <= 0) return;

    summary.trimmedEntries += removed;
    if (summary.dryRun) {
      summary.freedBytes += stat.size;
      return;
    }

    const next = JSON.stringify(kept, null, 2) + '\n';
    writeFileSync(storePath, next, 'utf-8');
    summary.freedBytes += Math.max(0, stat.size - Buffer.byteLength(next, 'utf-8'));
  } catch (err) {
    recordError(summary, storePath, err);
  }
}

function cleanupLogTree(logsDir: string, cutoffMs: number, summary: LogCleanupSummary): void {
  for (const path of walkFiles(logsDir, summary)) {
    summary.scannedFiles++;
    const stat = safeStat(path, summary);
    if (!stat) continue;

    const relPath = normalizeRelativePath(relative(logsDir, path));
    if (!isPrunableLogArtifact(relPath) || stat.mtimeMs >= cutoffMs) continue;

    if (relPath.startsWith('code-agents/') && !shouldDeleteCodeAgentArtifact(path, relPath)) {
      continue;
    }
    deleteFile(path, stat.size, summary);
  }

  trimInteractiveSessions(join(logsDir, 'code-agents', 'interactive-sessions.json'), cutoffMs, summary);
}

function cleanupMemoryLogs(agentsDir: string, cutoffMs: number, summary: LogCleanupSummary): void {
  if (!existsSync(agentsDir)) return;

  for (const path of walkFiles(agentsDir, summary)) {
    const normalized = normalizeRelativePath(relative(agentsDir, path));
    if (!normalized.includes('/memory/logs/') || !normalized.endsWith('.md')) continue;

    summary.scannedFiles++;
    const stat = safeStat(path, summary);
    if (stat && stat.mtimeMs < cutoffMs) {
      deleteFile(path, stat.size, summary);
    }
  }
}

function cleanupScratchDirs(home: string, cutoffMs: number, summary: LogCleanupSummary): void {
  for (const dir of [join(home, '.skimpyclaw', 's'), join(home, '.skimpyclaw', 'scratch')]) {
    for (const path of walkFiles(dir, summary)) {
      summary.scannedFiles++;
      const stat = safeStat(path, summary);
      if (stat && stat.mtimeMs < cutoffMs) {
        deleteFile(path, stat.size, summary);
      }
    }
  }
}

function cleanupSessionMessages(sessionsDir: string, cutoffMs: number, summary: LogCleanupSummary): void {
  for (const path of walkFiles(sessionsDir, summary)) {
    const name = basename(path);
    if (!name.endsWith('.jsonl') && !name.endsWith('.json')) continue;

    summary.scannedFiles++;
    const stat = safeStat(path, summary);
    if (!stat) continue;

    if (name.endsWith('.jsonl')) {
      try {
        const trim = trimSessionFileForRetention(path, cutoffMs, summary.dryRun);
        summary.trimmedEntries += trim.deletedEntries;
        summary.freedBytes += trim.freedBytes;
        if (trim.deletedFile) summary.deletedFiles++;
      } catch (err) {
        recordError(summary, path, err);
      }
      continue;
    }

    if (stat.mtimeMs < cutoffMs) {
      deleteFile(path, stat.size, summary);
    }
  }
}

function removeEmptyChildDirs(root: string, summary: LogCleanupSummary): boolean {
  if (!existsSync(root)) return true;

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }

  let empty = true;
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (removeEmptyChildDirs(path, summary)) {
        summary.deletedDirs++;
        if (!summary.dryRun) {
          try {
            rmSync(path, { recursive: false, force: true });
          } catch {
            empty = false;
          }
        }
      } else {
        empty = false;
      }
    } else {
      empty = false;
    }
  }

  if (!empty) return false;
  return true;
}

function removeEmptyDirsBelow(root: string, summary: LogCleanupSummary): void {
  if (!existsSync(root)) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (!removeEmptyChildDirs(path, summary)) continue;
    summary.deletedDirs++;
    if (summary.dryRun) continue;
    try {
      rmSync(path, { recursive: false, force: true });
    } catch {
      // Best effort; another writer may have recreated it.
    }
  }
}

function isSafeDigestToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0')
    && !value.includes('..');
}

function digestFileExists(digestsDir: string, id: string, jobId: string, date: string, summary: LogCleanupSummary): boolean {
  const jobDir = resolve(digestsDir, jobId);
  const base = resolve(digestsDir);
  if (!jobDir.startsWith(`${base}${sep}`) || !existsSync(jobDir)) return false;

  try {
    for (const file of readdirSync(jobDir)) {
      if (!file.endsWith('.json') || !file.startsWith(`${date}-`)) continue;
      try {
        const digest = JSON.parse(readFileSync(join(jobDir, file), 'utf-8')) as { id?: unknown };
        if (digest.id === id) return true;
      } catch {
        if (file === `${date}-${id}.json`) return true;
      }
      if (file === `${date}-${id}.json`) return true;
    }
    return false;
  } catch (err) {
    recordError(summary, jobDir, err);
    return true;
  }
}

function repairDigestIndex(digestsDir: string, summary: LogCleanupSummary): void {
  const indexPath = join(digestsDir, 'index.json');
  if (!existsSync(indexPath)) return;

  try {
    const raw = JSON.parse(readFileSync(indexPath, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const index = raw as Record<string, Record<string, unknown>>;
    const next: Record<string, Record<string, unknown>> = {};
    let changed = false;

    for (const [id, entry] of Object.entries(index)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        next[id] = entry as Record<string, unknown>;
        continue;
      }
      if (!isSafeDigestToken(id) || !isSafeDigestToken(entry?.jobId) || typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
        next[id] = entry;
        continue;
      }

      if (!digestFileExists(digestsDir, id, entry.jobId, entry.date, summary)) {
        changed = true;
        continue;
      }
      next[id] = entry;
    }

    if (changed && !summary.dryRun) {
      const tmpPath = `${indexPath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(next, null, 2) + '\n', 'utf-8');
      renameSync(tmpPath, indexPath);
    }
  } catch (err) {
    recordError(summary, indexPath, err);
  }
}

export function cleanupLogs(options: LogCleanupOptions = {}): LogCleanupSummary {
  const dryRun = options.dryRun === true;
  const summary = emptySummary(dryRun);
  const home = options.homeDir || homedir();
  const now = options.now || new Date();
  const logRetentionDays = options.logRetentionDays ?? DEFAULT_LOG_RETENTION_DAYS;
  const scratchRetentionHours = options.scratchRetentionHours ?? DEFAULT_SCRATCH_RETENTION_HOURS;

  const logsDir = join(home, '.skimpyclaw', 'logs');
  const logCutoffMs = now.getTime() - logRetentionDays * 24 * 60 * 60 * 1000;
  const scratchCutoffMs = now.getTime() - scratchRetentionHours * 60 * 60 * 1000;

  cleanupLogTree(logsDir, logCutoffMs, summary);
  cleanupMemoryLogs(join(home, '.skimpyclaw', 'agents'), logCutoffMs, summary);
  cleanupSessionMessages(join(home, '.skimpyclaw', 'sessions'), logCutoffMs, summary);
  cleanupScratchDirs(home, scratchCutoffMs, summary);
  repairDigestIndex(join(logsDir, 'digests'), summary);

  for (const dir of [join(logsDir, 'digests'), join(home, '.skimpyclaw', 'sessions'), join(home, '.skimpyclaw', 's'), join(home, '.skimpyclaw', 'scratch')]) {
    removeEmptyDirsBelow(dir, summary);
  }

  return summary;
}

export function formatCleanupSummary(summary: LogCleanupSummary): string {
  const action = summary.dryRun ? 'Would clean' : 'Cleaned';
  const freedMb = (summary.freedBytes / (1024 * 1024)).toFixed(2);
  const parts = [
    `${action} ${summary.deletedFiles} file(s)`,
    `removed ${summary.deletedDirs} empty dir(s)`,
    `trimmed ${summary.trimmedEntries} old entr${summary.trimmedEntries === 1 ? 'y' : 'ies'}`,
    `freed ${freedMb} MB`,
  ];
  if (summary.errors.length > 0) parts.push(`${summary.errors.length} error(s)`);
  return parts.join(', ');
}
