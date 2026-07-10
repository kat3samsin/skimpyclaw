import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, join } from 'path';

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
import { clearRegisteredArtifactsForTesting } from '../artifacts.js';

describe('notifyCodeAgentResult Discord routing', () => {
  const config = {
    channels: { active: 'discord' },
    gateway: { port: 18790, host: '127.0.0.1' },
  } as any;

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
    clearRegisteredArtifactsForTesting();
    setCodeAgentConfig(config);
    sendToDiscordThreadMock.mockResolvedValue(false);
    sendToDiscordThreadWithAttachmentsMock.mockResolvedValue(false);
    sendDiscordProactiveMessageMock.mockResolvedValue(undefined);
    sendDiscordProactiveMessageWithAttachmentsMock.mockResolvedValue(undefined);
    sendActiveChannelProactiveMessageMock.mockResolvedValue(true);
  });

  it('links generated HTML review artifacts without attaching the HTML body', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'skimpyclaw-review-artifact-'));
    try {
      const artifactPath = join(workdir, 'pr-123-review.html');
      writeFileSync(artifactPath, '<!doctype html><title>Review</title>', 'utf-8');

      const notification = buildCodeAgentDiscordNotification({
        ...completedTask,
        workdir,
        outputPreview: `Created the local artifact: [pr-123-review.html](${artifactPath})`,
      });

      expect(notification.content).toContain('**Reviews**');
      expect(notification.content).toMatch(
        /\[pr-123-review\.html\]\(http:\/\/127\.0\.0\.1:18790\/artifacts\/[^/]+\/pr-123-review\.html\)/
      );
      expect(notification.content).not.toContain('<!doctype html>');
      expect(notification.content).not.toContain('Attached for Discord preview/download');
      expect(notification.attachments).toBeUndefined();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it('copies review HTML from temp storage into ~/.skimpyclaw/reviews before linking it', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'skimpyclaw-review-source-'));
    const tempDir = mkdtempSync(join(tmpdir(), 'skimpyclaw-private-review-'));
    let copiedPath = '';
    try {
      const artifactPath = join(tempDir, 'pr-temp-copy-review.html');
      copiedPath = join(homedir(), '.skimpyclaw', 'reviews', basename(artifactPath));
      rmSync(copiedPath, { force: true });
      writeFileSync(artifactPath, '<!doctype html><title>Temp Review</title>', 'utf-8');

      const notification = buildCodeAgentDiscordNotification({
        ...completedTask,
        workdir,
        sourceWorkdir: tempDir,
        outputPreview: `Artifact: [pr-temp-copy-review.html](${artifactPath})`,
      });

      expect(existsSync(copiedPath)).toBe(true);
      expect(notification.content).toContain('**Reviews**');
      expect(notification.content).toMatch(
        /\[pr-temp-copy-review\.html\]\(http:\/\/127\.0\.0\.1:18790\/artifacts\/[^/]+\/pr-temp-copy-review\.html\)/
      );
      expect(notification.content).not.toContain(artifactPath);
      expect(notification.attachments).toBeUndefined();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
      rmSync(tempDir, { recursive: true, force: true });
      if (copiedPath) rmSync(copiedPath, { force: true });
    }
  });

  it('does not copy a review symlink whose target is outside the task roots', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'skimpyclaw-review-symlink-'));
    const linkPath = join(workdir, 'linked-review.html');
    const outsidePath = '/etc/hosts';
    const copiedPath = join(homedir(), '.skimpyclaw', 'reviews', basename(linkPath));
    try {
      rmSync(copiedPath, { force: true });
      symlinkSync(outsidePath, linkPath);

      const notification = buildCodeAgentDiscordNotification({
        ...completedTask,
        workdir,
        outputPreview: `Artifact: [linked-review.html](${linkPath})`,
      });

      expect(existsSync(copiedPath)).toBe(false);
      expect(notification.content).not.toContain('/artifacts/');
      expect(notification.content).not.toContain('**Reviews**');
    } finally {
      rmSync(workdir, { recursive: true, force: true });
      rmSync(copiedPath, { force: true });
    }
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

  it('sends long output directly to Discord instead of attaching a markdown report', async () => {
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

    expect(sendToDiscordThreadMock).toHaveBeenCalledWith(
      'thread-1',
      expect.stringContaining('`ca-1` completed · CLAUDE · claude-opus-4-6 · effort xhigh'),
    );
    expect(sendToDiscordThreadWithAttachmentsMock).not.toHaveBeenCalled();
    const message = (sendToDiscordThreadMock.mock.calls[0] as unknown[])[1] as string;
    expect(message).toContain('**Full Result**');
    expect(message).toContain('Details Details');
    expect(message).not.toContain('Full report attached.');
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
