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

describe('POST /api/dashboard/work', () => {
  it('creates a work item with required fields', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/dashboard/work',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { prompt: 'Fix login', workdir: '/r' },
    });
    expect(r.statusCode).toBe(201);
    const body = JSON.parse(r.payload);
    expect(body.id).toMatch(/^RL-/);
    expect(body.status).toBe('planning');
    expect(body.prompt).toBe('Fix login');
  });

  it('400 on missing prompt', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/dashboard/work',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { workdir: '/r' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('400 on missing workdir', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/dashboard/work',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { prompt: 'X' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('accepts optional fields', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/dashboard/work',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: {
        prompt: 'X', workdir: '/r',
        plannerModel: 'alt-p', devModel: 'alt-d', reviewerModel: 'alt-r',
        baseRef: 'main', maxIterations: 3,
      },
    });
    const body = JSON.parse(r.payload);
    expect(body.plannerModel).toBe('alt-p');
    expect(body.maxIterations).toBe(3);
  });
});

describe('POST /api/dashboard/work/:id/chat', () => {
  it('appends a message', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    const r = await app.inject({
      method: 'POST', url: `/api/dashboard/work/${s.id}/chat`,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { content: 'prefer minimal diff' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.chatMessages).toHaveLength(1);
    expect(body.chatMessages[0].content).toBe('prefer minimal diff');
  });

  it('400 on empty content', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    const r = await app.inject({
      method: 'POST', url: `/api/dashboard/work/${s.id}/chat`,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { content: '' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('404 on missing item', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/dashboard/work/RL-999/chat',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { content: 'x' },
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('POST /api/dashboard/work/:id/approve', () => {
  it('transitions awaiting_approval to planning', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    const { saveWorkItem, loadWorkItem } = await import('../code-agents/review-loop-storage.js');
    const state = loadWorkItem(s.id)!;
    state.status = 'awaiting_approval';
    state.currentPlan = 'plan';
    saveWorkItem(state);

    const r = await app.inject({
      method: 'POST', url: `/api/dashboard/work/${s.id}/approve`, headers: AUTH,
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.status).toBe('planning');
  });

  it('409 if not awaiting_approval', async () => {
    const s = createWorkItem({ prompt: 'X', workdir: '/r' });
    const r = await app.inject({
      method: 'POST', url: `/api/dashboard/work/${s.id}/approve`, headers: AUTH,
    });
    expect(r.statusCode).toBe(409);
  });
});
