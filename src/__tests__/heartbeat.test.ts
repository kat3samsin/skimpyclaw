import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRunAgentTurn } = vi.hoisted(() => ({
  mockRunAgentTurn: vi.fn(),
}));

vi.mock('../agent.js', () => ({
  runAgentTurn: mockRunAgentTurn,
}));

vi.mock('../channels.js', () => ({
  getActiveChannelId: () => 'telegram',
  isActiveChannelSilenced: () => false,
  sendActiveChannelProactiveMessage: vi.fn(async () => true),
}));

import { initHeartbeat, runHeartbeatCheck, stopHeartbeat } from '../heartbeat.js';

describe('heartbeat prompt path normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunAgentTurn.mockResolvedValue('HEARTBEAT_OK');
  });

  afterEach(() => {
    stopHeartbeat();
    vi.useRealTimers();
  });

  it('normalizes legacy heartbeat file path to agents/main/HEARTBEAT.md', async () => {
    const config = {
      agents: { default: 'main' },
      heartbeat: {
        intervalMs: 60000,
        prompt: 'Read /Users/example/HEARTBEAT.md only. Reply HEARTBEAT_OK.',
        model: 'anthropic/claude-haiku-4-5',
        tools: {
          enabled: true,
          allowedPaths: ['/Users/example/.skimpyclaw'],
          maxIterations: 10,
          bashTimeout: 15000,
        },
      },
      channels: {
        active: 'telegram',
        telegram: {
          defaultAllowedPaths: ['/Users/example/.skimpyclaw'],
        },
      },
    } as any;

    await runHeartbeatCheck(config);

    expect(mockRunAgentTurn).toHaveBeenCalledTimes(1);
    expect(mockRunAgentTurn).toHaveBeenCalledWith(
      'main',
      expect.stringContaining('/.skimpyclaw/agents/main/HEARTBEAT.md'),
      config,
      'anthropic/claude-haiku-4-5',
      expect.any(Object),
      undefined,
      expect.any(Object)
    );
  });

  it('normalizes /workspace heartbeat path to agents/main/HEARTBEAT.md', async () => {
    const config = {
      agents: { default: 'main' },
      heartbeat: {
        intervalMs: 60000,
        prompt: 'Read /workspace/HEARTBEAT.md only. Reply HEARTBEAT_OK.',
        model: 'anthropic/claude-haiku-4-5',
        tools: {
          enabled: true,
          allowedPaths: ['/Users/example/.skimpyclaw'],
          maxIterations: 10,
          bashTimeout: 15000,
        },
      },
      channels: {
        active: 'telegram',
        telegram: {
          defaultAllowedPaths: ['/Users/example/.skimpyclaw'],
        },
      },
    } as any;

    await runHeartbeatCheck(config);

    expect(mockRunAgentTurn).toHaveBeenCalledTimes(1);
    const promptArg = mockRunAgentTurn.mock.calls[0][1];
    expect(promptArg).toContain('/.skimpyclaw/agents/main/HEARTBEAT.md');
    expect(promptArg).not.toContain('/workspace/HEARTBEAT.md');
  });

  it('cancels the initial check on stop and replaces it on reinit', async () => {
    vi.useFakeTimers();
    const oldConfig = {
      agents: { default: 'main' },
      heartbeat: {
        intervalMs: 60000,
        prompt: 'old heartbeat',
        model: 'anthropic/claude-haiku-4-5',
      },
      channels: {
        active: 'telegram',
        telegram: { defaultAllowedPaths: ['/tmp'] },
      },
    } as any;

    initHeartbeat(oldConfig);
    stopHeartbeat();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockRunAgentTurn).not.toHaveBeenCalled();

    const newConfig = {
      ...oldConfig,
      heartbeat: { ...oldConfig.heartbeat, prompt: 'new heartbeat' },
    } as any;
    initHeartbeat(newConfig);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockRunAgentTurn).toHaveBeenCalledTimes(1);
    expect(mockRunAgentTurn.mock.calls[0][2]).toBe(newConfig);
  });
});
