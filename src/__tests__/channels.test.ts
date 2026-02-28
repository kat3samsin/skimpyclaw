import { beforeEach, describe, expect, it, vi } from 'vitest';

const telegramMock = vi.hoisted(() => ({
  initTelegram: vi.fn(async () => ({})),
  startTelegram: vi.fn(async () => {}),
  stopTelegram: vi.fn(async () => {}),
  isSilenced: vi.fn(() => false),
  sendProactiveMessage: vi.fn(async () => {}),
  sendProactiveVoice: vi.fn(async () => {}),
  getTelegramDefaultChatId: vi.fn(() => 12345),
}));

const discordMock = vi.hoisted(() => ({
  initDiscord: vi.fn(async () => true),
  startDiscord: vi.fn(async () => {}),
  stopDiscord: vi.fn(async () => {}),
  isDiscordSilenced: vi.fn(() => false),
  sendDiscordProactiveMessage: vi.fn(async () => {}),
  sendDiscordProactiveVoice: vi.fn(async () => {}),
  getDiscordDefaultTarget: vi.fn(() => '999'),
}));

vi.mock('../channels/telegram/index.js', () => telegramMock);
vi.mock('../discord.js', () => discordMock);

import {
  getActiveChannelId,
  initActiveChannel,
  sendActiveChannelProactiveMessage,
} from '../channels.js';

function makeConfig(overrides: Record<string, any> = {}): any {
  return {
    gateway: { port: 18790, mode: 'local' },
    agents: { default: 'main', list: { main: { identity: { name: 'bot', emoji: '🤖' }, model: 'm' } } },
    models: { providers: {}, aliases: {} },
    channels: {
      telegram: { enabled: false, token: '', allowFrom: [] },
      discord: { enabled: false, token: '', allowFrom: [] },
    },
    cron: { jobs: [] },
    heartbeat: { intervalMs: 60000, prompt: 'heartbeat' },
    ...overrides,
  };
}

describe('channels manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no channel is enabled', async () => {
    const cfg = makeConfig();
    const channel = await initActiveChannel(cfg);
    expect(channel).toBeNull();
    expect(getActiveChannelId()).toBeNull();
  });

  it('uses explicit active channel when enabled', async () => {
    const cfg = makeConfig({
      channels: {
        active: 'discord',
        telegram: { enabled: true, token: 'tg', allowFrom: [1] },
        discord: { enabled: true, token: 'dc', allowFrom: ['42'] },
      },
    });

    const channel = await initActiveChannel(cfg);
    expect(channel).toBe('discord');
    expect(discordMock.initDiscord).toHaveBeenCalledTimes(1);
    expect(telegramMock.initTelegram).not.toHaveBeenCalled();
  });

  it('defaults to telegram when multiple channels are enabled and active is unset', async () => {
    const cfg = makeConfig({
      channels: {
        telegram: { enabled: true, token: 'tg', allowFrom: [1] },
        discord: { enabled: true, token: 'dc', allowFrom: ['42'] },
      },
    });

    const channel = await initActiveChannel(cfg);
    expect(channel).toBe('telegram');
    expect(telegramMock.initTelegram).toHaveBeenCalledTimes(1);
    expect(discordMock.initDiscord).not.toHaveBeenCalled();
  });

  it('routes proactive message to active adapter target', async () => {
    const cfg = makeConfig({
      channels: {
        active: 'telegram',
        telegram: { enabled: true, token: 'tg', allowFrom: [1] },
        discord: { enabled: false, token: '', allowFrom: [] },
      },
    });

    await initActiveChannel(cfg);
    const sent = await sendActiveChannelProactiveMessage(cfg, 'hello');
    expect(sent).toBe(true);
    expect(telegramMock.sendProactiveMessage).toHaveBeenCalledWith(12345, 'hello');
  });
});
