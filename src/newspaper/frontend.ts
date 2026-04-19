// The Daily Claw — Newspaper frontend (inline HTML/CSS/JS)

import type { FastifyInstance } from 'fastify';
import type { Edition, Article, Section } from './types.js';
import { SECTION_LABELS, ALL_SECTIONS } from './types.js';
import { getTodayEdition, getEdition, listEditions, getLatestEdition, saveEdition } from './storage.js';
import { hydrateArticleContent } from './editorial-fetch.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isInternalPath(url: string): boolean {
  return url.startsWith('/');
}

/** @internal exported for testing */
export function articlePath(editionId: string, articleId: string): string {
  return `/newspaper/article/${encodeURIComponent(editionId)}/${encodeURIComponent(articleId)}`;
}

function linkedTitle(title: string, url: string, external: boolean = true): string {
  const escaped = escapeHtml(title);
  const valid = external ? isValidUrl(url) : (isInternalPath(url) || isValidUrl(url));
  if (!url || !valid) {
    return `<span class="no-link" title="No valid link available">${escaped}</span>`;
  }
  if (external) {
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escaped}</a>`;
  }
  return `<a href="${escapeHtml(url)}" data-newspaper-nav="true">${escaped}</a>`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

function readingTime(articleCount: number): string {
  const minutes = Math.max(1, Math.ceil(articleCount * 0.3));
  return `${minutes} min read`;
}

function editorialBodyHtml(article: Article): string {
  if (article.section !== 'editorials' || !article.fetchedContent) return '';

  const paragraphs = article.fetchedContent
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
    .map(paragraph => `<p class="editorial-body-paragraph">${escapeHtml(paragraph)}</p>`)
    .join('');

  return paragraphs ? `<div class="editorial-body">${paragraphs}</div>` : '';
}

function articleCardHtml(
  article: Article,
  editionId: string,
  showSection: boolean = false,
  showFullEditorialBody: boolean = false,
): string {
  const sectionBadge = showSection
    ? `<span class="section-badge section-${article.section}">${escapeHtml(SECTION_LABELS[article.section])}</span>`
    : '';
  const scoreBadge = article.score != null
    ? `<span class="score-badge" title="Score">${article.score}</span>`
    : '';
  const commentsBadge = article.comments != null
    ? `<span class="comments-badge" title="Comments">${article.comments} comments</span>`
    : '';
  const readClass = article.read ? 'article-read' : '';
  const summaryHtml = article.summary
    ? `<p class="article-summary">${escapeHtml(article.summary)}</p>`
    : '';
  const whyHtml = article.keyTakeaways?.[0]
    ? `<p class="why-it-matters"><strong>Why it matters:</strong> ${escapeHtml(article.keyTakeaways[0])}</p>`
    : '';
  const editorialBody = showFullEditorialBody ? editorialBodyHtml(article) : '';

  return `
    <article class="article-card ${readClass}" data-article-id="${escapeHtml(article.id)}">
      <h3 class="article-title">
        ${linkedTitle(article.title, articlePath(editionId, article.id), false)}
      </h3>
      ${summaryHtml}
      ${whyHtml}
      ${editorialBody}
      <div class="article-meta">
        <span class="source-badge"><a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.source)}</a></span>
        ${sectionBadge}
        ${scoreBadge}
        ${commentsBadge}
        <span class="freshness">${timeAgo(article.publishedAt || article.sources[0]?.url ? new Date().toISOString() : new Date().toISOString())}</span>
      </div>
    </article>`;
}

function leadStoryHtml(article: Article, editionId: string): string {
  const summaryHtml = article.summary
    ? `<p class="lead-summary">${escapeHtml(article.summary)}</p>`
    : '';
  const whyHtml = article.keyTakeaways?.[0]
    ? `<p class="lead-why"><strong>Why it matters:</strong> ${escapeHtml(article.keyTakeaways[0])}</p>`
    : '';
  const scoreMeta = article.score != null ? `<span class="lead-score">${article.score} points</span>` : '';
  const commentsMeta = article.comments != null ? `<span class="lead-comments">${article.comments} comments</span>` : '';

  return `
    <div class="lead-story">
      <div class="lead-kicker">${escapeHtml(SECTION_LABELS[article.section])}</div>
      <h2 class="lead-title banner-title">${linkedTitle(article.title, articlePath(editionId, article.id), false)}</h2>
      <div class="lead-dek-wrap">
        ${summaryHtml}
        ${whyHtml}
      </div>
      <div class="lead-meta issue-meta">
        <span class="source-badge"><a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.source)}</a></span>
        ${scoreMeta}
        ${commentsMeta}
      </div>
    </div>`;
}

function miniStoryHtml(article: Article, editionId: string): string {
  const summary = article.summary
    ? `<p class="mini-summary">${escapeHtml(article.summary)}</p>`
    : '';
  return `
    <article class="mini-story ${article.read ? 'article-read' : ''}">
      <div class="mini-kicker">${escapeHtml(SECTION_LABELS[article.section])}</div>
      <h3 class="mini-title">${linkedTitle(article.title, articlePath(editionId, article.id), false)}</h3>
      ${summary}
      <div class="mini-meta">
        <span>${escapeHtml(article.source)}</span>
        ${article.comments != null ? `<span>${article.comments} comments</span>` : ''}
      </div>
    </article>`;
}

function isEditorialFallbackCandidate(article: Article, leadStoryId?: string): boolean {
  if (article.id === leadStoryId) return false;

  const source = article.source.toLowerCase();
  if (source.startsWith('reddit')) return false;

  if (article.summary) return true;
  if (source.includes('hacker news')) return true;
  if (source.includes('news')) return true;

  try {
    const host = new URL(article.url).hostname.toLowerCase();
    if (host.includes('news.ycombinator.com')) return true;
    if (host.includes('news.')) return true;
  } catch {
    // Ignore malformed URLs here and rely on other signals.
  }

  return false;
}

/** @internal exported for testing */
export function editorialDisplayArticles(edition: Edition): Article[] {
  const actual = edition.articles.filter(article => article.section === 'editorials');
  if (actual.length > 0) return actual;

  return edition.articles
    .filter(article => isEditorialFallbackCandidate(article, edition.leadStoryId))
    .slice(0, 4);
}

function isGithubRepoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('github.com')) return false;
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length === 2; // owner/repo
  } catch {
    return false;
  }
}

function githubTrendingTableHtml(articles: Article[], editionId: string): string {
  if (articles.length === 0) return '';
  const rows = articles.map(a => {
    // Extract repo name from URL (owner/repo)
    let repoName = a.title;
    try {
      const parts = new URL(a.url).pathname.split('/').filter(Boolean);
      if (parts.length >= 2) repoName = `${parts[0]}/${parts[1]}`;
    } catch { /* keep title */ }
    const desc = a.summary ? escapeHtml(a.summary).slice(0, 120) : '';
    const stars = a.score != null ? `${a.score}` : '';
    return `
      <tr>
        <td class="gh-repo"><a href="${escapeHtml(articlePath(editionId, a.id))}" data-gh-article-id="${escapeHtml(a.id)}">${escapeHtml(repoName)}</a></td>
        <td class="gh-stars">${stars ? `${stars}` : ''}</td>
        <td class="gh-desc">${desc}</td>
      </tr>`;
  }).join('');

  return `
    <div class="gh-trending-block">
      <h3 class="gh-trending-header">GitHub Trending</h3>
      <table class="gh-trending-table">
        <thead><tr><th>Repository</th><th>Stars Today</th><th>Description</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function sectionHtml(section: Section, articles: Article[], editionId: string): string {
  if (articles.length === 0) return '';
  const label = SECTION_LABELS[section];

  // For AI section, separate GitHub trending repos into a special table
  let ghTrendingHtml = '';
  let regularArticles = articles;
  if (section === 'ai') {
    const ghRepos = articles.filter(a => isGithubRepoUrl(a.url));
    regularArticles = articles.filter(a => !isGithubRepoUrl(a.url));
    ghTrendingHtml = githubTrendingTableHtml(ghRepos, editionId);
  }

  const items = regularArticles.slice(0, 5).map((a, i) => `
    <li class="${a.read ? 'article-read' : ''}">
      ${linkedTitle(a.title, articlePath(editionId, a.id), false)}
      <span class="article-inline-meta">
        ${a.score != null ? `<span class="score-badge">${a.score}</span>` : ''}
        <span class="source-badge"><a href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.source)}</a></span>
      </span>
    </li>`).join('');

  const moreLink = articles.length > 5
    ? `<a href="/newspaper/section/${section}" class="more-link">All ${articles.length} stories &rarr;</a>`
    : '';

  return `
    <div class="section-block section-${section}">
      <h2 class="section-header">
        <a href="/newspaper/section/${section}">${escapeHtml(label)}</a>
      </h2>
      <ol class="section-list">${items}</ol>
      ${moreLink}
      ${ghTrendingHtml}
    </div>`;
}

/** @internal exported for testing */
export function pageShell(title: string, content: string, nav: string = ''): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700;900&family=Lora:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #f5f0e8;
      --paper: #faf6ee;
      --fg: #1a1a18;
      --fg-muted: #5c5a52;
      --accent: #2c2a24;
      --rule: #3d3529;
      --border: #d4cec0;
      --card-bg: rgba(250, 246, 238, 0.96);
      --section-us: #4a3f2f;
      --section-world: #3d4a3f;
      --section-ai: #2f3d4a;
      --section-ph: #4a3d2f;
      --section-business: #3a4a2f;
      --section-briefing: #4a2f3a;
      --section-editorials: #2c2a24;
      --font-serif: 'Playfair Display', Georgia, 'Times New Roman', Times, serif;
      --font-sans: 'Lora', Georgia, serif;
      --font-body: 'Lora', 'Charter', 'Bitstream Charter', Cambria, Georgia, serif;
      --font-mono: 'SF Mono', 'Fira Code', monospace;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--font-body);
      background: var(--bg);
      color: var(--fg);
      line-height: 1.6;
      max-width: 1100px;
      margin: 0 auto;
      padding: 0 1rem 2rem;
    }

    /* Masthead */
    .masthead {
      text-align: center;
      padding: 1.75rem 0 0.25rem;
      border-bottom: 1px solid var(--rule);
      margin-bottom: 0.35rem;
    }
    .masthead h1 {
      font-family: var(--font-serif);
      font-size: clamp(3rem, 8vw, 5.6rem);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent);
      line-height: 0.95;
      font-weight: 900;
    }
    .masthead .edition-info {
      display: none;
    }

    .issue-strip {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 0.75rem;
      align-items: center;
      border-top: 1px solid var(--rule);
      border-bottom: 3px double var(--rule);
      padding: 0.35rem 0;
      margin-bottom: 1rem;
      font-family: var(--font-serif);
      font-size: 0.9rem;
      font-weight: 700;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }
    .issue-strip span {
      text-align: center;
      white-space: nowrap;
    }

    /* Nav */
    .nav-bar {
      display: flex;
      justify-content: center;
      gap: 1.5rem;
      padding: 0.5rem 0 0.9rem;
      border-bottom: 1px solid var(--rule);
      margin-bottom: 1.25rem;
      flex-wrap: wrap;
    }
    .nav-bar a {
      text-decoration: none;
      color: var(--fg);
      font-family: var(--font-serif);
      font-size: 0.82rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      transition: color 0.2s;
    }
    .nav-bar a:hover, .nav-bar a.active {
      color: var(--fg-muted);
    }
    .refresh-btn {
      cursor: pointer;
      background: var(--paper);
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 0.22rem 0.6rem;
      border-radius: 0;
      font-size: 0.78rem;
      font-family: var(--font-serif);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .refresh-btn {
      border-color: var(--rule);
      font-weight: 600;
    }
    .refresh-btn:hover { background: var(--fg); color: var(--paper); }
    .refresh-btn:disabled { opacity: 0.5; cursor: wait; }

    /* Build status indicator */
    .build-status {
      display: none;
      align-items: center;
      gap: 0.5rem;
      font-family: var(--font-sans);
      font-size: 0.8rem;
      color: var(--fg-muted);
    }
    .build-status.visible { display: inline-flex; }
    .build-progress-bar {
      width: 80px;
      height: 6px;
      background: var(--border);
      border-radius: 3px;
      overflow: hidden;
      position: relative;
    }
    .build-progress-fill {
      height: 100%;
      border-radius: 3px;
      background: var(--fg);
      width: 0%;
      transition: width 0.3s ease;
    }
    .build-progress-fill.indeterminate {
      width: 40%;
      animation: indeterminate 1.2s ease-in-out infinite;
    }
    @keyframes indeterminate {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(280%); }
    }
    .build-status-text { white-space: nowrap; }
    .build-status.success .build-status-text { color: #2d7d2d; }
    .build-status.error .build-status-text { color: #c44; }
    .build-status.error .build-detail {
      font-size: 0.75rem;
      color: #c44;
      max-width: 300px;
    }
    .page-loader {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(245, 240, 232, 0.92);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.18s ease;
      z-index: 9999;
    }
    .page-loader.visible {
      opacity: 1;
      pointer-events: auto;
    }
    .page-loader-card {
      min-width: min(420px, calc(100vw - 2rem));
      padding: 1.4rem 1.5rem 1.2rem;
      border: 1px solid var(--rule);
      border-top: 4px double var(--rule);
      border-bottom: 4px double var(--rule);
      background: var(--paper);
      box-shadow: 0 18px 50px rgba(44, 42, 36, 0.12);
      text-align: center;
    }
    .page-loader-kicker {
      font-family: var(--font-serif);
      font-size: 0.76rem;
      text-transform: uppercase;
      letter-spacing: 0.16em;
      color: var(--fg-muted);
      margin-bottom: 0.55rem;
    }
    .page-loader-title {
      font-family: var(--font-serif);
      font-size: clamp(1.5rem, 4vw, 2.4rem);
      line-height: 0.95;
      text-transform: uppercase;
      font-style: italic;
      letter-spacing: 0.03em;
      margin-bottom: 0.8rem;
      color: var(--fg);
    }
    .page-loader-copy {
      font-size: 0.96rem;
      color: var(--fg-muted);
      margin-bottom: 0.95rem;
    }
    .page-loader-bar {
      width: min(260px, 100%);
      height: 6px;
      margin: 0 auto;
      background: #ddd5c7;
      overflow: hidden;
      position: relative;
    }
    .page-loader-bar::after {
      content: '';
      position: absolute;
      inset: 0 auto 0 0;
      width: 36%;
      background: var(--accent);
      animation: newspaperLoaderSlide 1s ease-in-out infinite;
    }
    @keyframes newspaperLoaderSlide {
      0% { transform: translateX(-120%); }
      100% { transform: translateX(320%); }
    }
    .edition-sync {
      width: 100%;
      text-align: center;
      font-family: var(--font-sans);
      font-size: 0.8rem;
      color: var(--fg-muted);
    }
    .edition-sync strong {
      color: var(--fg);
      font-weight: 600;
    }

    /* Lead story */
    .front-grid {
      display: grid;
      grid-template-columns: 1fr minmax(0, 1.65fr) 1fr;
      gap: 1rem;
      align-items: start;
      margin-bottom: 1.5rem;
    }
    .front-column {
      border-top: 1px solid var(--rule);
      padding-top: 0.7rem;
    }
    .front-column.right-column {
      border-left: 1px solid var(--border);
      padding-left: 1rem;
    }
    .front-column.left-column {
      border-right: 1px solid var(--border);
      padding-right: 1rem;
    }
    .front-center {
      border-top: 1px solid var(--rule);
      padding-top: 0.7rem;
    }
    .lead-story {
      padding: 0 0 1rem;
      border-bottom: 1px solid var(--rule);
      margin-bottom: 1rem;
      background: transparent;
    }
    .lead-kicker {
      font-family: var(--font-serif);
      font-size: 0.82rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--fg-muted);
      text-align: center;
      margin-bottom: 0.5rem;
    }
    .lead-title {
      font-family: var(--font-serif);
      font-size: 1.8rem;
      line-height: 0.95;
      margin-bottom: 0.75rem;
      text-transform: uppercase;
      font-style: italic;
      letter-spacing: 0.01em;
      text-align: left;
      overflow-wrap: break-word;
      word-break: break-word;
    }
    .banner-title {
      font-size: clamp(2.6rem, 5vw, 4.9rem);
      line-height: 0.92;
      font-weight: 900;
      margin-bottom: 1rem;
      overflow-wrap: break-word;
      word-break: break-word;
      hyphens: auto;
    }
    .lead-title a {
      color: var(--fg);
      text-decoration: none;
      border-bottom: 0;
      transition: color 0.15s;
    }
    .lead-title a:hover { color: var(--fg-muted); }
    .lead-dek-wrap {
      padding: 0.15rem 0 0.1rem;
    }
    .lead-summary {
      color: var(--fg);
      font-size: 1.13rem;
      margin-bottom: 0.65rem;
      line-height: 1.52;
      max-width: 46ch;
    }
    .lead-why {
      color: var(--fg-muted);
      font-size: 0.94rem;
      line-height: 1.45;
      max-width: 54ch;
    }
    .lead-meta {
      display: flex;
      gap: 0.75rem;
      align-items: center;
      flex-wrap: wrap;
      font-family: var(--font-serif);
      font-size: 0.8rem;
    }
    .issue-meta {
      border-top: 1px solid var(--border);
      padding-top: 0.5rem;
      margin-top: 0.75rem;
    }

    .mini-story {
      margin-bottom: 1rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--border);
    }
    .mini-story:last-child {
      border-bottom: none;
      margin-bottom: 0;
      padding-bottom: 0;
    }
    .mini-kicker {
      font-family: var(--font-serif);
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--fg-muted);
      margin-bottom: 0.35rem;
    }
    .mini-title {
      font-family: var(--font-serif);
      font-size: 1.08rem;
      line-height: 1.15;
      margin-bottom: 0.45rem;
    }
    .mini-title a {
      color: var(--fg);
      text-decoration: none;
    }
    .mini-title a:hover {
      color: var(--fg-muted);
    }
    .mini-summary {
      font-size: 0.92rem;
      line-height: 1.45;
      color: var(--fg);
      margin-bottom: 0.45rem;
    }
    .mini-meta {
      display: flex;
      gap: 0.6rem;
      flex-wrap: wrap;
      font-family: var(--font-serif);
      font-size: 0.73rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--fg-muted);
    }

    /* Section grid */
    .sections-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.9rem;
      margin-bottom: 2rem;
    }

    .section-block {
      border-top: 4px solid var(--rule);
      border-left: 1px solid var(--border);
      padding: 0.75rem 0 0 0.9rem;
      min-width: 0;
    }
    .section-us { border-top-color: var(--section-us); }
    .section-world { border-top-color: var(--section-world); }
    .section-ai { border-top-color: var(--section-ai); }
    .section-ph { border-top-color: var(--section-ph); }
    .section-business { border-top-color: var(--section-business); }
    .section-briefing { border-top-color: var(--section-briefing); }
    .section-editorials { border-top-color: var(--section-editorials); }

    .section-header {
      font-family: var(--font-serif);
      font-size: 1.5rem;
      margin-bottom: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      line-height: 1.05;
    }
    .section-header a {
      color: var(--fg);
      text-decoration: none;
    }
    .section-header a:hover { color: var(--accent); }

    .section-list {
      list-style: none;
      padding: 0;
    }
    .section-list li {
      padding: 0.4rem 0;
      border-bottom: 1px solid var(--border);
      font-size: 0.9rem;
      line-height: 1.35;
      overflow-wrap: break-word;
      word-break: break-word;
    }
    .section-list li:last-child { border-bottom: none; }
    .section-list li a {
      color: var(--fg);
      text-decoration: none;
      border-bottom: 1px solid var(--border);
      transition: color 0.15s, border-color 0.15s;
    }
    .section-list li a:hover { color: var(--accent); border-bottom-color: var(--accent); }
    .section-list li.article-read a { color: var(--fg-muted); border-bottom-color: transparent; }

    .article-inline-meta {
      display: inline-flex;
      gap: 0.4rem;
      margin-left: 0.4rem;
      font-family: var(--font-serif);
      font-size: 0.75rem;
    }

    /* Badges */
    .source-badge {
      background: transparent;
      color: var(--fg-muted);
      padding: 0;
      border-radius: 0;
      font-family: var(--font-serif);
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .section-badge {
      padding: 0.08rem 0.35rem;
      border-radius: 0;
      font-family: var(--font-serif);
      font-size: 0.7rem;
      font-weight: 600;
      color: var(--paper);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .section-badge.section-us { background: var(--section-us); }
    .section-badge.section-world { background: var(--section-world); }
    .section-badge.section-ai { background: var(--section-ai); }
    .section-badge.section-ph { background: var(--section-ph); }
    .section-badge.section-business { background: var(--section-business); }
    .section-badge.section-briefing { background: var(--section-briefing); }
    .section-badge.section-editorials { background: var(--section-editorials); }

    .score-badge {
      color: var(--accent);
      font-weight: 600;
      font-size: 0.75rem;
    }
    .comments-badge {
      color: var(--fg-muted);
      font-size: 0.75rem;
    }
    .freshness {
      color: var(--fg-muted);
      font-size: 0.75rem;
    }

    /* No-link (missing URL) */
    .no-link {
      color: var(--fg-muted);
      cursor: default;
      text-decoration: none;
      border-bottom: 1px dashed var(--border);
    }

    /* More link */
    .more-link {
      display: inline-block;
      margin-top: 0.5rem;
      font-size: 0.8rem;
      color: var(--accent);
      text-decoration: none;
    }
    .more-link:hover { text-decoration: underline; }

    /* Article cards (section view) */
    .article-card {
      padding: 1rem;
      border-bottom: 1px solid var(--border);
    }
    .article-card.article-read { opacity: 0.6; }
    .article-title {
      font-family: var(--font-serif);
      font-size: 1.15rem;
      margin-bottom: 0.4rem;
    }
    .article-title a {
      color: var(--fg);
      text-decoration: none;
      border-bottom: 1px solid var(--border);
      transition: color 0.15s, border-color 0.15s;
    }
    .article-title a:hover { color: var(--accent); border-bottom-color: var(--accent); }
    .article-summary {
      color: var(--fg-muted);
      font-size: 0.9rem;
      margin-bottom: 0.5rem;
    }
    .article-meta {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      flex-wrap: wrap;
      font-family: var(--font-serif);
    }

    /* Archive */
    .archive-list {
      list-style: none;
    }
    .archive-list li {
      padding: 0.75rem 0;
      border-bottom: 1px solid var(--border);
    }
    .archive-list li a {
      color: var(--fg);
      text-decoration: none;
      border-bottom: 1px solid var(--border);
      font-family: var(--font-serif);
      font-size: 1.1rem;
      transition: color 0.15s, border-color 0.15s;
    }
    .archive-list li a:hover { color: var(--accent); border-bottom-color: var(--accent); }
    .archive-meta {
      color: var(--fg-muted);
      font-size: 0.8rem;
      margin-top: 0.25rem;
    }

    /* Editorials block */
    .editorials-block {
      margin: 2rem 0;
      border-top: 14px solid var(--section-editorials);
      padding-top: 1.5rem;
    }
    .editorials-block .editorials-header {
      font-family: var(--font-serif);
      font-size: 1.4rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--section-editorials);
      margin-bottom: 1rem;
    }
    .editorials-block .editorials-header a {
      color: var(--section-editorials);
      text-decoration: none;
    }
    .editorials-block .editorials-header a:hover { opacity: 0.8; }
    .editorial-card {
      padding: 1rem 1.25rem;
      border-left: 3px solid var(--section-editorials);
      margin-bottom: 1rem;
      background: var(--card-bg);
    }
    .editorial-card h3 {
      font-family: var(--font-serif);
      font-size: 1.1rem;
      margin-bottom: 0.4rem;
    }
    .editorial-card h3 a {
      color: var(--fg);
      text-decoration: none;
      border-bottom: 1px solid var(--border);
      transition: color 0.15s, border-color 0.15s;
    }
    .editorial-card h3 a:hover { color: var(--accent); border-bottom-color: var(--accent); }
    .editorial-card .editorial-blurb {
      color: var(--fg);
      font-size: 0.92rem;
      font-style: italic;
      margin-bottom: 0.5rem;
      line-height: 1.55;
    }
    .editorial-card .editorial-takeaways {
      margin: 0.4rem 0 0.5rem 1.2rem;
      padding: 0;
      font-size: 0.88rem;
      line-height: 1.5;
      color: var(--fg-muted);
    }
    .editorial-card .editorial-takeaways li {
      margin-bottom: 0.25rem;
    }
    .editorial-card .editorial-meta {
      font-family: var(--font-sans);
      font-size: 0.75rem;
      color: var(--fg-muted);
    }
    .editorial-body {
      margin: 1rem 0 0.85rem;
      padding-top: 0.6rem;
      border-top: 1px solid var(--border);
    }
    .editorial-body-paragraph {
      color: var(--fg);
      font-size: 1rem;
      line-height: 1.85;
      margin-bottom: 1rem;
    }

    /* GitHub Trending table */
    .gh-trending-block {
      margin-top: 1rem;
      padding-top: 0.75rem;
      border-top: 1px solid var(--border);
    }
    .gh-trending-header {
      font-family: var(--font-serif);
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--fg-muted);
      margin-bottom: 0.5rem;
    }
    .gh-trending-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.82rem;
      line-height: 1.35;
    }
    .gh-trending-table thead th {
      font-family: var(--font-serif);
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--fg-muted);
      text-align: left;
      padding: 0.25rem 0.4rem;
      border-bottom: 1px solid var(--rule);
    }
    .gh-trending-table td {
      padding: 0.3rem 0.4rem;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    .gh-repo a {
      color: var(--fg);
      text-decoration: none;
      font-weight: 600;
      font-family: var(--font-mono);
      font-size: 0.78rem;
    }
    .gh-repo a:hover { color: var(--accent); }
    .gh-stars {
      white-space: nowrap;
      color: var(--fg-muted);
      font-family: var(--font-mono);
      font-size: 0.78rem;
      text-align: right;
    }
    .gh-desc {
      color: var(--fg-muted);
      font-size: 0.78rem;
    }

    /* Footer */
    .footer {
      text-align: center;
      padding: 2rem 0;
      border-top: 3px double var(--rule);
      color: var(--fg-muted);
      font-size: 0.8rem;
    }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 3rem 1rem;
      color: var(--fg-muted);
    }
    .empty-state h2 {
      font-family: var(--font-serif);
      font-size: 1.5rem;
      margin-bottom: 0.5rem;
      color: var(--fg);
    }

    /* Responsive */
    @media (max-width: 768px) {
      .masthead h1 { font-size: 2.5rem; }
      .lead-title { font-size: 1.3rem; }
      .issue-strip {
        grid-template-columns: 1fr 1fr;
        font-size: 0.74rem;
        row-gap: 0.3rem;
      }
      .front-grid {
        grid-template-columns: 1fr;
      }
      .front-column.left-column,
      .front-column.right-column {
        border-left: none;
        border-right: none;
        padding-left: 0;
        padding-right: 0;
      }
      .sections-grid { grid-template-columns: 1fr; }
      .nav-bar { gap: 0.75rem; }
    }
  </style>
</head>
<body>
  <div class="page-loader" aria-hidden="true">
    <div class="page-loader-card" role="status" aria-live="polite">
      <div class="page-loader-kicker">The Daily Claw</div>
      <div class="page-loader-title">Loading Edition</div>
      <p class="page-loader-copy">Pulling the story into the paper…</p>
      <div class="page-loader-bar"></div>
    </div>
  </div>
  ${content}
  <footer class="footer">
    The Daily Claw &mdash; Powered by SkimpyClaw
  </footer>
  <script>
    function setPageLoader(visible, message) {
      const loader = document.querySelector('.page-loader');
      const copy = document.querySelector('.page-loader-copy');
      if (!loader) return;
      loader.classList.toggle('visible', Boolean(visible));
      loader.setAttribute('aria-hidden', visible ? 'false' : 'true');
      if (copy && message) copy.textContent = message;
    }

    // Manual edition build trigger with inline progress indicator.
    function setBuildStatus(state, message, detail) {
      const el = document.querySelector('.build-status');
      const fill = document.querySelector('.build-progress-fill');
      const text = document.querySelector('.build-status-text');
      const detailEl = document.querySelector('.build-detail');
      if (!el) return;

      el.className = 'build-status visible ' + state;
      text.textContent = message || '';
      if (detailEl) detailEl.textContent = detail || '';

      if (state === 'building') {
        fill.className = 'build-progress-fill indeterminate';
        fill.style.width = '';
      } else if (state === 'success') {
        fill.className = 'build-progress-fill';
        fill.style.width = '100%';
      } else if (state === 'error') {
        fill.className = 'build-progress-fill';
        fill.style.width = '0%';
      } else {
        el.className = 'build-status';
      }
    }

    function setRefreshButtons(isBusy, mode) {
      const refreshBtn = document.querySelector('.refresh-btn');
      if (refreshBtn) {
        refreshBtn.disabled = isBusy;
        refreshBtn.textContent = isBusy ? 'Refreshing\u2026' : 'Get Fresh News';
      }
    }

    function formatStatusTime(dateStr) {
      if (!dateStr) return 'missing';
      try {
        return new Date(dateStr).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        });
      } catch {
        return dateStr;
      }
    }

    function renderNewspaperStatus(status) {
      const el = document.querySelector('.edition-sync');
      if (!el) return;

      if (!status) {
        el.textContent = 'Status unavailable';
        return;
      }

      if (status.refresh && status.refresh.inProgress) {
        el.innerHTML = '<strong>Refreshing newspaper\u2026</strong>';
        return;
      }

      const sourceSummary = Array.isArray(status.sources) && status.sources.length > 0
        ? status.sources.map(source => source.name + ': ' + formatStatusTime(source.latestDigestAt)).join(' | ')
        : 'No source digests found';

      if (status.state === 'fresh') {
        el.innerHTML = '<strong>Edition fresh.</strong> ' + sourceSummary;
      } else if (status.state === 'stale') {
        el.innerHTML = '<strong>Newer digests are available.</strong> ' + sourceSummary;
      } else {
        el.innerHTML = '<strong>No saved edition yet.</strong> ' + sourceSummary;
      }
    }

    async function loadNewspaperStatus() {
      try {
        const res = await fetch('/api/newspaper/status');
        if (!res.ok) return;
        const status = await res.json();
        renderNewspaperStatus(status);
      } catch {
        // Non-critical
      }
    }

    function getNewspaperAuthToken() {
      try {
        return window.localStorage.getItem('dashboard_token')
          || window.localStorage.getItem('skimpyclaw.newspaperToken')
          || '';
      } catch {
        return '';
      }
    }

    function saveNewspaperAuthToken(token) {
      try {
        if (token) {
          window.localStorage.setItem('dashboard_token', token);
          window.localStorage.setItem('skimpyclaw.newspaperToken', token);
        } else {
          window.localStorage.removeItem('dashboard_token');
          window.localStorage.removeItem('skimpyclaw.newspaperToken');
        }
      } catch {
        // Non-critical
      }
    }

    async function ensureNewspaperAuthToken(forcePrompt) {
      const existing = !forcePrompt ? getNewspaperAuthToken() : '';
      if (existing) return existing;

      const entered = window.prompt('Enter dashboard Bearer token to refresh the newspaper:');
      const token = (entered || '').trim();
      if (!token) return '';
      saveNewspaperAuthToken(token);
      return token;
    }

    async function triggerBuild(mode = 'fetch-and-build') {
      setRefreshButtons(true, mode);
      setPageLoader(true, 'Refreshing the newspaper and assembling a fresh edition…');
      setBuildStatus(
        'building',
        'Fetching latest digests\u2026',
      );
      try {
        let token = await ensureNewspaperAuthToken(false);
        if (!token) {
          setBuildStatus('error', 'Refresh cancelled', 'A Bearer token is required to refresh the newspaper.');
          setPageLoader(false);
          setRefreshButtons(false, mode);
          return;
        }

        let res = await fetch('/api/newspaper/refresh', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token,
          },
          body: JSON.stringify({ mode }),
        });

        if (res.status === 401) {
          saveNewspaperAuthToken('');
          token = await ensureNewspaperAuthToken(true);
          if (!token) {
            setBuildStatus('error', 'Refresh cancelled', 'A valid Bearer token is required to refresh the newspaper.');
            setPageLoader(false);
            setRefreshButtons(false, mode);
            return;
          }

          res = await fetch('/api/newspaper/refresh', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + token,
            },
            body: JSON.stringify({ mode }),
          });
        }

        const data = await res.json();
        if (res.ok && data.success) {
          const detail = Array.isArray(data.cronRuns)
            ? data.cronRuns.filter(run => run.status === 'error').map(run => run.id + ': ' + run.error).join(' | ')
            : '';
          setBuildStatus('success', 'Edition ready \u2014 ' + data.articleCount + ' articles', detail);
          setRefreshButtons(true, mode);
          setTimeout(() => location.reload(), 1500);
        } else {
          setBuildStatus('error', 'Refresh failed', data.error || res.statusText);
          setPageLoader(false);
          setRefreshButtons(false, mode);
        }
      } catch (err) {
        setBuildStatus('error', 'Refresh error', err.message);
        setPageLoader(false);
        setRefreshButtons(false, mode);
      }
    }

    function shouldShowNavigationLoader(link, event) {
      if (!link) return false;
      if (event.defaultPrevented) return false;
      if (event.button !== 0) return false;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
      if (link.target && link.target !== '_self') return false;

      const href = link.getAttribute('href') || '';
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return false;

      try {
        const url = new URL(link.href, window.location.href);
        if (url.origin !== window.location.origin) return false;
        return url.pathname.startsWith('/newspaper');
      } catch {
        return false;
      }
    }

    document.addEventListener('click', event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest('a');
      if (!shouldShowNavigationLoader(link, event)) return;
      setPageLoader(true, 'Loading the article and typesetting it for the paper…');
    });

    window.addEventListener('pageshow', () => setPageLoader(false));

    loadNewspaperStatus();
  </script>
</body>
</html>`;
}

/** @internal exported for testing */
export function navHtml(active?: string): string {
  const links = [
    { href: '/newspaper', label: 'Front Page', id: 'front' },
    ...ALL_SECTIONS.map(s => ({
      href: `/newspaper/section/${s}`,
      label: SECTION_LABELS[s],
      id: s,
    })),
    { href: '/newspaper/archive', label: 'Archive', id: 'archive' },
  ];

  const linkHtml = links.map(l =>
    `<a href="${l.href}" class="${active === l.id ? 'active' : ''}">${escapeHtml(l.label)}</a>`,
  ).join('');

  return `
    <nav class="nav-bar">
      ${linkHtml}
      <button class="refresh-btn" title="Run source jobs, then rebuild the edition" onclick="triggerBuild('fetch-and-build')">Get Fresh News</button>
      <span class="build-status">
        <span class="build-progress-bar"><span class="build-progress-fill"></span></span>
        <span class="build-status-text"></span>
        <span class="build-detail"></span>
      </span>
      <span class="edition-sync">Checking newspaper freshness…</span>
    </nav>`;
}

function mastheadHtml(edition: Edition | null): string {
  return `
    <header class="masthead">
      <h1><a href="/newspaper" style="text-decoration:none;color:var(--accent)">The Daily Claw</a></h1>
    </header>`;
}

function editorialsBlockHtml(articles: Article[], editionId: string): string {
  if (articles.length === 0) return '';
  const cards = articles.map(a => {
    const blurb = a.summary
      ? `<p class="editorial-blurb">${escapeHtml(a.summary)}</p>`
      : '';
    const takeaways = (a.keyTakeaways ?? [])
      .map(t => `<li>${escapeHtml(t)}</li>`)
      .join('');
    const takeawaysHtml = takeaways
      ? `<ul class="editorial-takeaways">${takeaways}</ul>`
      : '';
    const source = a.source ? `<span class="source-badge"><a href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.source)}</a></span>` : '';
    return `
      <div class="editorial-card">
        <h3>${linkedTitle(a.title, articlePath(editionId, a.id), false)}</h3>
        ${blurb}
        ${takeawaysHtml}
        <div class="editorial-meta">${source}</div>
      </div>`;
  }).join('');

  return `
    <div class="editorials-block">
      <h2 class="editorials-header">
        <a href="/newspaper/section/editorials">Editorials &amp; Long Reads</a>
      </h2>
      ${cards}
    </div>`;
}

function frontPageContent(edition: Edition): string {
  const lead = edition.articles.find(a => a.id === edition.leadStoryId);
  const leadHtml = lead ? leadStoryHtml(lead, edition.id) : '';

  // Group articles by section (excluding lead)
  const bySection: Record<string, Article[]> = {};
  for (const s of ALL_SECTIONS) bySection[s] = [];
  for (const a of edition.articles) {
    if (a.id === edition.leadStoryId) continue;
    bySection[a.section]?.push(a);
  }

  // Render non-editorial sections in the grid
  const nonEditorialSections = ALL_SECTIONS.filter(s => s !== 'editorials');
  const sectionsHtml = nonEditorialSections
    .filter(s => (bySection[s]?.length ?? 0) > 0)
    .map(s => sectionHtml(s, bySection[s], edition.id))
    .join('');

  // Render editorials as a distinct block below the grid
  const editorials = editorialDisplayArticles(edition);
  const editorialsHtml = editorialsBlockHtml(editorials, edition.id);
  const featureRail = nonEditorialSections
    .map(section => bySection[section]?.[0])
    .filter((article): article is Article => Boolean(article))
    .slice(0, 2);
  const rightRail = nonEditorialSections
    .map(section => bySection[section]?.[1] || bySection[section]?.[0])
    .filter((article): article is Article => Boolean(article))
    .slice(0, 2);

  return `
    ${mastheadHtml(edition)}
    <div class="issue-strip">
      <span>Volume ${new Date(edition.createdAt).getFullYear() - 2012}</span>
      <span>Number ${String(new Date(edition.createdAt).getDate()).padStart(2, '0')}</span>
      <span>${escapeHtml(formatDate(edition.createdAt))}</span>
      <span>${edition.articles.length} Articles</span>
      <span>${escapeHtml(edition.slot.toUpperCase())} Edition</span>
    </div>
    ${navHtml('front')}
    <div class="front-grid">
      <aside class="front-column left-column">
        ${featureRail.map(article => miniStoryHtml(article, edition.id)).join('')}
      </aside>
      <main class="front-center">
        ${leadHtml}
      </main>
      <aside class="front-column right-column">
        ${rightRail.map(article => miniStoryHtml(article, edition.id)).join('')}
      </aside>
    </div>
    <div class="sections-grid">
      ${sectionsHtml}
    </div>
    ${editorialsHtml}`;
}

function emptyContent(): string {
  return `
    ${mastheadHtml(null)}
    ${navHtml('front')}
    <div class="empty-state">
      <h2>No Edition Available</h2>
      <p>No newspaper edition has been built yet. Editions are built automatically from news digests.</p>
      <p style="margin-top:1rem">Use <strong>Get Fresh News</strong> to run the source jobs and rebuild the newspaper.</p>
    </div>`;
}

function sectionPageContent(section: Section, edition: Edition): string {
  const articles = section === 'editorials'
    ? editorialDisplayArticles(edition)
    : edition.articles.filter(a => a.section === section);
  const cardsHtml = articles.length > 0
    ? articles.map(a => articleCardHtml(a, edition.id, false, section === 'editorials')).join('')
    : '<div class="empty-state"><p>No articles in this section for this edition.</p></div>';

  return `
    ${mastheadHtml(edition)}
    ${navHtml(section)}
    <h2 style="font-family:var(--font-serif);font-size:1.5rem;margin-bottom:1rem;border-bottom:2px solid var(--border);padding-bottom:0.5rem">
      ${escapeHtml(SECTION_LABELS[section])}
    </h2>
    ${cardsHtml}`;
}

function articlePageContent(edition: Edition, article: Article): string {
  const body = article.fetchedContent
    ? article.fetchedContent
        .split(/\n{2,}/)
        .map(paragraph => paragraph.trim())
        .filter(Boolean)
        .map(paragraph => `<p class="editorial-body-paragraph">${escapeHtml(paragraph)}</p>`)
        .join('')
    : article.summary
      ? `<p class="article-summary">${escapeHtml(article.summary)}</p>`
      : '<p class="article-summary">No in-paper text is available for this story yet.</p>';

  const why = article.keyTakeaways?.[0]
    ? `<p class="why-it-matters"><strong>Why it matters:</strong> ${escapeHtml(article.keyTakeaways[0])}</p>`
    : '';

  return `
    ${mastheadHtml(edition)}
    ${navHtml(article.section)}
    <article class="lead-story">
      <div class="lead-kicker">${escapeHtml(SECTION_LABELS[article.section])}</div>
      <h2 class="lead-title" style="font-size:clamp(2rem, 5vw, 3.6rem)">${escapeHtml(article.title)}</h2>
      <div class="lead-meta issue-meta">
        <span class="source-badge"><a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.source)}</a></span>
        ${article.score != null ? `<span class="lead-score">${article.score} points</span>` : ''}
        ${article.comments != null ? `<span class="lead-comments">${article.comments} comments</span>` : ''}
      </div>
      ${why}
      <div class="editorial-body">${body}</div>
      <p class="archive-meta"><a href="/newspaper?edition=${escapeHtml(edition.id)}">Back to edition</a></p>
    </article>`;
}

function archivePageContent(editions: { id: string; createdAt: string; slot: string; articleCount: number; leadStoryTitle?: string }[]): string {
  const itemsHtml = editions.length > 0
    ? editions.map(e => `
        <li>
          <a href="/newspaper?edition=${escapeHtml(e.id)}">
            ${escapeHtml(formatDate(e.createdAt))} &mdash; ${escapeHtml(e.slot.charAt(0).toUpperCase() + e.slot.slice(1))} Edition
          </a>
          <div class="archive-meta">
            ${e.articleCount} articles
            ${e.leadStoryTitle ? `&middot; Lead: ${escapeHtml(e.leadStoryTitle)}` : ''}
          </div>
        </li>`).join('')
    : '<li class="empty-state">No editions in the archive.</li>';

  return `
    ${mastheadHtml(null)}
    ${navHtml('archive')}
    <h2 style="font-family:var(--font-serif);font-size:1.5rem;margin-bottom:1rem;border-bottom:2px solid var(--border);padding-bottom:0.5rem">
      Archive
    </h2>
    <ul class="archive-list">${itemsHtml}</ul>`;
}

/**
 * Register newspaper frontend routes on the Fastify instance.
 */
export function registerNewspaperFrontend(fastify: FastifyInstance): void {
  // Front page
  fastify.get<{ Querystring: { edition?: string } }>('/newspaper', async (request, reply) => {
    const editionId = (request.query as { edition?: string }).edition;
    const edition = editionId ? getEdition(editionId) : (getTodayEdition() || getLatestEdition());

    const content = edition ? frontPageContent(edition) : emptyContent();
    const html = pageShell('The Daily Claw', content);
    reply.type('text/html').send(html);
  });

  fastify.get<{ Params: { editionId: string; articleId: string } }>(
    '/newspaper/article/:editionId/:articleId',
    async (request, reply) => {
      const edition = getEdition(request.params.editionId);
      const article = edition?.articles.find(item => item.id === request.params.articleId);

      if (!edition || !article) {
        reply.code(404).type('text/html').send(
          pageShell('Article Not Found', '<div class="empty-state"><h2>Article Not Found</h2></div>'),
        );
        return;
      }

      if (!article.fetchedContent) {
        try {
          const hydrated = await hydrateArticleContent(article);
          if (hydrated) saveEdition(edition);
        } catch {
          // Leave the article page usable even when fetch-on-open fails.
        }
      }

      const html = pageShell(`${article.title} — The Daily Claw`, articlePageContent(edition, article));
      reply.type('text/html').send(html);
    },
  );

  // Section pages
  fastify.get<{ Params: { section: string } }>('/newspaper/section/:section', async (request, reply) => {
    const section = request.params.section as Section;
    if (!ALL_SECTIONS.includes(section)) {
      reply.code(404).type('text/html').send(
        pageShell('Not Found', '<div class="empty-state"><h2>Section Not Found</h2></div>'),
      );
      return;
    }

    const edition = getTodayEdition() || getLatestEdition();
    if (!edition) {
      reply.type('text/html').send(
        pageShell(`${SECTION_LABELS[section]} — The Daily Claw`, emptyContent()),
      );
      return;
    }

    const content = sectionPageContent(section, edition);
    const html = pageShell(`${SECTION_LABELS[section]} — The Daily Claw`, content);
    reply.type('text/html').send(html);
  });

  // Archive
  fastify.get('/newspaper/archive', async (_request, reply) => {
    const editions = listEditions(50);
    const content = archivePageContent(editions);
    const html = pageShell('Archive — The Daily Claw', content);
    reply.type('text/html').send(html);
  });
}
