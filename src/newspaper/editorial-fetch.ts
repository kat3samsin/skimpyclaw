import type { Article } from './types.js';
import {
  isGoogleNewsUrl,
  isLikelyIndexOrListingUrl,
  resolveArticleSource,
} from './source-resolution.js';

const ARTICLE_FETCH_TIMEOUT_MS = 12000;
const ARTICLE_MIN_CONTENT_CHARS = 1200;
const ARTICLE_MAX_CONTENT_CHARS = 12000;
const SEARCH_TIMEOUT_MS = 4000;

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, '\'')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

/** @internal exported for testing */
export function extractReadableTextFromHtml(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<(header|footer|nav|aside|form)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/article|\/section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  const normalized = decodeHtmlEntities(withoutNoise)
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');

  const paragraphs = normalized
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length >= 60)
    .filter(line => !/^subscribe|sign up|cookie|advertisement|share this/i.test(line));

  return paragraphs.join('\n\n').slice(0, ARTICLE_MAX_CONTENT_CHARS).trim();
}

function looksLikeHeadlineBundle(text: string): boolean {
  const paragraphs = text
    .split(/\n{2,}/)
    .map(part => part.trim())
    .filter(Boolean);

  if (paragraphs.length < 8) return false;

  const longSentenceCount = paragraphs.filter(part => /[.?!]["')\]]?$/.test(part) || /,\s+[a-z]/.test(part)).length;
  const shortHeadlineCount = paragraphs.filter(part => part.length >= 45 && part.length <= 140 && !/[.?!]["')\]]?$/.test(part)).length;
  const ratio = shortHeadlineCount / paragraphs.length;

  return longSentenceCount <= 2 && shortHeadlineCount >= 8 && ratio >= 0.7;
}

function hasUsableFetchedContent(article: Article): boolean {
  return Boolean(article.fetchedContent && article.fetchedContent.length >= ARTICLE_MIN_CONTENT_CHARS);
}

function isFetchableHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const blockedHosts = [
    'x.com',
    'twitter.com',
    'youtube.com',
    'www.youtube.com',
    'youtu.be',
  ];
  return !blockedHosts.some(domain => host === domain || host.endsWith(`.${domain}`));
}

/** @internal exported for testing */
export function canHydrateArticle(article: Article): boolean {
  if (hasUsableFetchedContent(article)) return false;

  try {
    const resolvedSource = resolveArticleSource(article.rawUrl ?? article.url, article.sourceUrl);
    const targetUrl = resolvedSource.canonicalUrl ?? article.rawUrl ?? article.url;
    const url = new URL(targetUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (isLikelyIndexOrListingUrl(targetUrl)) return false;
    return isFetchableHost(url);
  } catch {
    return false;
  }
}

function stripHtmlTags(text: string): string {
  return decodeHtmlEntities(text)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function compactParagraphs(lines: string[]): string {
  return lines
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => line.length >= 40)
    .join('\n\n')
    .slice(0, ARTICLE_MAX_CONTENT_CHARS)
    .trim();
}

function unwrapDuckDuckGoHref(href: string): string {
  try {
    const parsed = new URL(href, 'https://duckduckgo.com');
    if (parsed.hostname.endsWith('duckduckgo.com')) {
      const uddg = parsed.searchParams.get('uddg');
      if (uddg) return uddg;
    }
  } catch {
    // Fall through.
  }
  return href;
}

async function resolveGoogleNewsArticleUrl(article: Article): Promise<string | null> {
  const resolvedSource = resolveArticleSource(article.rawUrl ?? article.url, article.sourceUrl);
  if (resolvedSource.canonicalUrl && !isGoogleNewsUrl(resolvedSource.canonicalUrl)) {
    return resolvedSource.canonicalUrl;
  }

  const title = article.title.trim();
  if (!title) return null;

  try {
    const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(`"${title}"`)}`;
    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'skimpyclaw-newspaper/1.0 (+https://github.com/)',
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const html = await response.text();
    if (!html) return null;

    for (const match of html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"/gi)) {
      const candidate = unwrapDuckDuckGoHref(decodeHtmlEntities(match[1]).trim());
      try {
        const candidateUrl = new URL(candidate);
        const host = candidateUrl.hostname.toLowerCase();
        if (!(candidateUrl.protocol === 'http:' || candidateUrl.protocol === 'https:')) continue;
        if (host.includes('news.google.com') || host.includes('duckduckgo.com')) continue;
        if (isLikelyIndexOrListingUrl(candidateUrl.toString())) continue;
        return candidateUrl.toString();
      } catch {
        // Ignore malformed search hits.
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function fetchRedditThreadBody(url: URL): Promise<string | null> {
  const cleanRedditComment = (value: string): string | null => {
    const cleaned = stripHtmlTags(value).replace(/!\[[^\]]*\]\([^)]+\)/g, ' ').trim();
    if (!cleaned) return null;
    if (/featured it on our discord/i.test(cleaned)) return null;
    return cleaned;
  };

  try {
    const jsonUrl = `${url.origin}${url.pathname.replace(/\/$/, '')}.json${url.search || ''}`;
    const response = await fetch(jsonUrl, {
      headers: {
        'User-Agent': 'skimpyclaw-newspaper/1.0 (+https://github.com/)',
        'Accept': 'application/json,text/plain;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(ARTICLE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = await response.json() as any[];
    const post = payload?.[0]?.data?.children?.[0]?.data;
    if (!post) return null;

    const parts: string[] = [];
    if (post.title) parts.push(String(post.title));
    if (post.selftext) parts.push(String(post.selftext));

    const comments = payload?.[1]?.data?.children ?? [];
    for (const child of comments.slice(0, 5)) {
      const comment = child?.data;
      const cleaned = comment?.body ? cleanRedditComment(String(comment.body)) : null;
      if (cleaned) parts.push(cleaned);
    }

    const text = compactParagraphs(parts.map(stripHtmlTags));
    if (text.length >= 120) return text;
  } catch {
    // Fall through to HTML fallback below.
  }

  try {
    const oldRedditUrl = `https://old.reddit.com${url.pathname}${url.search || ''}`;
    const response = await fetch(oldRedditUrl, {
      headers: {
        'User-Agent': 'skimpyclaw-newspaper/1.0 (+https://github.com/)',
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(ARTICLE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const html = await response.text();
    if (!html) return null;

    const parts: string[] = [];
    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    if (titleMatch?.[1]) parts.push(stripHtmlTags(titleMatch[1]));

    for (const match of html.matchAll(/<div class="md"><p>([\s\S]*?)<\/p>/gi)) {
      const cleaned = cleanRedditComment(match[1]);
      if (cleaned) parts.push(cleaned);
      if (parts.length >= 8) break;
    }

    const text = compactParagraphs(parts);
    return text.length >= 120 ? text : null;
  } catch {
    return null;
  }
}

async function fetchGithubRepoBody(url: URL): Promise<string | null> {
  try {
    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'skimpyclaw-newspaper/1.0 (+https://github.com/)',
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(ARTICLE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const html = await response.text();
    if (!html) return null;

    const parts: string[] = [];
    const descriptionMatch = html.match(/<meta property="og:description" content="([^"]+)"/i);
    if (descriptionMatch?.[1]) parts.push(descriptionMatch[1]);

    const readmeMatch = html.match(/<article[^>]*markdown-body[^>]*>([\s\S]*?)<\/article>/i);
    if (readmeMatch?.[1]) parts.push(stripHtmlTags(readmeMatch[1]));

    const text = compactParagraphs(parts);
    return text.length >= 200 ? text : null;
  } catch {
    return null;
  }
}

async function fetchHackerNewsDiscussionBody(url: URL): Promise<string | null> {
  const itemId = url.searchParams.get('id');
  if (!itemId) return null;

  try {
    const response = await fetch(`https://hn.algolia.com/api/v1/items/${encodeURIComponent(itemId)}`, {
      headers: {
        'User-Agent': 'skimpyclaw-newspaper/1.0 (+https://github.com/)',
        'Accept': 'application/json,text/plain;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(ARTICLE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const item = await response.json() as any;
    const parts: string[] = [];
    if (item?.title) parts.push(String(item.title));
    if (item?.text) parts.push(String(item.text));

    const comments = Array.isArray(item?.children) ? item.children : [];
    for (const comment of comments.slice(0, 5)) {
      if (comment?.text) parts.push(String(comment.text));
    }

    const text = compactParagraphs(parts.map(stripHtmlTags));
    return text.length >= 200 ? text : null;
  } catch {
    return null;
  }
}

/** @internal exported for testing */
export async function fetchArticleBody(url: string, article?: Article): Promise<string | null> {
  try {
    const requestedUrl = url;
    const parsedUrl = new URL(requestedUrl);
    const host = parsedUrl.hostname.toLowerCase();
    if (isLikelyIndexOrListingUrl(requestedUrl)) return null;

    if (host.includes('news.google.com')) {
      const resolvedUrl = article ? await resolveGoogleNewsArticleUrl(article) : null;
      if (!resolvedUrl) return null;
      return await fetchArticleBody(resolvedUrl, {
        ...(article ?? {
          id: '',
          title: '',
          url: resolvedUrl,
          source: '',
          section: 'us',
          rank: 0,
          sourceAttribution: '',
          read: false,
          sources: [],
        }),
        url: resolvedUrl,
      });
    }

    if (host.includes('reddit.com')) {
      return await fetchRedditThreadBody(parsedUrl);
    }

    if (host === 'github.com' || host.endsWith('.github.com')) {
      return await fetchGithubRepoBody(parsedUrl);
    }

    if (host === 'news.ycombinator.com') {
      return await fetchHackerNewsDiscussionBody(parsedUrl);
    }

    const response = await fetch(requestedUrl, {
      headers: {
        'User-Agent': 'skimpyclaw-newspaper/1.0 (+https://github.com/)',
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(ARTICLE_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    const raw = await response.text();
    if (!raw) return null;

    const text = contentType.includes('text/plain')
      ? raw.trim().slice(0, ARTICLE_MAX_CONTENT_CHARS)
      : extractReadableTextFromHtml(raw);

    if (looksLikeHeadlineBundle(text)) return null;

    return text.length >= 400 ? text : null;
  } catch {
    return null;
  }
}

export async function hydrateArticleContent(article: Article): Promise<boolean> {
  if (!canHydrateArticle(article)) return false;
  const text = await fetchArticleBody(article.url, article);
  if (!text) return false;
  article.fetchedContent = text;
  return true;
}
