import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  sendActiveChannelProactiveMessageMock,
  sendToDiscordThreadMock,
  sendToDiscordThreadWithAttachmentsMock,
  sendDiscordProactiveMessageMock,
  sendDiscordProactiveMessageWithAttachmentsMock,
} = vi.hoisted(() => ({
  sendActiveChannelProactiveMessageMock: vi.fn(async () => true),
  sendToDiscordThreadMock: vi.fn(async () => false),
  sendToDiscordThreadWithAttachmentsMock: vi.fn(async () => false),
  sendDiscordProactiveMessageMock: vi.fn(async () => undefined),
  sendDiscordProactiveMessageWithAttachmentsMock: vi.fn(async () => undefined),
}));

vi.mock('../channels.js', () => ({
  sendActiveChannelProactiveMessage: sendActiveChannelProactiveMessageMock,
}));

vi.mock('../channels/discord/index.js', () => ({
  sendToDiscordThread: sendToDiscordThreadMock,
  sendToDiscordThreadWithAttachments: sendToDiscordThreadWithAttachmentsMock,
  sendDiscordProactiveMessage: sendDiscordProactiveMessageMock,
  sendDiscordProactiveMessageWithAttachments: sendDiscordProactiveMessageWithAttachmentsMock,
}));

import { buildCodeAgentDiscordNotification, notifyCodeAgentResult, setCodeAgentConfig } from '../code-agents/utils.js';

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
    sendToDiscordThreadWithAttachmentsMock.mockResolvedValue(false);
    sendDiscordProactiveMessageMock.mockResolvedValue(undefined);
    sendDiscordProactiveMessageWithAttachmentsMock.mockResolvedValue(undefined);
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
      expect.stringContaining('`ca-1` completed'),
    );
    expect(sendDiscordProactiveMessageMock).toHaveBeenCalledWith(
      'channel-1',
      expect.stringContaining('`ca-1` completed'),
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

  it('sends compact Discord summary with full report attachment for long output', async () => {
    const longOutput = [
      'Findings',
      '',
      '- High: important issue was resolved on current branch.',
      '- Low: coverage gaps remain.',
      '',
      'Risk Checks',
      '',
      'No reproducible leak found in current code.',
      '',
      'Recommendation',
      '',
      'Merge only if the PR head is current.',
      '',
      'Details '.repeat(500),
    ].join('\n');

    await notifyCodeAgentResult({
      ...completedTask,
      agent: 'claude',
      model: 'claude-opus-4-6',
      effort: 'xhigh',
      discordThreadId: 'thread-1',
      outputPreview: longOutput,
    });

    expect(sendToDiscordThreadWithAttachmentsMock).toHaveBeenCalledWith(
      'thread-1',
      expect.stringContaining('`ca-1` completed · CLAUDE · claude-opus-4-6 · effort xhigh'),
      [expect.objectContaining({
        name: 'ca-1-report.md',
        content: expect.stringContaining('## Result'),
      })],
    );
    const message = (sendToDiscordThreadWithAttachmentsMock.mock.calls[0] as unknown[])[1] as string;
    expect(message.length).toBeLessThan(1900);
    expect(message).toContain('Full report attached.');
  });

  it('strips raw Codex stream-json from Discord summary', () => {
    const rawCodexOutput = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'agent_message',
          text: 'Findings\n\n- High: state contract can regress.\n\nRecommendation\n\nDo not merge until fixed.',
        },
      }),
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'item_2',
          type: 'command_execution',
          command: 'git status --short',
          status: 'in_progress',
        },
      }),
    ].join('\n');

    const notification = buildCodeAgentDiscordNotification({
      ...completedTask,
      agent: 'codex',
      model: 'gpt-5.5',
      effort: 'high',
      outputPreview: rawCodexOutput,
      task: 'Review PR https://github.com/Automattic/wp-calypso/pull/110225',
    });

    expect(notification.content).toContain('**Findings**');
    expect(notification.content).toContain('state contract can regress');
    expect(notification.content).toContain('**Decision**');
    expect(notification.content).not.toContain('thread.started');
    expect(notification.content).not.toContain('command_execution');
    expect(notification.content).not.toContain('{"type"');
  });
});
