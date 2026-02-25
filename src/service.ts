import type { FastifyInstance } from 'fastify';
import type { Config } from './types.js';
import { createGateway } from './gateway.js';
import { initCron, stopCron } from './cron.js';
import { initHeartbeat, stopHeartbeat } from './heartbeat.js';
import { initActiveChannel, startActiveChannel, stopActiveChannel } from './channels.js';
import { initProviders } from './agent.js';
import { initLangfuse, shutdownLangfuse } from './langfuse.js';
import { restoreCodeAgentTasks, setCodeAgentConfig } from './tools.js';
import { releaseAll, cleanupOrphans, setRuntime } from './sandbox/index.js';

export interface SkimpyClawRuntime {
  config: Config;
  gateway: FastifyInstance;
  stop: () => Promise<void>;
}

export async function startRuntime(config: Config): Promise<SkimpyClawRuntime> {
  const smokeTest = process.env.SKIMPYCLAW_SMOKE_TEST === '1';

  initLangfuse(config);
  initProviders(config);
  restoreCodeAgentTasks();
  setCodeAgentConfig(config);

  // Initialize sandbox runtime if configured
  if (config.sandbox?.runtime) {
    setRuntime(config.sandbox.runtime);
  }

  // Clean up orphaned sandbox containers from previous runs
  cleanupOrphans().catch(() => {});

  const port = smokeTest ? (parseInt(process.env.SKIMPYCLAW_SMOKE_PORT || '19999', 10)) : config.gateway.port;
  const gateway = await createGateway(config);
  const host = config.gateway.host ?? '127.0.0.1';
  await gateway.listen({ port, host });

  if (!smokeTest) {
    initCron(config);
    await initActiveChannel(config);
    await startActiveChannel();
    initHeartbeat(config);
  } else {
    console.log('[smoke-test] Skipping channels, cron, and heartbeat');
  }

  return {
    config,
    gateway,
    stop: async () => {
      await releaseAll();
      stopCron();
      stopHeartbeat();
      await stopActiveChannel();
      await gateway.close();
      await shutdownLangfuse();
    },
  };
}
