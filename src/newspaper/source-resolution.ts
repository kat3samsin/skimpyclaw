export type SourceResolutionMethod =
  | 'primary'
  | 'source_url'
  | 'decoded_google_news'
  | 'invalid';

export interface ResolvedArticleSource {
  rawUrl: string;
  canonicalUrl: string | null;
  sourceUrl?: string;
  method: SourceResolutionMethod;
}

export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isGoogleNewsUrl(url: string): boolean {
  try {
    return new URL(url).hostname.includes('news.google.com');
  } catch {
    return false;
  }
}

export function isLikelyIndexOrListingUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase().replace(/\/+$/, '') || '/';

    if (path === '/' || path === '/today') return true;
    if (path.includes('/sitemap')) return true;
    if (/(^|\/)(section|sections|topic|topics|tag|tags|search|archive|archives|latest|headlines)(\/|$)/.test(path)) {
      return true;
    }
    if (host.includes('nytimes.com') && path === '/sitemap/today') return true;
    return false;
  } catch {
    return false;
  }
}

function extractGoogleNewsArticleToken(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('news.google.com')) return null;
    const match = parsed.pathname.match(/\/(?:rss\/)?articles\/([^/?#]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function decodeGoogleNewsArticleUrl(url: string): string | null {
  const token = extractGoogleNewsArticleToken(url);
  if (!token) return null;

  try {
    const normalizedToken = token.replace(/-/g, '+').replace(/_/g, '/');
    const paddedToken = normalizedToken.padEnd(Math.ceil(normalizedToken.length / 4) * 4, '=');
    const decoded = Buffer.from(paddedToken, 'base64').toString('utf8');
    const embeddedUrlMatch = decoded.match(/https?:\/\/[^\s"'<>\\\u0000-\u001f]+/i);
    const embeddedUrl = embeddedUrlMatch?.[0]?.replace(/[^\x20-\x7e]+$/g, '');
    if (!embeddedUrl || !isHttpUrl(embeddedUrl) || isGoogleNewsUrl(embeddedUrl)) return null;
    return embeddedUrl;
  } catch {
    return null;
  }
}

export function isInvalidGoogleNewsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('news.google.com')) return false;

    const match = u.pathname.match(/\/(?:rss\/)?articles\/(.+)/);
    if (!match) return false;

    const articleId = match[1];
    if (/^[a-z0-9-]+$/.test(articleId)) return true;

    return false;
  } catch {
    return false;
  }
}

function isUsableResolvedUrl(url?: string): boolean {
  return Boolean(url && isHttpUrl(url) && !isInvalidGoogleNewsUrl(url) && !isLikelyIndexOrListingUrl(url));
}

export function resolveArticleSource(url: string, sourceUrl?: string): ResolvedArticleSource {
  const decodedGoogleNewsUrl = decodeGoogleNewsArticleUrl(url);

  if (isGoogleNewsUrl(url) && isUsableResolvedUrl(sourceUrl)) {
    return {
      rawUrl: url,
      canonicalUrl: sourceUrl!,
      sourceUrl,
      method: 'source_url',
    };
  }

  if (isGoogleNewsUrl(url) && isUsableResolvedUrl(decodedGoogleNewsUrl ?? undefined)) {
    return {
      rawUrl: url,
      canonicalUrl: decodedGoogleNewsUrl!,
      sourceUrl,
      method: 'decoded_google_news',
    };
  }

  if (isUsableResolvedUrl(url)) {
    return {
      rawUrl: url,
      canonicalUrl: url,
      sourceUrl,
      method: 'primary',
    };
  }

  if (isUsableResolvedUrl(sourceUrl)) {
    return {
      rawUrl: url,
      canonicalUrl: sourceUrl!,
      sourceUrl,
      method: 'source_url',
    };
  }

  if (isUsableResolvedUrl(decodedGoogleNewsUrl ?? undefined)) {
    return {
      rawUrl: url,
      canonicalUrl: decodedGoogleNewsUrl!,
      sourceUrl,
      method: 'decoded_google_news',
    };
  }

  return {
    rawUrl: url,
    canonicalUrl: null,
    sourceUrl,
    method: 'invalid',
  };
}

export function sanitizeArticleUrl(url: string, sourceUrl?: string): string | null {
  return resolveArticleSource(url, sourceUrl).canonicalUrl;
}
