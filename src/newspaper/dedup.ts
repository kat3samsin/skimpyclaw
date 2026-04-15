// URL-exact deduplication for normalized articles

import type { NormalizedArticle } from './types.js';

/**
 * Canonicalize a URL for dedup comparison:
 * - Lowercase hostname
 * - Remove trailing slashes
 * - Remove common tracking params (utm_*, ref, source, etc.)
 * - Remove fragment
 */
export function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase();
    u.hash = '';
    // Remove tracking params
    const trackingParams = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'ref', 'source', 'fbclid', 'gclid', 'msclkid',
    ];
    for (const param of trackingParams) {
      u.searchParams.delete(param);
    }
    // Remove trailing slash
    let path = u.pathname;
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    u.pathname = path;
    return u.toString();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Deduplicate articles by canonical URL.
 * When duplicates found, keep the one with the higher score.
 * Merge sources from duplicates.
 */
export function deduplicateArticles(articles: NormalizedArticle[]): NormalizedArticle[] {
  const seen = new Map<string, NormalizedArticle>();

  for (const article of articles) {
    const canonical = canonicalizeUrl(article.url);
    const existing = seen.get(canonical);

    if (!existing) {
      seen.set(canonical, article);
      continue;
    }

    // Keep the one with higher score, or the more recent one
    const existingScore = existing.score ?? 0;
    const newScore = article.score ?? 0;
    if (newScore > existingScore) {
      seen.set(canonical, article);
    }
  }

  return Array.from(seen.values());
}
