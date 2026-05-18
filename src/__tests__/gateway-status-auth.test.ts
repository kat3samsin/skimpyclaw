import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
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
  runCronJob: vi.fn(),
}));

vi.mock('../agent.js', () => ({
  runAgentTurn: vi.fn().mockResolvedValue('ok'),
}));

vi.mock('../config.js', () => ({
  ensureDashboardToken: () => 'test-token',
  getLogsDir: () => '/tmp/test-skimpyclaw/logs',
}));

const { createGateway } = await import('../gateway.js');
const { clearRegisteredArtifactsForTesting, registerLocalArtifact } = await import('../artifacts.js');

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
});
