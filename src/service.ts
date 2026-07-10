import type { FastifyInstance } from 'fastify';
import type { Config } from './types.js';
import { createGateway } from './gateway.js';
import { initCron, stopCron } from './cron.js';
import { initHeartbeat, stopHeartbeat } from './heartbeat.js';
import { initActiveChannel, startActiveChannel, stopActiveChannel } from './channels.js';
import { initProviders } from './agent.js';
import { initLangfuse, shutdownLangfuse } from './langfuse.js';
import { cleanupMcp, restoreCodeAgentTasks, setCodeAgentConfig } from './tools.js';
import { cleanupLogs, formatCleanupSummary } from './log-cleanup.js';

export interface SkimpyClawRuntime {
  config: Config;
  gateway: FastifyInstance;
  stop: () => Promise<void>;
}

export async function startRuntime(config: Config): Promise<SkimpyClawRuntime> {
  const smokeTest = process.env.SKIMPYCLAW_SMOKE_TEST === '1';

  initLangfuse(config);
  initProviders(config);
  restoreCodeAgentTasks(config.codeAgents?.worktrees ?? {});
  setCodeAgentConfig(config);
  const cleanup = cleanupLogs();
  if (cleanup.deletedFiles > 0 || cleanup.deletedDirs > 0 || cleanup.errors.length > 0) {
    console.log(`[logs] ${formatCleanupSummary(cleanup)}`);
  }

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

  let stopPromise: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (!stopPromise) {
      stopPromise = (async () => {
        const errors: unknown[] = [];
        const close = async (resource: () => void | Promise<void>) => {
          try {
            await resource();
          } catch (error) {
            errors.push(error);
          }
        };

        await close(() => stopCron());
        await close(() => stopHeartbeat());
        await close(() => stopActiveChannel());
        await close(() => cleanupMcp());
        await close(() => gateway.close());
        await close(() => shutdownLangfuse());
        if (errors.length > 0) {
          throw new AggregateError(errors, 'Runtime shutdown failed');
        }
      })();
    }
    return stopPromise;
  };

  return {
    config,
    gateway,
    stop,
  };
}
