import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockBuildAndSaveEdition = vi.fn();
const mockRunCronJob = vi.fn();
const mockGetNewspaperStatus = vi.fn();
const mockResolveNewspaperJobIds = vi.fn();

vi.mock('../newspaper/edition-builder.js', () => ({
  buildAndSaveEdition: (...args: any[]) => mockBuildAndSaveEdition(...args),
}));

vi.mock('../cron.js', () => ({
  runCronJob: (...args: any[]) => mockRunCronJob(...args),
}));

vi.mock('../newspaper/workflow.js', () => ({
  getNewspaperStatus: (...args: any[]) => mockGetNewspaperStatus(...args),
  resolveNewspaperJobIds: (...args: any[]) => mockResolveNewspaperJobIds(...args),
}));

vi.mock('../newspaper/storage.js', () => ({
  getEdition: vi.fn(),
  getTodayEdition: vi.fn(),
  getLatestEdition: vi.fn(),
  listEditions: vi.fn().mockReturnValue([]),
  updateArticleRead: vi.fn().mockReturnValue(true),
  cleanupOldEditions: vi.fn().mockReturnValue(0),
}));

const { registerNewspaperAPI } = await import('../newspaper/routes.js');

const config: any = {
  cron: {
    jobs: [
      { id: 'ai-news', name: 'AI News' },
      { id: 'news', name: 'News' },
      { id: 'ph-news', name: 'PH News' },
    ],
  },
  newspaper: {
    maxArticlesPerSection: 8,
    blockedDomains: ['spam.test'],
  },
};

describe('newspaper routes', () => {
  beforeEach(() => {
    mockResolveNewspaperJobIds.mockReturnValue(['ai-news', 'news', 'ph-news']);
    mockBuildAndSaveEdition.mockResolvedValue({
      id: '2026-04-12-evening',
      slot: 'evening',
      articles: [{ id: 'a1' }, { id: 'a2' }],
    });
    mockGetNewspaperStatus.mockReturnValue({
      state: 'fresh',
      editionId: '2026-04-12-evening',
      editionArticleCount: 2,
      sourceJobIds: ['ai-news', 'news', 'ph-news'],
      sources: [],
    });
    mockRunCronJob.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns newspaper status with refresh metadata', async () => {
    const app = Fastify();
    registerNewspaperAPI(app, config);

    const res = await app.inject({ method: 'GET', url: '/api/newspaper/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      state: 'fresh',
      editionId: '2026-04-12-evening',
      refresh: { inProgress: false },
    });

    await app.close();
  });

  it('build endpoint rebuilds from configured newspaper source jobs', async () => {
    const app = Fastify();
    registerNewspaperAPI(app, config);

    const res = await app.inject({ method: 'POST', url: '/api/newspaper/build', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(mockBuildAndSaveEdition).toHaveBeenCalledWith(expect.objectContaining({
      jobIds: ['ai-news', 'news', 'ph-news'],
      maxPerSection: 8,
      blockedDomains: ['spam.test'],
    }));
    expect(res.json()).toMatchObject({
      success: true,
      articleCount: 2,
      sourceJobIds: ['ai-news', 'news', 'ph-news'],
    });

    await app.close();
  });

  it('refresh endpoint can fetch source jobs and then rebuild', async () => {
    const app = Fastify();
    registerNewspaperAPI(app, config);

    const res = await app.inject({
      method: 'POST',
      url: '/api/newspaper/refresh',
      payload: { mode: 'fetch-and-build' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockRunCronJob).toHaveBeenCalledTimes(3);
    expect(mockRunCronJob).toHaveBeenNthCalledWith(1, 'ai-news', config);
    expect(mockRunCronJob).toHaveBeenNthCalledWith(2, 'news', config);
    expect(mockRunCronJob).toHaveBeenNthCalledWith(3, 'ph-news', config);
    expect(mockBuildAndSaveEdition).toHaveBeenCalledWith(expect.objectContaining({
      jobIds: ['ai-news', 'news', 'ph-news'],
    }));
    expect(res.json()).toMatchObject({
      success: true,
      mode: 'fetch-and-build',
      articleCount: 2,
    });

    await app.close();
  });
});
