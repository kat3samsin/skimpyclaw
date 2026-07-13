import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

const {
  runAgentTurnMock,
  getActiveChannelIdMock,
  sendActiveChannelProactiveMessageMock,
  sendToDiscordThreadMock,
  sendToDiscordThreadWithVoiceMock,
  parseAndSaveDigestMock,
  synthesizeSpeechMock,
  cronCallbacks,
  configWatchCallbacks,
  loadConfigMock,
  watchCloseMock,
  spawnMock,
  testHome,
} = vi.hoisted(() => ({
  runAgentTurnMock: vi.fn(),
  getActiveChannelIdMock: vi.fn(() => 'telegram'),
  sendActiveChannelProactiveMessageMock: vi.fn(async () => true),
  sendToDiscordThreadMock: vi.fn(async () => false),
  sendToDiscordThreadWithVoiceMock: vi.fn(async () => false),
  parseAndSaveDigestMock: vi.fn(),
  synthesizeSpeechMock: vi.fn(),
  cronCallbacks: [] as Array<() => Promise<void>>,
  configWatchCallbacks: [] as Array<() => void>,
  loadConfigMock: vi.fn(),
  watchCloseMock: vi.fn(),
  spawnMock: vi.fn(),
  testHome: (() => {
    const { mkdtempSync } = require('fs');
    const { tmpdir } = require('os');
    const { join } = require('path');
    const dir = mkdtempSync(join(tmpdir(), 'skimpy-cron-home-'));
    process.env.SKIMPYCLAW_OBSIDIAN_VAULT_ROOT = join(dir, 'vault');
    return dir;
  })(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    watch: vi.fn((_path: string, listener: () => void) => {
      configWatchCallbacks.push(listener);
      return { close: watchCloseMock };
    }),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: spawnMock };
});

vi.mock('croner', () => ({
  Cron: class {
    constructor(_expr: string, _options: unknown, callback: () => Promise<void>) {
      cronCallbacks.push(callback);
    }

    stop(): void {}

    nextRun(): undefined {
      return undefined;
    }
  },
}));

vi.mock('../agent.js', () => ({
  runAgentTurn: runAgentTurnMock,
}));

vi.mock('../channels.js', () => ({
  sendActiveChannelProactiveMessage: sendActiveChannelProactiveMessageMock,
  sendActiveChannelProactiveVoice: vi.fn(async () => false),
  getActiveChannelId: getActiveChannelIdMock,
}));

vi.mock('../digests.js', () => ({
  parseAndSaveDigest: parseAndSaveDigestMock,
}));

vi.mock('../channels/discord/index.js', () => ({
  sendToDiscordThread: sendToDiscordThreadMock,
  sendToDiscordThreadWithVoice: sendToDiscordThreadWithVoiceMock,
}));

vi.mock('../config.js', () => ({
  getLogsDir: () => '/tmp',
  getConfigPath: () => '/tmp/config.json',
  loadConfig: loadConfigMock,
  resolveAllowedPaths: () => ['/tmp'],
}));

vi.mock('../audit.js', () => ({
  startTrace: vi.fn(() => 'trace-1'),
  addEvent: vi.fn(),
  endTrace: vi.fn(),
}));

vi.mock('../voice.js', () => ({
  synthesizeSpeech: synthesizeSpeechMock,
}));

vi.mock('../env-sanitizer.js', () => ({
  sanitizeCronEnv: () => ({}),
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => testHome };
});

import { getCronJobDetails, getCronJobs, initCron, runCronJob, stopCron, triggerCronJob } from '../cron.js';

function localDate(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function writeObsidianDailyOutputs(): string[] {
  const now = new Date();
  const filename = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${now.getFullYear()}.md`;
  const vault = process.env.SKIMPYCLAW_OBSIDIAN_VAULT_ROOT!;
  const paths = [
    join(vault, '2. Areas', 'Daily Notes', filename),
    join(vault, '2. Areas', 'Daily Digests', filename),
  ];
  const created: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, '# test\n', 'utf-8');
      created.push(path);
    }
  }
  return created;
}

const TEST_DISCORD_THREAD_ID = '123456789'.repeat(2);

describe('runCronJob digest chat output', () => {
  const config = {
    agents: { default: 'default', list: { default: { model: 'claude-sonnet' } } },
    channels: { active: 'telegram', telegram: { enabled: true, allowFrom: ['1'] }, discord: { enabled: false, allowFrom: [] } },
    cron: {
      jobs: [
        {
          id: 'tech-digest',
          name: 'Tech Digest',
          schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC' },
          payload: { kind: 'agentTurn', message: 'digest please' },
        },
      ],
    },
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    getActiveChannelIdMock.mockReturnValue('telegram');
    cronCallbacks.length = 0;
    configWatchCallbacks.length = 0;
    spawnMock.mockReset();
  });

  afterEach(() => {
    stopCron();
    vi.useRealTimers();
  });

  afterAll(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it('sends digest summary to chat when digest includes articles', async () => {
    const digestText = '1. Story https://example.com/story';
    runAgentTurnMock.mockResolvedValue(digestText);
    parseAndSaveDigestMock.mockReturnValue({ summary: digestText, articles: [{ id: 'a1' }] });

    await runCronJob('tech-digest', config);

    expect(parseAndSaveDigestMock).toHaveBeenCalledWith('tech-digest', 'Tech Digest', digestText);
    expect(sendActiveChannelProactiveMessageMock).toHaveBeenCalledWith(config, digestText);
  });

  it('does not send digest summary to chat when digest has no articles', async () => {
    const digestText = 'No links today';
    runAgentTurnMock.mockResolvedValue(digestText);
    parseAndSaveDigestMock.mockReturnValue({ summary: digestText, articles: [] });

    await runCronJob('tech-digest', config);

    expect(sendActiveChannelProactiveMessageMock).not.toHaveBeenCalledWith(config, digestText);
  });

  it('does not load a prompt through a symlink outside the prompts directory', async () => {
    const promptsRoot = join(testHome, '.skimpyclaw', 'prompts');
    const outsideRoot = join(testHome, 'outside-prompts');
    mkdirSync(promptsRoot, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });
    writeFileSync(join(outsideRoot, 'secret.md'), 'outside prompt', 'utf-8');
    symlinkSync(outsideRoot, join(promptsRoot, 'outside-link'), 'dir');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runAgentTurnMock.mockResolvedValue('No links today');
    parseAndSaveDigestMock.mockReturnValue({ summary: 'No links today', articles: [] });
    const promptConfig = {
      ...config,
      cron: {
        jobs: [{
          ...config.cron.jobs[0],
          payload: { kind: 'agentTurn', message: 'outside-link/secret.md' },
        }],
      },
    } as any;

    await runCronJob('tech-digest', promptConfig);

    expect(runAgentTurnMock.mock.calls[0][1]).toBe('outside-link/secret.md');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Rejected prompt path'));
    warnSpy.mockRestore();
  });

  it('resolves a manual cron run by normalized display name', async () => {
    const digestText = '1. Story https://example.com/story';
    const aliasConfig = {
      ...config,
      cron: {
        jobs: [
          {
            ...config.cron.jobs[0],
            name: 'Tech News',
          },
        ],
      },
    } as any;
    runAgentTurnMock.mockResolvedValue(digestText);
    parseAndSaveDigestMock.mockReturnValue({ summary: digestText, articles: [{ id: 'a1' }] });

    await runCronJob('tech-news', aliasConfig);

    expect(parseAndSaveDigestMock).toHaveBeenCalledWith('tech-digest', 'Tech News', digestText);
  });

  it('triggers a manual cron run without waiting for completion', async () => {
    let releaseRun = () => {};
    const aliasConfig = {
      ...config,
      cron: {
        jobs: [
          {
            ...config.cron.jobs[0],
            name: 'Tech News',
          },
        ],
      },
    } as any;
    runAgentTurnMock.mockImplementation(() => new Promise<string>(resolve => {
      releaseRun = () => resolve('1. Story https://example.com/story');
    }));
    parseAndSaveDigestMock.mockReturnValue({ summary: '1. Story https://example.com/story', articles: [{ id: 'a1' }] });

    const job = triggerCronJob('tech-news', aliasConfig);

    expect(job).toEqual({ id: 'tech-digest', name: 'Tech News' });
    await vi.waitFor(() => {
      expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
    });

    releaseRun();
    await vi.waitFor(() => {
      expect(parseAndSaveDigestMock).toHaveBeenCalledWith('tech-digest', 'Tech News', '1. Story https://example.com/story');
    });
  });

  it('skips overlapping execution for the same job id', async () => {
    let releaseFirstRun = () => {};
    runAgentTurnMock.mockImplementation(() => new Promise<string>(resolve => {
      releaseFirstRun = () => resolve('1. Story https://example.com/story');
    }));
    parseAndSaveDigestMock.mockReturnValue({ summary: '1. Story https://example.com/story', articles: [{ id: 'a1' }] });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const firstRun = runCronJob('tech-digest', config);
    await Promise.resolve();
    await runCronJob('tech-digest', config);

    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping overlapping run for job "tech-digest"'));

    releaseFirstRun();
    await firstRun;
    warnSpy.mockRestore();
  });

  it('contains scheduled cron errors after writing the failed job log', async () => {
    runAgentTurnMock.mockRejectedValue(new Error('boom'));
    parseAndSaveDigestMock.mockReturnValue({ summary: '', articles: [] });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    initCron(config);

    expect(cronCallbacks).toHaveLength(1);
    await expect(cronCallbacks[0]()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Scheduled job "tech-digest" failed: boom'),
    );

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('schedules interval jobs and reports their next run safely', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-22T00:00:00.000Z'));

    const intervalConfig = {
      ...config,
      cron: {
        jobs: [
          {
            id: 'interval-digest',
            name: 'Interval Digest',
            schedule: { kind: 'interval', ms: 5000 },
            payload: { kind: 'agentTurn', message: 'digest please' },
          },
        ],
      },
    } as any;
    runAgentTurnMock.mockResolvedValue('No links today');
    parseAndSaveDigestMock.mockReturnValue({ summary: 'No links today', articles: [] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    initCron(intervalConfig);

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Unsupported schedule kind: interval'));
    expect(getCronJobs()).toEqual([
      {
        id: 'interval-digest',
        name: 'Interval Digest',
        nextRun: new Date('2026-06-22T00:00:05.000Z'),
      },
    ]);
    expect(getCronJobDetails(intervalConfig)[0].schedule).toEqual({
      kind: 'interval',
      expr: undefined,
      ms: 5000,
      tz: undefined,
    });

    await vi.advanceTimersByTimeAsync(5000);

    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
    expect(getCronJobs()[0].nextRun).toEqual(new Date('2026-06-22T00:00:10.000Z'));

    warnSpy.mockRestore();
  });

  it('rejects duplicate job ids before scheduling any intervals', () => {
    vi.useFakeTimers();
    const duplicateConfig = {
      ...config,
      cron: {
        jobs: [
          {
            id: 'duplicate',
            name: 'First',
            schedule: { kind: 'interval', ms: 1000 },
            payload: { kind: 'agentTurn', message: 'first' },
          },
          {
            id: 'duplicate',
            name: 'Second',
            schedule: { kind: 'interval', ms: 2000 },
            payload: { kind: 'agentTurn', message: 'second' },
          },
        ],
      },
    } as any;

    expect(() => initCron(duplicateConfig)).toThrow('Duplicate cron job id: "duplicate"');
    expect(getCronJobs()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the current schedule when replacement config has duplicate ids', async () => {
    vi.useFakeTimers();
    const currentConfig = {
      ...config,
      cron: {
        jobs: [{
          id: 'current',
          name: 'Current',
          schedule: { kind: 'interval', ms: 1000 },
          payload: { kind: 'agentTurn', message: 'current' },
        }],
      },
    } as any;
    const duplicateConfig = {
      ...config,
      cron: {
        jobs: [
          { ...currentConfig.cron.jobs[0], id: 'duplicate' },
          { ...currentConfig.cron.jobs[0], id: 'duplicate' },
        ],
      },
    } as any;
    runAgentTurnMock.mockResolvedValue('No links today');
    parseAndSaveDigestMock.mockReturnValue({ summary: 'No links today', articles: [] });

    initCron(currentConfig);
    expect(() => initCron(duplicateConfig)).toThrow('Duplicate cron job id: "duplicate"');
    expect(getCronJobs()).toEqual([
      { id: 'current', name: 'Current', nextRun: new Date(Date.now() + 1000) },
    ]);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
  });

  it('cancels a queued config reload when cron stops', async () => {
    vi.useFakeTimers();
    initCron(config);

    expect(configWatchCallbacks).toHaveLength(1);
    configWatchCallbacks[0]();
    stopCron();
    await vi.advanceTimersByTimeAsync(1000);

    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(getCronJobs()).toEqual([]);
  });

  it('cancels an older queued reload when cron is reinitialized', async () => {
    vi.useFakeTimers();
    loadConfigMock.mockReturnValue(config);
    initCron(config);
    expect(configWatchCallbacks).toHaveLength(1);
    configWatchCallbacks[0]();

    const currentConfig = {
      ...config,
      cron: {
        jobs: [{
          id: 'current',
          name: 'Current',
          schedule: { kind: 'interval', ms: 5000 },
          payload: { kind: 'agentTurn', message: 'current' },
        }],
      },
    } as any;
    initCron(currentConfig);
    await vi.advanceTimersByTimeAsync(1000);

    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(getCronJobs().map(job => job.id)).toEqual(['current']);
  });

  it('caps overflowing script output and drains the process group before rejecting', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as any;
    child.pid = 4321;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    spawnMock.mockReturnValue(child);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGTERM') {
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
      }
      return true;
    });
    const scriptConfig = {
      ...config,
      cron: {
        jobs: [{
          id: 'overflow',
          name: 'Overflow',
          schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC' },
          payload: { kind: 'script', script: 'produce-output', timeoutMs: 60_000 },
        }],
      },
    } as any;

    try {
      const run = runCronJob('overflow', scriptConfig);
      let settled = false;
      void run.then(() => { settled = true; }, () => { settled = true; });
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

      child.stdout.emit('data', Buffer.alloc(10 * 1024 * 1024 + 1, 97));
      child.stdout.emit('data', Buffer.from('ignored after overflow'));
      await vi.advanceTimersByTimeAsync(999);

      expect(settled).toBe(false);
      expect(killSpy.mock.calls.filter(([, signal]) => signal === 'SIGTERM')).toHaveLength(1);
      expect(killSpy.mock.calls.some(([, signal]) => signal === 'SIGKILL')).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(run).rejects.toThrow('Script output exceeded maxBuffer of 10485760 bytes');
      expect(killSpy.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(1);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('drains a timed-out script process group before rejecting', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as any;
    child.pid = 4321;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    spawnMock.mockReturnValue(child);

    let processGroupAlive = true;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGTERM') {
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
      } else if (signal === 'SIGKILL') {
        processGroupAlive = false;
      } else if (signal === 0 && !processGroupAlive) {
        const error = new Error('No such process') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      }
      return true;
    });
    const scriptConfig = {
      ...config,
      cron: {
        jobs: [{
          id: 'timeout',
          name: 'Timeout',
          schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC' },
          payload: { kind: 'script', script: 'hang', timeoutMs: 100 },
        }],
      },
    } as any;

    try {
      const run = runCronJob('timeout', scriptConfig);
      const outcome = run.then(
        () => ({ status: 'resolved' as const, message: '' }),
        (error: Error) => ({ status: 'rejected' as const, message: error.message }),
      );
      let settled = false;
      void outcome.then(() => { settled = true; });
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(100);

      expect(settled).toBe(false);
      expect(killSpy.mock.calls.filter(([, signal]) => signal === 'SIGTERM')).toHaveLength(1);
      expect(killSpy.mock.calls.some(([, signal]) => signal === 'SIGKILL')).toBe(false);

      await vi.advanceTimersByTimeAsync(5000);

      await expect(outcome).resolves.toEqual({
        status: 'rejected',
        message: 'Script timed out after 100ms',
      });
      expect(killSpy.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(1);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('thread id set + successful send does not use active-channel send', async () => {
    const digestText = 'No links today';
    runAgentTurnMock.mockResolvedValue(digestText);
    parseAndSaveDigestMock.mockReturnValue({ summary: digestText, articles: [] });
    sendToDiscordThreadMock.mockResolvedValue(true);

    const threadConfig = {
      ...config,
      cron: {
        jobs: [
          {
            id: 'tech-digest',
            name: 'Tech Digest',
            schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC' },
            payload: {
              kind: 'agentTurn',
              message: 'digest please',
              discordThreadId: TEST_DISCORD_THREAD_ID,
            },
          },
        ],
      },
    } as any;

    await runCronJob('tech-digest', threadConfig);

    expect(sendToDiscordThreadMock).toHaveBeenCalled();
    expect(sendActiveChannelProactiveMessageMock).not.toHaveBeenCalled();
  });

  it('runs Discord-thread-targeted cron turns with Discord context for delegation', async () => {
    const digestText = 'No links today';
    runAgentTurnMock.mockResolvedValue(digestText);
    parseAndSaveDigestMock.mockReturnValue({ summary: digestText, articles: [] });

    const threadConfig = {
      ...config,
      cron: {
        jobs: [
          {
            id: 'tech-digest',
            name: 'Tech Digest',
            schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC' },
            payload: {
              kind: 'agentTurn',
              message: 'digest please',
              discordThreadId: TEST_DISCORD_THREAD_ID,
            },
          },
        ],
      },
    } as any;

    await runCronJob('tech-digest', threadConfig);

    const context = runAgentTurnMock.mock.calls[0][6];
    expect(context).toMatchObject({
      channel: 'discord',
      trigger: 'cron',
      sessionId: 'tech-digest',
      metadata: {
        jobName: 'Tech Digest',
        isCronJob: true,
        discordThreadId: TEST_DISCORD_THREAD_ID,
        isDm: false,
      },
    });
  });

  it('uses a cron job agent override when configured', async () => {
    const digestText = 'No links today';
    runAgentTurnMock.mockResolvedValue(digestText);
    parseAndSaveDigestMock.mockReturnValue({ summary: digestText, articles: [] });

    const mayoraConfig = {
      ...config,
      agents: {
        default: 'default',
        list: {
          default: { model: 'claude-sonnet' },
          mayora: { model: 'codex', identity: { name: 'Mayora', emoji: 'M' } },
        },
      },
      cron: {
        jobs: [
          {
            id: 'tech-digest',
            name: 'Tech Digest',
            agent: 'mayora',
            schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC' },
            payload: { kind: 'agentTurn', message: 'digest please' },
          },
        ],
      },
    } as any;

    await runCronJob('tech-digest', mayoraConfig);

    expect(runAgentTurnMock.mock.calls[0][0]).toBe('mayora');
  });

  it('fails visibly when a cron job references an unknown agent', async () => {
    const badConfig = {
      ...config,
      agents: {
        default: 'default',
        list: {
          default: { model: 'claude-sonnet' },
        },
      },
      cron: {
        jobs: [
          {
            id: 'tech-digest',
            name: 'Tech Digest',
            agent: 'missing-agent',
            schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC' },
            payload: { kind: 'agentTurn', message: 'digest please' },
          },
        ],
      },
    } as any;

    await expect(runCronJob('tech-digest', badConfig)).rejects.toThrow(
      'Cron job "tech-digest" references unknown agent "missing-agent"',
    );
  });

  it('fails visibly when no cron agent can be resolved', async () => {
    const badConfig = {
      ...config,
      agents: undefined,
      cron: {
        jobs: [
          {
            id: 'tech-digest',
            name: 'Tech Digest',
            schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC' },
            payload: { kind: 'agentTurn', message: 'digest please' },
          },
        ],
      },
    } as any;

    await expect(runCronJob('tech-digest', badConfig)).rejects.toThrow(
      'Cron job "tech-digest" needs an agent but no default agent is configured',
    );
  });

  it('thread id set + failed send does not fall back to active channel', async () => {
    const digestText = 'No links today';
    runAgentTurnMock.mockResolvedValue(digestText);
    parseAndSaveDigestMock.mockReturnValue({ summary: digestText, articles: [] });
    sendToDiscordThreadMock.mockResolvedValue(false);

    const threadConfig = {
      ...config,
      cron: {
        jobs: [
          {
            id: 'tech-digest',
            name: 'Tech Digest',
            schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC' },
            payload: {
              kind: 'agentTurn',
              message: 'digest please',
              discordThreadId: TEST_DISCORD_THREAD_ID,
            },
          },
        ],
      },
    } as any;

    await runCronJob('tech-digest', threadConfig);

    expect(sendToDiscordThreadMock).toHaveBeenCalled();
    expect(sendActiveChannelProactiveMessageMock).not.toHaveBeenCalled();
  });

  it('fails closed when discordThreadId is invalid', async () => {
    const digestText = 'No links today';
    runAgentTurnMock.mockResolvedValue(digestText);
    parseAndSaveDigestMock.mockReturnValue({ summary: digestText, articles: [] });

    const threadConfig = {
      ...config,
      cron: {
        jobs: [
          {
            id: 'tech-digest',
            name: 'Tech Digest',
            schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC' },
            payload: {
              kind: 'agentTurn',
              message: 'digest please',
              discordThreadId: 'not-a-thread-id',
            },
          },
        ],
      },
    } as any;

    await runCronJob('tech-digest', threadConfig);

    expect(sendToDiscordThreadMock).not.toHaveBeenCalled();
    expect(sendActiveChannelProactiveMessageMock).not.toHaveBeenCalled();
  });

  it('does not send a Discord cron notification without an explicit target', async () => {
    const digestText = 'No links today';
    getActiveChannelIdMock.mockReturnValue('discord');
    runAgentTurnMock.mockResolvedValue(digestText);
    parseAndSaveDigestMock.mockReturnValue({ summary: digestText, articles: [] });

    await runCronJob('tech-digest', config);

    expect(sendToDiscordThreadMock).not.toHaveBeenCalled();
    expect(sendActiveChannelProactiveMessageMock).not.toHaveBeenCalled();
  });

  it('routes an untargeted Discord cron to defaultChannelId without DM fallback', async () => {
    const digestText = 'No links today';
    const defaultChannelId = '987654321098765432';
    getActiveChannelIdMock.mockReturnValue('discord');
    runAgentTurnMock.mockResolvedValue(digestText);
    parseAndSaveDigestMock.mockReturnValue({ summary: digestText, articles: [] });
    sendToDiscordThreadMock.mockResolvedValue(false);
    const defaultChannelConfig = {
      ...config,
      channels: {
        ...config.channels,
        active: 'discord',
        discord: {
          enabled: true,
          allowFrom: ['123456789012345678'],
          defaultChannelId,
        },
      },
    } as any;

    await runCronJob('tech-digest', defaultChannelConfig);

    expect(sendToDiscordThreadMock).toHaveBeenCalledWith(
      defaultChannelId,
      expect.stringContaining('Cron: Tech Digest'),
    );
    expect(sendActiveChannelProactiveMessageMock).not.toHaveBeenCalled();
  });

  it('fails closed when the Discord defaultChannelId is invalid', async () => {
    const digestText = 'No links today';
    getActiveChannelIdMock.mockReturnValue('discord');
    runAgentTurnMock.mockResolvedValue(digestText);
    parseAndSaveDigestMock.mockReturnValue({ summary: digestText, articles: [] });
    const invalidDefaultConfig = {
      ...config,
      channels: {
        ...config.channels,
        active: 'discord',
        discord: {
          enabled: true,
          allowFrom: ['123456789012345678'],
          defaultChannelId: 'not-a-channel-id',
        },
      },
    } as any;

    await runCronJob('tech-digest', invalidDefaultConfig);

    expect(sendToDiscordThreadMock).not.toHaveBeenCalled();
    expect(sendActiveChannelProactiveMessageMock).not.toHaveBeenCalled();
  });

  it('no thread id uses active-channel send', async () => {
    const digestText = 'No links today';
    runAgentTurnMock.mockResolvedValue(digestText);
    parseAndSaveDigestMock.mockReturnValue({ summary: digestText, articles: [] });

    await runCronJob('tech-digest', config);

    expect(sendToDiscordThreadMock).not.toHaveBeenCalled();
    expect(sendActiveChannelProactiveMessageMock).toHaveBeenCalledWith(
      config,
      expect.stringContaining('Cron: Tech Digest'),
    );
  });

  it('sends voice attachment to Discord thread when sendAsVoice is enabled', async () => {
    const digestText = 'No links today';
    runAgentTurnMock.mockResolvedValue(digestText);
    parseAndSaveDigestMock.mockReturnValue({ summary: digestText, articles: [] });
    sendToDiscordThreadMock.mockResolvedValue(true); // Start notification succeeds
    sendToDiscordThreadWithVoiceMock.mockResolvedValue(true); // Final notification with voice succeeds
    synthesizeSpeechMock.mockResolvedValue({
      buffer: new Uint8Array([1, 2, 3]),
      format: 'mp3',
      provider: 'test-provider',
    });

    const voiceConfig = {
      ...config,
      voice: {
        provider: 'test-provider',
        apiKey: 'test-key',
      },
      cron: {
        jobs: [
          {
            id: 'tech-digest',
            name: 'Tech Digest',
            schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC' },
            payload: {
              kind: 'agentTurn',
              message: 'digest please',
              sendAsVoice: true,
              discordThreadId: TEST_DISCORD_THREAD_ID,
            },
          },
        ],
      },
    } as any;

    await runCronJob('tech-digest', voiceConfig);

    expect(synthesizeSpeechMock).toHaveBeenCalledWith(digestText, voiceConfig.voice);
    expect(sendToDiscordThreadWithVoiceMock).toHaveBeenCalledWith(
      TEST_DISCORD_THREAD_ID,
      expect.stringContaining('Cron: Tech Digest'),
      new Uint8Array([1, 2, 3]),
      'mp3',
    );
    // Start notification goes to Discord thread, final notification goes to Discord thread with voice
    expect(sendActiveChannelProactiveMessageMock).not.toHaveBeenCalled();
  });

  it('saves a voice artifact link and injects it into Mayora HTML', async () => {
    const date = localDate();
    const htmlDir = join(testHome, '.skimpyclaw', 'reports', 'mayora-daily-briefing');
    const htmlPath = join(htmlDir, `${date}.html`);
    mkdirSync(htmlDir, { recursive: true });
    writeFileSync(htmlPath, '<!doctype html><header></header><main>Brief</main>', 'utf-8');

    const text = `[Mayora Daily Briefing HTML](${htmlPath})\nFull detail`;
    runAgentTurnMock.mockResolvedValue(`---VOICE---\nShort voice\n---TEXT---\n${text}`);
    parseAndSaveDigestMock.mockReturnValue({ summary: text, articles: [] });
    sendToDiscordThreadMock.mockResolvedValue(true);
    sendToDiscordThreadWithVoiceMock.mockResolvedValue(true);
    synthesizeSpeechMock.mockResolvedValue({
      buffer: new Uint8Array([1, 2, 3]),
      format: 'mp3',
      provider: 'test-provider',
    });

    const voiceConfig = {
      ...config,
      gateway: { port: 18790, host: '127.0.0.1', mode: 'local' },
      voice: {
        provider: 'test-provider',
        apiKey: 'test-key',
      },
      cron: {
        jobs: [
          {
            id: 'morning',
            name: 'Morning Routine',
            agent: 'mayora',
            schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC' },
            payload: {
              kind: 'agentTurn',
              message: 'digest please',
              sendAsVoice: true,
              discordThreadId: TEST_DISCORD_THREAD_ID,
            },
          },
        ],
      },
      agents: {
        default: 'default',
        list: {
          default: { model: 'claude-sonnet' },
          mayora: { model: 'codex', identity: { name: 'Mayora', emoji: 'M' } },
        },
      },
    } as any;

    const created = writeObsidianDailyOutputs();
    try {
      await runCronJob('morning', voiceConfig);

      const voicePath = join(testHome, '.skimpyclaw', 'reports', 'voice', 'morning', `${date}.mp3`);
      expect(existsSync(voicePath)).toBe(true);
      const finalCall = sendToDiscordThreadWithVoiceMock.mock.calls.at(-1) as unknown as [string, string, Uint8Array, string];
      const finalMessage = finalCall[1];
      expect(finalMessage).toMatch(/Voice file: http:\/\/127\.0\.0\.1:18790\/artifacts\/[^/]+\/\d{4}-\d{2}-\d{2}\.mp3/);
      const updatedHtml = readFileSync(htmlPath, 'utf-8');
      expect(updatedHtml).toMatch(/<audio controls preload="metadata" src="http:\/\/127\.0\.0\.1:18790\/artifacts\/[^/]+\/\d{4}-\d{2}-\d{2}\.mp3"><\/audio>/);
      expect(updatedHtml).toMatch(/<a class="voice-open-link" href="http:\/\/127\.0\.0\.1:18790\/artifacts\/[^/]+\/\d{4}-\d{2}-\d{2}\.mp3">Open voice file<\/a>/);
    } finally {
      for (const path of created) rmSync(path, { force: true });
    }
  });

  it('creates a fallback Mayora HTML artifact when the agent links a missing file', async () => {
    const date = localDate();
    const htmlDir = join(testHome, '.skimpyclaw', 'reports', 'mayora-daily-briefing');
    const htmlPath = join(htmlDir, `${date}.html`);
    rmSync(htmlPath, { force: true });

    const text = [
      `[Mayora Daily Briefing HTML](${htmlPath})`,
      '',
      '## Recommended task now',
      '',
      '**Fix Reader Chat theme style leakage.**',
      '',
      'Context:',
      '1. First ordered item',
      '2. Second ordered item',
      'Links:',
      '- One link',
      '- Another link',
      '3. Third ordered item',
      'Suggested reply:',
      '> Quote me',
    ].join('\n');
    runAgentTurnMock.mockResolvedValue(`---VOICE---\nShort voice\n---TEXT---\n${text}`);
    parseAndSaveDigestMock.mockReturnValue({ summary: text, articles: [] });
    sendToDiscordThreadMock.mockResolvedValue(true);
    sendToDiscordThreadWithVoiceMock.mockResolvedValue(true);
    synthesizeSpeechMock.mockResolvedValue({
      buffer: new Uint8Array([1, 2, 3]),
      format: 'mp3',
      provider: 'test-provider',
    });

    const voiceConfig = {
      ...config,
      gateway: { port: 18790, host: '127.0.0.1', mode: 'local' },
      voice: {
        provider: 'test-provider',
        apiKey: 'test-key',
      },
      cron: {
        jobs: [
          {
            id: 'morning',
            name: 'Morning Routine',
            agent: 'mayora',
            schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC' },
            payload: {
              kind: 'agentTurn',
              message: 'digest please',
              sendAsVoice: true,
              discordThreadId: TEST_DISCORD_THREAD_ID,
            },
          },
        ],
      },
      agents: {
        default: 'default',
        list: {
          default: { model: 'claude-sonnet' },
          mayora: { model: 'codex', identity: { name: 'Mayora', emoji: 'M' } },
        },
      },
    } as any;

    const created = writeObsidianDailyOutputs();
    try {
      await runCronJob('morning', voiceConfig);

      const html = readFileSync(htmlPath, 'utf-8');
      expect(html).toContain('Fix Reader Chat theme style leakage.');
      expect(html).toContain('<p>Context:</p>');
      expect(html).toContain('<ol><li>First ordered item</li><li>Second ordered item</li></ol>');
      expect(html).toContain('<ul><li>One link</li><li>Another link</li></ul>');
      expect(html).toContain('<ol start="3"><li>Third ordered item</li></ol>');
      expect(html).toContain('<blockquote>Quote me</blockquote>');
      expect(html).toContain('Artifact status');
      expect(html).toMatch(/<audio controls preload="metadata" src="http:\/\/127\.0\.0\.1:18790\/artifacts\/[^/]+\/\d{4}-\d{2}-\d{2}\.mp3"><\/audio>/);
      expect(html).toMatch(/<a class="voice-open-link" href="http:\/\/127\.0\.0\.1:18790\/artifacts\/[^/]+\/\d{4}-\d{2}-\d{2}\.mp3">Open voice file<\/a>/);

      const finalCall = sendToDiscordThreadWithVoiceMock.mock.calls.at(-1) as unknown as [string, string, Uint8Array, string];
      expect(finalCall[1]).toContain(`http://127.0.0.1:18790/reports/mayora-daily-briefing/${date}.html`);
    } finally {
      for (const path of created) rmSync(path, { force: true });
    }
  });


  it('creates fallback Obsidian daily outputs when the morning routine does not write them', async () => {
    const text = 'Morning briefing without vault writes';
    runAgentTurnMock.mockResolvedValue(text);
    parseAndSaveDigestMock.mockReturnValue({ summary: text, articles: [] });
    const now = new Date();
    const filename = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${now.getFullYear()}.md`;
    const vault = process.env.SKIMPYCLAW_OBSIDIAN_VAULT_ROOT!;
    const notePath = join(vault, '2. Areas', 'Daily Notes', filename);
    const digestPath = join(vault, '2. Areas', 'Daily Digests', filename);
    rmSync(notePath, { force: true });
    rmSync(digestPath, { force: true });

    const morningConfig = {
      ...config,
      cron: {
        jobs: [
          {
            id: 'morning',
            name: 'Morning Routine',
            agent: 'mayora',
            schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC' },
            payload: { kind: 'agentTurn', message: 'morning please' },
          },
        ],
      },
      agents: {
        default: 'default',
        list: {
          default: { model: 'claude-sonnet' },
          mayora: { model: 'codex', identity: { name: 'Mayora', emoji: 'M' } },
        },
      },
    } as any;

    try {
      await expect(runCronJob('morning', morningConfig)).resolves.toBeUndefined();
      expect(readFileSync(notePath, 'utf-8')).toContain('Morning Routine fallback');
      expect(readFileSync(digestPath, 'utf-8')).toContain(text);
    } finally {
      rmSync(notePath, { force: true });
      rmSync(digestPath, { force: true });
    }
  });

  it('passes the morning routine when Obsidian daily outputs exist', async () => {
    const now = new Date();
    const filename = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${now.getFullYear()}.md`;
    const vault = process.env.SKIMPYCLAW_OBSIDIAN_VAULT_ROOT!;
    const notePath = join(vault, '2. Areas', 'Daily Notes', filename);
    const digestPath = join(vault, '2. Areas', 'Daily Digests', filename);
    const created: string[] = [];
    for (const path of [notePath, digestPath]) {
      if (!existsSync(path)) {
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, '# test\n', 'utf-8');
        created.push(path);
      }
    }

    try {
      const text = 'Morning briefing with vault writes';
      runAgentTurnMock.mockResolvedValue(text);
      parseAndSaveDigestMock.mockReturnValue({ summary: text, articles: [] });

      const morningConfig = {
        ...config,
        cron: {
          jobs: [
            {
              id: 'morning',
              name: 'Morning Routine',
              agent: 'mayora',
              schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC' },
              payload: { kind: 'agentTurn', message: 'morning please' },
            },
          ],
        },
        agents: {
          default: 'default',
          list: {
            default: { model: 'claude-sonnet' },
            mayora: { model: 'codex', identity: { name: 'Mayora', emoji: 'M' } },
          },
        },
      } as any;

      await expect(runCronJob('morning', morningConfig)).resolves.toBeUndefined();
    } finally {
      for (const path of created) rmSync(path, { force: true });
    }
  });

  it('sends voice to active channel when Discord thread is not configured', async () => {
    const digestText = 'No links today';
    runAgentTurnMock.mockResolvedValue(digestText);
    parseAndSaveDigestMock.mockReturnValue({ summary: digestText, articles: [] });
    synthesizeSpeechMock.mockResolvedValue({
      buffer: new Uint8Array([1, 2, 3]),
      format: 'mp3',
      provider: 'test-provider',
    });

    const voiceConfig = {
      ...config,
      voice: {
        provider: 'test-provider',
        apiKey: 'test-key',
      },
      cron: {
        jobs: [
          {
            id: 'tech-digest',
            name: 'Tech Digest',
            schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC' },
            payload: {
              kind: 'agentTurn',
              message: 'digest please',
              sendAsVoice: true,
            },
          },
        ],
      },
    } as any;

    await runCronJob('tech-digest', voiceConfig);

    expect(synthesizeSpeechMock).toHaveBeenCalledWith(digestText, voiceConfig.voice);
    expect(sendActiveChannelProactiveMessageMock).toHaveBeenCalled();
  });
});
