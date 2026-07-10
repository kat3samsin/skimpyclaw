import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, ToolConfig } from '../types.js';

const { chatWithToolsMock, startTraceMock } = vi.hoisted(() => ({
  chatWithToolsMock: vi.fn(),
  startTraceMock: vi.fn(),
}));

vi.mock('../providers/index.js', async () => {
  const actual = await vi.importActual<typeof import('../providers/index.js')>('../providers/index.js');
  return {
    ...actual,
    chatWithTools: chatWithToolsMock,
    resolveProviderRoute: vi.fn(() => ({
      resolvedModel: 'anthropic/test-model',
      provider: 'anthropic',
      modelId: 'test-model',
    })),
  };
});

vi.mock('../audit.js', () => ({
  startTrace: startTraceMock,
  endTrace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../langfuse.js', async () => {
  const actual = await vi.importActual<typeof import('../langfuse.js')>('../langfuse.js');
  return {
    ...actual,
    isLangfuseEnabled: vi.fn(() => false),
  };
});

import { runAgentTurn } from '../agent.js';

describe('runAgentTurn file lock ownership', () => {
  const config = {
    gateway: { port: 18790, mode: 'local' },
    agents: {
      default: 'test-agent',
      list: {
        'test-agent': {
          identity: { name: 'Test Agent', emoji: 'T' },
          model: 'anthropic/test-model',
        },
      },
    },
    skills: { enabled: false },
    models: { providers: {}, aliases: {} },
    channels: { telegram: { enabled: false, token: '', allowFrom: [] } },
    cron: { jobs: [] },
    heartbeat: { intervalMs: 300_000, prompt: 'HEARTBEAT' },
  } as Config;
  const toolConfig = {
    enabled: true,
    allowedPaths: ['/tmp'],
  } as ToolConfig;

  beforeEach(() => {
    chatWithToolsMock.mockReset();
    chatWithToolsMock.mockRejectedValue(new Error('stop after capturing context'));
    startTraceMock.mockReset();
    startTraceMock.mockReturnValueOnce('trace-1').mockReturnValueOnce('trace-2');
  });

  it('uses a unique audit trace as the lock owner for each turn in one session', async () => {
    const context = { sessionId: 'shared-session', trigger: 'discord' as const };

    await expect(runAgentTurn('test-agent', 'first', config, undefined, toolConfig, [], context))
      .rejects.toThrow('stop after capturing context');
    await expect(runAgentTurn('test-agent', 'second', config, undefined, toolConfig, [], context))
      .rejects.toThrow('stop after capturing context');

    const firstToolContext = chatWithToolsMock.mock.calls[0][4];
    const secondToolContext = chatWithToolsMock.mock.calls[1][4];
    expect(firstToolContext).toMatchObject({
      sessionId: 'shared-session',
      auditTraceId: 'trace-1',
      lockTaskId: 'trace-1',
    });
    expect(secondToolContext).toMatchObject({
      sessionId: 'shared-session',
      auditTraceId: 'trace-2',
      lockTaskId: 'trace-2',
    });
  });
});
