// Normalize digest output into NormalizedArticle[]

import { createHash } from 'crypto';
import { getDigests, getDigest } from '../digests.js';
import type { Digest, DigestArticle } from '../digests.js';
import type { NormalizedArticle, Section } from './types.js';
import { JOB_SECTION_MAP } from './types.js';
import { resolveArticleSource } from './source-resolution.js';

function generateArticleId(url: string): string {
  return createHash('md5').update(url).digest('hex').slice(0, 12);
}

export { decodeGoogleNewsArticleUrl, isInvalidGoogleNewsUrl, sanitizeArticleUrl } from './source-resolution.js';

/** Domains and keywords that indicate long-form editorial/opinion content. */
const EDITORIAL_DOMAINS = [
  'substack.com', 'medium.com', 'paulgraham.com', 'stratechery.com',
  'lesswrong.com', 'overcomingbias.com', 'astralcodexten.com',
  'danluu.com', 'gwern.net', 'ribbonfarm.com',
];

const EDITORIAL_KEYWORDS = [
  'opinion:', 'editorial:', 'essay:', 'long read:', 'deep dive:',
  'analysis:', 'perspective:', 'commentary:',
];

/** Minimum content length (chars) to classify as editorial when from a blog-like source. */
const EDITORIAL_CONTENT_THRESHOLD = 3000;

function isEditorial(article: DigestArticle): boolean {
  // Check URL domain
  try {
    const hostname = new URL(article.url).hostname;
    if (EDITORIAL_DOMAINS.some(d => hostname.includes(d))) return true;
  } catch { /* ignore invalid URLs */ }

  // Check title prefixes
  const titleLower = article.title.toLowerCase();
  if (EDITORIAL_KEYWORDS.some(kw => titleLower.startsWith(kw))) return true;

  // Check content length (long-form blog posts)
  if (article.content && article.content.length >= EDITORIAL_CONTENT_THRESHOLD) return true;

  return false;
}

/**
 * Infer the section for an article based on its digest job ID and source/content.
 * news-digest produces both US and World articles — use title heuristics to split.
 */
function inferSection(article: DigestArticle, jobId: string): Section {
  // Check for editorial content first
  if (isEditorial(article)) return 'editorials';
  const sections = JOB_SECTION_MAP[jobId];
  if (!sections) return 'us'; // fallback

  // If the job maps to a single section, use it
  if (sections.length === 1) return sections[0];

  // news-digest has US, World, and Business — use title heuristics to split
  const titleLower = article.title.toLowerCase();

  // Business keywords
  const businessKeywords = [
    'stock', 'market', 'dow', 'nasdaq', 's&p', 'wall street', 'fed ',
    'federal reserve', 'interest rate', 'inflation', 'gdp', 'earnings',
    'ipo', 'merger', 'acquisition', 'revenue', 'profit', 'recession',
    'treasury', 'bond', 'investor', 'trading', 'rally', 'selloff',
    'bull market', 'bear market', 'crypto', 'bitcoin', 'oil price',
    'commodity', 'tariff', 'trade war', 'economic', 'economy',
    'unemployment', 'jobs report', 'cpi ', 'ppi ',
  ];
  if (sections.includes('business')) {
    for (const kw of businessKeywords) {
      if (titleLower.includes(kw)) return 'business';
    }
  }

  // World keywords
  const worldKeywords = [
    'ukraine', 'russia', 'china', 'europe', 'eu ', 'nato', 'un ',
    'middle east', 'israel', 'gaza', 'iran', 'india', 'japan',
    'korea', 'africa', 'latin america', 'uk ', 'britain', 'france',
    'germany', 'brazil', 'mexico', 'australia', 'canada',
    'global', 'international', 'world',
  ];
  for (const kw of worldKeywords) {
    if (titleLower.includes(kw)) return 'world';
  }

  return 'us'; // default for news-digest
}

/**
 * Infer section from raw digest text by looking at markdown section headers.
 * Returns a map of article URL → section.
 */
function inferSectionsFromRawText(rawText: string, jobId: string): Map<string, Section> {
  const sections = JOB_SECTION_MAP[jobId];
  if (!sections || sections.length <= 1) return new Map();

  const urlSectionMap = new Map<string, Section>();
  const lines = rawText.split('\n');
  let currentSection: Section = 'us';

  for (const line of lines) {
    // Detect section headers like "## US Headlines" or "## World Headlines"
    const headerMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headerMatch) {
      const header = headerMatch[1].toLowerCase();
      if (header.includes('editorial') || header.includes('opinion') || header.includes('long read')) {
        currentSection = 'editorials';
      } else if (header.includes('business') || header.includes('market') || header.includes('finance')) {
        currentSection = 'business';
      } else if (header.includes('briefing') || header.includes('morning')) {
        currentSection = 'briefing';
      } else if (header.includes('philipp') || /\bph\b/.test(header)) {
        currentSection = 'ph';
      } else if (header.includes('ai') || header.includes('tech')) {
        currentSection = 'ai';
      } else if (header.includes('world')) {
        currentSection = 'world';
      } else if (header.includes('us') || header.includes('u.s.') || header.includes('america')) {
        currentSection = 'us';
      }
    }

    // Find URLs on this line and assign current section
    const urlMatch = line.match(/https?:\/\/[^\s)\]>'"`]+/gi);
    if (urlMatch) {
      for (const url of urlMatch) {
        const cleaned = url.replace(/[.,;:!?)\]>'"`]+$/, '');
        urlSectionMap.set(cleaned, currentSection);
      }
    }
  }

  return urlSectionMap;
}

/**
 * Convert a single Digest into NormalizedArticle[].
 */
export function normalizeDigest(digest: Digest): NormalizedArticle[] {
  const now = new Date().toISOString();
  const sectionMap = digest.summary
    ? inferSectionsFromRawText(digest.summary, digest.jobId)
    : new Map<string, Section>();

  const results: NormalizedArticle[] = [];
  for (const article of digest.articles) {
    const resolvedSource = resolveArticleSource(article.url, article.sourceUrl);
    const cleanUrl = resolvedSource.canonicalUrl;
    if (!cleanUrl) {
      console.warn(`[newspaper] Dropping article "${article.title}" — invalid URL: ${article.url}`);
      continue;
    }
    results.push({
      id: generateArticleId(cleanUrl),
      title: article.title,
      url: cleanUrl,
      rawUrl: resolvedSource.rawUrl,
      sourceUrl: resolvedSource.sourceUrl,
      sourceResolutionMethod: resolvedSource.method,
      source: article.source,
      section: sectionMap.get(article.url) || sectionMap.get(cleanUrl) || inferSection(article, digest.jobId),
      score: article.score,
      comments: article.comments,
      author: article.author,
      publishedAt: article.publishedAt,
      rawContent: article.content,
      fetchedAt: digest.createdAt || now,
    });
  }
  return results;
}

/**
 * Load recent digests for a given time window and normalize them.
 * Returns all articles from digests created within the window.
 */
export function loadAndNormalizeDigests(
  hoursBack: number = 14,
  jobIds?: string[],
): NormalizedArticle[] {
  const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
  const allArticles: NormalizedArticle[] = [];

  const targetJobs = jobIds || Object.keys(JOB_SECTION_MAP);

  for (const jobId of targetJobs) {
    const digestList = getDigests(jobId, 10); // get recent digests for this job
    for (const item of digestList) {
      if (new Date(item.createdAt) < cutoff) continue;
      const digest = getDigest(item.id);
      if (!digest) continue;
      allArticles.push(...normalizeDigest(digest));
    }
  }

  return allArticles;
}
