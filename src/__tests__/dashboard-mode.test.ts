import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import Fastify, { FastifyInstance } from 'fastify';
import { registerDashboard } from '../dashboard.js';

const ROOT = resolve(import.meta.url.replace(/^file:\/\//, ''), '../../..');
const WEB_DASHBOARD = join(ROOT, 'web', 'dashboard');
const WEB_SRC = join(WEB_DASHBOARD, 'src');

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  registerDashboard(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('Legacy dashboard mode', () => {
  it('serves inline dashboard by default', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<style>');
    expect(res.body).toContain('/api/dashboard/');
    expect(res.body).toContain('data-page="templates"');
  });
});

describe('Framework dashboard mode', () => {
  it('serves built SPA index and assets when dist exists', async () => {
    const distDir = mkdtempSync(join(tmpdir(), 'skimpy-dashboard-'));
    const assetsDir = join(distDir, 'assets');
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(
      join(distDir, 'index.html'),
      '<!doctype html><html><body><div id="app"></div><script type="module" src="/assets/app.js"></script></body></html>',
      'utf-8',
    );
    writeFileSync(join(assetsDir, 'app.js'), 'console.log("ok")', 'utf-8');

    const frameworkApp = Fastify();
    registerDashboard(frameworkApp, { mode: 'framework', frameworkDistDir: distDir });
    await frameworkApp.ready();

    const htmlRes = await frameworkApp.inject({ method: 'GET', url: '/dashboard' });
    expect(htmlRes.statusCode).toBe(200);
    expect(htmlRes.body).toContain('src="/assets/app.js"');

    const assetRes = await frameworkApp.inject({ method: 'GET', url: '/assets/app.js' });
    expect(assetRes.statusCode).toBe(200);
    expect(assetRes.headers['content-type']).toContain('text/javascript');
    expect(assetRes.body).toContain('console.log');

    await frameworkApp.close();
    rmSync(distDir, { recursive: true, force: true });
  });

  it('falls back to legacy dashboard when framework dist is missing', async () => {
    const missingDir = join(tmpdir(), 'missing-dashboard-dist-123');
    const fallbackApp = Fastify();
    registerDashboard(fallbackApp, { mode: 'framework', frameworkDistDir: missingDir });
    await fallbackApp.ready();

    const res = await fallbackApp.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<style>');
    expect(res.body).toContain('/api/dashboard/');

    await fallbackApp.close();
  });
});

describe('Framework scaffold contract', () => {
  it('web/dashboard scaffold exists', () => {
    expect(existsSync(WEB_DASHBOARD)).toBe(true);
    expect(existsSync(join(WEB_DASHBOARD, 'package.json'))).toBe(true);
    expect(existsSync(join(WEB_DASHBOARD, 'vite.config.ts'))).toBe(true);
    expect(existsSync(join(WEB_DASHBOARD, 'src', 'App.tsx'))).toBe(true);
  });

  it('framework sidebar includes templates tab', () => {
    const src = readFileSync(join(WEB_SRC, 'components', 'Sidebar.tsx'), 'utf-8');
    expect(src).toContain("id: 'templates'");
  });

  it('framework API client targets dashboard endpoints', () => {
    const src = readFileSync(join(WEB_SRC, 'api', 'client.ts'), 'utf-8');
    expect(src).toContain('/api/dashboard/');
    expect(src).toContain("request<StatusResponse>('status')");
    expect(src).toContain("request<{ approvals: Approval[] }>('approvals')");
    expect(src).toContain("request<HealthResponse>('health')");
    expect(src).toContain('Authorization');
    expect(src).toContain('Bearer');
    expect(src).toContain('localStorage');
  });
});
