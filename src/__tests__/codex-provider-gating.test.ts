import { describe, expect, it, vi } from 'vitest';
import type { Config, ToolConfig } from '../types.js';
import { chatWithToolsCodex } from '../providers/codex.js';

const { mockRunToolLoop } = vi.hoisted(() => ({
  mockRunToolLoop: vi.fn(),
}));

vi.mock('../providers/tool-loop.js', () => ({
  runToolLoop: mockRunToolLoop,
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

  it('uses unified runToolLoop with maxIterations default of 100', async () => {
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
});
