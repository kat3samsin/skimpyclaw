import { describe, it, expect } from 'vitest';
import { rankArticles, selectLeadStory } from '../newspaper/rank.js';
import type { NormalizedArticle } from '../newspaper/types.js';

function makeArticle(overrides: Partial<NormalizedArticle> = {}): NormalizedArticle {
  return {
    id: 'test',
    title: 'Test Article',
    url: 'https://example.com/test',
    source: 'Example',
    section: 'us',
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('rankArticles', () => {
  it('assigns ranks in order of importance', () => {
    const articles = [
      makeArticle({ id: 'low', score: 1, source: 'X' }),
      makeArticle({ id: 'high', score: 100, source: 'Hacker News' }),
      makeArticle({ id: 'mid', score: 50, source: 'Google News' }),
    ];
    const ranked = rankArticles(articles);
    expect(ranked[0].id).toBe('high');
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].id).toBe('mid');
    expect(ranked[1].rank).toBe(2);
  });

  it('respects maxPerSection', () => {
    const articles = Array.from({ length: 15 }, (_, i) =>
      makeArticle({ id: `a${i}`, section: 'ai', score: 100 - i }),
    );
    const ranked = rankArticles(articles, { maxPerSection: 5 });
    expect(ranked).toHaveLength(5);
  });

  it('handles articles without scores', () => {
    const articles = [
      makeArticle({ id: 'no-score', source: 'Hacker News' }),
      makeArticle({ id: 'with-score', score: 50, source: 'X' }),
    ];
    const ranked = rankArticles(articles);
    expect(ranked).toHaveLength(2);
    // with-score should rank higher due to actual score
    expect(ranked[0].id).toBe('with-score');
  });

  it('handles empty input', () => {
    expect(rankArticles([])).toEqual([]);
  });

  it('includes articles from multiple sections', () => {
    const articles = [
      makeArticle({ id: 'us1', section: 'us', score: 50 }),
      makeArticle({ id: 'ai1', section: 'ai', score: 80 }),
      makeArticle({ id: 'ph1', section: 'ph', score: 30 }),
    ];
    const ranked = rankArticles(articles);
    expect(ranked).toHaveLength(3);
    const sections = ranked.map(a => a.section);
    expect(sections).toContain('us');
    expect(sections).toContain('ai');
    expect(sections).toContain('ph');
  });
});

describe('selectLeadStory', () => {
  it('returns the first ranked article when it is already a preferred source', () => {
    const articles = [
      makeArticle({ id: 'first', score: 100, source: 'Hacker News' }),
      makeArticle({ id: 'second', score: 50 }),
    ];
    const ranked = rankArticles(articles);
    const lead = selectLeadStory(ranked);
    expect(lead?.id).toBe('first');
  });

  it('prefers Hacker News or news sources over Reddit for the lead story', () => {
    const ranked = rankArticles([
      makeArticle({ id: 'reddit-top', score: 100, source: 'Reddit r/LocalLLaMA' }),
      makeArticle({ id: 'hn-second', score: 85, source: 'Hacker News' }),
      makeArticle({ id: 'news-third', score: 80, source: 'Google News' }),
    ]);

    const lead = selectLeadStory(ranked);

    expect(lead?.id).toBe('hn-second');
  });

  it('falls back to the top-ranked article when no preferred lead source exists', () => {
    const ranked = rankArticles([
      makeArticle({ id: 'reddit-top', score: 100, source: 'Reddit r/Philippines' }),
      makeArticle({ id: 'reddit-second', score: 90, source: 'Reddit r/phinvest' }),
    ]);

    const lead = selectLeadStory(ranked);

    expect(lead?.id).toBe('reddit-top');
  });

  it('returns undefined for empty input', () => {
    expect(selectLeadStory([])).toBeUndefined();
  });
});
