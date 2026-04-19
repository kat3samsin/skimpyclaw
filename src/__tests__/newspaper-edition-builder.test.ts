import { describe, it, expect } from 'vitest';
import { buildEditionFromDigests, determineSlot, generateEditionId } from '../newspaper/edition-builder.js';
import type { Digest } from '../digests.js';

function makeDigest(jobId: string, articles: Digest['articles']): Digest {
  return {
    id: `${jobId}-test123`,
    jobId,
    jobName: jobId,
    createdAt: new Date().toISOString(),
    articles,
  };
}

describe('determineSlot', () => {
  it('returns morning for early hours (CT)', () => {
    // 10am UTC = 5am CT
    const morning = new Date('2026-04-11T10:00:00Z');
    expect(determineSlot(morning)).toBe('morning');
  });

  it('returns evening for late hours (CT)', () => {
    // 22:00 UTC = 5pm CT
    const evening = new Date('2026-04-11T22:00:00Z');
    expect(determineSlot(evening)).toBe('evening');
  });

  it('uses CST during winter instead of a fixed UTC-5 offset', () => {
    // January 15, 2026 20:30 UTC = 2:30pm CST, still morning.
    const winterAfternoon = new Date('2026-01-15T20:30:00Z');
    expect(determineSlot(winterAfternoon)).toBe('morning');
  });
});

describe('generateEditionId', () => {
  it('creates id from date and slot', () => {
    const date = new Date('2026-04-11T12:00:00Z');
    expect(generateEditionId(date, 'morning')).toBe('2026-04-11-morning');
  });

  it('uses the Chicago calendar date instead of UTC date', () => {
    // April 19, 2026 20:00 CDT is still April 19 in Chicago, but April 20 in UTC.
    const lateChicagoEvening = new Date('2026-04-20T01:00:00Z');
    expect(generateEditionId(lateChicagoEvening, 'evening')).toBe('2026-04-19-evening');
  });
});

describe('buildEditionFromDigests', () => {
  it('builds an edition from multiple digests', () => {
    const digests = [
      makeDigest('ai-news', [
        { id: 'ai1', title: 'AI breakthrough', url: 'https://hn.com/1', source: 'Hacker News', score: 500, read: false },
        { id: 'ai2', title: 'New LLM paper', url: 'https://hn.com/2', source: 'Hacker News', score: 200, read: false },
      ]),
      makeDigest('ph-digest', [
        { id: 'ph1', title: 'Manila traffic reform', url: 'https://reddit.com/r/Philippines/1', source: 'Reddit r/Philippines', score: 50, read: false },
      ]),
      makeDigest('news-digest', [
        { id: 'us1', title: 'Fed rate decision', url: 'https://news.google.com/1', source: 'Google News', score: 80, read: false },
        { id: 'w1', title: 'Ukraine ceasefire talks resume in Europe', url: 'https://news.google.com/2', source: 'Google News', score: 60, read: false },
      ]),
    ];

    const edition = buildEditionFromDigests(digests, {
      date: new Date('2026-04-11T12:00:00Z'),
      slot: 'morning',
    });

    expect(edition.id).toBe('2026-04-11-morning');
    expect(edition.slot).toBe('morning');
    expect(edition.articles.length).toBeGreaterThanOrEqual(4);
    expect(edition.leadStoryId).toBeTruthy();

    // Check sections are assigned
    const sections = new Set(edition.articles.map(a => a.section));
    expect(sections.has('ai')).toBe(true);
    expect(sections.has('ph')).toBe(true);
  });

  it('deduplicates across digests', () => {
    const digests = [
      makeDigest('ai-news', [
        { id: 'a1', title: 'Same Story', url: 'https://example.com/story', source: 'Hacker News', score: 100, read: false },
      ]),
      makeDigest('news-digest', [
        { id: 'a2', title: 'Same Story Again', url: 'https://example.com/story', source: 'Google News', score: 50, read: false },
      ]),
    ];

    const edition = buildEditionFromDigests(digests);
    // Should have 1 article (deduped by URL)
    expect(edition.articles).toHaveLength(1);
    expect(edition.articles[0].score).toBe(100); // keeps higher score
  });

  it('filters blocked domains', () => {
    const digests = [
      makeDigest('ai-news', [
        { id: 'a1', title: 'Good Article', url: 'https://good.com/article', source: 'Good', read: false },
        { id: 'a2', title: 'Blocked Article', url: 'https://spam.com/article', source: 'Spam', read: false },
      ]),
    ];

    const edition = buildEditionFromDigests(digests, {
      blockedDomains: ['spam.com'],
    });

    expect(edition.articles).toHaveLength(1);
    expect(edition.articles[0].title).toBe('Good Article');
  });

  it('handles empty digests', () => {
    const edition = buildEditionFromDigests([]);
    expect(edition.articles).toHaveLength(0);
    expect(edition.leadStoryId).toBeUndefined();
  });

  it('respects maxPerSection', () => {
    const articles = Array.from({ length: 20 }, (_, i) => ({
      id: `a${i}`,
      title: `Article ${i}`,
      url: `https://hn.com/${i}`,
      source: 'Hacker News',
      score: 100 - i,
      read: false as const,
    }));

    const digests = [makeDigest('ai-news', articles)];
    const edition = buildEditionFromDigests(digests, { maxPerSection: 5 });
    expect(edition.articles).toHaveLength(5);
  });

  it('assigns sourceAttribution to all articles', () => {
    const digests = [
      makeDigest('ai-news', [
        { id: 'a1', title: 'Test', url: 'https://example.com/1', source: 'Hacker News', read: false },
      ]),
    ];
    const edition = buildEditionFromDigests(digests);
    expect(edition.articles[0].sourceAttribution).toBe('Hacker News');
  });
});
