import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canHydrateArticle,
  extractReadableTextFromHtml,
  hydrateArticleContent,
} from '../newspaper/editorial-fetch.js';
import type { Article } from '../newspaper/types.js';

function makeArticle(overrides: Partial<Article> = {}): Article {
  return {
    id: 'editorial-1',
    title: 'Editorial',
    url: 'https://example.com/editorial',
    source: 'Example Opinion',
    section: 'editorials',
    rank: 1,
    sourceAttribution: 'Example Opinion',
    read: false,
    sources: [{ name: 'Example Opinion', url: 'https://example.com/editorial' }],
    ...overrides,
  };
}

describe('extractReadableTextFromHtml', () => {
  it('removes boilerplate tags and keeps readable paragraphs', () => {
    const html = `
      <html>
        <body>
          <header>Navigation</header>
          <article>
            <p>This is the first substantial paragraph of the article body with enough text to survive cleanup.</p>
            <p>This is the second substantial paragraph, also long enough to be retained in the cleaned editorial body.</p>
          </article>
          <footer>Subscribe now</footer>
        </body>
      </html>`;

    const text = extractReadableTextFromHtml(html);

    expect(text).toContain('first substantial paragraph');
    expect(text).toContain('second substantial paragraph');
    expect(text).not.toContain('Navigation');
    expect(text).not.toContain('Subscribe now');
  });
});

describe('canHydrateArticle', () => {
  it('allows direct article URLs plus supported discussion/repo sources, and blocks unsupported social hosts', () => {
    expect(canHydrateArticle(makeArticle({ section: 'us', url: 'https://example.com/story' }))).toBe(true);
    expect(canHydrateArticle(makeArticle({ section: 'ai', url: 'https://github.com/acme/project' }))).toBe(true);
    expect(canHydrateArticle(makeArticle({ section: 'ai', url: 'https://news.ycombinator.com/item?id=1' }))).toBe(true);
    expect(canHydrateArticle(makeArticle({ section: 'ai', url: 'https://www.reddit.com/r/test/comments/1/demo/' }))).toBe(true);
    expect(canHydrateArticle(makeArticle({ section: 'ai', url: 'https://x.com/some/post/1' }))).toBe(false);
    expect(canHydrateArticle(makeArticle({ section: 'us', url: 'https://www.nytimes.com/sitemap/today/' }))).toBe(false);
  });
});

describe('hydrateArticleContent', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('fetches and stores cleaned text for article pages', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/html' }),
      text: async () => `
        <article>
          <p>This is a full editorial paragraph that should be pulled into the newspaper and displayed to the reader in full.</p>
          <p>This is another long paragraph with enough detail to satisfy the minimum content threshold used by the fetcher.</p>
          <p>A third long paragraph keeps the body comfortably above the minimum content threshold for storage.</p>
          <p>A fourth paragraph ensures the final extracted content is long enough to be retained after cleanup and trimming.</p>
        </article>`,
    } as any);

    const article = makeArticle({ section: 'us' });
    const result = await hydrateArticleContent(article);

    expect(result).toBe(true);
    expect(article.fetchedContent).toContain('full editorial paragraph');
    expect(article.fetchedContent?.length).toBeGreaterThan(400);
  });

  it('skips unsupported hosts', async () => {
    global.fetch = vi.fn();

    const article = makeArticle({ section: 'ai', url: 'https://x.com/some/post/1' });
    const result = await hydrateArticleContent(article);

    expect(result).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects headline listing pages instead of storing them as article bodies', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/html' }),
      text: async () => `
        <main>
          <p>El amerizaje del Artemis II da impulso a la NASA en la renovada carrera lunar</p>
          <p>Eric Swalwell Suspends Campaign for California Governor After Sexual Assault Allegations</p>
          <p>How Would a Blockade of the Strait of Hormuz Work? Here Are Some Possibilities.</p>
          <p>Trump Says Gas Prices Might Not Drop By Midterms, Highlighting G.O.P. Peril</p>
          <p>Mamdani Returns to the Stage to Tell the Story of His First 100 Days</p>
          <p>Titanique on Broadway: Wild Titanic Parody, With Celine Dion as Kooky Guide</p>
          <p>Aiming at China, Malaysia Puts New Restrictions on Electric Cars</p>
          <p>China's Electrostate Is Poised to Win From War in the Middle East</p>
          <p>Quote of the Day: However Real the Issues, Congress More Resembles The Real Housewives</p>
        </main>`,
    } as any);

    const article = makeArticle({ section: 'us', url: 'https://example.com/sitemap/today' });
    const result = await hydrateArticleContent(article);

    expect(result).toBe(false);
    expect(article.fetchedContent).toBeUndefined();
  });

  it('resolves Google News wrappers through search and stores the fetched article body', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => `
          <html><body>
            <a class="result__a" href="https://duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com/business/story')}">story</a>
          </body></html>`,
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => `
          <article>
            <p>This is the first substantial paragraph of the business article body with enough detail to exceed the fetch threshold.</p>
            <p>This is the second substantial paragraph with market context, numbers, and concrete details about the reported event.</p>
            <p>This is the third substantial paragraph that provides the additional body length required for in-paper rendering.</p>
            <p>This is the fourth substantial paragraph to keep the extracted article body comfortably above the minimum threshold.</p>
          </article>`,
      } as any);

    const article = makeArticle({
      section: 'business',
      title: 'Oil prices rise after Trump threatens to block passage through Strait of Hormuz',
      url: 'https://news.google.com/rss/articles/test-wrapper',
      source: 'news.google.com',
    });
    const result = await hydrateArticleContent(article);

    expect(result).toBe(true);
    expect(article.fetchedContent).toContain('first substantial paragraph');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
