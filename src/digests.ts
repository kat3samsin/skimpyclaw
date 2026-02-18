// Digest storage and management for cron job outputs

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { getLogsDir } from './config.js';

export interface DigestArticle {
  id: string;
  title: string;
  source: string;
  url: string;
  score?: number;
  comments?: number;
  author?: string;
  summary?: string;
  content?: string;
  publishedAt?: string;
  read?: boolean;
}

export interface Digest {
  id: string;
  jobId: string;
  jobName: string;
  createdAt: string;
  articles: DigestArticle[];
  summary?: string;
}

export interface DigestListItem {
  id: string;
  jobId: string;
  jobName: string;
  createdAt: string;
  articleCount: number;
  preview: string[];
}

const DIGESTS_DIR_NAME = 'digests';

export function getDigestsDir(): string {
  const dir = join(getLogsDir(), DIGESTS_DIR_NAME);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getJobDir(jobId: string): string {
  const dir = join(getDigestsDir(), jobId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function generateDigestId(jobId: string, timestamp: string): string {
  const hash = createHash('md5').update(`${jobId}-${timestamp}`).digest('hex').slice(0, 8);
  return `${jobId}-${hash}`;
}

function generateArticleId(url: string): string {
  return createHash('md5').update(url).digest('hex').slice(0, 12);
}

export function saveDigest(digest: Digest): void {
  const jobDir = getJobDir(digest.jobId);
  const date = new Date(digest.createdAt).toISOString().split('T')[0];
  const filePath = join(jobDir, `${date}-${digest.id}.json`);
  writeFileSync(filePath, JSON.stringify(digest, null, 2), 'utf-8');
}

export function getDigests(jobId?: string, limit?: number): DigestListItem[] {
  const digestsDir = getDigestsDir();
  const items: DigestListItem[] = [];

  const jobDirs = jobId
    ? [join(digestsDir, jobId)].filter(existsSync)
    : readdirSync(digestsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => join(digestsDir, d.name));

  for (const dir of jobDirs) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const content = readFileSync(join(dir, file), 'utf-8');
        const digest: Digest = JSON.parse(content);
        items.push({
          id: digest.id,
          jobId: digest.jobId,
          jobName: digest.jobName,
          createdAt: digest.createdAt,
          articleCount: digest.articles.length,
          preview: digest.articles.slice(0, 2).map(a => a.title),
        });
      } catch {
        // Skip invalid files
      }
    }
  }

  // Sort by createdAt desc
  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  if (limit && limit > 0) {
    return items.slice(0, limit);
  }
  return items;
}

export function getDigest(id: string): Digest | null {
  const digestsDir = getDigestsDir();
  const jobDirs = readdirSync(digestsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => join(digestsDir, d.name));

  for (const dir of jobDirs) {
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const content = readFileSync(join(dir, file), 'utf-8');
        const digest: Digest = JSON.parse(content);
        if (digest.id === id) {
          return digest;
        }
      } catch {
        // Skip invalid files
      }
    }
  }
  return null;
}

export function deleteDigest(id: string): boolean {
  const digestsDir = getDigestsDir();
  const jobDirs = readdirSync(digestsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => join(digestsDir, d.name));

  for (const dir of jobDirs) {
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const content = readFileSync(join(dir, file), 'utf-8');
        const digest: Digest = JSON.parse(content);
        if (digest.id === id) {
          unlinkSync(join(dir, file));
          return true;
        }
      } catch {
        // Skip invalid files
      }
    }
  }
  return false;
}

export function updateArticleReadStatus(digestId: string, articleId: string, read: boolean): boolean {
  const digest = getDigest(digestId);
  if (!digest) return false;

  const article = digest.articles.find(a => a.id === articleId);
  if (!article) return false;

  article.read = read;
  saveDigest(digest);
  return true;
}

// --- Parsing Logic ---

interface ParsedArticle {
  title: string;
  url: string;
  source: string;
  score?: number;
  comments?: number;
  author?: string;
}

function detectSource(url: string): string {
  if (url.includes('news.ycombinator.com')) return 'Hacker News';
  if (url.includes('reddit.com')) {
    const match = url.match(/reddit\.com\/r\/([^/]+)/i);
    return match ? `Reddit r/${match[1]}` : 'Reddit';
  }
  if (url.includes('github.com')) return 'GitHub';
  if (url.includes('x.com') || url.includes('twitter.com')) return 'X';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'YouTube';
  if (url.includes('medium.com')) return 'Medium';
  if (url.includes('dev.to')) return 'Dev.to';
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, '');
  } catch {
    return 'Web';
  }
}

function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s)\]>'"`]+/gi;
  const matches = text.match(urlRegex) || [];
  // Clean up trailing punctuation
  return matches.map(url => url.replace(/[.,;:!?)\]>'"`]+$/, ''));
}

function extractTitleForUrl(text: string, url: string): string {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(url)) {
      // If the URL is on its own line (🔗 link line), look backwards for the title
      const isLinkOnlyLine = /^\s*🔗?\s*https?:\/\//i.test(line.trim());
      if (isLinkOnlyLine) {
        // Scan up to 3 lines back to find a numbered/bulleted title line
        for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
          const prev = lines[j].trim();
          if (!prev) continue;
          // Skip stats lines (⬆️, 💬, 🔥, ⭐, etc.)
          // Skip lines with emoji prefix (stats lines like ⬆️, 💬, 🔥, etc)
          // eslint-disable-next-line no-misleading-character-class
          if (/^[\u2B06\uFE0F\u{1F4AC}\u{1F525}\u{1F504}\u2B50\u{1F517}]+/u.test(prev)) continue;
          // Skip lines that are just URLs
          if (/^https?:\/\//.test(prev)) continue;
          // Found a title line — strip numbering/bullets and emoji prefix
          const cleaned = prev.replace(/^\d+\.\s*/, '').replace(/^[-*•]\s*/, '').trim();
          if (cleaned.length > 0) {
            // Strip trailing stats if inlined (e.g. "Title — ⭐ 123 stars today")
            // Strip trailing stats if inlined
          // eslint-disable-next-line no-misleading-character-class
          const noStats = cleaned.replace(/\s*[—-]\s*[\u2B50\u{1F525}\u2B06\uFE0F\u{1F4AC}\u{1F504}].+$/u, '').trim();
            return (noStats || cleaned).slice(0, 150);
          }
        }
      }
      // Title on same line as URL (inline format)
      const titleMatch = line.match(/^\s*[-*•]?\s*\d*\.?\s*(.+?)\s+https?:/);
      if (titleMatch) {
        return titleMatch[1].trim().slice(0, 150);
      }
      // Check previous line
      if (i > 0) {
        const prevLine = lines[i - 1].trim();
        // eslint-disable-next-line no-misleading-character-class
        if (prevLine && !prevLine.startsWith('http') && !/^[\u2B06\uFE0F\u{1F4AC}\u{1F525}\u{1F504}\u2B50\u{1F517}]+/u.test(prevLine)) {
          const cleaned = prevLine.replace(/^\d+\.\s*/, '').replace(/^[-*•]\s*/, '').trim();
          if (cleaned.length > 0) return cleaned.slice(0, 150);
        }
      }
    }
  }
  // Fallback: extract readable title from URL path
  return extractTitleFromUrl(url);
}

function extractTitleFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.replace(/\/+$/, ''); // strip trailing slash
    const segments = pathname.split('/').filter(Boolean);

    // Reddit: /r/sub/comments/id/title_slug → use title_slug
    if (urlObj.hostname.includes('reddit.com') && segments.length >= 5) {
      const slug = segments[4] || segments[segments.length - 1];
      return decodeURIComponent(slug.replace(/_/g, ' ')).slice(0, 150);
    }

    // GitHub: /owner/repo → "owner/repo"
    if (urlObj.hostname === 'github.com' && segments.length >= 2) {
      return `${segments[0]}/${segments[1]}`;
    }

    // HN: /item?id=123 → "Hacker News #123"
    if (urlObj.hostname === 'news.ycombinator.com') {
      const id = urlObj.searchParams.get('id');
      return id ? `Hacker News #${id}` : 'Hacker News';
    }

    // X/Twitter: /handle → "@handle"
    if (urlObj.hostname === 'x.com' || urlObj.hostname === 'twitter.com') {
      if (segments.length >= 1) return `@${segments[0]}`;
    }

    // General: use last meaningful path segment
    const last = segments.pop() || '';
    const decoded = decodeURIComponent(last.replace(/[-_]/g, ' ')).trim();
    return decoded.length > 0 ? decoded.slice(0, 150) : urlObj.hostname;
  } catch {
    return 'Untitled';
  }
}

function parseNumericValue(raw: string): number {
  const num = raw.toLowerCase().replace(/,/g, '');
  if (num.endsWith('k')) return parseFloat(num) * 1000;
  if (num.endsWith('m')) return parseFloat(num) * 1000000;
  if (num.endsWith('b')) return parseFloat(num) * 1000000000;
  return parseFloat(num);
}

function getNearbyLines(text: string, url: string): string[] {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(url)) {
      // Return the URL line plus 3 lines before and 1 after
      return lines.slice(Math.max(0, i - 3), i + 2);
    }
  }
  return [];
}

function extractScore(text: string, url: string, source: string): number | undefined {
  const nearby = getNearbyLines(text, url);
  for (const line of nearby) {
    // Hacker News: "123 points"
    const hnMatch = line.match(/(\d+(?:[.,]\d+)?)\s*points?/i);
    if (hnMatch) return parseNumericValue(hnMatch[1]);

    // Reddit: "45 upvotes" or ⬆️ 45
    const upvoteMatch = line.match(/(?:⬆️\s*)?(\d+(?:[.,]\d+)?[kmb]?)\s*(?:upvotes?|votes?)/i);
    if (upvoteMatch) return parseNumericValue(upvoteMatch[1]);

    // GitHub: "123 stars" or ⭐ 123
    const ghMatch = line.match(/(?:⭐\s*)?(\d+(?:[.,]\d+)?[kmb]?)\s*stars?/i);
    if (ghMatch) return parseNumericValue(ghMatch[1]);

    // X/Twitter: likes or 🔥
    const likesMatch = line.match(/(?:🔥\s*)?(\d+(?:[.,]\d+)?[kmb]?)\s*likes?/i);
    if (likesMatch) return parseNumericValue(likesMatch[1]);
  }
  return undefined;
}

function extractComments(text: string, url: string): number | undefined {
  const nearby = getNearbyLines(text, url);
  for (const line of nearby) {
    // 💬 N comments or just "N comments"
    const match = line.match(/(?:💬\s*)?(\d+(?:[.,]\d+)?[kmb]?)\s*comments?/i);
    if (match) return Math.round(parseNumericValue(match[1]));
  }
  return undefined;
}

function parseDigestContent(text: string): ParsedArticle[] {
  const urls = extractUrls(text);
  const seen = new Set<string>();
  const articles: ParsedArticle[] = [];

  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);

    const source = detectSource(url);
    const title = extractTitleForUrl(text, url);
    const score = extractScore(text, url, source);
    const comments = extractComments(text, url);

    articles.push({
      title,
      url,
      source,
      score,
      comments,
    });
  }

  return articles;
}

export function parseAndSaveDigest(jobId: string, jobName: string, rawOutput: string): Digest {
  const parsed = parseDigestContent(rawOutput);

  const digest: Digest = {
    id: generateDigestId(jobId, new Date().toISOString()),
    jobId,
    jobName,
    createdAt: new Date().toISOString(),
    articles: parsed.map(p => ({
      id: generateArticleId(p.url),
      title: p.title,
      source: p.source,
      url: p.url,
      score: p.score,
      comments: p.comments,
      author: p.author,
      read: false,
    })),
    summary: rawOutput,
  };

  saveDigest(digest);
  return digest;
}
