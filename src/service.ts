import type { FastifyInstance } from 'fastify';
import type { Config } from './types.js';
import { createGateway } from './gateway.js';
import { initCron, stopCron } from './cron.js';
import { initHeartbeat, stopHeartbeat } from './heartbeat.js';
import { initTelegram, startTelegram, stopTelegram } from './telegram.js';
import { initProviders } from './agent.js';

export interface SkimpyClawRuntime {
  config: Config;
  gateway: FastifyInstance;
  stop: () => Promise<void>;
}

export async function startRuntime(config: Config): Promise<SkimpyClawRuntime> {
  initProviders(config);

  const gateway = await createGateway(config);
  await gateway.listen({ port: config.gateway.port, host: '127.0.0.1' });

  initCron(config);
  initHeartbeat(config);

  const telegramBot = await initTelegram(config);
  if (telegramBot) {
    await startTelegram();
  }

  return {
    config,
    gateway,
    stop: async () => {
      stopCron();
      stopHeartbeat();
      await stopTelegram();
      await gateway.close();
    },
  };
}
