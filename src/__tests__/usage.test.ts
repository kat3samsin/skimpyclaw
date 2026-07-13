import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { chmodSync, mkdirSync, rmSync, readFileSync, existsSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  recordUsage,
  readUsageRecords,
  aggregateUsage,
  getUsageSummary,
  buildUsageRecord,
  setUsageDirForTesting,
  type UsageRecord,
} from '../usage.js';

const TEST_DIR = join(tmpdir(), `skimpyclaw-usage-test-${Date.now()}`);

function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: 'test-id',
    timestamp: new Date().toISOString(),
    model: 'claude-sonnet-4-5',
    provider: 'anthropic',
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500,
    inputCost: 0.003,
    outputCost: 0.0075,
    totalCost: 0.0105,
    trigger: 'telegram',
    ...overrides,
  };
}

beforeEach(() => {
  // Clean and recreate test dir
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  setUsageDirForTesting(TEST_DIR);
});

afterAll(() => {
  setUsageDirForTesting(null);
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe('recordUsage', () => {
  it('creates directory and writes JSONL', () => {
    // Use a subdirectory to test auto-creation
    const subDir = join(TEST_DIR, 'sub');
    setUsageDirForTesting(subDir);

    const record = makeRecord({ timestamp: '2026-02-21T10:00:00.000Z' });
    recordUsage(record);

    const filePath = join(subDir, '2026-02-21.jsonl');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.model).toBe('claude-sonnet-4-5');
    expect(parsed.totalCost).toBe(0.0105);
    expect(statSync(subDir).mode & 0o777).toBe(0o700);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);

    setUsageDirForTesting(TEST_DIR);
  });

  it('tightens permissions on existing usage storage', () => {
    const subDir = join(TEST_DIR, 'existing');
    const filePath = join(subDir, '2026-02-21.jsonl');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(filePath, '', 'utf-8');
    chmodSync(subDir, 0o755);
    chmodSync(filePath, 0o644);
    setUsageDirForTesting(subDir);

    recordUsage(makeRecord({ timestamp: '2026-02-21T10:00:00.000Z' }));

    expect(statSync(subDir).mode & 0o777).toBe(0o700);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    setUsageDirForTesting(TEST_DIR);
  });

  it('appends to existing file', () => {
    const record1 = makeRecord({ id: 'r1', timestamp: '2026-02-21T10:00:00.000Z' });
    const record2 = makeRecord({ id: 'r2', timestamp: '2026-02-21T11:00:00.000Z' });

    recordUsage(record1);
    recordUsage(record2);

    const filePath = join(TEST_DIR, '2026-02-21.jsonl');
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).id).toBe('r1');
    expect(JSON.parse(lines[1]).id).toBe('r2');
  });

  it('never throws on write failure', () => {
    setUsageDirForTesting('/nonexistent/deeply/nested/path/that/cannot/exist');
    // Should not throw
    expect(() => recordUsage(makeRecord())).not.toThrow();
    setUsageDirForTesting(TEST_DIR);
  });
});

describe('readUsageRecords', () => {
  it('returns empty for no data', () => {
    const result = readUsageRecords();
    expect(result.records).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('reads and parses records', () => {
    const record = makeRecord({ timestamp: '2026-02-21T10:00:00.000Z' });
    recordUsage(record);

    const result = readUsageRecords({ startDate: '2026-02-21', endDate: '2026-02-21' });
    expect(result.total).toBe(1);
    expect(result.records[0].model).toBe('claude-sonnet-4-5');
  });

  it('filters by date range', () => {
    recordUsage(makeRecord({ id: 'r1', timestamp: '2026-02-20T10:00:00.000Z' }));
    recordUsage(makeRecord({ id: 'r2', timestamp: '2026-02-21T10:00:00.000Z' }));
    recordUsage(makeRecord({ id: 'r3', timestamp: '2026-02-22T10:00:00.000Z' }));

    const result = readUsageRecords({ startDate: '2026-02-21', endDate: '2026-02-21' });
    expect(result.total).toBe(1);
    expect(result.records[0].id).toBe('r2');
  });

  it('respects limit and offset', () => {
    for (let i = 0; i < 5; i++) {
      recordUsage(makeRecord({
        id: `r${i}`,
        timestamp: `2026-02-21T${String(10 + i).padStart(2, '0')}:00:00.000Z`,
      }));
    }

    const result = readUsageRecords({
      startDate: '2026-02-21',
      endDate: '2026-02-21',
      limit: 2,
      offset: 1,
    });
    expect(result.total).toBe(5);
    expect(result.records).toHaveLength(2);
    // Newest first: r4, r3, r2, r1, r0 → offset 1 gives r3, r2
    expect(result.records[0].id).toBe('r3');
    expect(result.records[1].id).toBe('r2');
  });

  it('filters by model', () => {
    recordUsage(makeRecord({ id: 'r1', model: 'claude-sonnet-4-5', timestamp: '2026-02-21T10:00:00.000Z' }));
    recordUsage(makeRecord({ id: 'r2', model: 'gpt-4o', timestamp: '2026-02-21T11:00:00.000Z' }));

    const result = readUsageRecords({
      startDate: '2026-02-21',
      endDate: '2026-02-21',
      model: 'gpt-4o',
    });
    expect(result.total).toBe(1);
    expect(result.records[0].model).toBe('gpt-4o');
  });

  it('skips malformed lines', () => {
    const filePath = join(TEST_DIR, '2026-02-21.jsonl');
    const validRecord = JSON.stringify(makeRecord({ timestamp: '2026-02-21T10:00:00.000Z' }));
    writeFileSync(filePath, `${validRecord}\n{invalid json\n${validRecord}\n`, 'utf-8');

    const result = readUsageRecords({ startDate: '2026-02-21', endDate: '2026-02-21' });
    expect(result.total).toBe(2);
  });
});

describe('aggregateUsage', () => {
  it('sums costs and tokens correctly', () => {
    recordUsage(makeRecord({
      timestamp: '2026-02-21T10:00:00.000Z',
      inputTokens: 1000,
      outputTokens: 500,
      inputCost: 0.003,
      outputCost: 0.0075,
      totalCost: 0.0105,
    }));
    recordUsage(makeRecord({
      timestamp: '2026-02-21T11:00:00.000Z',
      inputTokens: 2000,
      outputTokens: 1000,
      inputCost: 0.006,
      outputCost: 0.015,
      totalCost: 0.021,
    }));

    const agg = aggregateUsage('2026-02-21', '2026-02-21');
    expect(agg.totalCalls).toBe(2);
    expect(agg.totalInputTokens).toBe(3000);
    expect(agg.totalOutputTokens).toBe(1500);
    expect(agg.totalCost).toBeCloseTo(0.0315, 4);
  });

  it('groups by model', () => {
    recordUsage(makeRecord({
      model: 'claude-sonnet-4-5',
      timestamp: '2026-02-21T10:00:00.000Z',
      totalCost: 0.01,
    }));
    recordUsage(makeRecord({
      model: 'gpt-4o',
      timestamp: '2026-02-21T11:00:00.000Z',
      totalCost: 0.02,
    }));

    const agg = aggregateUsage('2026-02-21', '2026-02-21');
    expect(Object.keys(agg.byModel)).toHaveLength(2);
    expect(agg.byModel['claude-sonnet-4-5'].calls).toBe(1);
    expect(agg.byModel['gpt-4o'].calls).toBe(1);
  });
});

describe('getUsageSummary', () => {
  it('returns three period aggregations', () => {
    const summary = getUsageSummary();
    expect(summary).toHaveProperty('today');
    expect(summary).toHaveProperty('week');
    expect(summary).toHaveProperty('month');
    expect(summary.today.totalCalls).toBe(0);
    expect(summary.today.totalCost).toBe(0);
  });
});

describe('buildUsageRecord', () => {
  it('creates a complete record', () => {
    const record = buildUsageRecord({
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
      inputTokens: 100,
      outputTokens: 50,
      inputCost: 0.001,
      outputCost: 0.002,
      totalCost: 0.003,
      trigger: 'telegram',
    });

    expect(record.id).toBeTruthy();
    expect(record.timestamp).toBeTruthy();
    expect(record.totalTokens).toBe(150);
    expect(record.model).toBe('claude-sonnet-4-5');
  });
});
