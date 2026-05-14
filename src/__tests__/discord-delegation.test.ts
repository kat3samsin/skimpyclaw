import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ChannelType } from 'discord.js';

const {
  runAgentTurnMock,
  loadHistoryMock,
  saveExchangeMock,
  clearHistoryMock,
} = vi.hoisted(() => ({
  runAgentTurnMock: vi.fn(),
  loadHistoryMock: vi.fn(async () => []),
  saveExchangeMock: vi.fn(async () => {}),
  clearHistoryMock: vi.fn(async () => {}),
}));

vi.mock('../agent.js', () => ({
  runAgentTurn: runAgentTurnMock,
}));

vi.mock('../gateway.js', () => ({
  getCurrentModel: () => 'codex/gpt-5.5',
  getCurrentThinking: () => 'xhigh',
}));

vi.mock('../sessions.js', () => ({
  loadHistory: loadHistoryMock,
  saveExchange: saveExchangeMock,
  clearHistory: clearHistoryMock,
}));

import { createDiscordAgentDelegateHandler } from '../channels/discord/delegation.js';
import {
  _setThreadAgentStorePathForTesting,
  setAgentProfileModel,
  setAgentProfilePrompt,
  setAgentProfileThinking,
  upsertAgentProfile,
} from '../channels/discord/thread-agents.js';

let tempDir: string;
let storePath: string;

describe('Discord agent delegation', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'skimpyclaw-discord-delegation-'));
    storePath = join(tempDir, 'thread-agents.json');
    _setThreadAgentStorePathForTesting(storePath);
    vi.clearAllMocks();
  });

  afterEach(() => {
    _setThreadAgentStorePathForTesting(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses discordThreadId as the parent source for cron-triggered delegation', async () => {
    upsertAgentProfile({ alias: 'codex-reviewer', agentId: 'main', createdBy: 'user-1' });
    setAgentProfileModel('codex-reviewer', 'codex/gpt-5.5');
    setAgentProfileThinking('codex-reviewer', 'xhigh');
    setAgentProfilePrompt('codex-reviewer', 'Review PRs read-only.');
    runAgentTurnMock.mockResolvedValue('No blocking or should-fix findings.');

    const delegatedThread = {
      id: 'delegated-thread',
      guildId: 'guild-1',
      parentId: 'parent-channel',
      send: vi.fn(async () => ({})),
      sendTyping: vi.fn(async () => {}),
    };
    const startThreadMock = vi.fn(async () => delegatedThread);
    const parentSendMock = vi.fn(async () => ({ startThread: startThreadMock }));
    const fetchMock = vi.fn(async (id: string) => {
      if (id === 'source-thread') {
        return { id, parentId: 'parent-channel', isThread: () => true };
      }
      if (id === 'parent-channel') {
        return { id, type: ChannelType.GuildText, send: parentSendMock };
      }
      return null;
    });
    const handler = createDiscordAgentDelegateHandler(() => ({
      channels: { fetch: fetchMock },
    }) as any);
    const config = {
      agents: { default: 'main', list: { main: { model: 'anthropic/claude-sonnet-4-6' } } },
      channels: { telegram: { enabled: false, allowFrom: [] }, discord: { enabled: true, allowFrom: [] } },
    } as any;

    const result = await handler(
      {
        alias: 'codex-reviewer',
        task: 'Review this PR read-only: https://github.com/example/repo/pull/123',
        mode: 'new_thread',
        wait: true,
        allowSelf: false,
      },
      config,
      {
        fullConfig: config,
        channel: 'discord',
        isCronJob: true,
        discordThreadId: 'source-thread',
        sessionId: 'pr-pre-review',
      },
    );

    expect(fetchMock).toHaveBeenCalledWith('source-thread');
    expect(fetchMock).toHaveBeenCalledWith('parent-channel');
    expect(startThreadMock).toHaveBeenCalledWith({
      name: expect.stringContaining('codex-reviewer: Review this PR read-only: #123'),
      autoArchiveDuration: 1440,
    });
    expect(runAgentTurnMock).toHaveBeenCalledWith(
      'main',
      expect.stringContaining('Review this PR read-only'),
      config,
      'codex/gpt-5.5',
      expect.objectContaining({ enabled: true }),
      [],
      expect.objectContaining({
        channel: 'discord',
        trigger: 'discord',
        sessionId: 'delegated-thread',
        metadata: expect.objectContaining({
          discordThreadId: 'delegated-thread',
          discordChannelId: 'parent-channel',
          isCronJob: true,
          threadAgentAlias: 'codex-reviewer',
          threadAgentThinking: 'xhigh',
          threadAgentPromptOverlay: 'Review PRs read-only.',
          delegationDepth: 1,
        }),
      }),
    );
    expect(result).toContain('Delegated to @codex-reviewer');
  });
});
