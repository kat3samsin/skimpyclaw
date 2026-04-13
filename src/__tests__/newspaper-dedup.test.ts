import { describe, it, expect } from 'vitest';
import { canonicalizeUrl, deduplicateArticles } from '../newspaper/dedup.js';
import type { NormalizedArticle } from '../newspaper/types.js';

function makeArticle(overrides: Partial<NormalizedArticle> = {}): NormalizedArticle {
  return {
    id: 'abc123',
    title: 'Test Article',
    url: 'https://example.com/article',
    source: 'Example',
    section: 'us',
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('canonicalizeUrl', () => {
  it('lowercases hostname', () => {
    expect(canonicalizeUrl('https://EXAMPLE.COM/Path')).toBe('https://example.com/Path');
  });

  it('removes trailing slash', () => {
    expect(canonicalizeUrl('https://example.com/path/')).toBe('https://example.com/path');
  });

  it('removes utm tracking params', () => {
    const url = 'https://example.com/path?utm_source=twitter&utm_medium=social&real=1';
    const result = canonicalizeUrl(url);
    expect(result).toContain('real=1');
    expect(result).not.toContain('utm_source');
    expect(result).not.toContain('utm_medium');
  });

  it('removes fragment', () => {
    expect(canonicalizeUrl('https://example.com/path#section')).toBe('https://example.com/path');
  });

  it('handles invalid URLs gracefully', () => {
    expect(canonicalizeUrl('not-a-url')).toBe('not-a-url');
  });

  it('preserves non-tracking query params', () => {
    const url = 'https://example.com/search?q=test&page=2';
    expect(canonicalizeUrl(url)).toBe(url);
  });
});

describe('deduplicateArticles', () => {
  it('removes exact URL duplicates', () => {
    const articles = [
      makeArticle({ id: 'a1', url: 'https://example.com/article', score: 10 }),
      makeArticle({ id: 'a2', url: 'https://example.com/article', score: 5 }),
    ];
    const result = deduplicateArticles(articles);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(10); // keeps higher score
  });

  it('deduplicates URLs that differ only by tracking params', () => {
    const articles = [
      makeArticle({ id: 'a1', url: 'https://example.com/article?utm_source=twitter', score: 5 }),
      makeArticle({ id: 'a2', url: 'https://example.com/article', score: 20 }),
    ];
    const result = deduplicateArticles(articles);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(20);
  });

  it('keeps articles with different URLs', () => {
    const articles = [
      makeArticle({ id: 'a1', url: 'https://example.com/article-1' }),
      makeArticle({ id: 'a2', url: 'https://example.com/article-2' }),
    ];
    const result = deduplicateArticles(articles);
    expect(result).toHaveLength(2);
  });

  it('handles empty input', () => {
    expect(deduplicateArticles([])).toEqual([]);
  });

  it('keeps article with higher score when duplicate found', () => {
    const articles = [
      makeArticle({ id: 'a1', url: 'https://example.com/same', score: 3 }),
      makeArticle({ id: 'a2', url: 'https://example.com/same', score: 100 }),
    ];
    const result = deduplicateArticles(articles);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a2');
  });
});
