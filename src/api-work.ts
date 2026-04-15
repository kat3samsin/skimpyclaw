import type { FastifyInstance } from 'fastify';
import { validateBearerToken } from './utils.js';
import type { Config } from './types.js';
import {
  listWorkItems,
  getWorkItem,
  createWorkItem,
  appendUserMessage,
  approvePlan,
  pauseWorkItem,
  resumeWorkItem,
  stopWorkItem,
  tickWorkItem,
} from './code-agents/review-loop.js';
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from './code-agents/review-loop-types.js';

const WORK_ID_RE = /^RL-\d{3,}$/;

function isValidWorkId(id: string): boolean {
  return WORK_ID_RE.test(id);
}

export function registerWorkAPI(fastify: FastifyInstance, config: Config): void {
  const runtimeConfig = config;

  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/dashboard/work')) return;
    const token = runtimeConfig.dashboard?.token;
    if (!token) return;
    if (!validateBearerToken(token, request.headers.authorization)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  fastify.get('/api/dashboard/work', async (request) => {
    const q = request.query as { status?: string };
    const all = listWorkItems();
    let filtered = all;
    if (q.status === 'active') {
      filtered = all.filter(i => ACTIVE_STATUSES.includes(i.status));
    } else if (q.status === 'done') {
      filtered = all.filter(i => TERMINAL_STATUSES.includes(i.status));
    }
    return { items: filtered };
  });

  fastify.get('/api/dashboard/work/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidWorkId(id)) {
      return reply.code(400).send({ error: 'invalid id format' });
    }
    const item = getWorkItem(id);
    if (!item) return reply.code(404).send({ error: 'not found' });
    return item;
  });

  fastify.post('/api/dashboard/work', async (request, reply) => {
    const body = request.body as any;
    if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
      return reply.code(400).send({ error: 'prompt is required' });
    }
    if (typeof body.workdir !== 'string' || !body.workdir.trim()) {
      return reply.code(400).send({ error: 'workdir is required' });
    }
    const state = createWorkItem({
      prompt: body.prompt,
      workdir: body.workdir,
      baseRef: typeof body.baseRef === 'string' ? body.baseRef : undefined,
      plannerModel: typeof body.plannerModel === 'string' ? body.plannerModel : undefined,
      devModel: typeof body.devModel === 'string' ? body.devModel : undefined,
      reviewerModel: typeof body.reviewerModel === 'string' ? body.reviewerModel : undefined,
      maxIterations: typeof body.maxIterations === 'number' ? body.maxIterations : undefined,
    });
    void tickWorkItem(state.id).catch(err => console.error('[api-work] tick error:', err));
    return reply.code(201).send(state);
  });

  fastify.post('/api/dashboard/work/:id/chat', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidWorkId(id)) return reply.code(400).send({ error: 'invalid id' });
    const body = request.body as any;
    if (!body || typeof body.content !== 'string' || !body.content.trim()) {
      return reply.code(400).send({ error: 'content is required' });
    }
    const state = appendUserMessage(id, body.content);
    if (!state) return reply.code(404).send({ error: 'not found' });
    void tickWorkItem(id).catch(err => console.error('[api-work] tick error:', err));
    return state;
  });

  fastify.post('/api/dashboard/work/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidWorkId(id)) return reply.code(400).send({ error: 'invalid id' });
    const state = approvePlan(id);
    if (!state) {
      const existing = getWorkItem(id);
      if (!existing) return reply.code(404).send({ error: 'not found' });
      return reply.code(409).send({ error: `cannot approve from status ${existing.status}` });
    }
    void tickWorkItem(id).catch(err => console.error('[api-work] tick error:', err));
    return state;
  });

  fastify.post('/api/dashboard/work/:id/pause', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidWorkId(id)) return reply.code(400).send({ error: 'invalid id' });
    const state = pauseWorkItem(id);
    if (!state) return reply.code(404).send({ error: 'not found' });
    return state;
  });

  fastify.post('/api/dashboard/work/:id/resume', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidWorkId(id)) return reply.code(400).send({ error: 'invalid id' });
    const state = resumeWorkItem(id);
    if (!state) return reply.code(404).send({ error: 'not found' });
    void tickWorkItem(id).catch(err => console.error('[api-work] tick error:', err));
    return state;
  });

  fastify.post('/api/dashboard/work/:id/stop', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidWorkId(id)) return reply.code(400).send({ error: 'invalid id' });
    const body = request.body as any;
    const reason = body && typeof body.reason === 'string' ? body.reason : undefined;
    const state = stopWorkItem(id, reason);
    if (!state) return reply.code(404).send({ error: 'not found' });
    return state;
  });
}
