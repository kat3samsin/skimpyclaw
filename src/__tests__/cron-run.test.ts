import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  runAgentTurnMock,
  sendActiveChannelProactiveMessageMock,
  sendToDiscordThreadMock,
  parseAndSaveDigestMock,
} = vi.hoisted(() => ({
  runAgentTurnMock: vi.fn(),
  sendActiveChannelProactiveMessageMock: vi.fn(async () => true),
  sendToDiscordThreadMock: vi.fn(async () => false),
  parseAndSaveDigestMock: vi.fn(),
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
  synthesizeSpeech: vi.fn(),
}));

vi.mock('../env-sanitizer.js', () => ({
  sanitizeCronEnv: () => ({}),
}));

vi.mock('../sandbox/index.js', () => ({
  ensureContainer: vi.fn(),
  SANDBOX_DEFAULTS: {},
  sandboxBash: vi.fn(),
}));

import { runCronJob } from '../cron.js';

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

  it('routes notifications to a configured Discord thread when delivery succeeds', async () => {
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
    expect(sendActiveChannelProactiveMessageMock).not.toHaveBeenCalledWith(
      threadConfig,
      expect.stringContaining('Cron: Tech Digest'),
    );
  });

  it('falls back to active channel when Discord thread delivery fails', async () => {
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
    expect(sendActiveChannelProactiveMessageMock).toHaveBeenCalledWith(
      threadConfig,
      expect.stringContaining('Cron: Tech Digest'),
    );
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
});
