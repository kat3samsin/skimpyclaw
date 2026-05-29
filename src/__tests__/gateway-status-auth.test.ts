import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../api.js', () => ({
  registerDashboardAPI: vi.fn(),
}));

vi.mock('../dashboard-frontend.js', () => ({
  registerDashboard: vi.fn(),
}));

vi.mock('../cron.js', () => ({
  getCronJobs: () => [{ id: 'job-1', name: 'Job 1', nextRun: undefined }],
  triggerCronJob: vi.fn(),
}));

vi.mock('../agent.js', () => ({
  runAgentTurn: vi.fn().mockResolvedValue('ok'),
}));

vi.mock('../config.js', () => ({
  ensureDashboardToken: () => 'test-token',
  getLogsDir: () => '/tmp/test-skimpyclaw/logs',
}));

const { createGateway } = await import('../gateway.js');
const {
  clearRegisteredArtifactsForTesting,
  clearRegisteredArtifactMemoryForTesting,
  registerLocalArtifact,
} = await import('../artifacts.js');

const cfg: any = {
  gateway: { port: 18790 },
  agents: {
    default: 'main',
    list: {
      main: {
        model: 'anthropic/claude-haiku-4-5',
        identity: { name: 'Bot', emoji: 'x' },
      },
    },
  },
  cron: { jobs: [] },
};

describe('gateway /status auth', () => {
  afterEach(async () => {
    vi.clearAllMocks();
    clearRegisteredArtifactsForTesting();
    delete process.env.SKIMPYCLAW_ARTIFACT_REGISTRY_PATH;
    delete process.env.SKIMPYCLAW_REPORTS_DIR;
  });

  it('keeps /health unauthenticated', async () => {
    const app = await createGateway(cfg);
    try {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('requires auth for /status', async () => {
    const app = await createGateway(cfg);
    try {
      const res = await app.inject({ method: 'GET', url: '/status' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('allows /status with valid bearer token', async () => {
    const app = await createGateway(cfg);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/status',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('ok');
    } finally {
      await app.close();
    }
  });

  it('serves registered local artifacts by opaque id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skimpy-artifact-route-'));
    const artifactPath = join(dir, 'review.html');
    writeFileSync(artifactPath, '<!doctype html><title>Review</title>', 'utf-8');
    const artifact = registerLocalArtifact(artifactPath);
    expect(artifact).not.toBeNull();

    const app = await createGateway(cfg);
    try {
      const res = await app.inject({ method: 'GET', url: `/artifacts/${artifact!.id}/review.html` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('<title>Review</title>');
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves persisted local artifacts after memory is cleared', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skimpy-artifact-persist-'));
    process.env.SKIMPYCLAW_ARTIFACT_REGISTRY_PATH = join(dir, 'registry.json');
    const artifactPath = join(dir, 'review.html');
    writeFileSync(artifactPath, '<!doctype html><title>Persisted</title>', 'utf-8');
    const artifact = registerLocalArtifact(artifactPath);
    expect(artifact).not.toBeNull();
    clearRegisteredArtifactMemoryForTesting();

    const app = await createGateway(cfg);
    try {
      const res = await app.inject({ method: 'GET', url: `/artifacts/${artifact!.id}/review.html` });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<title>Persisted</title>');
    } finally {
      await app.close();
      clearRegisteredArtifactsForTesting();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves dated report links without opaque artifact ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skimpy-report-route-'));
    process.env.SKIMPYCLAW_REPORTS_DIR = join(dir, 'reports');
    const reportDir = join(process.env.SKIMPYCLAW_REPORTS_DIR, 'chief-daily-reader');
    rmSync(reportDir, { recursive: true, force: true });
    mkdirSync(reportDir, { recursive: true });
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const reportBundleDir = join(reportDir, date);
    mkdirSync(reportBundleDir, { recursive: true });
    writeFileSync(join(reportBundleDir, 'index.html'), '<!doctype html><title>Daily Index</title>', 'utf-8');
    writeFileSync(join(reportBundleDir, 'news.html'), '<!doctype html><title>Daily News</title>', 'utf-8');
    writeFileSync(join(reportDir, `${date}.html`), '<!doctype html><title>Old Daily</title>', 'utf-8');

    const app = await createGateway(cfg);
    try {
      const dated = await app.inject({ method: 'GET', url: `/reports/chief-daily-reader/${date}.html` });
      expect(dated.statusCode).toBe(302);
      expect(dated.headers.location).toBe(`/reports/chief-daily-reader/${date}/index.html`);

      const todayRes = await app.inject({ method: 'GET', url: '/reports/chief-daily-reader/today.html' });
      expect(todayRes.statusCode).toBe(302);
      expect(todayRes.headers.location).toBe(`/reports/chief-daily-reader/${date}/index.html`);

      const indexRes = await app.inject({ method: 'GET', url: `/reports/chief-daily-reader/${date}/index.html` });
      expect(indexRes.statusCode).toBe(200);
      expect(indexRes.body).toContain('<title>Daily Index</title>');

      const newsRes = await app.inject({ method: 'GET', url: `/reports/chief-daily-reader/${date}/news.html` });
      expect(newsRes.statusCode).toBe(200);
      expect(newsRes.body).toContain('<title>Daily News</title>');

      const todayNewsRes = await app.inject({ method: 'GET', url: '/reports/chief-daily-reader/today/news.html' });
      expect(todayNewsRes.statusCode).toBe(200);
      expect(todayNewsRes.body).toContain('<title>Daily News</title>');
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
