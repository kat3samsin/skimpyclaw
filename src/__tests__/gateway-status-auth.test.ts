import { afterEach, describe, expect, it, vi } from 'vitest';

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
}));

const { createGateway } = await import('../gateway.js');

const cfg: any = {
  gateway: { port: 18790 },
  agents: {
    default: 'main',
    list: {
      main: {
        model: 'claude-fast',
        identity: { name: 'Bot', emoji: 'x' },
      },
    },
  },
  cron: { jobs: [] },
};

describe('gateway /status auth', () => {
  afterEach(async () => {
    vi.clearAllMocks();
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
});
