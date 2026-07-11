import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  gateway: {
    listen: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  },
  stopCron: vi.fn(),
  initCron: vi.fn(),
  stopHeartbeat: vi.fn(),
  initHeartbeat: vi.fn(),
  stopActiveChannel: vi.fn(async () => {}),
  initActiveChannel: vi.fn(async () => null),
  startActiveChannel: vi.fn(async () => {}),
  cleanupMcp: vi.fn(async () => {}),
  restoreCodeAgentTasks: vi.fn(),
  setCodeAgentConfig: vi.fn(),
  initProviders: vi.fn(),
  initLangfuse: vi.fn(),
  shutdownLangfuse: vi.fn(async () => {}),
  cleanupLogs: vi.fn(() => ({ deletedFiles: 0, deletedDirs: 0, errors: [] })),
}));

vi.mock('../gateway.js', () => ({
  createGateway: vi.fn(async () => mocks.gateway),
}));

vi.mock('../cron.js', () => ({
  initCron: mocks.initCron,
  stopCron: mocks.stopCron,
}));

vi.mock('../heartbeat.js', () => ({
  initHeartbeat: mocks.initHeartbeat,
  stopHeartbeat: mocks.stopHeartbeat,
}));

vi.mock('../channels.js', () => ({
  initActiveChannel: mocks.initActiveChannel,
  startActiveChannel: mocks.startActiveChannel,
  stopActiveChannel: mocks.stopActiveChannel,
}));

vi.mock('../agent.js', () => ({ initProviders: mocks.initProviders }));

vi.mock('../langfuse.js', () => ({
  initLangfuse: mocks.initLangfuse,
  shutdownLangfuse: mocks.shutdownLangfuse,
}));

vi.mock('../tools.js', () => ({
  restoreCodeAgentTasks: mocks.restoreCodeAgentTasks,
  setCodeAgentConfig: mocks.setCodeAgentConfig,
  cleanupMcp: mocks.cleanupMcp,
}));

vi.mock('../log-cleanup.js', () => ({
  cleanupLogs: mocks.cleanupLogs,
  formatCleanupSummary: vi.fn(() => ''),
}));

import { startRuntime } from '../service.js';

describe('runtime shutdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.SKIMPYCLAW_SMOKE_TEST;
    delete process.env.SKIMPYCLAW_SMOKE_PORT;
  });

  it('does not initialize persistent subsystems in smoke mode', async () => {
    process.env.SKIMPYCLAW_SMOKE_TEST = '1';
    process.env.SKIMPYCLAW_SMOKE_PORT = '19998';
    const config = {
      gateway: { port: 18790, host: '127.0.0.1', mode: 'local' },
      agents: { default: 'main', list: { main: { model: 'test' } } },
      models: { providers: {}, aliases: {} },
      channels: {
        telegram: { enabled: false, allowFrom: [] },
        discord: { enabled: false, allowFrom: [] },
      },
      cron: { jobs: [] },
      heartbeat: { intervalMs: 60_000, prompt: 'heartbeat' },
    } as any;

    const runtime = await startRuntime(config);

    expect(mocks.gateway.listen).toHaveBeenCalledWith({ port: 19998, host: '127.0.0.1' });
    expect(mocks.initLangfuse).not.toHaveBeenCalled();
    expect(mocks.initProviders).not.toHaveBeenCalled();
    expect(mocks.restoreCodeAgentTasks).not.toHaveBeenCalled();
    expect(mocks.setCodeAgentConfig).not.toHaveBeenCalled();
    expect(mocks.cleanupLogs).not.toHaveBeenCalled();
    expect(mocks.initCron).not.toHaveBeenCalled();
    expect(mocks.initActiveChannel).not.toHaveBeenCalled();
    expect(mocks.startActiveChannel).not.toHaveBeenCalled();
    expect(mocks.initHeartbeat).not.toHaveBeenCalled();

    await runtime.stop();
    expect(mocks.stopCron).not.toHaveBeenCalled();
    expect(mocks.stopHeartbeat).not.toHaveBeenCalled();
    expect(mocks.stopActiveChannel).not.toHaveBeenCalled();
    expect(mocks.cleanupMcp).not.toHaveBeenCalled();
    expect(mocks.shutdownLangfuse).not.toHaveBeenCalled();
    expect(mocks.gateway.close).toHaveBeenCalledOnce();
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
