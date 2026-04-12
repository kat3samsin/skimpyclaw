// Newspaper API routes — registered under /api/newspaper/*

import type { FastifyInstance } from 'fastify';
import type { Config } from '../types.js';
import type { Section } from './types.js';
import { ALL_SECTIONS } from './types.js';
import { buildAndSaveEdition } from './edition-builder.js';
import {
  getEdition,
  getTodayEdition,
  getLatestEdition,
  listEditions,
  updateArticleRead,
  cleanupOldEditions,
} from './storage.js';

export function registerNewspaperAPI(fastify: FastifyInstance, config: Config): void {
  // GET /api/newspaper/today — get today's edition (or latest)
  fastify.get('/api/newspaper/today', async (_request, reply) => {
    const edition = getTodayEdition() || getLatestEdition();
    if (!edition) {
      return reply.code(404).send({ error: 'No edition available' });
    }
    return edition;
  });

  // GET /api/newspaper/edition/:id — get a specific edition
  fastify.get<{ Params: { id: string } }>('/api/newspaper/edition/:id', async (request, reply) => {
    const edition = getEdition(request.params.id);
    if (!edition) {
      return reply.code(404).send({ error: 'Edition not found' });
    }
    return edition;
  });

  // GET /api/newspaper/archive — list editions
  fastify.get<{ Querystring: { limit?: string; offset?: string } }>(
    '/api/newspaper/archive',
    async (request) => {
      const qs = request.query as { limit?: string; offset?: string };
      const limit = parseInt(qs.limit || '30', 10);
      const offset = parseInt(qs.offset || '0', 10);
      return { editions: listEditions(limit, offset) };
    },
  );

  // POST /api/newspaper/build — manually trigger edition build (same pipeline as cron).
  // Auth: requires Bearer token (enforced by gateway auth hook).
  // Body: { hoursBack?: number (default 14), slot?: "morning"|"evening" (auto-detected if omitted) }
  // Response: { success: true, editionId, articleCount, slot } or 500 with error detail.
  // UI: "Build Now" button in the newspaper frontend calls this endpoint.
  fastify.post<{ Body: { hoursBack?: number; slot?: string } }>(
    '/api/newspaper/build',
    async (request, reply) => {
      try {
        const body = (request.body || {}) as { hoursBack?: number; slot?: string };
        const newspaperConfig = (config as any).newspaper || {};
        const edition = await buildAndSaveEdition({
          hoursBack: body.hoursBack ?? 14,
          slot: body.slot as any,
          maxPerSection: newspaperConfig.maxArticlesPerSection ?? 10,
          blockedDomains: newspaperConfig.blockedDomains ?? [],
        });
        return {
          success: true,
          editionId: edition.id,
          articleCount: edition.articles.length,
          slot: edition.slot,
        };
      } catch (err: any) {
        console.error('[newspaper] Build failed:', err);
        return reply.code(500).send({ error: 'Edition build failed', detail: err.message });
      }
    },
  );

  // POST /api/newspaper/edition/:editionId/articles/:articleId/read — toggle read state
  fastify.post<{ Params: { editionId: string; articleId: string }; Body: { read: boolean } }>(
    '/api/newspaper/edition/:editionId/articles/:articleId/read',
    async (request, reply) => {
      const { editionId, articleId } = request.params;
      const body = (request.body || {}) as { read?: boolean };
      const read = body.read !== false; // default to true
      const success = updateArticleRead(editionId, articleId, read);
      if (!success) {
        return reply.code(404).send({ error: 'Edition or article not found' });
      }
      return { success: true };
    },
  );

  // POST /api/newspaper/cleanup — remove old editions
  fastify.post('/api/newspaper/cleanup', async () => {
    const newspaperConfig = (config as any).newspaper || {};
    const retentionDays = newspaperConfig.retentionDays ?? 90;
    const deleted = cleanupOldEditions(retentionDays);
    return { success: true, deleted };
  });
}
