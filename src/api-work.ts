import type { FastifyInstance } from 'fastify';
import { validateBearerToken } from './utils.js';
import type { Config } from './types.js';
import {
  listWorkItems,
  getWorkItem,
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
}
