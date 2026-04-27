import { describe, expect, it } from 'vitest';
import type { Message } from 'discord.js';
import { buildCodeAgentThreadContext } from '../channels/discord/utils.js';
import type { CodeAgentTask } from '../code-agents/types.js';

function makeMessage(channel: { id: string; isDMBased: () => boolean; isThread: () => boolean }): Message {
  return { channel } as unknown as Message;
}

function makeTask(overrides: Partial<CodeAgentTask> = {}): CodeAgentTask {
  return {
    id: 'ca-12',
    agent: 'codex',
    task: 'Fix the Discord thread context bug',
    status: 'completed',
    discordThreadId: 'thread-1',
    startedAt: '2026-04-27T14:00:00.000Z',
    endedAt: '2026-04-27T14:05:00.000Z',
    workdir: '/Users/katre/Sites/skimpyclaw',
    outputPreview: 'Implemented a context bridge.',
    validationPassed: true,
    ...overrides,
  };
}

describe('Discord coding-agent thread context', () => {
  it('injects task metadata for messages inside a coding-agent thread', () => {
    const message = makeMessage({
      id: 'thread-1',
      isDMBased: () => false,
      isThread: () => true,
    });

    const context = buildCodeAgentThreadContext(message, [makeTask()]);

    expect(context).toContain('Task ID: ca-12');
    expect(context).toContain('Task status: completed');
    expect(context).toContain('Fix the Discord thread context bug');
    expect(context).toContain('check_code_agent with id "ca-12"');
  });

  it('returns null outside task threads', () => {
    const message = makeMessage({
      id: 'channel-1',
      isDMBased: () => false,
      isThread: () => false,
    });

    expect(buildCodeAgentThreadContext(message, [makeTask()])).toBeNull();
  });
});
