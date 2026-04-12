// The Daily Claw — Newspaper frontend (inline HTML/CSS/JS)

import type { FastifyInstance } from 'fastify';
import type { Edition, Article, Section } from './types.js';
import { SECTION_LABELS, ALL_SECTIONS } from './types.js';
import { getTodayEdition, getEdition, listEditions, getLatestEdition } from './storage.js';

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

function linkedTitle(title: string, url: string): string {
  const escaped = escapeHtml(title);
  if (!url || !isValidUrl(url)) {
    return `<span class="no-link" title="No valid link available">${escaped}</span>`;
  }
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escaped}</a>`;
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

function articleCardHtml(article: Article, showSection: boolean = false): string {
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

  return `
    <article class="article-card ${readClass}" data-article-id="${escapeHtml(article.id)}">
      <h3 class="article-title">
        ${linkedTitle(article.title, article.url)}
      </h3>
      ${summaryHtml}
      ${whyHtml}
      <div class="article-meta">
        <span class="source-badge">${escapeHtml(article.source)}</span>
        ${sectionBadge}
        ${scoreBadge}
        ${commentsBadge}
        <span class="freshness">${timeAgo(article.publishedAt || article.sources[0]?.url ? new Date().toISOString() : new Date().toISOString())}</span>
      </div>
    </article>`;
}

function leadStoryHtml(article: Article): string {
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
      <div class="lead-label">LEAD STORY</div>
      <h2 class="lead-title">
        ${linkedTitle(article.title, article.url)}
      </h2>
      ${summaryHtml}
      ${whyHtml}
      <div class="lead-meta">
        <span class="source-badge">${escapeHtml(article.source)}</span>
        <span class="section-badge section-${article.section}">${escapeHtml(SECTION_LABELS[article.section])}</span>
        ${scoreMeta}
        ${commentsMeta}
      </div>
    </div>`;
}

function sectionHtml(section: Section, articles: Article[], editionId: string): string {
  if (articles.length === 0) return '';
  const label = SECTION_LABELS[section];
  const items = articles.slice(0, 5).map((a, i) => `
    <li class="${a.read ? 'article-read' : ''}">
      ${linkedTitle(a.title, a.url)}
      <span class="article-inline-meta">
        ${a.score != null ? `<span class="score-badge">${a.score}</span>` : ''}
        <span class="source-badge">${escapeHtml(a.source)}</span>
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
    </div>`;
}

function pageShell(title: string, content: string, nav: string = ''): string {
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
      --bg: #faf8f5;
      --fg: #1a1a1a;
      --fg-muted: #666;
      --accent: #8b0000;
      --border: #d4c5a9;
      --card-bg: #fff;
      --section-us: #1a3a5c;
      --section-world: #2d5016;
      --section-ai: #4a1a6b;
      --section-ph: #8b4513;
      --section-editorials: #6b3a2a;
      --font-serif: 'Playfair Display', Georgia, 'Times New Roman', Times, serif;
      --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      --font-body: 'Lora', 'Charter', 'Bitstream Charter', Cambria, Georgia, serif;
      --font-mono: 'SF Mono', 'Fira Code', monospace;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #1a1a1a;
        --fg: #e8e0d4;
        --fg-muted: #999;
        --accent: #d4634a;
        --border: #3a3a3a;
        --card-bg: #252525;
        --section-us: #5b8ab5;
        --section-world: #6ba35c;
        --section-ai: #9b6bc4;
        --section-ph: #c4915b;
        --section-editorials: #c47a5b;
      }
    }

    [data-theme="dark"] {
      --bg: #1a1a1a;
      --fg: #e8e0d4;
      --fg-muted: #999;
      --accent: #d4634a;
      --border: #3a3a3a;
      --card-bg: #252525;
      --section-us: #5b8ab5;
      --section-world: #6ba35c;
      --section-ai: #9b6bc4;
      --section-ph: #c4915b;
      --section-editorials: #c47a5b;
    }

    [data-theme="light"] {
      --bg: #faf8f5;
      --fg: #1a1a1a;
      --fg-muted: #666;
      --accent: #8b0000;
      --border: #d4c5a9;
      --card-bg: #fff;
      --section-us: #1a3a5c;
      --section-world: #2d5016;
      --section-ai: #4a1a6b;
      --section-ph: #8b4513;
      --section-editorials: #6b3a2a;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--font-body);
      background: var(--bg);
      color: var(--fg);
      line-height: 1.6;
      max-width: 1100px;
      margin: 0 auto;
      padding: 0 1rem;
    }

    /* Masthead */
    .masthead {
      text-align: center;
      padding: 1.5rem 0 1rem;
      border-bottom: 3px double var(--border);
      margin-bottom: 1.5rem;
    }
    .masthead h1 {
      font-family: var(--font-serif);
      font-size: 2.5rem;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      color: var(--accent);
    }
    .masthead .edition-info {
      font-family: var(--font-sans);
      font-size: 0.85rem;
      color: var(--fg-muted);
      margin-top: 0.25rem;
    }
    .masthead .edition-info .stale-warning {
      color: #c44;
      font-weight: bold;
    }

    /* Nav */
    .nav-bar {
      display: flex;
      justify-content: center;
      gap: 1.5rem;
      padding: 0.75rem 0;
      border-bottom: 1px solid var(--border);
      margin-bottom: 1.5rem;
      flex-wrap: wrap;
    }
    .nav-bar a {
      text-decoration: none;
      color: var(--fg-muted);
      font-family: var(--font-sans);
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      transition: color 0.2s;
    }
    .nav-bar a:hover, .nav-bar a.active {
      color: var(--accent);
    }
    .theme-toggle, .build-btn {
      cursor: pointer;
      background: none;
      border: 1px solid var(--border);
      color: var(--fg-muted);
      padding: 0.2rem 0.5rem;
      border-radius: 3px;
      font-size: 0.8rem;
    }
    .build-btn {
      color: var(--accent);
      border-color: var(--accent);
      font-weight: 600;
    }
    .build-btn:hover { background: var(--accent); color: #fff; }
    .build-btn:disabled { opacity: 0.5; cursor: wait; }

    /* Lead story */
    .lead-story {
      padding: 1.5rem;
      border: 2px solid var(--border);
      margin-bottom: 2rem;
      background: var(--card-bg);
    }
    .lead-label {
      font-family: var(--font-sans);
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      color: var(--accent);
      font-weight: 700;
      margin-bottom: 0.5rem;
    }
    .lead-title {
      font-family: var(--font-serif);
      font-size: 1.8rem;
      line-height: 1.25;
      margin-bottom: 0.75rem;
    }
    .lead-title a {
      color: var(--fg);
      text-decoration: none;
      border-bottom: 2px solid var(--border);
      transition: color 0.15s, border-color 0.15s;
    }
    .lead-title a:hover { color: var(--accent); border-bottom-color: var(--accent); }
    .lead-summary {
      color: var(--fg-muted);
      font-size: 1rem;
      margin-bottom: 0.75rem;
      line-height: 1.5;
    }
    .lead-meta {
      display: flex;
      gap: 0.75rem;
      align-items: center;
      flex-wrap: wrap;
      font-family: var(--font-sans);
      font-size: 0.8rem;
    }

    /* Section grid */
    .sections-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2rem;
    }

    .section-block {
      border-top: 3px solid var(--border);
      padding-top: 0.75rem;
    }
    .section-us { border-top-color: var(--section-us); }
    .section-world { border-top-color: var(--section-world); }
    .section-ai { border-top-color: var(--section-ai); }
    .section-ph { border-top-color: var(--section-ph); }
    .section-editorials { border-top-color: var(--section-editorials); }

    .section-header {
      font-family: var(--font-serif);
      font-size: 1.1rem;
      margin-bottom: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
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
      font-family: var(--font-sans);
      font-size: 0.75rem;
    }

    /* Badges */
    .source-badge {
      background: var(--border);
      color: var(--fg);
      padding: 0.1rem 0.4rem;
      border-radius: 2px;
      font-family: var(--font-sans);
      font-size: 0.7rem;
      font-weight: 500;
    }
    .section-badge {
      padding: 0.1rem 0.4rem;
      border-radius: 2px;
      font-family: var(--font-sans);
      font-size: 0.7rem;
      font-weight: 600;
      color: #fff;
    }
    .section-badge.section-us { background: var(--section-us); }
    .section-badge.section-world { background: var(--section-world); }
    .section-badge.section-ai { background: var(--section-ai); }
    .section-badge.section-ph { background: var(--section-ph); }
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
      font-family: var(--font-sans);
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
      border-top: 3px double var(--section-editorials);
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
      color: var(--fg-muted);
      font-size: 0.9rem;
      font-style: italic;
      margin-bottom: 0.4rem;
      line-height: 1.5;
    }
    .editorial-card .editorial-meta {
      font-family: var(--font-sans);
      font-size: 0.75rem;
      color: var(--fg-muted);
    }

    /* Footer */
    .footer {
      text-align: center;
      padding: 2rem 0;
      border-top: 1px solid var(--border);
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
      .masthead h1 { font-size: 1.8rem; }
      .lead-title { font-size: 1.3rem; }
      .sections-grid { grid-template-columns: 1fr; }
      .nav-bar { gap: 0.75rem; }
    }
  </style>
</head>
<body>
  ${content}
  <footer class="footer">
    The Daily Claw &mdash; Powered by SkimpyClaw
  </footer>
  <script>
    // Theme toggle
    const toggle = document.querySelector('.theme-toggle');
    if (toggle) {
      const stored = localStorage.getItem('newspaper-theme');
      if (stored) document.documentElement.setAttribute('data-theme', stored);
      toggle.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        const next = current === 'dark' ? 'light' : (current === 'light' ? 'dark' :
          (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark'));
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('newspaper-theme', next);
      });
    }

    // Manual edition build trigger.
    // Calls POST /api/newspaper/build with optional Bearer token from localStorage.
    async function triggerBuild() {
      const btn = document.querySelector('.build-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Building\u2026'; }
      try {
        const headers = { 'Content-Type': 'application/json' };
        const token = localStorage.getItem('dashboard-token');
        if (token) headers['Authorization'] = 'Bearer ' + token;
        const res = await fetch('/api/newspaper/build', {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
        });
        const data = await res.json();
        if (res.ok && data.success) {
          alert('Edition built: ' + data.editionId + ' (' + data.articleCount + ' articles)');
          location.reload();
        } else {
          alert('Build failed: ' + (data.error || res.statusText));
        }
      } catch (err) {
        alert('Build error: ' + err.message);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Build Now'; }
      }
    }
  </script>
</body>
</html>`;
}

function navHtml(active?: string): string {
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
      <button class="build-btn" title="Trigger a new edition build" onclick="triggerBuild()">Build Now</button>
      <button class="theme-toggle" title="Toggle dark/light mode">Theme</button>
    </nav>`;
}

function mastheadHtml(edition: Edition | null): string {
  const dateStr = edition
    ? formatDate(edition.createdAt)
    : formatDate(new Date().toISOString());
  const slotStr = edition
    ? `${edition.slot.charAt(0).toUpperCase() + edition.slot.slice(1)} Edition`
    : '';
  const timeStr = edition ? formatTime(edition.createdAt) : '';

  // Stale check: > 14 hours old
  let staleWarning = '';
  if (edition) {
    const age = Date.now() - new Date(edition.createdAt).getTime();
    if (age > 14 * 60 * 60 * 1000) {
      staleWarning = '<span class="stale-warning"> (stale — no fresh edition)</span>';
    }
  }

  return `
    <header class="masthead">
      <h1><a href="/newspaper" style="text-decoration:none;color:var(--accent)">The Daily Claw</a></h1>
      <div class="edition-info">
        ${escapeHtml(dateStr)} ${escapeHtml(slotStr)} &middot; ${escapeHtml(timeStr)}
        ${staleWarning}
        ${edition ? `&middot; ${readingTime(edition.articles.length)}` : ''}
      </div>
    </header>`;
}

function editorialsBlockHtml(articles: Article[]): string {
  if (articles.length === 0) return '';
  const cards = articles.map(a => {
    const blurb = a.summary
      ? `<p class="editorial-blurb">${escapeHtml(a.summary)}</p>`
      : '';
    const source = a.source ? `<span class="source-badge">${escapeHtml(a.source)}</span>` : '';
    return `
      <div class="editorial-card">
        <h3>${linkedTitle(a.title, a.url)}</h3>
        ${blurb}
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
  const leadHtml = lead ? leadStoryHtml(lead) : '';

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
  const editorials = bySection['editorials'] ?? [];
  const editorialsHtml = editorialsBlockHtml(editorials);

  return `
    ${mastheadHtml(edition)}
    ${navHtml('front')}
    ${leadHtml}
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
      <p style="margin-top:1rem">Trigger a build: <code>POST /api/newspaper/build</code></p>
    </div>`;
}

function sectionPageContent(section: Section, edition: Edition): string {
  const articles = edition.articles.filter(a => a.section === section);
  const cardsHtml = articles.length > 0
    ? articles.map(a => articleCardHtml(a, false)).join('')
    : '<div class="empty-state"><p>No articles in this section for this edition.</p></div>';

  return `
    ${mastheadHtml(edition)}
    ${navHtml(section)}
    <h2 style="font-family:var(--font-serif);font-size:1.5rem;margin-bottom:1rem;border-bottom:2px solid var(--border);padding-bottom:0.5rem">
      ${escapeHtml(SECTION_LABELS[section])}
    </h2>
    ${cardsHtml}`;
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
