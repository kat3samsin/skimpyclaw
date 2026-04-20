import type { FastifyInstance } from 'fastify';
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './types.js';
import { createGateway } from './gateway.js';
import { initCron, stopCron } from './cron.js';
import { initHeartbeat, stopHeartbeat } from './heartbeat.js';
import { initActiveChannel, startActiveChannel, stopActiveChannel } from './channels.js';
import { initProviders } from './agent.js';
import { initLangfuse, shutdownLangfuse } from './langfuse.js';
import { restoreCodeAgentTasks, setCodeAgentConfig } from './tools.js';

export interface SkimpyClawRuntime {
  config: Config;
  gateway: FastifyInstance;
  stop: () => Promise<void>;
}

/** Clean up old scratch files (observation masking). Keeps files < 24h. */
function cleanupScratch(): void {
  try {
    const dir = join(homedir(), '.skimpyclaw', 'scratch');
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let count = 0;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try {
        if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); count++; }
      } catch { /* skip */ }
    }
    if (count > 0) console.log(`[scratch] Cleaned up ${count} old file(s)`);
  } catch { /* dir doesn't exist yet, fine */ }
}

export async function startRuntime(config: Config): Promise<SkimpyClawRuntime> {
  const smokeTest = process.env.SKIMPYCLAW_SMOKE_TEST === '1';

  initLangfuse(config);
  initProviders(config);
  restoreCodeAgentTasks();
  setCodeAgentConfig(config);
  cleanupScratch();

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
      stopCron();
      stopHeartbeat();
      await stopActiveChannel();
      await gateway.close();
      await shutdownLangfuse();
    },
  };
}
