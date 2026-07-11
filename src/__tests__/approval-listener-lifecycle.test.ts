import { beforeEach, describe, expect, it, vi } from 'vitest';

type ApprovalListener = (event: { approval: TestApproval }) => void;

interface TestApproval {
  id: string;
  command: string;
  tier: number;
  reason: string;
  cwd?: string;
  expiresAt: Date;
  channelMeta?: {
    channel: string;
    chatId?: string | number;
  };
}

const approvalEvents = vi.hoisted(() => {
  const listeners = new Set<(event: { approval: TestApproval }) => void>();

  return {
    onApprovalEvent: vi.fn((_type: string, listener: ApprovalListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit(approval: TestApproval) {
      for (const listener of [...listeners]) listener({ approval });
    },
    listenerCount() {
      return listeners.size;
    },
    reset() {
      listeners.clear();
    },
  };
});

const telegramMocks = vi.hoisted(() => {
  const sendMessage = vi.fn(async () => ({}));
  const runnerHandles: Array<{ stop: ReturnType<typeof vi.fn> }> = [];

  class Bot {
    api = {
      setMyCommands: vi.fn(async () => ({})),
      sendMessage,
    };

    use = vi.fn();
    command = vi.fn();
    on = vi.fn();
    catch = vi.fn();
  }

  class InlineKeyboard {
    text(): this {
      return this;
    }
  }

  return {
    Bot,
    InlineKeyboard,
    sendMessage,
    runnerHandles,
    run: vi.fn(() => {
      const handle = { stop: vi.fn(async () => {}) };
      runnerHandles.push(handle);
      return handle;
    }),
  };
});

const discordMocks = vi.hoisted(() => {
  const clients: Array<{
    destroy: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  }> = [];
  const handleInteraction = vi.fn(async () => {});

  class Client {
    destroy = vi.fn();
    login = vi.fn(async () => ({}));
    on = vi.fn();
    once = vi.fn();

    constructor() {
      clients.push(this);
    }
  }

  return {
    Client,
    clients,
    handleInteraction,
    sendApprovalCard: vi.fn(async () => {}),
    registerDelegateToAgentHandler: vi.fn(),
  };
});

vi.mock('../exec-approval.js', () => ({
  onApprovalEvent: approvalEvents.onApprovalEvent,
  listApprovals: vi.fn(() => []),
  approveRequest: vi.fn(() => true),
  denyRequest: vi.fn(() => true),
  getApproval: vi.fn(),
}));

vi.mock('grammy', () => ({
  Bot: telegramMocks.Bot,
  GrammyError: class GrammyError extends Error {},
  HttpError: class HttpError extends Error {},
  InputFile: class InputFile {},
  InlineKeyboard: telegramMocks.InlineKeyboard,
}));

vi.mock('@grammyjs/runner', () => ({
  run: telegramMocks.run,
}));

vi.mock('discord.js', () => ({
  Client: discordMocks.Client,
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    DirectMessages: 4,
    MessageContent: 8,
  },
  Partials: { Channel: 1 },
  AttachmentBuilder: class AttachmentBuilder {},
}));

vi.mock('../channels/discord/handlers.js', () => ({
  handleCommand: vi.fn(),
  handleIncomingMessage: vi.fn(),
  handleInteraction: discordMocks.handleInteraction,
  sendApprovalCard: discordMocks.sendApprovalCard,
}));

vi.mock('../channels/discord/delegation.js', () => ({
  createDiscordAgentDelegateHandler: vi.fn(() => vi.fn()),
}));

vi.mock('../tools/agent-delegation.js', () => ({
  registerDelegateToAgentHandler: discordMocks.registerDelegateToAgentHandler,
}));

import { initTelegram, stopTelegram } from '../channels/telegram/index.js';
import { initDiscord, stopDiscord } from '../channels/discord/index.js';

function makeConfig(): any {
  return {
    agents: {
      default: 'main',
      list: {
        main: {
          identity: { name: 'SkimpyClaw', emoji: '🦞' },
          model: 'test-model',
        },
      },
    },
    channels: {
      telegram: {
        enabled: true,
        token: 'telegram-token',
        allowFrom: [123],
      },
      discord: {
        enabled: true,
        token: 'discord-token',
        allowFrom: ['456'],
        defaultChannelId: '456',
      },
    },
  };
}

function makeApproval(channel: 'telegram' | 'discord'): TestApproval {
  return {
    id: `${channel}-approval`,
    command: 'sudo echo test',
    tier: 2,
    reason: 'test approval',
    expiresAt: new Date(Date.now() + 60_000),
    channelMeta: {
      channel,
      chatId: channel === 'telegram' ? 123 : '456',
    },
  };
}

beforeEach(async () => {
  for (const handle of telegramMocks.runnerHandles) {
    handle.stop.mockResolvedValue(undefined);
  }
  for (const client of discordMocks.clients) {
    client.destroy.mockImplementation(() => undefined);
  }
  await stopTelegram();
  await stopDiscord();

  approvalEvents.reset();
  telegramMocks.sendMessage.mockClear();
  telegramMocks.runnerHandles.length = 0;
  telegramMocks.run.mockClear();
  discordMocks.sendApprovalCard.mockClear();
  discordMocks.handleInteraction.mockReset().mockResolvedValue(undefined);
  discordMocks.clients.length = 0;
});

describe('approval listener lifecycle', () => {
  it('replaces the Telegram listener on reinit and removes it on stop', async () => {
    const cfg = makeConfig();

    await initTelegram(cfg);
    await initTelegram(cfg);

    expect(approvalEvents.listenerCount()).toBe(1);
    approvalEvents.emit(makeApproval('telegram'));
    expect(telegramMocks.sendMessage).toHaveBeenCalledTimes(1);

    await stopTelegram();
    expect(approvalEvents.listenerCount()).toBe(0);

    approvalEvents.emit(makeApproval('telegram'));
    expect(telegramMocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('cleans up the Telegram listener before disabled init and failed stop exits', async () => {
    const cfg = makeConfig();
    await initTelegram(cfg);

    const disabled = makeConfig();
    disabled.channels.telegram.enabled = false;
    expect(await initTelegram(disabled)).toBeNull();
    expect(approvalEvents.listenerCount()).toBe(0);

    await initTelegram(cfg);
    telegramMocks.runnerHandles.at(-1)?.stop.mockRejectedValueOnce(new Error('runner stop failed'));

    await expect(stopTelegram()).rejects.toThrow('runner stop failed');
    expect(approvalEvents.listenerCount()).toBe(0);
  });

  it('does not subscribe when the Telegram runner fails to initialize', async () => {
    telegramMocks.run.mockImplementationOnce(() => {
      throw new Error('runner init failed');
    });

    await expect(initTelegram(makeConfig())).rejects.toThrow('runner init failed');
    expect(approvalEvents.listenerCount()).toBe(0);
  });

  it('replaces the Discord listener on reinit and removes it on stop', async () => {
    const cfg = makeConfig();

    await initDiscord(cfg);
    await initDiscord(cfg);

    expect(approvalEvents.listenerCount()).toBe(1);
    approvalEvents.emit(makeApproval('discord'));
    expect(discordMocks.sendApprovalCard).toHaveBeenCalledTimes(1);

    await stopDiscord();
    expect(approvalEvents.listenerCount()).toBe(0);

    approvalEvents.emit(makeApproval('discord'));
    expect(discordMocks.sendApprovalCard).toHaveBeenCalledTimes(1);
  });

  it('cleans up the Discord listener before disabled init and failed stop exits', async () => {
    const cfg = makeConfig();
    await initDiscord(cfg);

    const disabled = makeConfig();
    disabled.channels.discord.enabled = false;
    expect(await initDiscord(disabled)).toBe(false);
    expect(approvalEvents.listenerCount()).toBe(0);

    await initDiscord(cfg);
    discordMocks.clients.at(-1)?.destroy.mockImplementationOnce(() => {
      throw new Error('client destroy failed');
    });

    await expect(stopDiscord()).rejects.toThrow('client destroy failed');
    expect(approvalEvents.listenerCount()).toBe(0);
  });

  it('observes rejected Discord interaction handlers', async () => {
    const error = new Error('interaction failed');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    discordMocks.handleInteraction.mockRejectedValueOnce(error);

    await initDiscord(makeConfig());
    const interactionHandler = discordMocks.clients.at(-1)?.on.mock.calls
      .find(([event]) => event === 'interactionCreate')?.[1] as ((interaction: unknown) => void) | undefined;
    expect(interactionHandler).toBeTypeOf('function');

    interactionHandler?.({ id: 'interaction-1' });

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('[discord] Interaction handler failed:', error);
    });
    consoleErrorSpy.mockRestore();
  });
});
