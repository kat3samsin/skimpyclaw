import type { FastifyInstance } from 'fastify';
import type { Config } from './types.js';
import { createGateway } from './gateway.js';
import { initCron, stopCron } from './cron.js';
import { initHeartbeat, stopHeartbeat } from './heartbeat.js';
import { initActiveChannel, startActiveChannel, stopActiveChannel } from './channels.js';
import { initProviders } from './agent.js';
import { initLangfuse, shutdownLangfuse } from './langfuse.js';

export interface SkimpyClawRuntime {
  config: Config;
  gateway: FastifyInstance;
  stop: () => Promise<void>;
}

export async function startRuntime(config: Config): Promise<SkimpyClawRuntime> {
  initLangfuse(config);
  initProviders(config);

  const gateway = await createGateway(config);
  await gateway.listen({ port: config.gateway.port, host: '127.0.0.1' });

  initCron(config);

  await initActiveChannel(config);
  await startActiveChannel();
  initHeartbeat(config);

  return {
    config,
    gateway,
    stop: async () => {
      stopCron();
      stopHeartbeat();
      await stopActiveChannel();
      await gateway.close();
      await shutdownLangfuse();
    },
  };
}
