import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { runHeartbeatCheck } from '../heartbeat.js';

describe('heartbeat prompt path normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunAgentTurn.mockResolvedValue('HEARTBEAT_OK');
  });

  it('normalizes legacy heartbeat file path to agents/main/HEARTBEAT.md', async () => {
    const config = {
      agents: { default: 'main' },
      heartbeat: {
        intervalMs: 60000,
        prompt: 'Read /Users/example/HEARTBEAT.md only. Reply HEARTBEAT_OK.',
        model: 'claude-fast',
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
      'claude-fast',
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
        model: 'claude-fast',
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
});
