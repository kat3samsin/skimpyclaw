import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerDashboard } from '../dashboard-frontend.js';

let app: FastifyInstance;
let distDir: string;

beforeAll(async () => {
  distDir = mkdtempSync(join(tmpdir(), 'skimpy-dashboard-test-'));
  mkdirSync(join(distDir, 'assets'), { recursive: true });
  writeFileSync(
    join(distDir, 'index.html'),
    '<!doctype html><html><body><script>window.__SKIMPY_DASHBOARD__={botName:"__SKIMPY_BOT_NAME__",botEmoji:"__SKIMPY_BOT_EMOJI__"}</script><div id="app"></div></body></html>',
    'utf-8',
  );

  app = Fastify();
  registerDashboard(app, {
    frameworkDistDir: distDir,
    botName: 'SkimpyClaw',
    botEmoji: '👙🦞',
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(distDir, { recursive: true, force: true });
});

describe('Dashboard route', () => {
  it('GET /dashboard returns 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('injects configured bot identity into served HTML', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.body).toContain('SkimpyClaw');
    expect(res.body).toContain('👙🦞');
    expect(res.body).not.toContain('__SKIMPY_BOT_NAME__');
    expect(res.body).not.toContain('__SKIMPY_BOT_EMOJI__');
  });

  it('serves dashboard subpaths with SPA index', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/messages' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="app"');
  });
});
