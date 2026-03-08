import { describe, expect, it, vi } from 'vitest';
import type { Config, ToolConfig } from '../types.js';
import { chatWithToolsOpenAI } from '../providers/openai.js';

const { mockRunToolLoop } = vi.hoisted(() => ({
  mockRunToolLoop: vi.fn(),
}));

vi.mock('../providers/tool-loop.js', () => ({
  runToolLoop: mockRunToolLoop,
}));

// Mock tools module so the legacy path doesn't need real tool definitions
vi.mock('../tools.js', () => ({
  getToolDefinitions: vi.fn().mockResolvedValue([]),
  executeTool: vi.fn().mockResolvedValue('ok'),
}));

// Mock audit module
vi.mock('../audit.js', () => ({
  startTrace: vi.fn().mockReturnValue('trace-gating'),
  addEvent: vi.fn(),
  endTrace: vi.fn().mockResolvedValue(undefined),
}));

// Mock the OpenAI client module internals for legacy path
vi.mock('openai', () => ({
  default: class {},
}));

// Provide a fake OpenAI client for the provider
const mockCreate = vi.fn();
const fakeClient = { chat: { completions: { create: mockCreate } } };

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

  it('uses unified runToolLoop by default', async () => {
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

  it('falls back to legacy loop when unifiedToolLoop is false', async () => {
    mockRunToolLoop.mockReset();
    addOpenAIClient('testprovider', fakeClient as any);
    const abortController = new AbortController();
    abortController.abort();

    const result = await chatWithToolsOpenAI({
      messages: [{ role: 'user', content: 'hi' }],
      options: { model: 'testprovider/gpt-4o' },
      config: {
        ...baseConfig,
        experimental: { unifiedToolLoop: false },
      },
      toolConfig: baseToolConfig,
      toolContext: { abortSignal: abortController.signal },
    }, 'testprovider');

    expect(mockRunToolLoop).not.toHaveBeenCalled();
    // Legacy path returns cancelled because we aborted
    expect(result.response).toContain('Cancelled');

    clearOpenAIClients();
  });
});
