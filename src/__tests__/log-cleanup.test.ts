import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { cleanupLogs } from '../log-cleanup.js';
import { clearSessionKeyCacheForTests, readSessionEntriesFromFile } from '../sessions.js';

let testHome: string | null = null;

afterEach(() => {
  delete process.env.SKIMPYCLAW_HISTORY_KEY;
  clearSessionKeyCacheForTests();
  if (testHome) {
    rmSync(testHome, { recursive: true, force: true });
    testHome = null;
  }
});

function makeHome(): string {
  testHome = mkdtempSync(join(tmpdir(), 'skimpyclaw-log-cleanup-'));
  return testHome;
}

function writeTestFile(path: string, content: string, mtime: Date): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  utimesSync(path, mtime, mtime);
}

describe('cleanupLogs', () => {
  it('prunes only known old log artifacts, scratch files, and memory logs', () => {
    const home = makeHome();
    const now = new Date('2026-02-15T12:00:00Z');
    const old = new Date('2026-01-01T00:00:00Z');
    const recent = new Date('2026-02-14T00:00:00Z');
    const root = join(home, '.skimpyclaw');

    writeTestFile(join(root, 'logs', 'audit', '2026-01-01.jsonl'), 'old audit\n', old);
    writeTestFile(join(root, 'logs', 'audit', '2026-02-14.jsonl'), 'new audit\n', recent);
    writeTestFile(join(root, 'logs', 'usage', '2026-01-01.jsonl'), 'old usage\n', old);
    writeTestFile(join(root, 'logs', 'cron', 'daily-2026-01-01.log'), 'old cron\n', old);
    writeTestFile(join(root, 'logs', 'code-agents', 'ca-1.json'), '{"status":"completed"}\n', old);
    writeTestFile(join(root, 'logs', 'code-agents', 'ca-2.json'), '{"status":"running"}\n', old);
    writeTestFile(join(root, 'logs', 'code-agents', 'ca-1.log'), 'old completed log\n', old);
    writeTestFile(join(root, 'logs', 'code-agents', 'ca-2.log'), 'old running log\n', old);
    writeTestFile(join(root, 'logs', 'stdout.log.1'), 'rotated stdout\n', old);
    writeTestFile(join(root, 'logs', 'custom', 'state.jsonl'), 'keep me\n', old);
    writeTestFile(join(root, 'logs', 'custom', 'app.log.1'), 'keep me too\n', old);
    writeTestFile(join(root, 'logs', 'code-agents', 'interactive-sessions.json'), '[]\n', old);
    writeTestFile(join(root, 'agents', 'main', 'memory', 'logs', '2026-01-01.md'), 'old memory\n', old);
    writeTestFile(join(root, 's', 'abc'), 'old scratch\n', old);

    writeTestFile(join(root, 'logs', 'digests', 'daily', '2026-01-01-daily-aaaaaaaa.json'), '{}\n', old);
    writeTestFile(join(root, 'logs', 'digests', 'daily', '2026-02-14-daily-bbbbbbbb.json'), '{}\n', recent);
    writeTestFile(join(root, 'logs', 'digests', 'index.json'), JSON.stringify({
      'daily-aaaaaaaa': { jobId: 'daily', date: '2026-01-01' },
      'daily-bbbbbbbb': { jobId: 'daily', date: '2026-02-14', title: 'keep metadata' },
    }), recent);

    const summary = cleanupLogs({
      homeDir: home,
      now,
      logRetentionDays: 30,
      scratchRetentionHours: 24,
    });

    expect(summary.errors).toEqual([]);
    expect(summary.deletedFiles).toBe(9);
    expect(existsSync(join(root, 'logs', 'audit', '2026-01-01.jsonl'))).toBe(false);
    expect(existsSync(join(root, 'logs', 'audit', '2026-02-14.jsonl'))).toBe(true);
    expect(existsSync(join(root, 'logs', 'code-agents', 'ca-1.json'))).toBe(false);
    expect(existsSync(join(root, 'logs', 'code-agents', 'ca-2.json'))).toBe(true);
    expect(existsSync(join(root, 'logs', 'code-agents', 'ca-1.log'))).toBe(false);
    expect(existsSync(join(root, 'logs', 'code-agents', 'ca-2.log'))).toBe(true);
    expect(existsSync(join(root, 'logs', 'code-agents', 'interactive-sessions.json'))).toBe(true);
    expect(existsSync(join(root, 'logs', 'custom', 'state.jsonl'))).toBe(true);
    expect(existsSync(join(root, 'logs', 'custom', 'app.log.1'))).toBe(true);
    expect(existsSync(join(root, 'logs', 'stdout.log.1'))).toBe(false);
    expect(existsSync(join(root, 'agents', 'main', 'memory', 'logs', '2026-01-01.md'))).toBe(false);
    expect(existsSync(join(root, 's', 'abc'))).toBe(false);
    expect(existsSync(join(root, 'logs', 'digests', 'daily', '2026-01-01-daily-aaaaaaaa.json'))).toBe(false);
    expect(existsSync(join(root, 'logs', 'digests', 'daily', '2026-02-14-daily-bbbbbbbb.json'))).toBe(true);

    const digestIndex = JSON.parse(readFileSync(join(root, 'logs', 'digests', 'index.json'), 'utf-8'));
    expect(digestIndex).toEqual({
      'daily-bbbbbbbb': { jobId: 'daily', date: '2026-02-14', title: 'keep metadata' },
    });
  });

  it('trims local message history and stale interactive coding sessions', () => {
    process.env.SKIMPYCLAW_HISTORY_KEY = '0'.repeat(64);
    clearSessionKeyCacheForTests();

    const home = makeHome();
    const now = new Date('2026-02-15T12:00:00Z');
    const old = new Date('2026-01-01T00:00:00Z');
    const recent = new Date('2026-02-14T00:00:00Z');
    const root = join(home, '.skimpyclaw');
    const sessionPath = join(root, 'sessions', 'discord-123.jsonl');
    const oldLegacySessionPath = join(root, 'sessions', 'telegram-legacy.json');

    writeTestFile(sessionPath, [
      JSON.stringify({ ts: old.toISOString(), user: 'old question', assistant: 'old answer' }),
      JSON.stringify({ ts: recent.toISOString(), user: 'recent question', assistant: 'recent answer' }),
    ].join('\n') + '\n', recent);
    writeTestFile(oldLegacySessionPath, '{"messages":[]}\n', old);
    writeTestFile(join(root, 'logs', 'code-agents', 'interactive-sessions.json'), JSON.stringify([
      {
        discordThreadId: 'old-thread',
        cliSessionId: 'old-cli',
        cliAgent: 'claude',
        status: 'active',
        createdAt: old.toISOString(),
        lastActivityAt: old.toISOString(),
        initialTask: 'old task',
      },
      {
        discordThreadId: 'recent-thread',
        cliSessionId: 'recent-cli',
        cliAgent: 'claude',
        status: 'active',
        createdAt: recent.toISOString(),
        lastActivityAt: recent.toISOString(),
        initialTask: 'recent task',
      },
    ], null, 2), recent);

    const summary = cleanupLogs({
      homeDir: home,
      now,
      logRetentionDays: 30,
    });

    expect(summary.errors).toEqual([]);
    expect(summary.trimmedEntries).toBe(2);
    expect(existsSync(sessionPath)).toBe(true);
    expect(existsSync(oldLegacySessionPath)).toBe(false);
    expect(readSessionEntriesFromFile(sessionPath)).toEqual([
      { ts: recent.toISOString(), user: 'recent question', assistant: 'recent answer' },
    ]);
    expect(JSON.parse(readFileSync(join(root, 'logs', 'code-agents', 'interactive-sessions.json'), 'utf-8'))).toEqual([
      {
        discordThreadId: 'recent-thread',
        cliSessionId: 'recent-cli',
        cliAgent: 'claude',
        status: 'active',
        createdAt: recent.toISOString(),
        lastActivityAt: recent.toISOString(),
        initialTask: 'recent task',
      },
    ]);
  });

  it('dry-run reports planned cleanup without mutating files', () => {
    const home = makeHome();
    const now = new Date('2026-02-15T12:00:00Z');
    const old = new Date('2026-01-01T00:00:00Z');
    const root = join(home, '.skimpyclaw');
    const oldAuditPath = join(root, 'logs', 'audit', '2026-01-01.jsonl');

    writeTestFile(oldAuditPath, 'old audit\n', old);

    const summary = cleanupLogs({
      homeDir: home,
      now,
      dryRun: true,
      logRetentionDays: 30,
    });

    expect(summary.dryRun).toBe(true);
    expect(summary.deletedFiles).toBe(1);
    expect(existsSync(oldAuditPath)).toBe(true);
  });
});
