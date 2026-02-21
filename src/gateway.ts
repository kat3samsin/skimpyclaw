// Gateway HTTP server for health checks and control

import Fastify, { FastifyInstance } from 'fastify';
import { join } from 'path';
import type { Config, GatewayStatus } from './types.js';
import { runAgentTurn } from './agent.js';
import { getCronJobs, runCronJob } from './cron.js';
import { registerDashboardAPI } from './api.js';
import { registerDashboard } from './dashboard.js';
import { ensureDashboardToken } from './config.js';

let config: Config;
let startTime: Date;
let lastMessage: Date | undefined;
let currentModel: string;

export async function createGateway(cfg: Config): Promise<FastifyInstance> {
  config = cfg;
  startTime = new Date();
  currentModel = cfg.agents.list[cfg.agents.default]?.model || 'claude-sonnet-4-5';

  const fastify = Fastify({
    logger: {
      level: 'info',
    },
  });

  // Health check
  fastify.get('/health', async () => {
    return { status: 'ok', uptime: Date.now() - startTime.getTime() };
  });

  // Status
  fastify.get('/status', async (): Promise<GatewayStatus> => {
    const jobs = getCronJobs();
    return {
      status: 'ok',
      uptime: Date.now() - startTime.getTime(),
      agent: config.agents.default,
      model: currentModel,
      lastMessage,
      cronJobs: jobs.map(j => ({
        id: j.id,
        name: j.name,
        nextRun: j.nextRun,
      })),
    };
  });

  // Send message to agent
  fastify.post<{
    Body: { message: string; model?: string };
  }>('/message', async (request, reply) => {
    const { message, model } = request.body;
    if (!message) {
      return reply.code(400).send({ error: 'message required' });
    }

    try {
      const response = await runAgentTurn(
        config.agents.default,
        message,
        config,
        model || currentModel,
        undefined,
        undefined,
        {
          channel: 'gateway',
          metadata: { ip: request.ip },
        }
      );
      lastMessage = new Date();
      return { response };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(500).send({ error: msg });
    }
  });

  // Switch model
  fastify.post<{
    Body: { model: string };
  }>('/model', async (request, reply) => {
    const { model } = request.body;
    if (!model) {
      return reply.code(400).send({ error: 'model required' });
    }

    currentModel = model;
    return { model: currentModel };
  });

  // Trigger cron job
  fastify.post<{
    Params: { id: string };
  }>('/cron/:id/run', async (request, reply) => {
    const { id } = request.params;

    try {
      await runCronJob(id, config);
      return { status: 'triggered', id };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(404).send({ error: msg });
    }
  });

  // Reload config (placeholder - requires restart for now)
  fastify.post('/reload', async () => {
    return { status: 'ok', note: 'Restart required for config changes' };
  });

  // Ensure dashboard token exists and print it
  const dashboardToken = ensureDashboardToken(config);
  console.log(`[dashboard] Access token: ${dashboardToken}`);
  console.log(`[dashboard] URL: http://localhost:${config.gateway.port}/dashboard`);

  // Register dashboard API routes (includes auth hook)
  registerDashboardAPI(fastify, config);

  // Register dashboard frontend (legacy inline HTML or built framework app)
  registerDashboard(fastify, {
    mode: config.dashboard?.frontend === 'legacy' ? 'legacy' : 'framework',
    frameworkDistDir: join(process.cwd(), 'dist', 'dashboard'),
    botName: config.agents.list[config.agents.default]?.identity?.name || 'SkimpyClaw',
    botEmoji: config.agents.list[config.agents.default]?.identity?.emoji || '👙🦞',
  });

  return fastify;
}

export function getCurrentModel(): string {
  return currentModel;
}

export function setCurrentModel(model: string): void {
  currentModel = model;
}

export function getLastMessage(): Date | undefined {
  return lastMessage;
}

export function setLastMessage(date: Date): void {
  lastMessage = date;
}
