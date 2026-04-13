import { describe, expect, it, vi } from 'vitest';

const mockGetDigests = vi.fn();
const mockGetLatestEdition = vi.fn();
const mockGetTodayEdition = vi.fn();

vi.mock('../digests.js', () => ({
  getDigests: (...args: any[]) => mockGetDigests(...args),
}));

vi.mock('../newspaper/storage.js', () => ({
  getLatestEdition: (...args: any[]) => mockGetLatestEdition(...args),
  getTodayEdition: (...args: any[]) => mockGetTodayEdition(...args),
}));

const { resolveNewspaperJobIds } = await import('../newspaper/workflow.js');

describe('resolveNewspaperJobIds', () => {
  it('includes morning when it is configured', () => {
    mockGetDigests.mockReturnValue([]);

    const config: any = {
      cron: {
        jobs: [
          { id: 'ai-news' },
          { id: 'news-digest' },
          { id: 'ph-digest' },
          { id: 'morning' },
        ],
      },
    };

    expect(resolveNewspaperJobIds(config)).toEqual([
      'ai-news',
      'news-digest',
      'ph-digest',
      'morning',
    ]);
  });
});
