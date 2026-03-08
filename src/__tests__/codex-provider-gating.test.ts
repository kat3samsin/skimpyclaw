import { describe, expect, it, vi } from 'vitest';
import type { Config, ToolConfig } from '../types.js';
import { chatWithToolsCodex } from '../providers/codex.js';

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

describe('chatWithToolsCodex unified loop gating', () => {
  const baseConfig = {
    gateway: { port: 18790, mode: 'local' },
    agents: { default: 'main', list: {} },
    models: { providers: {}, aliases: {} },
    channels: { telegram: { enabled: false, token: 't', allowFrom: [] } },
    cron: { jobs: [] },
    heartbeat: { intervalMs: 300000, prompt: 'HEARTBEAT' },
  } as Config;

  const baseToolConfig = {
    enabled: true,
    allowedPaths: ['/tmp'],
    maxIterations: 0,
  } as ToolConfig;

  it('uses unified runToolLoop by default', async () => {
    mockRunToolLoop.mockResolvedValueOnce({ response: 'unified', toolCalls: [] });

    const result = await chatWithToolsCodex({
      messages: [{ role: 'user', content: 'hi' }],
      options: { model: 'codex/gpt-5.3-codex' },
      config: baseConfig,
      toolConfig: baseToolConfig,
    });

    expect(mockRunToolLoop).toHaveBeenCalledOnce();
    expect(mockRunToolLoop.mock.calls[0][4].maxIterations).toBe(100);
    expect(result.response).toBe('unified');
  });

  it('falls back to legacy loop when unifiedToolLoop is false', async () => {
    mockRunToolLoop.mockReset();
    const abortController = new AbortController();
    abortController.abort();

    const result = await chatWithToolsCodex({
      messages: [{ role: 'user', content: 'hi' }],
      options: { model: 'codex/gpt-5.3-codex' },
      config: {
        ...baseConfig,
        experimental: { unifiedToolLoop: false },
      },
      toolConfig: baseToolConfig,
      toolContext: { abortSignal: abortController.signal },
    });

    expect(mockRunToolLoop).not.toHaveBeenCalled();
    expect(result.response).toContain('Cancelled');
  });
});
