import { describe, it, expect } from 'vitest';
import { normalizeDigest, isInvalidGoogleNewsUrl, sanitizeArticleUrl, decodeGoogleNewsArticleUrl } from '../newspaper/normalize.js';
import type { Digest } from '../digests.js';

function makeDigest(overrides: Partial<Digest> = {}): Digest {
  return {
    id: 'test-digest',
    jobId: 'ai-news',
    jobName: 'AI News',
    createdAt: new Date().toISOString(),
    articles: [
      {
        id: 'art1',
        title: 'OpenAI releases GPT-5',
        url: 'https://news.ycombinator.com/item?id=12345',
        source: 'Hacker News',
        score: 500,
        comments: 200,
        read: false,
      },
      {
        id: 'art2',
        title: 'New ML framework released',
        url: 'https://reddit.com/r/MachineLearning/comments/abc/new_framework',
        source: 'Reddit r/MachineLearning',
        score: 100,
        read: false,
      },
    ],
    ...overrides,
  };
}

describe('normalizeDigest', () => {
  it('converts digest articles to normalized format', () => {
    const digest = makeDigest();
    const articles = normalizeDigest(digest);

    expect(articles).toHaveLength(2);
    expect(articles[0]).toMatchObject({
      title: 'OpenAI releases GPT-5',
      url: 'https://news.ycombinator.com/item?id=12345',
      source: 'Hacker News',
      section: 'ai', // ai-news job maps to 'ai'
      score: 500,
      comments: 200,
    });
    expect(articles[0].id).toBeTruthy();
    expect(articles[0].fetchedAt).toBeTruthy();
  });

  it('assigns correct section for ai-news job', () => {
    const digest = makeDigest({ jobId: 'ai-news' });
    const articles = normalizeDigest(digest);
    expect(articles.every(a => a.section === 'ai')).toBe(true);
  });

  it('assigns correct section for ai-news job', () => {
    const digest = makeDigest({ jobId: 'ai-news' });
    const articles = normalizeDigest(digest);
    expect(articles.every(a => a.section === 'ai')).toBe(true);
  });

  it('assigns correct section for ph-digest job', () => {
    const digest = makeDigest({
      jobId: 'ph-digest',
      articles: [
        {
          id: 'ph1',
          title: 'Philippines economy grows',
          url: 'https://reddit.com/r/Philippines/comments/xyz/economy',
          source: 'Reddit r/Philippines',
          read: false,
        },
      ],
    });
    const articles = normalizeDigest(digest);
    expect(articles[0].section).toBe('ph');
  });

  it('assigns correct section for ph-news job', () => {
    const digest = makeDigest({
      jobId: 'ph-news',
      articles: [
        {
          id: 'ph2',
          title: 'PH headline',
          url: 'https://reddit.com/r/Philippines/comments/abc/ph-headline',
          source: 'Reddit r/Philippines',
          read: false,
        },
      ],
    });
    const articles = normalizeDigest(digest);
    expect(articles[0].section).toBe('ph');
  });

  it('infers us/world section from news-digest using keywords', () => {
    const digest = makeDigest({
      jobId: 'news-digest',
      articles: [
        {
          id: 'w1',
          title: 'Ukraine peace talks resume in Europe',
          url: 'https://www.reuters.com/world/ukraine-peace-talks',
          source: 'Google News',
          read: false,
        },
        {
          id: 'u1',
          title: 'Fed raises interest rates again',
          url: 'https://www.reuters.com/markets/fed-rates',
          source: 'Google News',
          read: false,
        },
      ],
    });
    const articles = normalizeDigest(digest);
    expect(articles.find(a => a.title.includes('Ukraine'))?.section).toBe('world');
    expect(articles.find(a => a.title.includes('Fed'))?.section).toBe('business');
  });

  it('infers us/world section from news job using keywords', () => {
    const digest = makeDigest({
      jobId: 'news',
      articles: [
        {
          id: 'w2',
          title: 'China trade talks resume',
          url: 'https://www.reuters.com/world/china-trade',
          source: 'Google News',
          read: false,
        },
        {
          id: 'u2',
          title: 'Congress debates budget deal',
          url: 'https://www.reuters.com/us/congress-budget',
          source: 'Google News',
          read: false,
        },
      ],
    });
    const articles = normalizeDigest(digest);
    expect(articles.find(a => a.title.includes('China'))?.section).toBe('world');
    expect(articles.find(a => a.title.includes('Congress'))?.section).toBe('us');
  });

  it('uses raw text section headers when available', () => {
    const rawText = `## US Headlines
1. Stock market hits record high
https://www.reuters.com/markets/stock-record

## World Headlines
1. EU summit concludes
https://www.reuters.com/world/eu-summit`;

    const digest = makeDigest({
      jobId: 'news-digest',
      summary: rawText,
      articles: [
        {
          id: 'us1',
          title: 'Stock market hits record high',
          url: 'https://www.reuters.com/markets/stock-record',
          source: 'Google News',
          read: false,
        },
        {
          id: 'w1',
          title: 'EU summit concludes',
          url: 'https://www.reuters.com/world/eu-summit',
          source: 'Google News',
          read: false,
        },
      ],
    });
    const articles = normalizeDigest(digest);
    expect(articles.find(a => a.title.includes('Stock'))?.section).toBe('us');
    expect(articles.find(a => a.title.includes('EU'))?.section).toBe('world');
  });

  it('maps morning job articles to briefing section', () => {
    const digest = makeDigest({
      jobId: 'morning',
      articles: [
        {
          id: 'pr1',
          title: 'wpcom #210870',
          url: 'https://github.a8c.com/Automattic/wpcom/pull/210870',
          source: 'GitHub',
          read: false,
        },
        {
          id: 'p2',
          title: 'Team standup notes',
          url: 'https://datascip2.wordpress.com/2026/04/12/standup',
          source: 'P2',
          read: false,
        },
      ],
    });

    const articles = normalizeDigest(digest);
    expect(articles.every(a => a.section === 'briefing')).toBe(true);
  });

  it('handles empty articles array', () => {
    const digest = makeDigest({ articles: [] });
    expect(normalizeDigest(digest)).toEqual([]);
  });

  it('drops articles with invalid Google News slug URLs', () => {
    const digest = makeDigest({
      jobId: 'news-digest',
      articles: [
        {
          id: 'bad1',
          title: 'Article with fake Google News URL',
          url: 'https://news.google.com/articles/fake-slug-url',
          source: 'Google News',
          read: false,
        },
        {
          id: 'good1',
          title: 'Article with real URL',
          url: 'https://www.reuters.com/world/real-article',
          source: 'Google News',
          read: false,
        },
      ],
    });
    const articles = normalizeDigest(digest);
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe('Article with real URL');
  });

  it('uses sourceUrl when primary URL is invalid Google News slug', () => {
    const digest = makeDigest({
      jobId: 'news-digest',
      articles: [
        {
          id: 'fallback1',
          title: 'Article with fallback',
          url: 'https://news.google.com/articles/some-slug',
          sourceUrl: 'https://www.bbc.com/news/real-article-123',
          source: 'Google News',
          read: false,
        },
      ],
    });
    const articles = normalizeDigest(digest);
    expect(articles).toHaveLength(1);
    expect(articles[0].url).toBe('https://www.bbc.com/news/real-article-123');
  });

  it('keeps valid Google News URLs with base64 IDs', () => {
    const validUrl = 'https://news.google.com/rss/articles/CBMiM2h0dHBzOi8vdGVjaGNydW5jaC5jb20vMjAyNi8wNC8xMi90ZXN0L9IBAA?oc=5';
    const digest = makeDigest({
      jobId: 'news-digest',
      articles: [
        {
          id: 'valid1',
          title: 'Valid Google News article',
          url: validUrl,
          source: 'Google News',
          read: false,
        },
      ],
    });
    const articles = normalizeDigest(digest);
    expect(articles).toHaveLength(1);
    expect(articles[0].url).toBe('https://techcrunch.com/2026/04/12/test/');
  });

  it('prefers sourceUrl over Google News wrapper URLs when available', () => {
    const googleNewsUrl = 'https://news.google.com/rss/articles/CBMiXmh0dHBzOi8vd3d3LmJiYy5jb20';
    const digest = makeDigest({
      jobId: 'news-digest',
      articles: [
        {
          id: 'wrapped1',
          title: 'Wrapped article',
          url: googleNewsUrl,
          sourceUrl: 'https://www.bbc.com/news/articles/c1234567890o',
          source: 'Google News',
          read: false,
        },
      ],
    });

    const articles = normalizeDigest(digest);
    expect(articles).toHaveLength(1);
    expect(articles[0].url).toBe('https://www.bbc.com/news/articles/c1234567890o');
    expect(articles[0].rawUrl).toBe(googleNewsUrl);
    expect(articles[0].sourceUrl).toBe('https://www.bbc.com/news/articles/c1234567890o');
    expect(articles[0].sourceResolutionMethod).toBe('source_url');
  });
});

describe('decodeGoogleNewsArticleUrl', () => {
  it('decodes an embedded direct article URL from a Google News wrapper', () => {
    expect(
      decodeGoogleNewsArticleUrl('https://news.google.com/rss/articles/CBMiM2h0dHBzOi8vdGVjaGNydW5jaC5jb20vMjAyNi8wNC8xMi90ZXN0L9IBAA?oc=5'),
    ).toBe('https://techcrunch.com/2026/04/12/test/');
  });

  it('returns null for malformed or non-wrapper URLs', () => {
    expect(decodeGoogleNewsArticleUrl('https://www.reuters.com/world/story')).toBeNull();
    expect(decodeGoogleNewsArticleUrl('https://news.google.com/articles/fake-slug')).toBeNull();
    expect(decodeGoogleNewsArticleUrl('not-a-url')).toBeNull();
  });
});

describe('isInvalidGoogleNewsUrl', () => {
  it('returns true for human-readable slug URLs', () => {
    expect(isInvalidGoogleNewsUrl('https://news.google.com/articles/fed-rates-2026')).toBe(true);
    expect(isInvalidGoogleNewsUrl('https://news.google.com/articles/ukraine-ceasefire')).toBe(true);
    expect(isInvalidGoogleNewsUrl('https://news.google.com/rss/articles/some-slug')).toBe(true);
    expect(isInvalidGoogleNewsUrl('https://news.google.com/articles/simple')).toBe(true);
  });

  it('returns false for valid base64-encoded Google News URLs', () => {
    expect(isInvalidGoogleNewsUrl('https://news.google.com/rss/articles/CBMiXmh0dHBzOi8v')).toBe(false);
    expect(isInvalidGoogleNewsUrl('https://news.google.com/articles/CBMiR2h0dHBzOi8vYXJzd')).toBe(false);
  });

  it('returns false for non-Google-News URLs', () => {
    expect(isInvalidGoogleNewsUrl('https://www.reuters.com/article/some-slug')).toBe(false);
    expect(isInvalidGoogleNewsUrl('https://news.ycombinator.com/item?id=12345')).toBe(false);
    expect(isInvalidGoogleNewsUrl('https://reddit.com/r/news/comments/abc/slug')).toBe(false);
  });

  it('returns false for Google News homepage or non-article paths', () => {
    expect(isInvalidGoogleNewsUrl('https://news.google.com/')).toBe(false);
    expect(isInvalidGoogleNewsUrl('https://news.google.com/search?q=test')).toBe(false);
  });

  it('handles malformed URLs gracefully', () => {
    expect(isInvalidGoogleNewsUrl('not-a-url')).toBe(false);
    expect(isInvalidGoogleNewsUrl('')).toBe(false);
  });
});

describe('sanitizeArticleUrl', () => {
  it('returns original URL when it is valid', () => {
    expect(sanitizeArticleUrl('https://www.reuters.com/article')).toBe('https://www.reuters.com/article');
  });

  it('returns sourceUrl when primary is invalid Google News slug', () => {
    expect(sanitizeArticleUrl(
      'https://news.google.com/articles/fake-slug',
      'https://www.bbc.com/real-article',
    )).toBe('https://www.bbc.com/real-article');
  });

  it('returns sourceUrl when primary is a valid Google News wrapper URL', () => {
    expect(sanitizeArticleUrl(
      'https://news.google.com/rss/articles/CBMiXmh0dHBzOi8v',
      'https://www.reuters.com/world/test-article',
    )).toBe('https://www.reuters.com/world/test-article');
  });

  it('returns decoded direct URL when sourceUrl is missing but wrapper is decodable', () => {
    expect(sanitizeArticleUrl(
      'https://news.google.com/rss/articles/CBMiM2h0dHBzOi8vdGVjaGNydW5jaC5jb20vMjAyNi8wNC8xMi90ZXN0L9IBAA?oc=5',
    )).toBe('https://techcrunch.com/2026/04/12/test/');
  });

  it('returns null when both URLs are invalid', () => {
    expect(sanitizeArticleUrl(
      'https://news.google.com/articles/fake-slug',
      'https://news.google.com/articles/also-fake',
    )).toBeNull();
  });

  it('returns null when primary is invalid and no sourceUrl provided', () => {
    expect(sanitizeArticleUrl('https://news.google.com/articles/bad-slug')).toBeNull();
    expect(sanitizeArticleUrl('https://news.google.com/articles/bad-slug', undefined)).toBeNull();
  });

  it('returns null for index or sitemap pages that are not real articles', () => {
    expect(sanitizeArticleUrl('https://www.nytimes.com/sitemap/today/')).toBeNull();
    expect(sanitizeArticleUrl('https://example.com/section/world')).toBeNull();
  });

  it('returns null when primary URL is malformed and no fallback is available', () => {
    expect(sanitizeArticleUrl('not-a-url')).toBeNull();
  });
});
