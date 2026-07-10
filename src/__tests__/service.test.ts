import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  gateway: {
    listen: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  },
  stopCron: vi.fn(),
  stopHeartbeat: vi.fn(),
  stopActiveChannel: vi.fn(async () => {}),
  cleanupMcp: vi.fn(async () => {}),
  shutdownLangfuse: vi.fn(async () => {}),
}));

vi.mock('../gateway.js', () => ({
  createGateway: vi.fn(async () => mocks.gateway),
}));

vi.mock('../cron.js', () => ({
  initCron: vi.fn(),
  stopCron: mocks.stopCron,
}));

vi.mock('../heartbeat.js', () => ({
  initHeartbeat: vi.fn(),
  stopHeartbeat: mocks.stopHeartbeat,
}));

vi.mock('../channels.js', () => ({
  initActiveChannel: vi.fn(async () => null),
  startActiveChannel: vi.fn(async () => {}),
  stopActiveChannel: mocks.stopActiveChannel,
}));

vi.mock('../agent.js', () => ({ initProviders: vi.fn() }));

vi.mock('../langfuse.js', () => ({
  initLangfuse: vi.fn(),
  shutdownLangfuse: mocks.shutdownLangfuse,
}));

vi.mock('../tools.js', () => ({
  restoreCodeAgentTasks: vi.fn(),
  setCodeAgentConfig: vi.fn(),
  cleanupMcp: mocks.cleanupMcp,
}));

vi.mock('../log-cleanup.js', () => ({
  cleanupLogs: vi.fn(() => ({ deletedFiles: 0, deletedDirs: 0, errors: [] })),
  formatCleanupSummary: vi.fn(() => ''),
}));

import { startRuntime } from '../service.js';

describe('runtime shutdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes every owned resource once and includes MCP cleanup', async () => {
    const config = {
      gateway: { port: 18790, host: '127.0.0.1', mode: 'local' },
      agents: { default: 'main', list: { main: { model: 'test' } } },
      channels: {
        telegram: { enabled: false, allowFrom: [] },
        discord: { enabled: false, allowFrom: [] },
      },
      cron: { jobs: [] },
      heartbeat: { intervalMs: 60_000, prompt: 'heartbeat' },
    } as any;
    const runtime = await startRuntime(config);

    const firstStop = runtime.stop();
    const secondStop = runtime.stop();
    expect(secondStop).toBe(firstStop);
    await Promise.all([firstStop, secondStop]);

    expect(mocks.stopCron).toHaveBeenCalledTimes(1);
    expect(mocks.stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(mocks.stopActiveChannel).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupMcp).toHaveBeenCalledTimes(1);
    expect(mocks.gateway.close).toHaveBeenCalledTimes(1);
    expect(mocks.shutdownLangfuse).toHaveBeenCalledTimes(1);

    expect(mocks.stopCron.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.stopHeartbeat.mock.invocationCallOrder[0]);
    expect(mocks.stopHeartbeat.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.stopActiveChannel.mock.invocationCallOrder[0]);
    expect(mocks.stopActiveChannel.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.cleanupMcp.mock.invocationCallOrder[0]);
    expect(mocks.cleanupMcp.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.gateway.close.mock.invocationCallOrder[0]);
    expect(mocks.gateway.close.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.shutdownLangfuse.mock.invocationCallOrder[0]);
  });

  it('continues closing later resources after a shutdown failure', async () => {
    mocks.stopActiveChannel.mockRejectedValueOnce(new Error('channel stop failed'));
    const config = {
      gateway: { port: 18790, host: '127.0.0.1', mode: 'local' },
      agents: { default: 'main', list: { main: { model: 'test' } } },
      channels: {
        telegram: { enabled: false, allowFrom: [] },
        discord: { enabled: false, allowFrom: [] },
      },
      cron: { jobs: [] },
      heartbeat: { intervalMs: 60_000, prompt: 'heartbeat' },
    } as any;
    const runtime = await startRuntime(config);

    const firstStop = runtime.stop();
    const secondStop = runtime.stop();
    expect(secondStop).toBe(firstStop);
    await expect(firstStop).rejects.toThrow('Runtime shutdown failed');
    await expect(secondStop).rejects.toThrow('Runtime shutdown failed');

    expect(mocks.stopActiveChannel).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupMcp).toHaveBeenCalledTimes(1);
    expect(mocks.gateway.close).toHaveBeenCalledTimes(1);
    expect(mocks.shutdownLangfuse).toHaveBeenCalledTimes(1);
  });
});
