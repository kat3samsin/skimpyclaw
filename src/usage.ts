// Usage tracking — JSONL append-only storage at ~/.skimpyclaw/logs/usage/YYYY-MM-DD.jsonl

import { randomUUID } from 'crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { formatDate, readJsonlDir } from './utils.js';

const USAGE_DIR = join(homedir(), '.skimpyclaw', 'logs', 'usage');

export interface UsageRecord {
  id: string;
  timestamp: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  trigger: string;
  agentId?: string;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface UsageAggregation {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCalls: number;
  byModel: Record<string, {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }>;
}

export interface UsageSummary {
  today: UsageAggregation;
  week: UsageAggregation;
  month: UsageAggregation;
}

export interface ReadUsageOptions {
  startDate?: string; // YYYY-MM-DD
  endDate?: string;   // YYYY-MM-DD
  limit?: number;
  offset?: number;
  model?: string;
}

/** For testing: override the usage directory */
let usageDirOverride: string | null = null;
export function setUsageDirForTesting(dir: string | null): void {
  usageDirOverride = dir;
}
function getUsageDir(): string {
  return usageDirOverride ?? USAGE_DIR;
}
function getFilePath(dateStr: string): string {
  return join(getUsageDir(), `${dateStr}.jsonl`);
}

/**
 * Record a usage event. Sync append, never throws.
 */
export function recordUsage(record: UsageRecord): void {
  try {
    const dir = getUsageDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    chmodSync(dir, 0o700);
    const dateStr = record.timestamp.slice(0, 10); // YYYY-MM-DD from ISO
    const filePath = getFilePath(dateStr);
    appendFileSync(filePath, JSON.stringify(record) + '\n', { encoding: 'utf-8', mode: 0o600 });
    chmodSync(filePath, 0o600);
  } catch (err) {
    console.warn('[usage] Failed to record usage:', err);
  }
}

/**
 * Build a UsageRecord from model call data. Returns a complete record ready for recordUsage().
 */
export function buildUsageRecord(opts: {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  trigger: string;
  agentId?: string;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}): UsageRecord {
  return {
    id: randomUUID().slice(0, 8),
    timestamp: new Date().toISOString(),
    model: opts.model,
    provider: opts.provider,
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
    totalTokens: opts.inputTokens + opts.outputTokens,
    inputCost: opts.inputCost,
    outputCost: opts.outputCost,
    totalCost: opts.totalCost,
    trigger: opts.trigger,
    agentId: opts.agentId,
    cacheReadTokens: opts.cacheReadTokens,
    cacheCreationTokens: opts.cacheCreationTokens,
  };
}

/**
 * Read usage records from JSONL files in a date range.
 */
export function readUsageRecords(options: ReadUsageOptions = {}): { records: UsageRecord[]; total: number } {
  const dir = getUsageDir();
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  const now = new Date();
  const endDate = options.endDate ?? formatDate(now);
  const startDate = options.startDate ?? formatDate(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));

  const modelFilter = options.model;
  const allRecords = readJsonlDir<UsageRecord>(
    dir,
    startDate,
    endDate,
    modelFilter ? (r) => r.model === modelFilter : undefined,
  );

  // Sort newest first
  allRecords.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  const total = allRecords.length;
  const paged = allRecords.slice(offset, offset + limit);

  return { records: paged, total };
}

function emptyAggregation(): UsageAggregation {
  return { totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCalls: 0, byModel: {} };
}

/**
 * Aggregate usage over a date range.
 */
export function aggregateUsage(startDate: string, endDate: string): UsageAggregation {
  const { records } = readUsageRecords({ startDate, endDate, limit: 100000 });
  const agg = emptyAggregation();

  for (const r of records) {
    agg.totalCost += r.totalCost;
    agg.totalInputTokens += r.inputTokens;
    agg.totalOutputTokens += r.outputTokens;
    agg.totalCalls++;

    if (!agg.byModel[r.model]) {
      agg.byModel[r.model] = { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    }
    agg.byModel[r.model].calls++;
    agg.byModel[r.model].inputTokens += r.inputTokens;
    agg.byModel[r.model].outputTokens += r.outputTokens;
    agg.byModel[r.model].cost += r.totalCost;
  }

  return agg;
}

/**
 * Get usage summary for today, last 7 days, and last 30 days.
 * Reads files once for the full 30-day window, then partitions in memory.
 */
export function getUsageSummary(): UsageSummary {
  const now = new Date();
  const todayStr = formatDate(now);

  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const weekAgoStr = formatDate(weekAgo);
  const monthAgoStr = formatDate(monthAgo);

  // Read all records once for the full 30-day range
  const { records: allRecords } = readUsageRecords({ startDate: monthAgoStr, endDate: todayStr, limit: 100000 });

  const aggregate = (records: UsageRecord[]): UsageAggregation => {
    const agg = emptyAggregation();
    for (const r of records) {
      agg.totalCost += r.totalCost;
      agg.totalInputTokens += r.inputTokens;
      agg.totalOutputTokens += r.outputTokens;
      agg.totalCalls++;
      if (!agg.byModel[r.model]) {
        agg.byModel[r.model] = { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
      }
      agg.byModel[r.model].calls++;
      agg.byModel[r.model].inputTokens += r.inputTokens;
      agg.byModel[r.model].outputTokens += r.outputTokens;
      agg.byModel[r.model].cost += r.totalCost;
    }
    return agg;
  };

  return {
    today: aggregate(allRecords.filter(r => r.timestamp.slice(0, 10) === todayStr)),
    week: aggregate(allRecords.filter(r => r.timestamp.slice(0, 10) >= weekAgoStr)),
    month: aggregate(allRecords),
  };
}
