import { describe, it, expect } from 'vitest';
import { articlePath, editorialDisplayArticles, navHtml, pageShell } from '../newspaper/frontend.js';
import type { Article, Edition } from '../newspaper/types.js';

function makeArticle(overrides: Partial<Article> = {}): Article {
  return {
    id: 'article-1',
    title: 'Test article',
    url: 'https://example.com/story',
    source: 'Example News',
    section: 'us',
    rank: 1,
    sourceAttribution: 'Example News',
    read: false,
    sources: [{ name: 'Example News', url: 'https://example.com/story' }],
    ...overrides,
  };
}

function makeEdition(articles: Article[], leadStoryId?: string): Edition {
  return {
    id: '2026-04-12-evening',
    createdAt: new Date().toISOString(),
    slot: 'evening',
    leadStoryId,
    articles,
  };
}

describe('newspaper frontend — build status indicator', () => {
  it('navHtml includes fresh-news control', () => {
    const html = navHtml('front');
    expect(html).toContain('class="refresh-btn"');
    expect(html).toContain('Get Fresh News');
    expect(html).not.toContain('theme-toggle');
    expect(html).not.toContain('>Theme<');
    expect(html).not.toContain('class="build-btn"');
    expect(html).not.toContain('Rebuild');
  });

  it('pageShell includes broadsheet-style layout hooks', () => {
    const html = pageShell('Test', '<section class="front-grid"><div class="issue-strip"></div></section>');
    expect(html).toContain('.issue-strip');
    expect(html).toContain('.front-grid');
    expect(html).toContain('.banner-title');
    expect(html).toContain('.mini-story');
  });

  it('pageShell uses cream newspaper background without theme switching', () => {
    const html = pageShell('Test', '<p>content</p>');
    expect(html).toContain('--bg: #f5f0e8;');
    expect(html).toContain('--paper: #faf6ee;');
    expect(html).toContain('background: var(--bg);');
    expect(html).not.toContain('prefers-color-scheme');
    expect(html).not.toContain('data-theme');
    expect(html).not.toContain('newspaper-theme');
  });

  it('navHtml includes the build-status container with progress bar', () => {
    const html = navHtml();
    expect(html).toContain('class="build-status"');
    expect(html).toContain('class="build-progress-bar"');
    expect(html).toContain('class="build-progress-fill"');
    expect(html).toContain('class="build-status-text"');
    expect(html).toContain('class="build-detail"');
    expect(html).toContain('class="edition-sync"');
  });

  it('build-status is hidden by default (no "visible" class)', () => {
    const html = navHtml();
    // The status span should have class="build-status" without "visible"
    expect(html).toMatch(/class="build-status"[^>]*>/);
    expect(html).not.toMatch(/class="build-status visible"/);
  });

  it('pageShell includes setBuildStatus function', () => {
    const html = pageShell('Test', '<p>content</p>');
    expect(html).toContain('function setBuildStatus(');
  });

  it('pageShell includes triggerBuild function', () => {
    const html = pageShell('Test', '<p>content</p>');
    expect(html).toContain('async function triggerBuild(');
  });

  it('pageShell includes newspaper status loader', () => {
    const html = pageShell('Test', '<p>content</p>');
    expect(html).toContain('async function loadNewspaperStatus()');
    expect(html).toContain("fetch('/api/newspaper/status')");
  });

  it('triggerBuild does not require auth token', () => {
    const html = pageShell('Test', '<p>content</p>');
    expect(html).not.toContain('dashboard-token');
    expect(html).not.toContain("'Authorization'");
    expect(html).not.toContain('res.status === 401');
  });

  it('pageShell CSS includes build-status styles', () => {
    const html = pageShell('Test', '<p>content</p>');
    expect(html).toContain('.build-status');
    expect(html).toContain('.build-progress-bar');
    expect(html).toContain('.build-progress-fill.indeterminate');
    expect(html).toContain('@keyframes indeterminate');
  });

  it('pageShell includes a full-page loader overlay', () => {
    const html = pageShell('Test', '<p>content</p>');
    expect(html).toContain('class="page-loader"');
    expect(html).toContain('class="page-loader-card"');
    expect(html).toContain('.page-loader.visible');
    expect(html).toContain('@keyframes newspaperLoaderSlide');
  });

  it('pageShell includes internal navigation loader hooks', () => {
    const html = pageShell('Test', '<p>content</p>');
    expect(html).toContain('function setPageLoader(');
    expect(html).toContain('function shouldShowNavigationLoader(');
    expect(html).toContain("document.addEventListener('click'");
    expect(html).toContain("window.addEventListener('pageshow'");
  });

  it('triggerBuild sets success state and reloads on success', () => {
    const html = pageShell('Test', '<p>content</p>');
    expect(html).toContain("setBuildStatus('success'");
    expect(html).toContain('location.reload()');
  });

  it('triggerBuild sets error state on failure', () => {
    const html = pageShell('Test', '<p>content</p>');
    expect(html).toContain("setBuildStatus('error', 'Refresh failed'");
    expect(html).toContain("setBuildStatus('error', 'Refresh error'");
  });

  it('builds internal reader paths for article pages', () => {
    expect(articlePath('2026-04-13-evening', 'abc123')).toBe('/newspaper/article/2026-04-13-evening/abc123');
  });
});

describe('newspaper frontend — editorials fallback', () => {
  it('uses actual editorials when present', () => {
    const edition = makeEdition([
      makeArticle({ id: 'ed-1', section: 'editorials', source: 'Stratechery', title: 'Editorial piece' }),
      makeArticle({ id: 'news-1', section: 'us', source: 'news.google.com', title: 'Reported story' }),
    ]);

    const articles = editorialDisplayArticles(edition);

    expect(articles).toHaveLength(1);
    expect(articles[0].id).toBe('ed-1');
  });

  it('backfills editorials from non-Reddit HN/news articles when no editorials exist', () => {
    const edition = makeEdition([
      makeArticle({ id: 'lead', source: 'Hacker News', title: 'Lead story', summary: 'Lead summary' }),
      makeArticle({ id: 'news-1', source: 'news.google.com', title: 'Economy outlook', summary: 'Summary 1', rank: 2 }),
      makeArticle({ id: 'hn-2', source: 'Hacker News', title: 'Infra incident', rank: 3 }),
      makeArticle({ id: 'reddit-1', source: 'Reddit r/Philippines', title: 'Reddit post', summary: 'Should not appear', rank: 4 }),
    ], 'lead');

    const articles = editorialDisplayArticles(edition);

    expect(articles.map(article => article.id)).toEqual(['news-1', 'hn-2']);
  });
});
