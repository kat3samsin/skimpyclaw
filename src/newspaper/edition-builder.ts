// Edition builder — orchestrates normalize → dedup → rank → edition

import type {
  Article,
  Edition,
  EditionSlot,
  NormalizedArticle,
  Section,
} from './types.js';
import { ALL_SECTIONS } from './types.js';
import { loadAndNormalizeDigests, normalizeDigest } from './normalize.js';
import { deduplicateArticles } from './dedup.js';
import { rankArticles, selectLeadStory } from './rank.js';
import type { RankedArticle } from './rank.js';
import { saveEdition, getEdition } from './storage.js';
import { summarizeEditionArticles } from './summarize.js';
import { loadConfig } from '../config.js';
import type { Digest } from '../digests.js';

/**
 * Determine the edition slot based on current time.
 * Morning: before 3pm CT (8pm UTC)
 * Evening: 3pm CT and later
 */
export function determineSlot(now: Date = new Date()): EditionSlot {
  // Convert to Central Time offset (-5 or -6)
  // Use simple approach: check UTC hour
  const utcHour = now.getUTCHours();
  // CT is UTC-5 (CDT) or UTC-6 (CST). Approximate as UTC-5.
  const ctHour = (utcHour - 5 + 24) % 24;
  return ctHour < 15 ? 'morning' : 'evening';
}

/**
 * Generate an edition ID from date and slot.
 */
export function generateEditionId(date: Date, slot: EditionSlot): string {
  const dateStr = date.toISOString().split('T')[0];
  return `${dateStr}-${slot}`;
}

/**
 * Convert a RankedArticle to an Article for storage.
 */
function toArticle(ranked: RankedArticle): Article {
  return {
    id: ranked.id,
    title: ranked.title,
    url: ranked.url,
    rawUrl: ranked.rawUrl,
    sourceUrl: ranked.sourceUrl,
    sourceResolutionMethod: ranked.sourceResolutionMethod,
    source: ranked.source,
    section: ranked.section,
    rank: ranked.rank,
    score: ranked.score,
    comments: ranked.comments,
    author: ranked.author,
    publishedAt: ranked.publishedAt,
    fetchedContent: ranked.rawContent,
    sourceAttribution: ranked.source,
    read: false,
    sources: [{ name: ranked.source, url: ranked.url }],
  };
}

export interface BuildEditionOptions {
  /** Hours to look back for digests (default: 14) */
  hoursBack?: number;
  /** Max articles per section (default: 10) */
  maxPerSection?: number;
  /** Specific job IDs to include */
  jobIds?: string[];
  /** Override slot detection */
  slot?: EditionSlot;
  /** Override date for edition ID */
  date?: Date;
  /** Blocked domains to filter out */
  blockedDomains?: string[];
}

/**
 * Build an edition from recent digests.
 * Pipeline: load digests → normalize → filter → dedup → rank → summarize → assemble edition.
 */
export async function buildEdition(options: BuildEditionOptions = {}): Promise<Edition> {
  const now = options.date ?? new Date();
  const slot = options.slot ?? determineSlot(now);
  const editionId = generateEditionId(now, slot);
  const hoursBack = options.hoursBack ?? 14;
  const maxPerSection = options.maxPerSection ?? 10;
  const blockedDomains = options.blockedDomains ?? [];

  console.log(`[newspaper] Building edition ${editionId}...`);

  // 1. Load and normalize
  let articles = loadAndNormalizeDigests(hoursBack, options.jobIds);
  console.log(`[newspaper] Normalized ${articles.length} articles from digests`);

  // 2. Filter blocked domains
  if (blockedDomains.length > 0) {
    articles = articles.filter(a => {
      try {
        const hostname = new URL(a.url).hostname;
        return !blockedDomains.some(d => hostname.includes(d));
      } catch {
        return true;
      }
    });
  }

  // 3. Deduplicate
  articles = deduplicateArticles(articles);
  console.log(`[newspaper] ${articles.length} articles after dedup`);

  // 4. Rank
  const ranked = rankArticles(articles, { maxPerSection });
  console.log(`[newspaper] ${ranked.length} articles after ranking`);

  // 5. Select lead story
  const lead = selectLeadStory(ranked);

  // 6. Assemble edition
  const edition: Edition = {
    id: editionId,
    createdAt: now.toISOString(),
    slot,
    leadStoryId: lead?.id,
    articles: ranked.map(toArticle),
  };

  // 7. LLM summarization (best-effort, won't break build on failure)
  try {
    const config = loadConfig();
    await summarizeEditionArticles(edition.articles, config);
  } catch (err) {
    console.warn(`[newspaper] Summarization failed, continuing without summaries:`, (err as Error).message);
  }

  // Log section breakdown
  const sectionCounts: Record<string, number> = {};
  for (const a of edition.articles) {
    sectionCounts[a.section] = (sectionCounts[a.section] ?? 0) + 1;
  }
  console.log(`[newspaper] Built edition ${editionId}: ${edition.articles.length} articles, sections: ${JSON.stringify(sectionCounts)}`);

  return edition;
}

/**
 * Build and save an edition. Returns the saved edition.
 */
export async function buildAndSaveEdition(options: BuildEditionOptions = {}): Promise<Edition> {
  const edition = await buildEdition(options);
  saveEdition(edition);
  console.log(`[newspaper] Saved edition ${edition.id}`);
  return edition;
}

/**
 * Build an edition from pre-loaded digests (for testing or custom pipelines).
 */
export function buildEditionFromDigests(
  digests: Digest[],
  options: Omit<BuildEditionOptions, 'hoursBack' | 'jobIds'> = {},
): Edition {
  const now = options.date ?? new Date();
  const slot = options.slot ?? determineSlot(now);
  const editionId = generateEditionId(now, slot);
  const maxPerSection = options.maxPerSection ?? 10;
  const blockedDomains = options.blockedDomains ?? [];

  // Normalize all digests
  let articles: NormalizedArticle[] = [];
  for (const digest of digests) {
    articles.push(...normalizeDigest(digest));
  }

  // Filter blocked domains
  if (blockedDomains.length > 0) {
    articles = articles.filter(a => {
      try {
        const hostname = new URL(a.url).hostname;
        return !blockedDomains.some(d => hostname.includes(d));
      } catch {
        return true;
      }
    });
  }

  // Dedup + rank
  articles = deduplicateArticles(articles);
  const ranked = rankArticles(articles, { maxPerSection });
  const lead = selectLeadStory(ranked);

  return {
    id: editionId,
    createdAt: now.toISOString(),
    slot,
    leadStoryId: lead?.id,
    articles: ranked.map(toArticle),
  };
}
