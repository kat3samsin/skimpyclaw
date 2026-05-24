import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const {
  runAgentTurnMock,
  sendActiveChannelProactiveMessageMock,
  sendToDiscordThreadMock,
  sendToDiscordThreadWithVoiceMock,
  parseAndSaveDigestMock,
  synthesizeSpeechMock,
  cronCallbacks,
  testHome,
} = vi.hoisted(() => ({
  runAgentTurnMock: vi.fn(),
  sendActiveChannelProactiveMessageMock: vi.fn(async () => true),
  sendToDiscordThreadMock: vi.fn(async () => false),
  sendToDiscordThreadWithVoiceMock: vi.fn(async () => false),
  parseAndSaveDigestMock: vi.fn(),
  synthesizeSpeechMock: vi.fn(),
  cronCallbacks: [] as Array<() => Promise<void>>,
  testHome: (() => {
    const { mkdtempSync } = require('fs');
    const { tmpdir } = require('os');
    const { join } = require('path');
    return mkdtempSync(join(tmpdir(), 'skimpy-cron-home-'));
  })(),
}));

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
  getActiveChannelId: () => 'telegram',
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
  loadConfig: vi.fn(),
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

import { initCron, runCronJob } from '../cron.js';

function localDate(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

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
    cronCallbacks.length = 0;
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
              discordThreadId: '123456789012345678',
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
              discordThreadId: '123456789012345678',
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
        discordThreadId: '123456789012345678',
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
              discordThreadId: '123456789012345678',
            },
          },
        ],
      },
    } as any;

    await runCronJob('tech-digest', threadConfig);

    expect(sendToDiscordThreadMock).toHaveBeenCalled();
    expect(sendActiveChannelProactiveMessageMock).not.toHaveBeenCalled();
  });

  it('falls back to active channel when discordThreadId is invalid', async () => {
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
    expect(sendActiveChannelProactiveMessageMock).toHaveBeenCalledWith(
      threadConfig,
      expect.stringContaining('Cron: Tech Digest'),
    );
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
              discordThreadId: '123456789012345678',
            },
          },
        ],
      },
    } as any;

    await runCronJob('tech-digest', voiceConfig);

    expect(synthesizeSpeechMock).toHaveBeenCalledWith(digestText, voiceConfig.voice);
    expect(sendToDiscordThreadWithVoiceMock).toHaveBeenCalledWith(
      '123456789012345678',
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
              discordThreadId: '123456789012345678',
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

    await runCronJob('morning', voiceConfig);

    const voicePath = join(testHome, '.skimpyclaw', 'reports', 'voice', 'morning', `${date}.mp3`);
    expect(existsSync(voicePath)).toBe(true);
    const finalCall = sendToDiscordThreadWithVoiceMock.mock.calls.at(-1) as unknown as [string, string, Uint8Array, string];
    const finalMessage = finalCall[1];
    expect(finalMessage).toMatch(/Voice file: http:\/\/127\.0\.0\.1:18790\/artifacts\/[^/]+\/\d{4}-\d{2}-\d{2}\.mp3/);
    expect(readFileSync(htmlPath, 'utf-8')).toMatch(/<a href="http:\/\/127\.0\.0\.1:18790\/artifacts\/[^/]+\/\d{4}-\d{2}-\d{2}\.mp3">Open voice file<\/a>/);
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
