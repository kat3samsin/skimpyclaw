import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockChat } = vi.hoisted(() => ({
  mockChat: vi.fn(),
}));

vi.mock('../providers/index.js', () => ({
  chat: mockChat,
}));

import { clearSummaryCache, summarizeArticle } from '../newspaper/summarize.js';
import type { Article } from '../newspaper/types.js';

function makeArticle(overrides: Partial<Article> = {}): Article {
  return {
    id: 'article-1',
    title: 'Test headline',
    url: 'https://example.com/story',
    source: 'Example News',
    section: 'us',
    rank: 1,
    sourceAttribution: 'Example News',
    read: false,
    sources: [{ name: 'Example News', url: 'https://example.com/story' }],
    ...overrides,
  };
}

describe('newspaper summarization', () => {
  beforeEach(() => {
    clearSummaryCache();
    mockChat.mockReset();
  });

  it('skips non-news social posts', async () => {
    const article = makeArticle({
      source: 'Reddit r/Philippines',
      url: 'https://www.reddit.com/r/Philippines/comments/123/story/',
    });

    const result = await summarizeArticle(article, {} as any);

    expect(result).toBeNull();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('uses a newspaper-style prompt for Hacker News items', async () => {
    mockChat.mockResolvedValue(`SUMMARY: A concise blurb.\nWHY: A clear reason.`);

    const article = makeArticle({
      source: 'Hacker News',
      url: 'https://news.ycombinator.com/item?id=123',
      score: 420,
      comments: 87,
    });

    const result = await summarizeArticle(article, {
      models: {
        providers: { codex: { authPath: '/Users/test/.codex/auth.json' } },
        aliases: { codex: 'codex/gpt-5.3-codex' },
      },
    } as any);

    expect(result).toEqual({
      summary: 'A concise blurb.',
      whyItMatters: 'A clear reason.',
    });
    expect(mockChat).toHaveBeenCalledTimes(1);
    const [messages, options] = mockChat.mock.calls[0];
    expect(messages[0].content).toContain('front-page newspaper blurb');
    expect(messages[0].content).toContain('Hacker News item');
    expect(messages[0].content).toContain('Score: 420');
    expect(messages[0].content).toContain('Comments: 87');
    expect(options.model).toBe('codex');
  });
});
