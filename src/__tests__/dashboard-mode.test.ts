import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import Fastify, { FastifyInstance } from 'fastify';
import { registerDashboard } from '../dashboard-frontend.js';

const ROOT = resolve(import.meta.url.replace(/^file:\/\//, ''), '../../..');
const WEB_DASHBOARD = join(ROOT, 'web', 'dashboard');
const WEB_SRC = join(WEB_DASHBOARD, 'src');
const DEFAULT_DIST_INDEX = join(ROOT, 'dist', 'dashboard', 'index.html');

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  registerDashboard(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('Default dashboard mode', () => {
  it('serves framework dashboard when dist exists, otherwise returns build hint', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    if (existsSync(DEFAULT_DIST_INDEX)) {
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    } else {
      expect(res.statusCode).toBe(503);
      expect(res.body).toContain('pnpm dashboard:build');
    }
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
    registerDashboard(frameworkApp, { frameworkDistDir: distDir });
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

  it('serves favicon.svg from dist root', async () => {
    const distDir = mkdtempSync(join(tmpdir(), 'skimpy-favicon-'));
    mkdirSync(join(distDir, 'assets'), { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><html><body></body></html>', 'utf-8');
    writeFileSync(join(distDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf-8');

    const faviconApp = Fastify();
    registerDashboard(faviconApp, { frameworkDistDir: distDir });
    await faviconApp.ready();

    const res = await faviconApp.inject({ method: 'GET', url: '/favicon.svg' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(res.body).toContain('<svg');

    await faviconApp.close();
    rmSync(distDir, { recursive: true, force: true });
  });

  it('returns 404 for missing root static files', async () => {
    const distDir = mkdtempSync(join(tmpdir(), 'skimpy-nofav-'));
    mkdirSync(join(distDir, 'assets'), { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><html><body></body></html>', 'utf-8');

    const noFavApp = Fastify();
    registerDashboard(noFavApp, { frameworkDistDir: distDir });
    await noFavApp.ready();

    const res = await noFavApp.inject({ method: 'GET', url: '/favicon.svg' });
    expect(res.statusCode).toBe(404);

    await noFavApp.close();
    rmSync(distDir, { recursive: true, force: true });
  });

  it('rejects path traversal on root static route', async () => {
    const distDir = mkdtempSync(join(tmpdir(), 'skimpy-traverse-'));
    mkdirSync(join(distDir, 'assets'), { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><html><body></body></html>', 'utf-8');

    const traverseApp = Fastify();
    registerDashboard(traverseApp, { frameworkDistDir: distDir });
    await traverseApp.ready();

    const res = await traverseApp.inject({ method: 'GET', url: '/..%2F..%2Fetc%2Fpasswd.svg' });
    expect(res.statusCode).toBe(404);

    await traverseApp.close();
    rmSync(distDir, { recursive: true, force: true });
  });

  it('does not serve non-static extensions from root', async () => {
    const distDir = mkdtempSync(join(tmpdir(), 'skimpy-ext-'));
    mkdirSync(join(distDir, 'assets'), { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><html><body></body></html>', 'utf-8');
    writeFileSync(join(distDir, 'secret.json'), '{"key":"value"}', 'utf-8');

    const extApp = Fastify();
    registerDashboard(extApp, { frameworkDistDir: distDir });
    await extApp.ready();

    // .json is not in the allowed extensions list
    const res = await extApp.inject({ method: 'GET', url: '/secret.json' });
    // Should fall through (callNotFound), not serve the file
    expect(res.statusCode).not.toBe(200);

    await extApp.close();
    rmSync(distDir, { recursive: true, force: true });
  });

  it('returns 503 when framework dist is missing', async () => {
    const missingDir = join(tmpdir(), 'missing-dashboard-dist-123');
    const fallbackApp = Fastify();
    registerDashboard(fallbackApp, { frameworkDistDir: missingDir });
    await fallbackApp.ready();

    const res = await fallbackApp.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('pnpm dashboard:build');

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

  it('framework sidebar includes usage tab', () => {
    const src = readFileSync(join(WEB_SRC, 'components', 'Sidebar.tsx'), 'utf-8');
    expect(src).toContain("id: 'usage'");
    expect(src).toContain('LuDollarSign');
  });

  it('framework API client targets dashboard endpoints', () => {
    const src = readFileSync(join(WEB_SRC, 'api', 'client.ts'), 'utf-8');
    expect(src).toContain('/api/dashboard/');
    expect(src).toContain("request<StatusResponse>('status')");
    expect(src).toContain("request<ApprovalsResponse>('approvals')");
    expect(src).toContain("request<HealthResponse>('health')");
    expect(src).toContain("request<UsageSummaryResponse>('usage')");
    expect(src).toContain('Authorization');
    expect(src).toContain('Bearer');
    expect(src).toContain('localStorage');
  });
});
