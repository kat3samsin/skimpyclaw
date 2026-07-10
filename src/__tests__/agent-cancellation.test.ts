import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, ToolConfig } from '../types.js';

const {
  appendFileSyncMock,
  chatWithToolsMock,
  endTraceMock,
  startTraceMock,
} = vi.hoisted(() => ({
  appendFileSyncMock: vi.fn(),
  chatWithToolsMock: vi.fn(),
  endTraceMock: vi.fn(),
  startTraceMock: vi.fn(() => 'trace-cancel'),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, appendFileSync: appendFileSyncMock };
});

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
  endTrace: endTraceMock,
}));

vi.mock('../langfuse.js', async () => {
  const actual = await vi.importActual<typeof import('../langfuse.js')>('../langfuse.js');
  return { ...actual, isLangfuseEnabled: vi.fn(() => false) };
});

import { runAgentTurn } from '../agent.js';

describe('runAgentTurn cancellation', () => {
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
  const toolConfig = { enabled: true, allowedPaths: ['/tmp'] } as ToolConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    startTraceMock.mockReturnValue('trace-cancel');
    endTraceMock.mockResolvedValue(undefined);
  });

  it('rejects a late provider response without appending it to memory', async () => {
    let resolveProvider = (_value: { response: string; toolCalls: string[] }) => {};
    chatWithToolsMock.mockImplementation(() => new Promise((resolve) => {
      resolveProvider = resolve;
    }));
    const controller = new AbortController();
    const turn = runAgentTurn(
      'test-agent',
      'do work',
      config,
      undefined,
      toolConfig,
      [],
      { sessionId: 'session-1', trigger: 'discord', abortSignal: controller.signal },
    );

    await vi.waitFor(() => expect(chatWithToolsMock).toHaveBeenCalledTimes(1));
    controller.abort();
    resolveProvider({ response: 'late response', toolCalls: [] });

    await expect(turn).rejects.toThrow('Agent turn cancelled');
    expect(appendFileSyncMock).not.toHaveBeenCalled();
    expect(endTraceMock).toHaveBeenCalledWith('trace-cancel', 'error');
    expect(endTraceMock).not.toHaveBeenCalledWith('trace-cancel', 'ok');
  });
});
