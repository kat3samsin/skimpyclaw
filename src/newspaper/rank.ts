// Article ranking for newspaper edition placement

import type { NormalizedArticle, Section } from './types.js';
import { getSourceWeight } from './types.js';

export interface RankedArticle extends NormalizedArticle {
  rank: number;
  importanceScore: number;
}

function isPreferredLeadSource(article: Pick<NormalizedArticle, 'source' | 'url'>): boolean {
  const source = article.source.toLowerCase();

  if (source.includes('hacker news')) return true;
  if (source.includes('news')) return true;

  try {
    const host = new URL(article.url).hostname.toLowerCase();
    if (host.includes('news.ycombinator.com')) return true;
    if (host.includes('news.')) return true;
  } catch {
    // Ignore malformed URLs and fall back to source-based checks.
  }

  return false;
}

/**
 * Normalize a score to 0-1 range within the given articles.
 * Returns 0.5 if no articles have scores.
 */
function normalizeScore(score: number | undefined, maxScore: number): number {
  if (score == null || maxScore <= 0) return 0.5;
  return Math.min(score / maxScore, 1.0);
}

/**
 * Calculate recency penalty.
 * Articles fetched within the last hour get 0, older articles get penalized.
 * Max penalty at 24 hours.
 */
function recencyPenalty(fetchedAt: string): number {
  const hoursAgo = (Date.now() - new Date(fetchedAt).getTime()) / (1000 * 60 * 60);
  return Math.min(hoursAgo / 24, 1.0);
}

/**
 * Score and rank articles.
 *
 * importance = (normalized_score * 0.4) + (recency * -0.2) + (source_weight * 0.3) + (section_boost * 0.1)
 */
export function rankArticles(
  articles: NormalizedArticle[],
  options: {
    maxPerSection?: number;
    leadSection?: Section;
  } = {},
): RankedArticle[] {
  const maxPerSection = options.maxPerSection ?? 10;

  // Find max score for normalization
  const maxScore = Math.max(
    ...articles.map(a => a.score ?? 0),
    1, // avoid division by zero
  );

  // Score each article
  const scored: RankedArticle[] = articles.map(article => {
    const normalizedScore = normalizeScore(article.score, maxScore);
    const recency = recencyPenalty(article.fetchedAt);
    const sourceWeight = getSourceWeight(article.source);
    const sectionBoost = 0; // No per-section boost in base ranking

    const importanceScore =
      (normalizedScore * 0.4) +
      (recency * -0.2) +
      (sourceWeight * 0.3) +
      (sectionBoost * 0.1);

    return {
      ...article,
      rank: 0, // set below
      importanceScore,
    };
  });

  // Sort by importance (descending)
  scored.sort((a, b) => b.importanceScore - a.importanceScore);

  // Assign ranks and limit per section
  const sectionCounts: Record<string, number> = {};
  const result: RankedArticle[] = [];
  let globalRank = 1;

  for (const article of scored) {
    const count = sectionCounts[article.section] ?? 0;
    if (count >= maxPerSection) continue;
    sectionCounts[article.section] = count + 1;
    article.rank = globalRank++;
    result.push(article);
  }

  return result;
}

/**
 * Select the lead story, preferring HN and news sources over Reddit/social links.
 */
export function selectLeadStory(articles: RankedArticle[]): RankedArticle | undefined {
  return articles.find(isPreferredLeadSource) ?? articles[0];
}
