import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  sendActiveChannelProactiveMessageMock,
  sendToDiscordThreadMock,
  sendDiscordProactiveMessageMock,
} = vi.hoisted(() => ({
  sendActiveChannelProactiveMessageMock: vi.fn(async () => true),
  sendToDiscordThreadMock: vi.fn(async () => false),
  sendDiscordProactiveMessageMock: vi.fn(async () => undefined),
}));

vi.mock('../channels.js', () => ({
  sendActiveChannelProactiveMessage: sendActiveChannelProactiveMessageMock,
}));

vi.mock('../channels/discord/index.js', () => ({
  sendToDiscordThread: sendToDiscordThreadMock,
  sendDiscordProactiveMessage: sendDiscordProactiveMessageMock,
}));

import { notifyCodeAgentResult, setCodeAgentConfig } from '../code-agents/utils.js';

describe('notifyCodeAgentResult Discord routing', () => {
  const config = { channels: { active: 'discord' } } as any;

  const completedTask = {
    id: 'ca-1',
    agent: 'codex',
    task: 'Fix Discord routing',
    status: 'completed',
    startedAt: '2026-04-12T00:00:00.000Z',
    durationSeconds: 12,
    workdir: '/tmp',
    outputPreview: 'Patched notifier routing.',
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    setCodeAgentConfig(config);
    sendToDiscordThreadMock.mockResolvedValue(false);
    sendDiscordProactiveMessageMock.mockResolvedValue(undefined);
    sendActiveChannelProactiveMessageMock.mockResolvedValue(true);
  });

  it('falls back from Discord thread to the originating Discord channel', async () => {
    await notifyCodeAgentResult({
        ...completedTask,
        discordThreadId: 'thread-1',
        discordChannelId: 'channel-1',
      });

    expect(sendToDiscordThreadMock).toHaveBeenCalledWith(
      'thread-1',
      expect.stringContaining('Coding agent ca-1 completed'),
    );
    expect(sendDiscordProactiveMessageMock).toHaveBeenCalledWith(
      'channel-1',
      expect.stringContaining('Coding agent ca-1 completed'),
    );
    expect(sendActiveChannelProactiveMessageMock).not.toHaveBeenCalled();
  });

  it('does not fall back to the global active channel when Discord-scoped delivery fails', async () => {
    sendDiscordProactiveMessageMock.mockRejectedValue(new Error('channel missing'));

    await notifyCodeAgentResult({
        ...completedTask,
        discordThreadId: 'thread-1',
        discordChannelId: 'channel-1',
      });

    expect(sendToDiscordThreadMock).toHaveBeenCalled();
    expect(sendDiscordProactiveMessageMock).toHaveBeenCalled();
    expect(sendActiveChannelProactiveMessageMock).not.toHaveBeenCalled();
  });

  it('uses the active channel only when the task has no Discord-specific route', async () => {
    await notifyCodeAgentResult(completedTask);

    expect(sendToDiscordThreadMock).not.toHaveBeenCalled();
    expect(sendDiscordProactiveMessageMock).not.toHaveBeenCalled();
    expect(sendActiveChannelProactiveMessageMock).toHaveBeenCalledWith(
      config,
      expect.stringContaining('Coding agent ca-1 completed'),
    );
  });
});
