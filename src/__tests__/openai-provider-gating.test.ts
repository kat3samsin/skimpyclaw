import { describe, expect, it, vi } from 'vitest';
import type { Config, ToolConfig } from '../types.js';
import { chatWithToolsOpenAI } from '../providers/openai.js';

const { mockRunToolLoop } = vi.hoisted(() => ({
  mockRunToolLoop: vi.fn(),
}));

vi.mock('../providers/tool-loop.js', () => ({
  runToolLoop: mockRunToolLoop,
}));

// Mock the OpenAI client module internals
vi.mock('openai', () => ({
  default: class {},
}));

// Provide a fake OpenAI client for the provider
const fakeClient = { chat: { completions: { create: vi.fn() } } };

// We need to add the fake client to the openaiClients map
import { addOpenAIClient, clearOpenAIClients } from '../providers/openai.js';

describe('chatWithToolsOpenAI unified loop gating', () => {
  const baseConfig = {
    gateway: { port: 18790, mode: 'local' },
    agents: { default: 'main', list: {} },
    models: { providers: { testprovider: { apiKey: 'test' } }, aliases: {} },
    channels: { telegram: { enabled: false, token: 't', allowFrom: [] } },
    cron: { jobs: [] },
    heartbeat: { intervalMs: 300000, prompt: 'HEARTBEAT' },
  } as Config;

  const baseToolConfig = {
    enabled: true,
    allowedPaths: ['/tmp'],
    maxIterations: 10,
  } as ToolConfig;

  it('uses unified runToolLoop', async () => {
    mockRunToolLoop.mockResolvedValueOnce({ response: 'unified', toolCalls: [] });
    addOpenAIClient('testprovider', fakeClient as any);

    const result = await chatWithToolsOpenAI({
      messages: [{ role: 'user', content: 'hi' }],
      options: { model: 'testprovider/gpt-4o' },
      config: baseConfig,
      toolConfig: baseToolConfig,
    }, 'testprovider');

    expect(mockRunToolLoop).toHaveBeenCalledOnce();
    expect(result.response).toBe('unified');

    clearOpenAIClients();
  });
});
