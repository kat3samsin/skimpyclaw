import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Stub the agent executor and registry so createWorkItem runs without real I/O beyond our tmp dir.
vi.mock('../code-agents/executor.js', () => ({
  runCodeAgentBackground: vi.fn(async () => {}),
}));
vi.mock('../code-agents/registry.js', () => ({
  getNextCodeAgentId: vi.fn(() => 'ca-1'),
  storeCodeAgentTask: vi.fn(() => {}),
  writeCodeAgentTask: vi.fn(() => {}),
  getCodeAgent: vi.fn(() => ({
    id: 'ca-1', status: 'completed', outputPreview: 'x',
    agent: 'claude', task: 't', startedAt: new Date().toISOString(), workdir: '/r',
  })),
}));

import { setWorkRootForTesting } from '../code-agents/review-loop-storage.js';
import { createWorkItem } from '../code-agents/review-loop.js';
import { registerWorkAPI } from '../api-work.js';

const AUTH = { authorization: 'Bearer test-token' };
let app: FastifyInstance;
let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'api-work-'));
  setWorkRootForTesting(tmp);
  app = Fastify();
  registerWorkAPI(app, { dashboard: { token: 'test-token' } } as any);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(tmp, { recursive: true, force: true });
  setWorkRootForTesting(null);
});

describe('GET /api/dashboard/work', () => {
  it('401 without auth', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/dashboard/work' });
    expect(r.statusCode).toBe(401);
  });

  it('returns empty list initially', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/dashboard/work', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ items: [] });
  });

  it('returns created items', async () => {
    createWorkItem({ prompt: 'X', workdir: '/r' });
    createWorkItem({ prompt: 'Y', workdir: '/r' });
    const r = await app.inject({ method: 'GET', url: '/api/dashboard/work', headers: AUTH });
    const body = JSON.parse(r.payload);
    expect(body.items).toHaveLength(2);
    expect(body.items[0].id).toMatch(/^RL-/);
    expect(body.items[0].status).toBe('planning');
  });

  it('filter ?status=active excludes terminal items', async () => {
    const a = createWorkItem({ prompt: 'A', workdir: '/r' });
    const b = createWorkItem({ prompt: 'B', workdir: '/r' });
    const { saveWorkItem, loadWorkItem } = await import('../code-agents/review-loop-storage.js');
    const done = loadWorkItem(b.id)!;
    done.status = 'done';
    saveWorkItem(done);

    const r = await app.inject({ method: 'GET', url: '/api/dashboard/work?status=active', headers: AUTH });
    const body = JSON.parse(r.payload);
    expect(body.items.map((i: any) => i.id)).toEqual([a.id]);
  });
});

describe('GET /api/dashboard/work/:id', () => {
  it('404 for missing', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/dashboard/work/RL-999', headers: AUTH });
    expect(r.statusCode).toBe(404);
  });

  it('returns full state for existing', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    const r = await app.inject({ method: 'GET', url: `/api/dashboard/work/${s.id}`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.id).toBe(s.id);
    expect(body.status).toBe('planning');
    expect(body.timeline).toHaveLength(1);
  });

  it('rejects malformed ids', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/dashboard/work/not-valid', headers: AUTH });
    expect(r.statusCode).toBe(400);
  });
});
