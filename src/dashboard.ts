// Dashboard frontend - serves the single-page dashboard UI

import { existsSync, readFileSync } from 'fs';
import { extname, isAbsolute, join, relative, resolve } from 'path';
import { FastifyInstance } from 'fastify';

export interface DashboardFrontendOptions {
  mode?: 'legacy' | 'framework';
  frameworkDistDir?: string;
  botName?: string;
  botEmoji?: string;
}

export function registerDashboard(
  fastify: FastifyInstance,
  options: DashboardFrontendOptions = {},
): void {
  const mode = options.mode ?? 'legacy';
  const botName = options.botName ?? 'SkimpyClaw';
  const botEmoji = options.botEmoji ?? '👙🦞';
  const frameworkDistDir = resolve(options.frameworkDistDir ?? join(process.cwd(), 'dist', 'dashboard'));
  const frameworkIndexPath = join(frameworkDistDir, 'index.html');

  if (mode === 'framework' && existsSync(frameworkIndexPath)) {
    const serveFrameworkIndex = async (_request: unknown, reply: any) => {
      try {
        const html = readFileSync(frameworkIndexPath, 'utf-8')
          .replace('__SKIMPY_BOT_NAME__', escapeForInlineScript(botName))
          .replace('__SKIMPY_BOT_EMOJI__', escapeForInlineScript(botEmoji));
        reply.type('text/html').send(html);
      } catch {
        reply.code(500).send('Framework dashboard failed to load');
      }
    };

    fastify.get('/dashboard', serveFrameworkIndex);
    fastify.get('/dashboard/*', serveFrameworkIndex);

    fastify.get<{ Params: { '*': string } }>('/assets/*', async (request, reply) => {
      const relPath = request.params['*'];
      const assetsBaseDir = resolve(frameworkDistDir, 'assets');
      const filePath = resolve(assetsBaseDir, relPath);
      const rel = relative(assetsBaseDir, filePath);
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || !existsSync(filePath)) {
        reply.code(404).send('Not found');
        return;
      }

      const buffer = readFileSync(filePath);
      reply.type(getMimeType(filePath)).send(buffer);
    });
    return;
  }

  if (mode === 'framework') {
    console.warn(`[dashboard] Framework mode requested, but ${frameworkIndexPath} is missing. Falling back to legacy.`);
  }

  fastify.get('/dashboard', async (_request, reply) => {
    reply.type('text/html').send(DASHBOARD_HTML);
  });
}

function escapeForInlineScript(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.map') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.woff2') return 'font/woff2';
  if (ext === '.woff') return 'font/woff';
  if (ext === '.ttf') return 'font/ttf';
  return 'application/octet-stream';
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SkimpyClaw Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Playfair+Display:wght@600;700;800&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/marked/lib/marked.umd.min.js"></script>
<style>
/* ══════════════════════════════════════════════════
   LIGHT THEME (default) — warm cream + sage
   ══════════════════════════════════════════════════ */
:root,
[data-theme="light"] {
  --bg: #f5f2ee;
  --bg-sidebar: #f5f2ee;
  --surface: #ffffff;
  --surface-alt: #f9f7f4;
  --surface-hover: #f0ede8;
  --text: #2c2825;
  --text-dim: #5c5652;
  --text-muted: #9b948e;
  --accent: #4a7c6f;
  --accent-hover: #3b6b5e;
  --accent-soft: rgba(74, 124, 111, 0.08);
  --accent-soft-2: rgba(74, 124, 111, 0.04);
  --success: #4a7c6f;
  --success-soft: rgba(74, 124, 111, 0.08);
  --warning: #c4873a;
  --warning-soft: rgba(196, 135, 58, 0.08);
  --error: #c25450;
  --error-soft: rgba(194, 84, 80, 0.06);
  --border: rgba(0,0,0,0.06);
  --border-light: rgba(0,0,0,0.04);
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.03);
  --shadow: 0 2px 8px rgba(0,0,0,0.04);
  --shadow-md: 0 4px 16px rgba(0,0,0,0.06);
  --sidebar-active: #ffffff;
  --sidebar-hover: rgba(0,0,0,0.03);
  --welcome-from: #4a7c6f;
  --welcome-to: #6ba396;
  --welcome-text: #ffffff;
  --log-info: #5c5652;
  --log-warn: #b07c1a;
  --log-error: #c25450;
  --highlight: var(--accent);
  --mono: 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace;
  --sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --serif: 'Playfair Display', Georgia, 'Times New Roman', serif;
}

/* ══════════════════════════════════════════════════
   DARK THEME — warm charcoal + sage
   ══════════════════════════════════════════════════ */
[data-theme="dark"] {
  --bg: #1a1816;
  --bg-sidebar: #1a1816;
  --surface: #242120;
  --surface-alt: #2c2928;
  --surface-hover: #353230;
  --text: #ede9e4;
  --text-dim: #a8a29e;
  --text-muted: #6d6762;
  --accent: #7dbcab;
  --accent-hover: #92ccbc;
  --accent-soft: rgba(125, 188, 171, 0.12);
  --accent-soft-2: rgba(125, 188, 171, 0.06);
  --success: #7dbcab;
  --success-soft: rgba(125, 188, 171, 0.1);
  --warning: #e0a95e;
  --warning-soft: rgba(224, 169, 94, 0.1);
  --error: #d97a77;
  --error-soft: rgba(217, 122, 119, 0.1);
  --border: rgba(255,255,255,0.07);
  --border-light: rgba(255,255,255,0.04);
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.2);
  --shadow: 0 2px 8px rgba(0,0,0,0.2);
  --shadow-md: 0 4px 16px rgba(0,0,0,0.3);
  --sidebar-active: rgba(125, 188, 171, 0.08);
  --sidebar-hover: rgba(255,255,255,0.04);
  --welcome-from: #3d6b5e;
  --welcome-to: #6ba396;
  --welcome-text: #ffffff;
  --log-info: #a8a29e;
  --log-warn: #e0a95e;
  --log-error: #d97a77;
  --highlight: var(--accent);
}

/* ══════════════════════════════════════════════════
   SHARED TOKENS
   ══════════════════════════════════════════════════ */
:root {
  --radius: 16px;
  --radius-md: 12px;
  --radius-sm: 8px;
  --sidebar-width: 260px;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: var(--sans);
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  font-size: 14px;
  line-height: 1.55;
  transition: background 0.3s ease, color 0.3s ease;
  -webkit-font-smoothing: antialiased;
}

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

/* ══════════════════════════════════════════════════
   LAYOUT SHELL
   ══════════════════════════════════════════════════ */
.shell {
  display: grid;
  grid-template-columns: var(--sidebar-width) 1fr;
  min-height: 100vh;
}

/* ══════════════════════════════════════════════════
   SIDEBAR
   ══════════════════════════════════════════════════ */
.sidebar {
  background: var(--bg-sidebar);
  display: flex;
  flex-direction: column;
  position: sticky;
  top: 0;
  height: 100vh;
  z-index: 10;
  transition: background 0.3s ease;
  overflow-y: auto;
}

.sidebar-header {
  padding: 28px 24px 20px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.sidebar-logo {
  width: 40px; height: 40px;
  background: linear-gradient(135deg, var(--welcome-from), var(--welcome-to));
  border-radius: var(--radius-md);
  display: flex; align-items: center; justify-content: center;
  font-size: 20px;
  box-shadow: 0 2px 8px rgba(74, 124, 111, 0.2);
}

.sidebar-brand {
  display: flex; flex-direction: column;
}

.sidebar-brand-name {
  font-family: var(--serif);
  font-size: 17px; font-weight: 700; color: var(--text);
  letter-spacing: -0.01em;
}

.sidebar-brand-status {
  font-size: 11px; color: var(--success);
  display: flex; align-items: center; gap: 5px;
  font-weight: 500;
}

.sidebar-brand-status::before {
  content: '';
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--success);
  display: inline-block;
}

.sidebar-section {
  padding: 0 12px;
  margin-bottom: 8px;
}

.sidebar-section-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 16px 12px 8px;
}

.sidebar-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--text-dim);
  font-size: 14px;
  font-weight: 500;
  transition: all 0.15s ease;
  border: none;
  background: transparent;
  width: 100%;
  text-align: left;
  font-family: var(--sans);
  position: relative;
}

.sidebar-item:hover {
  background: var(--sidebar-hover);
  color: var(--text);
}

.sidebar-item.active {
  background: var(--sidebar-active);
  color: var(--accent);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}

.sidebar-item.active::before {
  content: '';
  position: absolute;
  left: 0; top: 8px; bottom: 8px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--accent);
}

.sidebar-item svg {
  width: 20px; height: 20px;
  flex-shrink: 0;
  opacity: 0.6;
}

.sidebar-item.active svg { opacity: 1; }
.sidebar-item:hover svg { opacity: 0.85; }

.sidebar-item .item-badge {
  margin-left: auto;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--warning-soft);
  color: var(--warning);
}

.sidebar-spacer { flex: 1; }

.sidebar-footer {
  padding: 16px 12px;
  border-top: 1px solid var(--border-light);
}

.sidebar-footer-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 500;
  transition: all 0.15s ease;
  border: none;
  background: transparent;
  width: 100%;
  text-align: left;
  font-family: var(--sans);
}

.sidebar-footer-item:hover {
  background: var(--sidebar-hover);
  color: var(--text-dim);
}

.sidebar-footer-item.active {
  background: var(--sidebar-active);
  color: var(--accent);
  font-weight: 600;
}

.sidebar-footer-item svg {
  width: 18px; height: 18px;
  flex-shrink: 0;
  opacity: 0.5;
}

/* ══════════════════════════════════════════════════
   MAIN CONTENT
   ══════════════════════════════════════════════════ */
.main {
  overflow-y: auto;
  padding: 32px 36px;
}

/* ── Page Header ──────────────────────────────────── */
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 28px;
}

.page-title {
  font-family: var(--serif);
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text);
}

.header-actions { display: flex; gap: 10px; align-items: center; }

.header-meta {
  font-size: 12px;
  color: var(--text-muted);
  font-family: var(--mono);
}

.theme-toggle {
  width: 36px; height: 36px;
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 16px;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s ease;
  color: var(--text);
}
.theme-toggle:hover { background: var(--surface-hover); }

/* ── Pages ─────────────────────────────────────────── */
.page { display: none; }
.page.active { display: block; }

/* ══════════════════════════════════════════════════
   WELCOME BANNER
   ══════════════════════════════════════════════════ */
.welcome-banner {
  background: linear-gradient(135deg, var(--welcome-from), var(--welcome-to));
  border-radius: var(--radius);
  padding: 28px 32px;
  margin-bottom: 28px;
  color: var(--welcome-text);
  position: relative;
  overflow: hidden;
}

.welcome-banner::after {
  content: '';
  position: absolute;
  right: -20px; top: -20px;
  width: 200px; height: 200px;
  border-radius: 50%;
  background: rgba(255,255,255,0.08);
}

.welcome-banner::before {
  content: '';
  position: absolute;
  right: 80px; bottom: -40px;
  width: 120px; height: 120px;
  border-radius: 50%;
  background: rgba(255,255,255,0.05);
}

.welcome-greeting {
  font-family: var(--serif);
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 6px;
  letter-spacing: -0.01em;
  position: relative; z-index: 1;
}

.welcome-sub {
  font-size: 14px;
  opacity: 0.85;
  font-weight: 400;
  position: relative; z-index: 1;
}

/* ══════════════════════════════════════════════════
   APPROVAL BANNER
   ══════════════════════════════════════════════════ */
.approval-banner {
  background: var(--warning-soft);
  border: 1px solid rgba(245, 158, 11, 0.15);
  border-radius: var(--radius);
  padding: 18px 22px;
  margin-bottom: 24px;
  display: flex;
  align-items: center;
  gap: 16px;
}

.approval-banner-icon { font-size: 22px; flex-shrink: 0; }
.approval-banner-content { flex: 1; }
.approval-banner-title { font-weight: 600; font-size: 14px; margin-bottom: 3px; }
.approval-banner-detail { font-size: 13px; color: var(--text-dim); font-family: var(--mono); }
.approval-banner-actions { display: flex; gap: 8px; }

/* ══════════════════════════════════════════════════
   STAT CARDS
   ══════════════════════════════════════════════════ */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 18px;
  margin-bottom: 28px;
}

.stat-card {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 22px 24px;
  box-shadow: var(--shadow-sm);
  transition: all 0.2s ease;
  border: 1px solid var(--border-light);
}

.stat-card:hover {
  box-shadow: var(--shadow);
  transform: translateY(-1px);
}

.stat-icon {
  width: 40px; height: 40px;
  border-radius: var(--radius-sm);
  display: flex; align-items: center; justify-content: center;
  font-size: 18px;
  margin-bottom: 14px;
}

.stat-icon.sage { background: var(--accent-soft); color: var(--accent); }
.stat-icon.green { background: var(--success-soft); color: var(--success); }
.stat-icon.amber { background: var(--warning-soft); color: var(--warning); }
.stat-icon.blue { background: rgba(86, 119, 145, 0.08); color: #567791; }

.stat-label {
  font-size: 12px;
  color: var(--text-muted);
  font-weight: 500;
  margin-bottom: 6px;
}

.stat-value {
  font-family: var(--serif);
  font-size: 28px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.02em;
}

.stat-sub {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
}

/* ══════════════════════════════════════════════════
   SECTIONS
   ══════════════════════════════════════════════════ */
.section { margin-bottom: 28px; }

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.section-title {
  font-family: var(--serif);
  font-size: 18px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: -0.01em;
}

.section-link {
  font-size: 13px;
  color: var(--accent);
  cursor: pointer;
  text-decoration: none;
  font-weight: 500;
}
.section-link:hover { text-decoration: underline; }

/* ══════════════════════════════════════════════════
   ACTIVITY FEED
   ══════════════════════════════════════════════════ */
.feed-card {
  background: var(--surface);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--border-light);
  overflow: hidden;
}

.feed { display: flex; flex-direction: column; }

.feed-item {
  display: grid;
  grid-template-columns: 40px 1fr auto;
  gap: 14px;
  align-items: start;
  padding: 16px 20px;
  transition: background 0.12s ease;
  border-bottom: 1px solid var(--border-light);
}
.feed-item:last-child { border-bottom: none; }
.feed-item:hover { background: var(--surface-alt); }

.feed-icon {
  width: 40px; height: 40px;
  border-radius: var(--radius-sm);
  display: flex; align-items: center; justify-content: center;
  font-size: 16px;
  flex-shrink: 0;
}

.feed-icon.telegram { background: var(--accent-soft); color: var(--accent); }
.feed-icon.cron { background: var(--warning-soft); color: var(--warning); }
.feed-icon.system { background: var(--surface-alt); color: var(--text-muted); }
.feed-icon.code { background: var(--accent-soft); color: var(--accent); }

.feed-title { font-weight: 600; font-size: 14px; margin-bottom: 3px; }
.feed-detail { font-size: 13px; color: var(--text-dim); line-height: 1.45; }
.feed-time { font-size: 11px; color: var(--text-muted); font-family: var(--mono); white-space: nowrap; padding-top: 2px; }

/* ══════════════════════════════════════════════════
   CRON CARDS
   ══════════════════════════════════════════════════ */
.cron-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }

.cron-card {
  background: var(--surface);
  border: 1px solid var(--border-light);
  border-radius: var(--radius);
  padding: 20px 22px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: var(--shadow-sm);
  transition: all 0.15s ease;
}
.cron-card:hover { box-shadow: var(--shadow); transform: translateY(-1px); }

.cron-info { flex: 1; }
.cron-name { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
.cron-schedule { font-size: 12px; color: var(--text-muted); font-family: var(--mono); }
.cron-next { font-size: 12px; color: var(--success); font-family: var(--mono); text-align: right; font-weight: 500; }

/* ══════════════════════════════════════════════════
   BUTTONS
   ══════════════════════════════════════════════════ */
.btn {
  padding: 8px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  font-family: var(--sans);
  font-weight: 500;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.12s ease;
}
.btn:hover { background: var(--surface-hover); }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-primary:hover { background: var(--accent-hover); }
.btn-success { background: var(--success); border-color: var(--success); color: #fff; }
.btn-success:hover { opacity: 0.9; }
.btn-danger { background: var(--error-soft); border-color: rgba(239, 68, 68, 0.2); color: var(--error); }
.btn-danger:hover { background: rgba(239, 68, 68, 0.12); }
.btn-sm { padding: 5px 12px; font-size: 12px; }
.btn-small { padding: 5px 12px; font-size: 12px; }

/* ══════════════════════════════════════════════════
   HEALTH CHECKS
   ══════════════════════════════════════════════════ */
.health-card {
  background: var(--surface);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--border-light);
  overflow: hidden;
}

.health-grid { display: flex; flex-direction: column; }

.health-row {
  display: grid;
  grid-template-columns: 28px 1fr auto;
  gap: 14px;
  align-items: center;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border-light);
  transition: background 0.12s ease;
}
.health-row:last-child { border-bottom: none; }
.health-row:hover { background: var(--surface-alt); }

.health-dot {
  width: 10px; height: 10px;
  border-radius: 50%;
}
.health-dot.pass { background: var(--success); }
.health-dot.fail { background: var(--error); }
.health-dot.warn { background: var(--warning); }

.health-name { font-weight: 500; font-size: 14px; }
.health-value { font-size: 12px; font-family: var(--mono); color: var(--text-muted); }

/* ══════════════════════════════════════════════════
   SPLIT VIEW (History, Digests, etc.)
   ══════════════════════════════════════════════════ */
.split-view {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 18px;
  height: calc(100vh - 160px);
}

.split, .split-view {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 18px;
  height: calc(100vh - 160px);
}

.split-left, .split-list {
  background: var(--surface);
  border: 1px solid var(--border-light);
  border-radius: var(--radius);
  overflow-y: auto;
  box-shadow: var(--shadow-sm);
}

.split-right, .split-detail {
  background: var(--surface);
  border: 1px solid var(--border-light);
  border-radius: var(--radius);
  overflow-y: auto;
  padding: 24px;
  box-shadow: var(--shadow-sm);
}

.list-item {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-light);
  cursor: pointer;
  transition: background 0.12s ease;
}
.list-item:last-child { border-bottom: none; }
.list-item:hover { background: var(--surface-alt); }
.list-item.active { background: var(--accent-soft-2); border-left: 3px solid var(--accent); }
.list-item-title { font-weight: 600; font-size: 14px; margin-bottom: 3px; }
.list-item-sub, .list-item-meta { font-size: 12px; color: var(--text-muted); font-family: var(--mono); }

/* ── Chat Bubbles ─────────────────────────────────── */
.chat-msg { margin-bottom: 16px; max-width: 80%; }
.chat-msg.user { margin-left: auto; }
.chat-role {
  font-size: 10px; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.06em;
  font-family: var(--mono); margin-bottom: 6px; font-weight: 600;
}
.chat-bubble {
  padding: 14px 18px;
  border-radius: var(--radius-md);
  font-size: 14px; line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.chat-msg.user .chat-bubble, .chat-bubble.user { background: var(--accent-soft); border: 1px solid rgba(74, 124, 111, 0.12); margin-left: auto; }
.chat-msg.assistant .chat-bubble, .chat-bubble.assistant { background: var(--surface-alt); border: 1px solid var(--border); }

/* ══════════════════════════════════════════════════
   LOG VIEWER
   ══════════════════════════════════════════════════ */
.log-pane, .log-viewer {
  background: var(--surface);
  border: 1px solid var(--border-light);
  border-radius: var(--radius);
  font-family: var(--mono);
  font-size: 12px; line-height: 1.8;
  padding: 18px 20px;
  white-space: pre-wrap; word-break: break-all;
  max-height: calc(100vh - 260px);
  overflow-y: auto;
  box-shadow: var(--shadow-sm);
}

.log-line-info { color: var(--log-info); }
.log-line-warn { color: var(--log-warn); }
.log-line-error { color: var(--log-error); font-weight: 500; }

/* ══════════════════════════════════════════════════
   EMPTY STATE
   ══════════════════════════════════════════════════ */
.empty-state, .empty {
  text-align: center;
  padding: 64px 24px;
  color: var(--text-muted);
}
.empty-state-icon { font-size: 40px; margin-bottom: 16px; opacity: 0.4; }
.empty-state-text { font-size: 14px; }

/* ══════════════════════════════════════════════════
   CODING AGENT TREE (redesign)
   ══════════════════════════════════════════════════ */
.tree-container { display: flex; flex-direction: column; gap: 20px; }

.tree-card {
  background: var(--surface);
  border: 1px solid var(--border-light);
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: var(--shadow-sm);
  transition: all 0.15s ease;
}
.tree-card:hover { box-shadow: var(--shadow); }

.tree-card-header {
  padding: 20px 24px;
  display: flex; justify-content: space-between; align-items: start;
  gap: 16px;
}

.tree-card-left { display: flex; flex-direction: column; gap: 8px; flex: 1; }

.tree-card-id {
  font-family: var(--mono); font-size: 13px;
  color: var(--accent); font-weight: 600;
}

.tree-card-task { font-size: 14px; line-height: 1.55; color: var(--text); }

.tree-card-meta {
  display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
  font-size: 12px; font-family: var(--mono); color: var(--text-muted);
  margin-top: 2px;
}

.tree-card-right { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; flex-shrink: 0; }

.badge-status {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 14px; border-radius: 999px;
  font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.04em;
}

.badge-status.running { background: var(--accent-soft); color: var(--accent); }
.badge-status.completed { background: var(--success-soft); color: var(--success); }
.badge-status.failed { background: var(--error-soft); color: var(--error); }
.badge-status.validating { background: var(--warning-soft); color: var(--warning); }

.badge-team {
  padding: 4px 12px; border-radius: 999px;
  font-size: 11px; font-weight: 600;
  background: var(--accent-soft); color: var(--accent);
}

@keyframes spin { to { transform: rotate(360deg); } }

.spinner {
  display: inline-block; width: 10px; height: 10px;
  border: 2px solid currentColor; border-top-color: transparent;
  border-radius: 50%; animation: spin 0.8s linear infinite;
}

.tree-progress { height: 3px; background: var(--surface-alt); }

.tree-progress-bar {
  height: 100%; border-radius: 0 0 2px 2px;
  transition: width 0.3s ease;
}
.tree-progress-bar.running { background: var(--accent); }
.tree-progress-bar.completed { background: var(--success); }
.tree-progress-bar.failed { background: var(--error); }

.tree-children {
  margin: 0 24px 20px 24px;
  padding-left: 20px;
  border-left: 2px solid var(--border);
}

.tree-children-label {
  font-size: 12px; font-weight: 600; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.04em;
  padding: 14px 0 10px 0;
}

.tree-child-card {
  background: var(--surface-alt);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  margin-bottom: 10px;
  overflow: hidden;
  cursor: pointer;
  transition: all 0.12s ease;
}

.tree-child-card:hover { background: var(--surface-hover); }

.tree-child-card.status-completed { border-left: 3px solid var(--success); }
.tree-child-card.status-running { border-left: 3px solid var(--accent); }
.tree-child-card.status-failed { border-left: 3px solid var(--error); }
.tree-child-card.status-validating { border-left: 3px solid var(--warning); }

.tree-child-header {
  padding: 14px 16px;
  display: flex; justify-content: space-between; align-items: center;
  gap: 12px;
}

.tree-child-left { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
.tree-child-icon { font-size: 16px; flex-shrink: 0; }
.tree-child-info { flex: 1; min-width: 0; }
.tree-child-id { font-family: var(--mono); font-size: 12px; color: var(--accent); font-weight: 500; }
.tree-child-task { font-size: 13px; color: var(--text); line-height: 1.45; margin-top: 3px; }
.tree-child-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.tree-child-elapsed { font-size: 11px; font-family: var(--mono); color: var(--text-muted); }

.tree-child-detail {
  display: none;
  border-top: 1px solid var(--border);
  padding: 14px 16px;
}
.tree-child-detail.expanded { display: block; }

.tree-output {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 14px 16px;
  font-family: var(--mono); font-size: 12px; line-height: 1.7;
  white-space: pre-wrap; word-break: break-word;
  max-height: 300px; overflow-y: auto;
  color: var(--text-dim);
}

.tree-output.error {
  background: var(--error-soft);
  border-color: rgba(239, 68, 68, 0.15);
  color: var(--error);
}

.tree-synthesis {
  margin: 0 24px 20px 24px;
  padding: 16px 20px;
  background: var(--surface-alt);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.tree-synthesis-label {
  font-size: 11px; font-weight: 600; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 8px;
}
.tree-synthesis-content { font-size: 14px; line-height: 1.6; color: var(--text); }

.detail-toggle {
  font-size: 12px; color: var(--accent); font-weight: 500;
  font-family: var(--mono); cursor: pointer;
  padding: 10px 24px; user-select: none;
}
.detail-toggle:hover { text-decoration: underline; }

.tree-summary {
  display: flex; gap: 14px; margin-bottom: 24px; flex-wrap: wrap;
}
.tree-summary-pill {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 18px;
  background: var(--surface);
  border: 1px solid var(--border-light);
  border-radius: var(--radius);
  font-size: 13px; font-weight: 500;
  box-shadow: var(--shadow-sm);
}
.tree-summary-pill .pill-num {
  font-family: var(--serif);
  font-size: 20px; font-weight: 700;
}
.tree-summary-pill .pill-label { color: var(--text-muted); font-size: 12px; }
.tree-summary-pill.running .pill-num { color: var(--accent); }
.tree-summary-pill.completed .pill-num { color: var(--success); }
.tree-summary-pill.failed .pill-num { color: var(--error); }
.tree-summary-pill.cost .pill-num { color: var(--text); }

.cost-badge {
  background: var(--surface-alt);
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  color: var(--text-dim);
}

.tree-actions {
  display: flex; gap: 6px; margin-top: 4px;
}

.waterfall {
  background: var(--surface);
  border: 1px solid var(--border-light);
  border-radius: var(--radius);
  padding: 20px 24px;
  box-shadow: var(--shadow-sm);
  margin-bottom: 24px;
}
.waterfall-title {
  font-family: var(--serif);
  font-size: 16px; font-weight: 700;
  margin-bottom: 16px;
}
.waterfall-axis {
  display: flex; justify-content: space-between;
  font-size: 10px; font-family: var(--mono);
  color: var(--text-muted);
  margin-bottom: 10px;
  padding: 0 4px;
}
.waterfall-rows { display: flex; flex-direction: column; gap: 8px; }
.waterfall-row {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 12px;
  align-items: center;
  font-size: 12px;
}
.waterfall-label {
  font-family: var(--mono);
  color: var(--text-dim);
  font-size: 11px;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.waterfall-track {
  height: 24px;
  background: var(--surface-alt);
  border-radius: 4px;
  position: relative;
  overflow: hidden;
}
.waterfall-bar {
  position: absolute;
  top: 3px; bottom: 3px;
  border-radius: 3px;
  min-width: 4px;
}
.waterfall-bar.completed { background: var(--success); opacity: 0.7; }
.waterfall-bar.running { background: var(--accent); opacity: 0.7; animation: pulse-bar 1.5s ease infinite; }
.waterfall-bar.failed { background: var(--error); opacity: 0.7; }
@keyframes pulse-bar { 0%,100% { opacity: 0.5; } 50% { opacity: 0.9; } }

.file-changes {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; font-family: var(--mono);
  color: var(--text-dim);
  background: var(--surface-alt);
  padding: 3px 10px;
  border-radius: 999px;
}
.file-changes .added { color: var(--success); }
.file-changes .removed { color: var(--error); }

/* ══════════════════════════════════════════════════
   SKILLS
   ══════════════════════════════════════════════════ */
.skills-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}

.skill-card {
  background: var(--surface);
  border: 1px solid var(--border-light);
  border-radius: var(--radius);
  padding: 22px 24px;
  box-shadow: var(--shadow-sm);
  transition: all 0.15s ease;
}
.skill-card:hover { box-shadow: var(--shadow); transform: translateY(-1px); }

.skill-header { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.skill-emoji {
  width: 40px; height: 40px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent);
  display: flex; align-items: center; justify-content: center;
  font-size: 13px;
  font-weight: 700;
  font-family: var(--mono);
  letter-spacing: -0.02em;
}
.skill-name { font-weight: 600; font-size: 15px; }
.skill-desc { font-size: 13px; color: var(--text-dim); line-height: 1.5; margin-bottom: 12px; }
.skill-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.skill-tag {
  font-size: 11px; font-family: var(--mono);
  padding: 3px 10px; border-radius: 999px;
  background: var(--surface-alt); color: var(--text-muted);
  border: 1px solid var(--border-light);
}

/* ══════════════════════════════════════════════════
   CRON JOBS — ENHANCED
   ══════════════════════════════════════════════════ */
.cron-week-strip {
  background: var(--surface);
  border: 1px solid var(--border-light);
  border-radius: var(--radius);
  padding: 20px 24px;
  box-shadow: var(--shadow-sm);
  margin-bottom: 24px;
}
.cron-week-title {
  font-family: var(--serif);
  font-size: 16px; font-weight: 700;
  margin-bottom: 14px;
}
.cron-week-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 8px;
}
.cron-week-day { text-align: center; }
.cron-day-label {
  font-size: 10px; font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 8px;
}
.cron-day-dots {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-height: 60px;
}
.cron-dot { width: 8px; height: 8px; border-radius: 50%; }
.cron-dot.morning { background: var(--accent); }
.cron-dot.reading { background: var(--warning); }
.cron-dot.exercise { background: #e07c5a; }
.cron-dot.heartbeat { background: var(--text-muted); opacity: 0.3; }
.cron-dot-time {
  font-size: 9px; font-family: var(--mono);
  color: var(--text-muted);
}

.cron-week-legend {
  display: flex; gap: 16px; margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-light);
}
.cron-legend-item {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; color: var(--text-muted);
}
.cron-legend-dot { width: 8px; height: 8px; border-radius: 50%; }

.cron-cards { display: flex; flex-direction: column; gap: 14px; }

.cron-card-rich {
  background: var(--surface);
  border: 1px solid var(--border-light);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  transition: all 0.15s;
}
.cron-card-rich:hover { box-shadow: var(--shadow); }

.cron-card-main {
  padding: 18px 22px;
  display: flex;
  justify-content: space-between;
  align-items: start;
  gap: 16px;
}

.cron-card-left { flex: 1; }
.cron-card-top {
  display: flex; align-items: center; gap: 12px;
  margin-bottom: 6px;
}
.cron-card-name { font-weight: 600; font-size: 15px; }
.cron-card-type {
  font-size: 10px; font-weight: 600;
  padding: 2px 8px; border-radius: 999px;
  text-transform: uppercase; letter-spacing: 0.04em;
  background: var(--accent-soft); color: var(--accent);
}
.cron-card-schedule {
  font-size: 13px; color: var(--text-dim);
  margin-bottom: 4px;
}
.cron-card-expr {
  font-size: 11px; font-family: var(--mono);
  color: var(--text-muted);
}

.cron-card-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

/* ══════════════════════════════════════════════════
   FORMS
   ══════════════════════════════════════════════════ */
select,
input,
textarea {
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  font-family: var(--mono);
  font-size: 14px;
  width: 100%;
}

select:focus,
input:focus,
textarea:focus {
  outline: none;
  border-color: var(--accent);
}

textarea {
  resize: vertical;
  min-height: 300px;
  line-height: 1.55;
}

label {
  display: block;
  font-size: 13px;
  color: var(--text-dim);
  margin-bottom: 4px;
  font-weight: 500;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
  font-family: var(--mono);
}
td {
  padding: 7px 8px;
  border-bottom: 1px solid var(--border);
}
td:first-child { color: var(--accent); }

/* ══════════════════════════════════════════════════
   LEGACY CLASSES (used by JS-generated HTML)
   ══════════════════════════════════════════════════ */

/* Toast notification */
.toast {
  position: fixed;
  bottom: 20px;
  right: 20px;
  padding: 12px 18px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-family: var(--mono);
  z-index: 1000;
  border: 1px solid var(--border-light);
  box-shadow: var(--shadow-md);
}
.toast.success { background: var(--success-soft); color: var(--text); border-color: rgba(74, 124, 111, 0.15); }
.toast.error { background: var(--error-soft); color: var(--text); border-color: rgba(194, 84, 80, 0.15); }

/* Card (model, config, health pages) */
.card {
  background: var(--surface);
  border: 1px solid var(--border-light);
  border-radius: var(--radius);
  padding: 20px 22px;
  margin-bottom: 14px;
  box-shadow: var(--shadow-sm);
}

.card-title {
  font-size: 14px;
  color: var(--text-dim);
  margin-bottom: 8px;
  font-weight: 500;
}

.card-value {
  font-family: var(--serif);
  font-size: 28px;
  font-weight: 700;
  line-height: 1.2;
}

/* Grid (status cards) */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 14px;
  margin-bottom: 18px;
}

/* Toolbar */
.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

/* Markdown content */
.markdown-content {
  font-size: 14px;
  line-height: 1.7;
  color: var(--text);
}

.markdown-content h1,
.markdown-content h2,
.markdown-content h3,
.markdown-content h4,
.markdown-content h5,
.markdown-content h6 {
  margin: 16px 0 8px;
  line-height: 1.3;
}

.markdown-content p { margin: 10px 0; }
.markdown-content ul,
.markdown-content ol { margin: 8px 0 10px 22px; }
.markdown-content li { margin: 4px 0; }
.markdown-content hr {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 14px 0;
}

.markdown-content code {
  background: var(--surface-alt);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 1px 6px;
  font-family: var(--mono);
  font-size: 12px;
}

.markdown-content pre {
  background: var(--surface-alt);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px;
  overflow-x: auto;
  margin: 10px 0;
}

.markdown-content pre code {
  background: transparent;
  border: 0;
  padding: 0;
  font-size: 13px;
}

.markdown-content blockquote {
  border-left: 3px solid var(--accent);
  margin: 10px 0;
  padding: 2px 0 2px 10px;
  color: var(--text-dim);
}

.markdown-content table {
  width: 100%;
  border-collapse: collapse;
  margin: 10px 0;
}

.markdown-content a { color: var(--accent); }
.markdown-content a:hover { text-decoration: underline; }

/* Toggle label */
.toggle-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-dim);
  cursor: pointer;
}
.toggle-label input { width: auto; }

/* Unsaved badge */
.unsaved { color: var(--warning); font-size: 13px; margin-left: 8px; font-family: var(--mono); }

/* Approval classes */
.approval-tier {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}
.approval-tier.tier-1 { background: var(--surface-alt); color: var(--text-dim); }
.approval-tier.tier-2 { background: var(--warning-soft); color: var(--warning); }
.approval-tier.tier-3 { background: var(--error-soft); color: var(--error); }

.approval-countdown {
  font-size: 12px;
  color: var(--text-dim);
  font-family: var(--mono);
}
.approval-countdown.urgent { color: var(--error); font-weight: 600; }

.approval-command {
  font-family: var(--mono);
  font-size: 13px;
  background: var(--surface-alt);
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  margin: 6px 0;
  word-break: break-all;
  border: 1px solid var(--border-light);
}

.approval-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.approval-actions .btn { font-size: 12px; padding: 4px 12px; }

.approval-status {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.approval-status.pending { background: var(--warning-soft); color: var(--warning); }
.approval-status.approved { background: var(--success-soft); color: var(--success); }
.approval-status.denied { background: var(--error-soft); color: var(--error); }
.approval-status.expired { background: var(--surface-alt); color: var(--text-dim); }

/* Audit classes */
.audit-entry {
  background: var(--surface);
  border: 1px solid var(--border-light);
  border-radius: var(--radius);
  padding: 16px 20px;
  margin-bottom: 12px;
  transition: background 0.12s ease;
  box-shadow: var(--shadow-sm);
}
.audit-entry:hover { background: var(--surface-alt); }

.audit-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
  gap: 10px;
  flex-wrap: wrap;
}

.audit-id {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--accent);
  font-weight: 600;
}

.audit-meta {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 12px;
  color: var(--text-dim);
  font-family: var(--mono);
}

.audit-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.audit-badge.ok { background: var(--success-soft); color: var(--success); }
.audit-badge.error { background: var(--error-soft); color: var(--error); }

.audit-trigger {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.audit-trigger.telegram { background: var(--accent-soft); color: var(--accent); }
.audit-trigger.cron { background: var(--warning-soft); color: var(--warning); }
.audit-trigger.api { background: var(--success-soft); color: var(--success); }
.audit-trigger.system { background: var(--surface-alt); color: var(--text-dim); border: 1px solid var(--border); }
.audit-trigger.discord { background: rgba(88, 101, 242, 0.1); color: #7289da; }
.audit-trigger.code_agent { background: rgba(147, 51, 234, 0.1); color: #9333ea; }

.audit-summary {
  display: flex;
  gap: 12px;
  align-items: center;
  font-size: 13px;
  color: var(--text-dim);
  margin-bottom: 4px;
}

.audit-events-toggle {
  font-size: 13px;
  color: var(--accent);
  cursor: pointer;
  user-select: none;
  margin-top: 6px;
  font-family: var(--mono);
}
.audit-events-toggle:hover { text-decoration: underline; }

.audit-events {
  display: none;
  margin-top: 8px;
  padding: 10px 0 0 0;
  border-top: 1px solid var(--border);
}
.audit-events.expanded { display: block; }

.audit-event {
  display: grid;
  grid-template-columns: 80px 1fr auto;
  gap: 8px;
  padding: 6px 0;
  font-size: 13px;
  border-bottom: 1px solid var(--border-light);
  align-items: center;
}
.audit-event:last-child { border-bottom: none; }

.audit-event-type {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--accent);
  font-weight: 500;
}

.audit-event-summary {
  color: var(--text);
  line-height: 1.4;
}

.audit-event-duration {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-dim);
  text-align: right;
  white-space: nowrap;
}

/* Coding Agent legacy classes */
.ca-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.ca-status-badge.idle { background: var(--surface-alt); color: var(--text-dim); }
.ca-status-badge.running { background: var(--accent-soft); color: var(--accent); }
.ca-status-badge.validating { background: var(--warning-soft); color: var(--warning); }
.ca-status-badge.completed { background: var(--success-soft); color: var(--success); }
.ca-status-badge.failed { background: var(--error-soft); color: var(--error); }
.ca-status-badge.timeout { background: var(--error-soft); color: var(--error); }

.ca-spinner {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.ca-task {
  font-size: 14px;
  line-height: 1.6;
  margin-bottom: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.ca-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  font-family: var(--mono);
  color: var(--text-dim);
  margin-bottom: 12px;
}

.ca-output {
  background: var(--surface-alt);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 400px;
  overflow-y: auto;
}

.ca-output-md {
  white-space: normal;
  font-family: var(--sans);
  max-height: 400px;
  overflow-y: auto;
}
.ca-output-md h1, .ca-output-md h2, .ca-output-md h3 { margin: 10px 0 4px; font-size: 14px; }
.ca-output-md h2 { font-size: 15px; }
.ca-output-md h1 { font-size: 16px; }
.ca-output-md p { margin: 4px 0; }
.ca-output-md ul, .ca-output-md ol { margin: 4px 0; padding-left: 20px; }
.ca-output-md li { margin: 2px 0; }
.ca-output-md code { background: var(--surface); padding: 1px 5px; border-radius: 3px; font-family: var(--mono); font-size: 0.9em; }
.ca-output-md pre { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px; overflow-x: auto; font-size: 11px; }
.ca-output-md pre code { background: none; padding: 0; }

.ca-error {
  background: var(--error-soft);
  border: 1px solid rgba(194, 84, 80, 0.15);
  color: var(--error);
}

.ca-tree { margin-bottom: 16px; }
.ca-tree-children {
  margin-left: 20px;
  padding-left: 16px;
  border-left: 2px solid var(--border);
}
.ca-tree-child {
  background: var(--surface);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm);
  padding: 12px 16px;
  margin-bottom: 10px;
  font-size: 14px;
  cursor: pointer;
}
.ca-tree-child .ca-output {
  max-height: 300px;
  overflow-y: auto;
}

/* Digests */
.digest-header {
  margin-bottom: 20px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}

.digest-title {
  font-family: var(--serif);
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 6px;
}

.digest-meta {
  font-size: 13px;
  color: var(--text-dim);
  font-family: var(--mono);
}

.digest-reader {
  font-size: 15px;
  line-height: 1.8;
  color: var(--text);
  padding: 0 4px;
  max-width: 720px;
}

.digest-reader h3.digest-h3 {
  font-size: 18px; font-weight: 700;
  margin: 28px 0 12px 0; color: var(--accent);
  border-bottom: 1px solid var(--border); padding-bottom: 6px;
}
.digest-reader h4.digest-h4 { font-size: 16px; font-weight: 600; margin: 20px 0 8px 0; color: var(--text); }
.digest-reader hr.digest-hr { border: none; border-top: 1px solid var(--border); margin: 20px 0; }
.digest-reader a.digest-link { color: var(--accent); word-break: break-all; font-size: 13px; font-family: var(--mono); }
.digest-reader a.digest-link:hover { text-decoration: underline; }
.digest-reader strong { color: var(--text); font-weight: 600; }

.digest-section-header {
  font-size: 16px; font-weight: 700; color: var(--accent);
  margin: 24px 0 12px 0; padding: 8px 12px;
  background: var(--surface-alt); border-radius: var(--radius-sm);
  border-left: 3px solid var(--accent);
}
.digest-section-header:first-child { margin-top: 0; }

.digest-item-title { font-size: 15px; font-weight: 600; color: var(--text); margin-top: 12px; line-height: 1.4; }
.digest-stats { font-size: 13px; color: var(--text-dim); font-family: var(--mono); margin: 2px 0; }
.digest-link-line { font-size: 13px; margin: 2px 0 8px 0; }
.digest-link-line .digest-link-icon { margin-right: 2px; }
.digest-link-line .digest-link { color: var(--accent); font-family: var(--mono); font-size: 12px; word-break: break-all; }
.digest-link-line .digest-link:hover { text-decoration: underline; }
.digest-line { font-size: 14px; color: var(--text-dim); line-height: 1.5; margin: 1px 0; }
.digest-spacer { height: 4px; }
.digest-hr { border: none; border-top: 1px solid var(--border); margin: 16px 0; }

.digest-articles { padding: 8px 0; }
.digest-article-card {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-light);
  display: flex; flex-direction: column; gap: 4px;
}
.digest-article-card:last-child { border-bottom: none; }
.digest-article-card .source-badge { font-size: 11px; color: var(--accent); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
.digest-article-card .article-title { font-size: 15px; font-weight: 600; color: var(--text); text-decoration: none; line-height: 1.3; }
.digest-article-card .article-title:hover { text-decoration: underline; color: var(--accent); }
.digest-article-card .article-stats { font-size: 13px; color: var(--text-dim); font-family: var(--mono); }

.source-badge { font-size: 11px; color: var(--accent); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }

/* Article list */
.article-list { display: flex; flex-direction: column; gap: 10px; }
.article-item {
  background: var(--surface); border: 1px solid var(--border-light);
  border-radius: var(--radius-sm); padding: 14px;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.article-item:hover { background: var(--surface-alt); border-color: var(--accent); }
.article-item.read { opacity: 0.7; }
.article-item.read .article-title { text-decoration: line-through; color: var(--text-dim); }

.article-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 6px; }
.article-title { font-weight: 600; font-size: 15px; line-height: 1.4; flex: 1; }
.article-title a { color: var(--text); }
.article-title a:hover { color: var(--accent); }
.article-actions { display: flex; gap: 6px; flex-shrink: 0; }
.article-meta { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; font-size: 12px; color: var(--text-dim); font-family: var(--mono); margin-bottom: 6px; }
.article-source { color: var(--accent); font-weight: 500; }
.article-score, .article-comments { background: var(--surface-alt); padding: 2px 8px; border-radius: 999px; }
.article-summary { font-size: 13px; line-height: 1.5; color: var(--text-dim); }

.read-btn {
  padding: 4px 10px; font-size: 12px; border-radius: var(--radius-sm);
  background: var(--surface-alt); border: 1px solid var(--border);
  color: var(--text-dim); cursor: pointer; transition: all 0.12s ease;
}
.read-btn:hover { background: var(--accent); color: #fff; border-color: var(--accent); }
.read-btn.mark-unread { background: var(--success); color: #fff; border-color: var(--success); }

/* Status dot */
.status-dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: var(--success); display: inline-block;
}
.status-dot.error { background: var(--error); }

/* ══════════════════════════════════════════════════
   RESPONSIVE
   ══════════════════════════════════════════════════ */
@media (max-width: 1024px) {
  .shell { grid-template-columns: 1fr; }
  .sidebar {
    position: static; height: auto;
    flex-direction: row; overflow-x: auto;
    border-bottom: 1px solid var(--border-light);
  }
  .sidebar-section, .sidebar-footer { display: flex; gap: 4px; }
  .sidebar-spacer { display: none; }
  .main { padding: 20px 16px; }
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
  .split, .split-view { grid-template-columns: 1fr; height: auto; }
  .split-list, .split-left { max-height: 50vh; }
}

@media (max-width: 768px) {
  .stats-grid { grid-template-columns: 1fr; }
  .grid { grid-template-columns: 1fr; }
  .cron-grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>

<div class="shell">
  <!-- ══════════════════════════════════════════════
       SIDEBAR
       ══════════════════════════════════════════════ -->
  <nav class="sidebar">
    <div class="sidebar-header">
      <div class="sidebar-logo">\u{1F459}\u{1F99E}</div>
      <div class="sidebar-brand">
        <div class="sidebar-brand-name">SkimpyClaw</div>
        <div class="sidebar-brand-status">Online</div>
      </div>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-section-label">Dashboard</div>

      <button class="sidebar-item active" data-page="overview" onclick="switchPage('overview')">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
        Overview
      </button>

      <button class="sidebar-item" data-page="history" onclick="switchPage('history')">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        History
      </button>

      <button class="sidebar-item" data-page="approvals" onclick="switchPage('approvals')">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        Approvals
      </button>

      <button class="sidebar-item" data-page="digests" onclick="switchPage('digests')">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
        Digests
      </button>

      <button class="sidebar-item" data-page="audit" onclick="switchPage('audit')">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        Audit
      </button>

      <button class="sidebar-item" data-page="coding" onclick="switchPage('coding')">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        Coding Agent
      </button>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-section-label">Settings</div>

      <button class="sidebar-item" data-page="memory" onclick="switchPage('memory')">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
        Memory
      </button>

      <button class="sidebar-item" data-page="templates" onclick="switchPage('templates')">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        Templates
      </button>

      <button class="sidebar-item" data-page="model" onclick="switchPage('model')">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
        Model
      </button>

      <button class="sidebar-item" data-page="skills" onclick="switchPage('skills')">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        Skills
      </button>

      <button class="sidebar-item" data-page="cron" onclick="switchPage('cron')">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        Cron Jobs
      </button>

      <button class="sidebar-item" data-page="config" onclick="switchPage('config')">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        Config
      </button>
    </div>

    <div class="sidebar-spacer"></div>

    <div class="sidebar-footer">
      <button class="sidebar-footer-item" data-page="logs" onclick="switchPage('logs')">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>
        Logs
      </button>
      <button class="sidebar-footer-item" data-page="health" onclick="switchPage('health')">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
        Health
      </button>
    </div>
  </nav>

  <!-- ══════════════════════════════════════════════
       MAIN CONTENT
       ══════════════════════════════════════════════ -->
  <div class="main">

    <div class="page-header">
      <div class="page-title" id="pageTitle">Overview</div>
      <div class="header-actions">
        <span class="header-meta" id="headerMeta"></span>
        <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" title="Toggle theme"><svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg></button>
      </div>
    </div>

    <!-- Overview Page -->
    <div class="page active" id="page-overview">
      <div id="welcomeBanner"></div>
      <div id="approvalBannerContainer"></div>
      <div class="stats-grid" id="statusGrid"></div>
      <div class="section">
        <div class="section-header">
          <div class="section-title">Recent Activity</div>
          <a class="section-link" onclick="switchPage('history')">View all \u2192</a>
        </div>
        <div id="overviewFeed"></div>
      </div>
      <div class="section">
        <div class="section-header">
          <div class="section-title">Scheduled Jobs</div>
          <a class="section-link" onclick="switchPage('cron')">Manage \u2192</a>
        </div>
        <div id="statusCronJobs"></div>
      </div>
      <div class="section">
        <div class="section-header">
          <div class="section-title">System Health</div>
          <a class="section-link" onclick="switchPage('health')">Details \u2192</a>
        </div>
        <div id="overviewHealthGrid"></div>
      </div>
    </div>

    <!-- History Page -->
    <div class="page" id="page-history">
      <div class="toolbar" style="margin-bottom:16px;">
        <select id="historyTriggerFilter" style="width:160px;">
          <option value="">All triggers</option>
          <option value="telegram">Telegram</option>
          <option value="cron">Cron</option>
          <option value="discord">Discord</option>
          <option value="api">API</option>
          <option value="system">System</option>
          <option value="code_agent">Coding Agent</option>
          <option value="code_team">Coding Team</option>
        </select>
        <button class="btn btn-sm" id="historyRefreshBtn">Refresh</button>
        <span id="historyCount" style="font-size:13px;color:var(--text-muted);margin-left:auto;"></span>
      </div>
      <div class="split-view">
        <div class="split-left" id="historyList"></div>
        <div class="split-right" id="historyDetail">
          <div class="empty-state"><div class="empty-state-icon"><svg width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div><div class="empty-state-text">Select a trace to view details</div></div>
        </div>
      </div>
    </div>

    <!-- Memory Page -->
    <div class="page" id="page-memory">
      <div class="toolbar">
        <label style="margin-bottom:0;">Agent:</label>
        <select id="memoryAgentSelect" style="width:200px;"></select>
      </div>
      <div class="split" style="height:calc(100vh - 200px);">
        <div class="split-list" id="memoryFileList"></div>
        <div class="split-detail" id="memoryContent">
          <div class="empty">Select a file to view</div>
        </div>
      </div>
    </div>

    <!-- Cron Page -->
    <div class="page" id="page-cron">
      <div id="cronJobs"></div>
    </div>

    <!-- Model Page -->
    <div class="page" id="page-model">
      <div class="card" style="margin-bottom:20px;">
        <div class="card-title">Current Model</div>
        <div class="card-value" id="currentModel">-</div>
      </div>
      <div class="card" style="margin-bottom:20px;">
        <div class="card-title">Switch Model</div>
        <div class="toolbar" style="margin-top:8px;">
          <input type="text" id="modelInput" placeholder="Model ID or alias" style="flex:1;width:auto;">
          <button class="btn" id="modelSwitchBtn">Switch</button>
        </div>
      </div>
      <div class="card" style="margin-bottom:20px;">
        <div class="card-title">Aliases</div>
        <div id="modelAliases"></div>
      </div>
      <div class="card">
        <div class="card-title">Agent Models</div>
        <div id="agentModels"></div>
      </div>
    </div>

    <!-- Templates Page -->
    <div class="page" id="page-templates">
      <div class="toolbar">
        <label style="margin-bottom:0;">Agent:</label>
        <select id="templateAgentSelect" style="width:200px;"></select>
      </div>
      <div class="split" style="height:calc(100vh - 200px);">
        <div class="split-list" id="templateFileList"></div>
        <div class="split-detail" id="templateEditor">
          <div class="empty">Select a template to edit</div>
        </div>
      </div>
    </div>

    <!-- Approvals Page -->
    <div class="page" id="page-approvals">
      <div class="toolbar">
        <button class="btn btn-small" id="approvalsRefreshBtn">Refresh</button>
        <label class="toggle-label"><input type="checkbox" id="approvalsAutoRefresh" checked> Auto-refresh</label>
        <span id="approvalsCount" style="font-size:13px;color:var(--text-dim);margin-left:auto;"></span>
      </div>
      <div id="approvalsPending"></div>
      <h3 class="section-title" style="margin-top:20px;">Recent</h3>
      <div id="approvalsRecent"></div>
    </div>

    <!-- Coding Agent Page -->
    <div class="page" id="page-coding">
      <div id="caStatus">
        <div class="empty">No coding agents have run yet. Send a coding task via Telegram or Discord.</div>
      </div>
    </div>

    <!-- Audit Page -->
    <div class="page" id="page-audit">
      <div class="toolbar">
        <label style="margin-bottom:0;">Trigger:</label>
        <select id="auditTriggerFilter" style="width:160px;">
          <option value="">All</option>
          <option value="telegram">Telegram</option>
          <option value="cron">Cron</option>
          <option value="api">API</option>
          <option value="system">System</option>
          <option value="discord">Discord</option>
          <option value="code_agent">Coding Agent</option>
        </select>
        <button class="btn btn-small" id="auditRefreshBtn">Refresh</button>
        <span id="auditCount" style="font-size:13px;color:var(--text-dim);margin-left:auto;"></span>
      </div>
      <div id="auditEntries"></div>
      <div style="text-align:center;margin-top:12px;">
        <button class="btn btn-small" id="auditLoadMoreBtn" style="display:none;">Load More</button>
      </div>
    </div>

    <!-- Digests Page -->
    <div class="page" id="page-digests">
      <div class="split">
        <div class="split-list" id="digestList"></div>
        <div class="split-detail" id="digestDetail">
          <div class="empty">Select a digest to view articles</div>
        </div>
      </div>
    </div>

    <!-- Skills Page -->
    <div class="page" id="page-skills">
      <div class="toolbar">
        <button class="btn btn-small" id="skillsRefreshBtn">Refresh</button>
        <button class="btn btn-small btn-success" id="skillsCreateBtn">Create Skill</button>
        <span id="skillsCount" style="font-size:13px;color:var(--text-dim);margin-left:auto;"></span>
      </div>
      <div id="skillsList"></div>
      <div id="skillsCreateForm" style="display:none;margin-top:16px;">
        <div class="card">
          <div class="card-title">Create New Skill</div>
          <div style="margin-bottom:8px;">
            <label>Name (alphanumeric + hyphens):</label>
            <input type="text" id="skillNameInput" placeholder="my-skill" style="width:300px;">
          </div>
          <label>SKILL.md content:</label>
          <textarea id="skillContentInput" style="min-height:300px;" placeholder="---\\nname: my-skill\\ndescription: What this skill does\\nemoji: \\"🔧\\"\\ntags: [\\"example\\"]\\n---\\n\\n# My Skill\\n\\nSkill documentation here..."></textarea>
          <div class="toolbar" style="margin-top:8px;">
            <button class="btn btn-success" id="skillSaveNewBtn">Save</button>
            <button class="btn btn-small" id="skillCancelCreateBtn">Cancel</button>
          </div>
        </div>
      </div>
      <div id="skillDetail" style="display:none;margin-top:16px;"></div>
    </div>

    <!-- Logs Page -->
    <div class="page" id="page-logs">
      <div class="split">
        <div class="split-list" id="logFileList"></div>
        <div class="split-detail" id="logViewer" style="padding:0;">
          <div class="toolbar" style="padding:12px;border-bottom:1px solid var(--border);">
            <label class="toggle-label"><input type="checkbox" id="logTailMode"> Tail mode</label>
            <input type="number" id="logTailLines" value="100" min="10" max="10000" style="width:80px;" placeholder="Lines">
            <label class="toggle-label"><input type="checkbox" id="logAutoRefresh"> Auto-refresh</label>
            <button class="btn btn-small" id="logRefreshBtn">Refresh</button>
          </div>
          <div class="log-viewer" id="logContent">Select a log file to view</div>
        </div>
      </div>
    </div>

    <!-- Config Page -->
    <div class="page" id="page-config">
      <div class="card">
        <div class="card-title">Configuration (secrets redacted)</div>
        <textarea id="configEditor" style="min-height:500px;"></textarea>
        <div class="toolbar" style="margin-top:12px;">
          <button class="btn" id="configValidateBtn">Validate</button>
          <button class="btn btn-success" id="configSaveBtn">Save</button>
          <span id="configStatus" style="font-size:12px;"></span>
        </div>
        <div style="margin-top:8px;font-size:12px;color:var(--warning);">
          Warning: Restart required for changes to take effect.
        </div>
      </div>
    </div>

    <!-- Health Page -->
    <div class="page" id="page-health">
      <div class="card" id="doctorSummaryCard">
        <div class="card-title" style="display:flex;justify-content:space-between;align-items:center;">
          System Health
          <div style="display:flex;gap:8px;align-items:center;">
            <span id="doctorTimestamp" style="font-size:11px;color:var(--text-dim);font-weight:normal;"></span>
            <button class="btn" id="healthRecheckBtn" style="font-size:12px;">Re-check</button>
          </div>
        </div>
        <div id="doctorSummary" style="margin-bottom:8px;">Loading...</div>
      </div>
      <div id="doctorCategories">Loading...</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px;">
        <div class="card">
          <div class="card-title">Environment Variables</div>
          <div id="healthEnvVars">Loading...</div>
        </div>
        <div class="card">
          <div class="card-title">Feature Toggles</div>
          <div id="healthFeatures">Loading...</div>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
// --- Theme ---
function initTheme() {
  const saved = localStorage.getItem('skimpyclaw-theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcon(saved);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('skimpyclaw-theme', next);
  updateThemeIcon(next);
}

function updateThemeIcon(theme) {
  var btn = document.getElementById('themeToggle');
  if (!btn) return;
  if (theme === 'dark') {
    btn.innerHTML = '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  } else {
    btn.innerHTML = '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  }
}

initTheme();
// --- State ---
let statusInterval = null;
let logAutoRefreshInterval = null;
let currentLogFile = null;
let currentSessionId = null;
let currentTemplateFile = null;
let templateUnsaved = false;
let agentList = [];

// --- Utilities ---
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function md(str) {
  if (typeof marked !== 'undefined' && marked.parse) {
    try { return marked.parse(str, { breaks: true }); } catch(e) {}
  }
  return esc(str);
}

function isSafeHref(url) {
  if (!url) return false;
  if (url.startsWith('#') || url.startsWith('/')) return true;
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function renderInlineMarkdown(text) {
  let html = esc(text || '');

  html = html.replace(/\\x60([^\\x60]+)\\x60/g, '<code>$1</code>');
  html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  html = html.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');

  html = html.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, (m, label, href) => {
    return isSafeHref(href)
      ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'
      : label;
  });

  html = html.replace(/(^|\\s)(https?:\\/\\/[^\\s<]+)/g, (m, prefix, url) => {
    return isSafeHref(url)
      ? prefix + '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(url) + '</a>'
      : m;
  });

  return html;
}

function renderMarkdown(md) {
  const src = String(md || '').replace(/\\r\\n/g, '\\n');
  if (!src.trim()) return '<div class="empty">(empty)</div>';

  const lines = src.split('\\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\\x60\\x60\\x60/.test(line.trim())) {
      const code = [];
      i++;
      while (i < lines.length && !/^\\x60\\x60\\x60/.test(lines[i].trim())) {
        code.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      out.push('<pre><code>' + esc(code.join('\\n')) + '</code></pre>');
      continue;
    }

    const heading = line.match(/^(#{1,6})\\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push('<h' + level + '>' + renderInlineMarkdown(heading[2]) + '</h' + level + '>');
      i++;
      continue;
    }

    if (/^\\s*([-*_])\\1\\1+\\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    const quote = line.match(/^>\\s?(.*)$/);
    if (quote) {
      out.push('<blockquote>' + renderInlineMarkdown(quote[1]) + '</blockquote>');
      i++;
      continue;
    }

    const ul = line.match(/^\\s*[-*]\\s+(.*)$/);
    if (ul) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\\s*[-*]\\s+(.*)$/);
        if (!m) break;
        items.push('<li>' + renderInlineMarkdown(m[1]) + '</li>');
        i++;
      }
      out.push('<ul>' + items.join('') + '</ul>');
      continue;
    }

    const ol = line.match(/^\\s*\\d+\\.\\s+(.*)$/);
    if (ol) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\\s*\\d+\\.\\s+(.*)$/);
        if (!m) break;
        items.push('<li>' + renderInlineMarkdown(m[1]) + '</li>');
        i++;
      }
      out.push('<ol>' + items.join('') + '</ol>');
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const paragraph = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() &&
      !/^(#{1,6})\\s+/.test(lines[i]) &&
      !/^\\s*([-*_])\\1\\1+\\s*$/.test(lines[i]) &&
      !/^>\\s?/.test(lines[i]) &&
      !/^\\s*[-*]\\s+/.test(lines[i]) &&
      !/^\\s*\\d+\\.\\s+/.test(lines[i]) &&
      !/^\\x60\\x60\\x60/.test(lines[i].trim())) {
      paragraph.push(lines[i].trim());
      i++;
    }
    out.push('<p>' + renderInlineMarkdown(paragraph.join(' ')) + '</p>');
  }

  return '<div class="markdown-content">' + out.join('') + '</div>';
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(d + 'd');
  if (h > 0) parts.push(h + 'h');
  if (m > 0) parts.push(m + 'm');
  parts.push(s + 's');
  return parts.join(' ');
}

function formatDate(dateStr) {
  if (!dateStr) return 'N/A';
  const d = new Date(dateStr);
  return d.toLocaleString();
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function getToken() {
  return localStorage.getItem('skimpyclaw_token') || '';
}

function setToken(token) {
  localStorage.setItem('skimpyclaw_token', token);
}

function showTokenPrompt() {
  const existing = document.getElementById('tokenOverlay');
  if (existing) return; // Already showing

  const overlay = document.createElement('div');
  overlay.id = 'tokenOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:9999;';
  overlay.innerHTML =
    '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px;width:400px;max-width:90vw;">' +
    '<h3 style="margin-bottom:12px;font-size:14px;">Dashboard Token Required</h3>' +
    '<p style="font-size:12px;color:var(--text-dim);margin-bottom:12px;">Enter the token shown in the server console output.</p>' +
    '<input type="text" id="tokenInput" placeholder="Paste token here" style="margin-bottom:12px;">' +
    '<button class="btn btn-success" id="tokenSubmitBtn" style="width:100%;">Connect</button>' +
    '</div>';
  document.body.appendChild(overlay);

  document.getElementById('tokenSubmitBtn').addEventListener('click', () => {
    const token = document.getElementById('tokenInput').value.trim();
    if (token) {
      setToken(token);
      overlay.remove();
      // Retry loading
      startStatusRefresh();
    }
  });

  document.getElementById('tokenInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('tokenSubmitBtn').click();
    }
  });
}

async function api(path, options) {
  try {
    const opts = options || {};
    opts.headers = opts.headers || {};
    const token = getToken();
    if (token) {
      opts.headers['Authorization'] = 'Bearer ' + token;
    }
    const res = await fetch('/api/dashboard/' + path, opts);
    if (res.status === 401) {
      showTokenPrompt();
      throw new Error('Unauthorized');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return await res.json();
  } catch (e) {
    console.error('API error:', path, e);
    throw e;
  }
}

function showToast(message, type) {
  const t = document.createElement('div');
  t.className = 'toast ' + (type || 'success');
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}


// --- Page Navigation ---
function switchPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.sidebar-item, .sidebar-footer-item').forEach(b => b.classList.remove('active'));
  var page = document.getElementById('page-' + name);
  var btn = document.querySelector('[data-page="' + name + '"]');
  if (page) page.classList.add('active');
  if (btn) btn.classList.add('active');
  var titles = { overview:'Overview', history:'History', approvals:'Approvals', digests:'Digests', coding:'Coding Agent', audit:'Audit', memory:'Memory', model:'Model', templates:'Templates', skills:'Skills', cron:'Cron Jobs', config:'Config', logs:'Logs', health:'Health' };
  document.getElementById('pageTitle').textContent = titles[name] || name;
  onPageActivated(name);
}

function onPageActivated(page) {
  // Clear status refresh when leaving overview
  if (page !== 'overview' && statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }
  if (page === 'overview') startStatusRefresh();
  else if (page === 'history') loadHistory();
  else if (page === 'memory') loadMemory();
  else if (page === 'approvals') startApprovalsPolling();
  else if (page === 'cron') loadCronJobs();
  else if (page === 'model') loadModel();
  else if (page === 'templates') loadTemplates();
  else if (page === 'coding') startCaPolling();
  else if (page === 'audit') loadAudit();
  else if (page === 'logs') loadLogFiles();
  else if (page === 'digests') loadDigests();
  else if (page === 'skills') loadSkills();
  else if (page === 'config') loadConfig();
  else if (page === 'health') loadHealth();
}

// --- Status Tab ---
function getGreeting() {
  var h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function formatStartDate(uptimeSeconds) {
  var started = new Date(Date.now() - uptimeSeconds * 1000);
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[started.getMonth()] + ' ' + started.getDate() + ' ' +
    (started.getHours() < 10 ? '0' : '') + started.getHours() + ':' +
    (started.getMinutes() < 10 ? '0' : '') + started.getMinutes();
}

function formatNextCronRun(dateStr) {
  if (!dateStr) return '';
  var d = new Date(dateStr);
  var now = new Date();
  var diffMs = d.getTime() - now.getTime();
  if (diffMs < 0) return 'overdue';
  var diffH = Math.floor(diffMs / 3600000);
  var diffM = Math.floor((diffMs % 3600000) / 60000);
  if (diffH > 24) return Math.floor(diffH / 24) + 'd';
  if (diffH > 0) return diffH + 'h ' + diffM + 'm';
  return diffM + 'm';
}

async function loadStatus() {
  try {
    var data = await api('status');
    // Update header meta
    var metaEl = document.getElementById('headerMeta');
    if (metaEl) {
      metaEl.textContent = esc(data.model || '') + ' \\u00B7 up ' + formatUptime(data.uptime);
    }

    // Welcome banner
    var welcomeEl = document.getElementById('welcomeBanner');
    var cronCount = data.cronJobs ? data.cronJobs.length : 0;
    var subagentsDone = data.subagents ? data.subagents.recentCompleted : 0;
    welcomeEl.innerHTML =
      '<div class="welcome-banner">' +
        '<div class="welcome-greeting">' + getGreeting() + ', Katrina</div>' +
        '<div class="welcome-sub">' +
          'Up ' + formatUptime(data.uptime) +
          ' \\u00B7 ' + cronCount + ' cron job' + (cronCount !== 1 ? 's' : '') +
          ' \\u00B7 ' + subagentsDone + ' task' + (subagentsDone !== 1 ? 's' : '') + ' completed' +
          ' \\u00B7 ' + esc(data.model || 'no model') +
        '</div>' +
      '</div>';

    // Approval banner (fetch pending approvals)
    var bannerEl = document.getElementById('approvalBannerContainer');
    try {
      var appData = await api('approvals');
      var pending = appData.pending || [];
      if (pending.length > 0) {
        var a = pending[0];
        var serverNow = appData.now ? new Date(appData.now).getTime() : Date.now();
        var exp = new Date(a.expiresAt).getTime();
        var remaining = Math.max(0, Math.round((exp - serverNow) / 1000));
        var m = Math.floor(remaining / 60);
        var s = remaining % 60;
        var countdown = m + ':' + (s < 10 ? '0' : '') + s;
        bannerEl.innerHTML =
          '<div class="approval-banner">' +
            '<div class="approval-banner-icon"><svg width="20" height="20" fill="none" stroke="var(--warning)" stroke-width="2" viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>' +
            '<div class="approval-banner-content">' +
              '<div class="approval-banner-title">Pending Approval' + (pending.length > 1 ? ' (' + pending.length + ')' : '') + '</div>' +
              '<div class="approval-banner-detail">' + esc(a.command) + ' \\u2014 Tier ' + a.tier + ' \\u00B7 expires in ' + countdown + '</div>' +
            '</div>' +
            '<div class="approval-banner-actions">' +
              '<button class="btn btn-success btn-sm" onclick="approveApproval(\\'' + esc(a.id) + '\\')">Approve</button>' +
              '<button class="btn btn-danger btn-sm" onclick="denyApproval(\\'' + esc(a.id) + '\\')">Deny</button>' +
            '</div>' +
          '</div>';
      } else {
        bannerEl.innerHTML = '';
      }
    } catch(e2) {
      bannerEl.innerHTML = '';
    }

    // Stat cards
    var grid = document.getElementById('statusGrid');
    var nextCron = '';
    if (data.cronJobs && data.cronJobs.length > 0) {
      var soonest = data.cronJobs.reduce(function(a, b) {
        return new Date(a.nextRun) < new Date(b.nextRun) ? a : b;
      });
      nextCron = 'Next: ' + esc(soonest.name || soonest.id) + ' in ' + formatNextCronRun(soonest.nextRun);
    }
    grid.innerHTML =
      '<div class="stat-card">' +
        '<div class="stat-icon sage"><svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>' +
        '<div class="stat-label">Uptime</div>' +
        '<div class="stat-value">' + formatUptime(data.uptime) + '</div>' +
        '<div class="stat-sub">Started ' + formatStartDate(data.uptime) + '</div>' +
      '</div>' +
      '<div class="stat-card">' +
        '<div class="stat-icon green"><svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>' +
        '<div class="stat-label">Model</div>' +
        '<div class="stat-value" style="font-size:18px;">' + esc(data.model || '-') + '</div>' +
        '<div class="stat-sub">Agent: ' + esc(data.agent || '-') + '</div>' +
      '</div>' +
      '<div class="stat-card">' +
        '<div class="stat-icon amber"><svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>' +
        '<div class="stat-label">Cron Jobs</div>' +
        '<div class="stat-value">' + cronCount + '</div>' +
        '<div class="stat-sub">' + (nextCron || 'No upcoming jobs') + '</div>' +
      '</div>' +
      '<div class="stat-card">' +
        '<div class="stat-icon blue"><svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></div>' +
        '<div class="stat-label">Subagents</div>' +
        '<div class="stat-value">' + (data.subagents ? data.subagents.active : 0) + ' active</div>' +
        '<div class="stat-sub">' + subagentsDone + ' completed \\u00B7 ' + (data.subagents ? data.subagents.recentFailed : 0) + ' failed</div>' +
      '</div>';

    // Cron jobs grid
    var cronEl = document.getElementById('statusCronJobs');
    if (data.cronJobs && data.cronJobs.length > 0) {
      cronEl.innerHTML = '<div class="cron-grid">' + data.cronJobs.map(function(j) {
        return '<div class="cron-card">' +
          '<div><div class="cron-name">' + esc(j.name || j.id) + '</div>' +
          '<div class="cron-schedule">' + esc(j.schedule ? j.schedule.expr || '' : '') + '</div></div>' +
          '<div class="cron-next">Next: ' + formatNextCronRun(j.nextRun) + '</div>' +
        '</div>';
      }).join('') + '</div>';
    } else {
      cronEl.innerHTML = '<div class="empty">No cron jobs configured</div>';
    }

    // Recent activity feed (from audit traces)
    var feedEl = document.getElementById('overviewFeed');
    if (feedEl) {
      try {
        var auditData = await api('audit?limit=8&offset=0');
        var traces = auditData.traces || [];
        if (traces.length > 0) {
          feedEl.innerHTML = '<div class="feed-card"><div class="feed">' + traces.map(function(t) {
            var trigger = t.trigger || 'system';
            var iconClass = TRIGGER_ICON_CLASS[trigger] || 'system';
            var icon = TRIGGER_ICONS[trigger] || TRIGGER_ICONS.system;
            var summary = getTraceSummary(t);
            var evtCount = t.events ? t.events.length : 0;
            var dur = formatDuration(t.durationMs);
            var statusDot = t.status === 'ok' ? '' : ' <span style="color:var(--error);">\\u25CF</span>';
            return '<div class="feed-item">' +
              '<div class="feed-icon ' + iconClass + '">' + icon + '</div>' +
              '<div><div class="feed-title">' + esc(trigger) + statusDot + '</div>' +
              '<div class="feed-detail">' + esc(summary.slice(0, 100)) + '</div></div>' +
              '<div class="feed-time">' + formatTimeAgo(t.startedAt) + '<br><span style="font-size:10px;">' + evtCount + ' events \\u00B7 ' + dur + '</span></div>' +
            '</div>';
          }).join('') + '</div></div>';
        } else {
          feedEl.innerHTML = '<div class="empty">No recent activity</div>';
        }
      } catch(e3) {
        feedEl.innerHTML = '<div class="empty">Could not load activity</div>';
      }
    }

    // Health summary
    var healthEl = document.getElementById('overviewHealthGrid');
    if (healthEl) {
      try {
        var docData = await api('doctor');
        var checks = docData.report ? docData.report.checks : [];
        var topChecks = checks.slice(0, 5);
        if (topChecks.length > 0) {
          healthEl.innerHTML = '<div class="health-card"><div class="health-grid">' + topChecks.map(function(ch) {
            var dotClass = ch.ok ? 'pass' : (ch.fatal ? 'fail' : 'warn');
            return '<div class="health-row">' +
              '<div class="health-dot ' + dotClass + '"></div>' +
              '<div class="health-name">' + esc(ch.name) + '</div>' +
              '<div class="health-value">' + esc(ch.detail) + '</div>' +
            '</div>';
          }).join('') + '</div></div>';
        } else {
          healthEl.innerHTML = '<div class="empty">No health checks</div>';
        }
      } catch(e4) {
        healthEl.innerHTML = '';
      }
    }

  } catch (e) {
    var metaEl2 = document.getElementById('headerMeta');
    if (metaEl2) metaEl2.textContent = 'Offline';
  }
}

function startStatusRefresh() {
  loadStatus();
  statusInterval = setInterval(loadStatus, 5000);
}

// --- History Tab (Audit Traces) ---
var historyTraces = [];
var historyOffset = 0;
var HISTORY_PAGE_SIZE = 50;

var TRIGGER_ICONS = {
  telegram: '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  cron: '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  discord: '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  code_agent: '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  code_team: '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  api: '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  system: '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9"/></svg>'
};

var TRIGGER_ICON_CLASS = {
  telegram: 'telegram', cron: 'cron', discord: 'telegram',
  code_agent: 'code', code_team: 'code', api: 'system', system: 'system'
};

function getTraceSummary(trace) {
  if (!trace.events || trace.events.length === 0) return 'No events';
  // Find first non-tool event, or first event summary
  for (var i = 0; i < trace.events.length; i++) {
    var ev = trace.events[i];
    if (ev.type === 'response' || ev.type === 'message') return ev.summary || '';
  }
  // Fallback: count tool uses
  var toolUses = trace.events.filter(function(e) { return e.type === 'tool_use'; }).length;
  var firstTool = trace.events[0];
  if (toolUses > 0) return toolUses + ' tool call' + (toolUses !== 1 ? 's' : '') + (firstTool ? ' \\u2014 ' + firstTool.summary.split('(')[0] : '');
  return trace.events[0].summary || '';
}

function formatTimeAgo(dateStr) {
  if (!dateStr) return '';
  var now = Date.now();
  var then = new Date(dateStr).getTime();
  var diffMs = now - then;
  var diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return diffMin + 'm ago';
  var diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return diffH + 'h ago';
  var diffD = Math.floor(diffH / 24);
  if (diffD === 1) return 'yesterday';
  if (diffD < 7) return diffD + 'd ago';
  return formatDate(dateStr);
}

async function loadHistory(append) {
  if (!append) {
    historyOffset = 0;
    historyTraces = [];
  }
  var triggerFilter = document.getElementById('historyTriggerFilter').value;
  var path = 'audit?limit=' + HISTORY_PAGE_SIZE + '&offset=' + historyOffset;
  if (triggerFilter) path += '&trigger=' + encodeURIComponent(triggerFilter);

  try {
    var data = await api(path);
    var list = document.getElementById('historyList');
    var countEl = document.getElementById('historyCount');
    var traces = data.traces || [];
    historyTraces = historyTraces.concat(traces);

    if (historyTraces.length === 0) {
      list.innerHTML = '<div style="padding:24px;" class="empty-state"><div class="empty-state-text">No activity found</div></div>';
      countEl.textContent = '0 traces';
      return;
    }

    countEl.textContent = (data.total || historyTraces.length) + ' total';

    var html = historyTraces.map(function(t) {
      var trigger = t.trigger || 'system';
      var iconClass = TRIGGER_ICON_CLASS[trigger] || 'system';
      var icon = TRIGGER_ICONS[trigger] || TRIGGER_ICONS.system;
      var summary = getTraceSummary(t);
      var evtCount = t.events ? t.events.length : 0;
      var statusDot = t.status === 'ok' ? '<span style="color:var(--success);">\\u25CF</span>' : '<span style="color:var(--error);">\\u25CF</span>';
      var dur = formatDuration(t.durationMs);

      return '<div class="list-item" data-trace-id="' + esc(t.traceId) + '">' +
        '<div style="display:flex;align-items:center;gap:10px;">' +
          '<div class="feed-icon ' + iconClass + '" style="width:32px;height:32px;font-size:14px;flex-shrink:0;">' + icon + '</div>' +
          '<div style="flex:1;min-width:0;">' +
            '<div class="list-item-title" style="display:flex;align-items:center;gap:6px;">' +
              statusDot + ' ' + esc(trigger) +
              '<span style="font-weight:400;color:var(--text-muted);font-size:12px;">' + evtCount + ' events \\u00B7 ' + dur + '</span>' +
            '</div>' +
            '<div class="list-item-meta" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(summary.slice(0, 80)) + '</div>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--text-muted);font-family:var(--mono);white-space:nowrap;">' + formatTimeAgo(t.startedAt) + '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    // Add load more if there are more
    if (data.total && historyOffset + traces.length < data.total) {
      html += '<div class="list-item" style="text-align:center;color:var(--accent);font-weight:500;cursor:pointer;" id="historyLoadMore">Load more...</div>';
    }

    list.innerHTML = html;

    // Attach click handlers
    list.querySelectorAll('.list-item[data-trace-id]').forEach(function(item) {
      item.addEventListener('click', function() { loadHistoryTrace(item.getAttribute('data-trace-id')); });
    });
    var loadMoreBtn = document.getElementById('historyLoadMore');
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', function() {
        historyOffset += HISTORY_PAGE_SIZE;
        loadHistory(true);
      });
    }
  } catch (e) {
    document.getElementById('historyList').innerHTML = '<div style="padding:24px;" class="empty-state"><div class="empty-state-text">Failed to load history</div></div>';
  }
}

function loadHistoryTrace(traceId) {
  // Highlight in list
  document.querySelectorAll('#historyList .list-item').forEach(function(i) {
    i.classList.toggle('active', i.getAttribute('data-trace-id') === traceId);
  });

  var trace = historyTraces.find(function(t) { return t.traceId === traceId; });
  var detail = document.getElementById('historyDetail');
  if (!trace) {
    detail.innerHTML = '<div class="empty-state"><div class="empty-state-text">Trace not found</div></div>';
    return;
  }

  var trigger = trace.trigger || 'system';
  var statusColor = trace.status === 'ok' ? 'var(--success)' : 'var(--error)';

  var html = '';
  // Header
  html += '<div style="margin-bottom:20px;">';
  html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">';
  html += '<span style="font-family:var(--serif);font-size:18px;font-weight:700;">' + esc(trigger) + '</span>';
  html += '<span class="badge-status ' + (trace.status === 'ok' ? 'completed' : 'failed') + '">' + esc(trace.status.toUpperCase()) + '</span>';
  html += '</div>';
  html += '<div style="font-size:12px;font-family:var(--mono);color:var(--text-muted);display:flex;gap:12px;flex-wrap:wrap;">';
  html += '<span>' + esc(trace.traceId) + '</span>';
  html += '<span>' + formatDuration(trace.durationMs) + '</span>';
  html += '<span>' + formatDate(trace.startedAt) + '</span>';
  if (trace.endedAt) html += '<span>\\u2192 ' + formatDate(trace.endedAt) + '</span>';
  html += '</div></div>';

  // Events timeline
  if (trace.events && trace.events.length > 0) {
    html += '<div style="font-family:var(--serif);font-size:16px;font-weight:700;margin-bottom:12px;">Events (' + trace.events.length + ')</div>';
    html += '<div style="display:flex;flex-direction:column;gap:2px;">';
    for (var i = 0; i < trace.events.length; i++) {
      var ev = trace.events[i];
      var evColor = ev.type === 'tool_use' ? 'var(--accent)' : ev.type === 'response' ? 'var(--success)' : 'var(--text-dim)';
      var evDur = ev.durationMs != null ? formatDuration(ev.durationMs) : '';
      html += '<div style="display:grid;grid-template-columns:80px 1fr auto;gap:8px;padding:8px 0;border-bottom:1px solid var(--border-light);align-items:start;">';
      html += '<span style="font-size:11px;font-weight:600;color:' + evColor + ';font-family:var(--mono);text-transform:uppercase;">' + esc(ev.type || '-') + '</span>';
      html += '<span style="font-size:13px;line-height:1.45;word-break:break-word;">' + esc(ev.summary || '') + '</span>';
      html += '<span style="font-size:11px;color:var(--text-muted);font-family:var(--mono);white-space:nowrap;">' + evDur + '</span>';
      html += '</div>';
    }
    html += '</div>';
  } else {
    html += '<div class="empty-state"><div class="empty-state-text">No events in this trace</div></div>';
  }

  detail.innerHTML = html;
}

document.getElementById('historyRefreshBtn').addEventListener('click', function() { loadHistory(false); });
document.getElementById('historyTriggerFilter').addEventListener('change', function() { loadHistory(false); });

// --- Memory Tab ---
async function loadMemory() {
  await populateAgentSelects();
  const agentId = document.getElementById('memoryAgentSelect').value;
  if (!agentId) return;
  try {
    const data = await api('memory/' + encodeURIComponent(agentId));
    const list = document.getElementById('memoryFileList');
    let items = '<div class="list-item" data-file="curated"><div class="list-item-title">MEMORY.md</div><div class="list-item-sub">Curated memory</div></div>';
    if (data.files && data.files.length > 0) {
      items += data.files.map(f =>
        '<div class="list-item" data-file="' + esc(f.name) + '">' +
        '<div class="list-item-title">' + esc(f.name) + '</div>' +
        '<div class="list-item-sub">' + (f.size ? formatSize(f.size) : '') + '</div>' +
        '</div>'
      ).join('');
    }
    list.innerHTML = items;
    list.querySelectorAll('.list-item').forEach(item => {
      item.addEventListener('click', () => loadMemoryFile(agentId, item.dataset.file));
    });
  } catch (e) {
    document.getElementById('memoryFileList').innerHTML = '<div class="empty">Failed to load memory files</div>';
  }
}

async function loadMemoryFile(agentId, filename) {
  document.querySelectorAll('#memoryFileList .list-item').forEach(i => {
    i.classList.toggle('active', i.dataset.file === filename);
  });
  const el = document.getElementById('memoryContent');
  try {
    const data = await api('memory/' + encodeURIComponent(agentId) + '/' + encodeURIComponent(filename));
    const content = data.content || '';
    const isMarkdown = filename === 'curated' || String(filename).toLowerCase().endsWith('.md');
    el.innerHTML = isMarkdown
      ? renderMarkdown(content)
      : '<pre style="white-space:pre-wrap;font-size:13px;line-height:1.6;">' + esc(content || '(empty)') + '</pre>';
  } catch (e) {
    el.innerHTML = '<div class="empty">Failed to load file</div>';
  }
}

// --- Cron Tab ---
async function loadCronJobs() {
  try {
    const data = await api('cron');
    const el = document.getElementById('cronJobs');
    if (!data.jobs || data.jobs.length === 0) {
      el.innerHTML = '<div class="empty">No cron jobs configured</div>';
      return;
    }
    el.innerHTML = data.jobs.map(j =>
      '<div class="card"><div class="cron-card">' +
      '<div class="cron-info">' +
      '<div class="cron-name">' + esc(j.name || j.id) + '</div>' +
      '<div class="cron-schedule">Schedule: ' + esc(j.schedule?.expr || '-') + (j.schedule?.tz ? ' (' + esc(j.schedule.tz) + ')' : '') + '</div>' +
      '<div class="cron-next">Next run: ' + formatDate(j.nextRun) + '</div>' +
      '</div>' +
      '<button class="btn btn-small" onclick="triggerCronJob(\\'' + esc(j.id) + '\\')">Run Now</button>' +
      '</div></div>'
    ).join('');
  } catch (e) {
    document.getElementById('cronJobs').innerHTML = '<div class="empty">Failed to load cron jobs</div>';
  }
}

async function triggerCronJob(id) {
  try {
    await api('cron/' + encodeURIComponent(id) + '/run', { method: 'POST' });
    showToast('Job triggered: ' + id);
  } catch (e) {
    showToast('Failed to trigger job: ' + e.message, 'error');
  }
}

// --- Model Tab ---
async function loadModel() {
  try {
    const data = await api('model');
    document.getElementById('currentModel').textContent = data.current || '-';

    const aliasEl = document.getElementById('modelAliases');
    if (data.aliases && Object.keys(data.aliases).length > 0) {
      aliasEl.innerHTML = '<table style="width:100%;font-size:13px;">' +
        Object.entries(data.aliases).map(([k, v]) =>
          '<tr><td style="padding:4px 8px;color:var(--highlight);">' + esc(k) + '</td><td style="padding:4px 8px;">' + esc(String(v)) + '</td></tr>'
        ).join('') + '</table>';
    } else {
      aliasEl.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:8px;">No aliases configured</div>';
    }

    const agentEl = document.getElementById('agentModels');
    if (data.agents && Object.keys(data.agents).length > 0) {
      agentEl.innerHTML = '<table style="width:100%;font-size:13px;">' +
        Object.entries(data.agents).map(([k, v]) =>
          '<tr><td style="padding:4px 8px;color:var(--success);">' + esc(k) + '</td><td style="padding:4px 8px;">' + esc(String(v || 'default')) + '</td></tr>'
        ).join('') + '</table>';
    } else {
      agentEl.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:8px;">No agents configured</div>';
    }
  } catch (e) {
    document.getElementById('currentModel').textContent = 'Error loading';
  }
}

document.getElementById('modelSwitchBtn').addEventListener('click', async () => {
  const model = document.getElementById('modelInput').value.trim();
  if (!model) return;
  try {
    await api('model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model })
    });
    showToast('Model switched to ' + model);
    document.getElementById('modelInput').value = '';
    loadModel();
  } catch (e) {
    showToast('Failed to switch model: ' + e.message, 'error');
  }
});

// --- Templates Tab ---
async function loadTemplates() {
  await populateAgentSelects();
  const agentId = document.getElementById('templateAgentSelect').value;
  if (!agentId) return;
  try {
    const data = await api('templates/' + encodeURIComponent(agentId));
    const list = document.getElementById('templateFileList');
    if (!data.templates || data.templates.length === 0) {
      list.innerHTML = '<div class="empty">No templates found</div>';
      return;
    }
    list.innerHTML = data.templates.map(t =>
      '<div class="list-item" data-name="' + esc(t.name) + '">' +
      '<div class="list-item-title">' + esc(t.name) + '</div>' +
      '<div class="list-item-sub">' + (t.exists ? formatSize(t.size) : 'Not created') + '</div>' +
      '</div>'
    ).join('');
    list.querySelectorAll('.list-item').forEach(item => {
      item.addEventListener('click', () => loadTemplate(agentId, item.dataset.name));
    });
  } catch (e) {
    document.getElementById('templateFileList').innerHTML = '<div class="empty">Failed to load templates</div>';
  }
}

async function loadTemplate(agentId, name) {
  currentTemplateFile = name;
  templateUnsaved = false;
  document.querySelectorAll('#templateFileList .list-item').forEach(i => {
    i.classList.toggle('active', i.dataset.name === name);
  });
  const el = document.getElementById('templateEditor');
  try {
    const data = await api('templates/' + encodeURIComponent(agentId) + '/' + encodeURIComponent(name));
    el.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
      '<div><strong>' + esc(name) + '</strong><span class="unsaved" id="unsavedIndicator" style="display:none;">unsaved changes</span></div>' +
      '<button class="btn btn-success btn-small" id="templateSaveBtn">Save</button>' +
      '</div>' +
      '<textarea id="templateTextarea" style="min-height:calc(100vh - 300px);">' + esc(data.content || '') + '</textarea>';
    document.getElementById('templateTextarea').addEventListener('input', () => {
      templateUnsaved = true;
      document.getElementById('unsavedIndicator').style.display = 'inline';
    });
    document.getElementById('templateSaveBtn').addEventListener('click', () => saveTemplate(agentId, name));
  } catch (e) {
    el.innerHTML = '<div class="empty">Failed to load template (may not exist yet)</div>';
  }
}

async function saveTemplate(agentId, name) {
  const content = document.getElementById('templateTextarea').value;
  try {
    await api('templates/' + encodeURIComponent(agentId) + '/' + encodeURIComponent(name), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    templateUnsaved = false;
    document.getElementById('unsavedIndicator').style.display = 'none';
    showToast('Template saved');
  } catch (e) {
    showToast('Failed to save: ' + e.message, 'error');
  }
}

// --- Logs Tab ---
async function loadLogFiles() {
  try {
    const data = await api('logs');
    const list = document.getElementById('logFileList');
    if (!data.files || data.files.length === 0) {
      list.innerHTML = '<div class="empty">No log files</div>';
      return;
    }
    list.innerHTML = data.files.map(f =>
      '<div class="list-item" data-name="' + esc(f.name) + '">' +
      '<div class="list-item-title">' + esc(f.name) + '</div>' +
      '<div class="list-item-sub">' + formatSize(f.size) + ' &middot; ' + formatDate(f.modified) + '</div>' +
      '</div>'
    ).join('');
    list.querySelectorAll('.list-item').forEach(item => {
      item.addEventListener('click', () => {
        currentLogFile = item.dataset.name;
        document.querySelectorAll('#logFileList .list-item').forEach(i => {
          i.classList.toggle('active', i.dataset.name === currentLogFile);
        });
        loadLogContent();
      });
    });
  } catch (e) {
    document.getElementById('logFileList').innerHTML = '<div class="empty">Failed to load logs</div>';
  }
}

async function loadLogContent() {
  if (!currentLogFile) return;
  const tailMode = document.getElementById('logTailMode').checked;
  const tailLines = document.getElementById('logTailLines').value;
  let path = 'logs/' + encodeURIComponent(currentLogFile);
  if (tailMode && tailLines) {
    path += '?tail=' + encodeURIComponent(tailLines);
  }
  try {
    const data = await api(path);
    document.getElementById('logContent').textContent = data.content || '(empty)';
    // Auto-scroll to bottom
    const viewer = document.getElementById('logContent');
    viewer.scrollTop = viewer.scrollHeight;
  } catch (e) {
    document.getElementById('logContent').textContent = 'Failed to load log';
  }
}

document.getElementById('logRefreshBtn').addEventListener('click', loadLogContent);
document.getElementById('logTailMode').addEventListener('change', loadLogContent);
document.getElementById('logAutoRefresh').addEventListener('change', (e) => {
  if (e.target.checked) {
    logAutoRefreshInterval = setInterval(loadLogContent, 3000);
  } else {
    clearInterval(logAutoRefreshInterval);
    logAutoRefreshInterval = null;
  }
});

// --- Coding Agent Tab (Multi-Agent) ---
let caPollingInterval = null;

function stopCaPolling() {
  if (caPollingInterval) {
    clearInterval(caPollingInterval);
    caPollingInterval = null;
  }
}

function startCaPolling() {
  loadCaAgents();
  stopCaPolling();
  caPollingInterval = setInterval(loadCaAgents, 3000);
}

async function loadCaAgents() {
  try {
    const data = await api('code-agents');
    renderCaAgents(data.agents || []);
  } catch {
    document.getElementById('caStatus').innerHTML =
      '<div class="empty">Failed to load coding agents</div>';
  }
}

function renderCaAgents(agents) {
  var el = document.getElementById('caStatus');
  if (!agents || agents.length === 0) {
    el.innerHTML = '<div class="empty">No coding agents have run yet.</div>';
    return;
  }

  // Save expanded states and scroll positions before re-rendering
  var expandedIds = new Set();
  var scrollPositions = {};
  var expandedTeammates = new Set();
  document.querySelectorAll('.audit-events.expanded').forEach(function(detailEl) {
    if (detailEl.id) {
      expandedIds.add(detailEl.id);
      var outputEl = detailEl.querySelector('.ca-output');
      if (outputEl) {
        scrollPositions[detailEl.id] = outputEl.scrollTop;
      }
    }
  });
  // Save expanded teammate panels
  document.querySelectorAll('[id^="tm-"]').forEach(function(tmEl) {
    if (tmEl.style.display !== 'none') {
      expandedTeammates.add(tmEl.id);
    }
  });

  // Build lookup for child tasks (parentTaskId → children)
  var childMap = {};
  for (var ci = 0; ci < agents.length; ci++) {
    if (agents[ci].parentTaskId) {
      if (!childMap[agents[ci].parentTaskId]) childMap[agents[ci].parentTaskId] = [];
      childMap[agents[ci].parentTaskId].push(agents[ci]);
    }
  }

  var html = '';
  for (var i = 0; i < agents.length; i++) {
    var a = agents[i];
    // Skip child tasks — they render under their parent
    if (a.parentTaskId) continue;
    var isActive = a.status === 'running' || a.status === 'validating';
    var spinner = isActive ? '<span class="ca-spinner"></span> ' : '';
    var secs = a.durationSeconds != null ? a.durationSeconds
      : Math.round((Date.now() - new Date(a.startedAt).getTime()) / 1000);
    var elapsed = secs < 60 ? secs + 's' : Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
    var taskPreview = (a.task || '').length > 80 ? a.task.slice(0, 80) + '...' : (a.task || '');
    var detailId = 'ca-detail-' + (a.id || '').replace(/[^a-zA-Z0-9]/g, '');
    var children = childMap[a.id] || [];
    var isTeam = a.agent === 'team-coordinator' && children.length > 0;

    // Wrap team-coordinator agents in a tree container
    if (isTeam) html += '<div class="ca-tree">';

    html += '<div class="audit-entry">';
    html += '<div class="audit-header">';
    html += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">';
    html += '<span class="audit-id">' + esc(a.id) + '</span>';
    html += '<span class="ca-status-badge ' + esc(a.status) + '">' + spinner + esc(a.status.toUpperCase()) + '</span>';
    if (a.agent === 'team-coordinator') {
      var childCount = (a.childTaskIds || []).length;
      html += '<span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;background:#7c3aed;color:#fff;">Team (' + childCount + ')</span>';
    } else if (a.agent) {
      html += '<span style="font-size:13px;color:var(--text-dim);">' + esc(a.agent) + '</span>';
    }
    html += '</div>';
    html += '<div class="audit-meta">';
    html += '<span>' + elapsed + '</span>';
    if (a.model) html += '<span>' + esc(a.model) + '</span>';
    if (a.startedAt) html += '<span>' + formatDate(a.startedAt) + '</span>';
    html += '</div>';
    html += '</div>';

    // Task preview
    if (taskPreview) {
      html += '<div class="audit-summary"><span>' + esc(taskPreview) + '</span></div>';
    }

    // Expandable details (meta info, full task, parent-level output/errors)
    var hasDetails = a.task || a.liveOutput || a.outputPreview || a.error || a.endedAt || a.validationPassed != null;
    if (hasDetails) {
      html += '<div class="audit-events-toggle" onclick="toggleCaDetail(\\'' + detailId + '\\', this)">\\u25B6 Details</div>';
      html += '<div class="audit-events" id="' + detailId + '">';

      // Meta details
      html += '<div class="ca-meta" style="margin-bottom:8px;">';
      if (a.startedAt) html += '<span>Started: ' + formatDate(a.startedAt) + '</span>';
      if (a.endedAt) html += '<span>Ended: ' + formatDate(a.endedAt) + '</span>';
      if (a.validationPassed != null) html += '<span>Tests: ' + (a.validationPassed ? 'PASS' : 'FAIL') + '</span>';
      if (a.workdir) html += '<span>Dir: ' + esc(a.workdir) + '</span>';
      html += '</div>';

      // Full task
      if (a.task) html += '<div class="ca-task">' + esc(a.task) + '</div>';

      // Output (parent-level) — skip for team coordinators since synthesis shows in tree
      if (!isTeam) {
        var output = a.liveOutput || a.outputPreview;
        if (output) html += '<div class="ca-output ca-output-md" style="margin-top:8px;">' + md(output) + '</div>';
      }
      if (a.error) html += '<div class="ca-output ca-error ca-output-md" style="margin-top:8px;">' + md(a.error) + '</div>';

      html += '</div>';
    }

    html += '</div>'; // end .audit-entry

    // Tree children — rendered OUTSIDE the root card, always visible
    if (isTeam) {
      html += '<div class="ca-tree-children">';
      html += '<div style="font-size:13px;font-weight:600;color:var(--text-dim);margin-bottom:8px;margin-top:8px;text-transform:uppercase;letter-spacing:0.04em;">Agents (' + children.length + ')</div>';

      for (var ch = 0; ch < children.length; ch++) {
        var child = children[ch];
        var childActive = child.status === 'running' || child.status === 'validating';
        var childIcon = child.status === 'running' ? '\\u{1F504}' : child.status === 'completed' ? '\\u2705' : child.status === 'failed' ? '\\u274C' : child.status === 'timeout' ? '\\u23F0' : child.status === 'validating' ? '\\u{1F50D}' : '\\u2B55';
        var childSecs = child.durationSeconds != null ? child.durationSeconds : Math.round((Date.now() - new Date(child.startedAt).getTime()) / 1000);
        var childElapsed = childSecs < 60 ? childSecs + 's' : Math.floor(childSecs / 60) + 'm ' + (childSecs % 60) + 's';
        var childSubtask = child.subtask || child.task || '';
        var childDetailId = 'tm-' + (a.id || '').replace(/[^a-zA-Z0-9]/g, '') + '-' + ch;
        var childBorderColor = child.status === 'completed' ? 'var(--success)' : child.status === 'failed' ? 'var(--error)' : child.status === 'timeout' ? 'var(--warning)' : 'var(--highlight)';

        html += '<div class="ca-tree-child" style="border-left:3px solid ' + childBorderColor + ';" onclick="toggleTeammate(\\'' + childDetailId + '\\')">';

        // Header row
        html += '<div style="display:flex;justify-content:space-between;align-items:center;">';
        html += '<div style="display:flex;align-items:center;gap:6px;">';
        html += '<span>' + childIcon + '</span>';
        html += '<span class="audit-id" style="font-size:13px;">' + esc(child.id) + '</span>';
        if (childActive) html += '<span class="ca-spinner"></span>';
        html += '<span style="color:var(--text-dim);font-size:13px;">' + childElapsed + '</span>';
        html += '</div>';
        html += '<span class="ca-status-badge ' + esc(child.status) + '" style="font-size:11px;padding:2px 8px;">' + esc(child.status.toUpperCase()) + '</span>';
        html += '</div>';

        // Subtask description
        html += '<div style="margin-top:4px;color:var(--text);">' + esc(childSubtask) + '</div>';

        // Expandable detail (output)
        html += '<div id="' + childDetailId + '" style="display:none;margin-top:8px;">';
        var childOutput = child.liveOutput || child.outputPreview;
        if (childOutput) html += '<div class="ca-output ca-output-md" style="font-size:13px;max-height:300px;overflow-y:auto;">' + md(childOutput) + '</div>';
        if (child.error) html += '<div class="ca-output ca-error ca-output-md" style="font-size:13px;margin-top:4px;">' + md(child.error) + '</div>';
        html += '</div>';

        html += '</div>'; // end .ca-tree-child
      }

      // Synthesis result — after children
      if (a.synthesisResult) {
        html += '<div style="margin-top:8px;padding:12px 16px;background:var(--surface-alt);border:1px solid var(--border);border-radius:8px;font-size:14px;max-height:400px;overflow-y:auto;">';
        html += '<div style="font-size:12px;font-weight:600;color:var(--text-dim);margin-bottom:4px;">SYNTHESIS</div>';
        html += '<div class="ca-output-md" style="word-break:break-word;">' + md(a.synthesisResult) + '</div>';
        html += '</div>';
      }

      html += '</div>'; // end .ca-tree-children
      html += '</div>'; // end .ca-tree
    }
  }

  el.innerHTML = html;

  // Restore expanded states and scroll positions
  expandedIds.forEach(function(id) {
    var detailEl = document.getElementById(id);
    if (detailEl) {
      detailEl.classList.add('expanded');
      var toggle = detailEl.previousElementSibling;
      if (toggle && toggle.classList.contains('audit-events-toggle')) {
        toggle.textContent = '\u25BC Details';
      }
      // Restore scroll position
      if (scrollPositions[id] !== undefined) {
        var outputEl = detailEl.querySelector('.ca-output');
        if (outputEl) {
          outputEl.scrollTop = scrollPositions[id];
        }
      }
    }
  });

  // Restore expanded teammate panels
  expandedTeammates.forEach(function(tmId) {
    var tmEl = document.getElementById(tmId);
    if (tmEl) tmEl.style.display = 'block';
  });

  // Auto-expand and auto-scroll live output for active agents
  for (var j = 0; j < agents.length; j++) {
    if (agents[j].status === 'running' || agents[j].status === 'validating') {
      // Auto-expand parent-level details
      var detailId2 = 'ca-detail-' + (agents[j].id || '').replace(/[^a-zA-Z0-9]/g, '');
      var detailEl = document.getElementById(detailId2);
      if (detailEl) {
        detailEl.classList.add('expanded');
        var toggle = detailEl.previousElementSibling;
        if (toggle && toggle.classList.contains('audit-events-toggle')) {
          toggle.textContent = '\\u25BC Details';
        }
        var outputEl = detailEl.querySelector('.ca-output');
        if (outputEl) outputEl.scrollTop = outputEl.scrollHeight;
      }
    }
  }
  // Auto-expand active children's output panels
  for (var k = 0; k < agents.length; k++) {
    if (agents[k].parentTaskId && (agents[k].status === 'running' || agents[k].status === 'validating')) {
      var parentId = (agents[k].parentTaskId || '').replace(/[^a-zA-Z0-9]/g, '');
      // Find the tm- panel for this child by scanning all panels under this parent
      var parentChildren = childMap[agents[k].parentTaskId] || [];
      for (var ci2 = 0; ci2 < parentChildren.length; ci2++) {
        if (parentChildren[ci2].id === agents[k].id) {
          var tmId = 'tm-' + parentId + '-' + ci2;
          var tmEl = document.getElementById(tmId);
          if (tmEl && tmEl.style.display === 'none') {
            tmEl.style.display = 'block';
          }
          if (tmEl) {
            var tmOutput = tmEl.querySelector('.ca-output');
            if (tmOutput) tmOutput.scrollTop = tmOutput.scrollHeight;
          }
          break;
        }
      }
    }
  }
}

function toggleCaDetail(id, toggleEl) {
  var el = document.getElementById(id);
  if (el) {
    var expanded = el.classList.toggle('expanded');
    if (toggleEl) {
      toggleEl.textContent = (expanded ? '\\u25BC' : '\\u25B6') + ' Details';
    }
  }
}

function toggleTeammate(id) {
  var el = document.getElementById(id);
  if (el) {
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  }
}

// Stop polling when leaving the page
var origOnPage = onPageActivated;
onPageActivated = function(page) {
  if (page !== 'coding') stopCaPolling();
  if (page !== 'approvals') stopApprovalsPolling();
  origOnPage(page);
};

// --- Audit Tab ---
let auditOffset = 0;
const AUDIT_PAGE_SIZE = 30;

function toggleAuditEvents(el, eventsId, count) {
  var eventsEl = document.getElementById(eventsId);
  var expanded = eventsEl.classList.toggle('expanded');
  el.textContent = (expanded ? '\\u25BC' : '\\u25B6') + ' Events (' + count + ')';
}

function formatDuration(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return (ms / 60000).toFixed(1) + 'm';
}

async function loadAudit(append) {
  if (!append) {
    auditOffset = 0;
    document.getElementById('auditEntries').innerHTML = '';
  }

  const triggerFilter = document.getElementById('auditTriggerFilter').value;
  let path = 'audit?limit=' + AUDIT_PAGE_SIZE + '&offset=' + auditOffset;
  if (triggerFilter) path += '&trigger=' + encodeURIComponent(triggerFilter);

  try {
    const data = await api(path);
    const el = document.getElementById('auditEntries');
    const countEl = document.getElementById('auditCount');
    const moreBtn = document.getElementById('auditLoadMoreBtn');

    if (!data.traces || data.traces.length === 0) {
      if (!append) {
        el.innerHTML = '<div class="empty">No audit traces found</div>';
      }
      countEl.textContent = 'Total: ' + (data.total || 0);
      moreBtn.style.display = 'none';
      return;
    }

    const html = data.traces.map(function(t) {
      const evtCount = t.events ? t.events.length : 0;
      const traceId = t.traceId || '-';
      const eventsId = 'evt-' + traceId.replace(/[^a-zA-Z0-9]/g, '');

      var eventsHtml = '';
      if (t.events && t.events.length > 0) {
        eventsHtml = '<div class="audit-events-toggle" onclick="toggleAuditEvents(this, \\'' + eventsId + '\\', ' + evtCount + ')">\\u25B6 Events (' + evtCount + ')</div>' +
          '<div class="audit-events" id="' + eventsId + '">' +
          t.events.map(function(ev) {
            return '<div class="audit-event">' +
              '<span class="audit-event-type">' + esc(ev.type || '-') + '</span>' +
              '<span class="audit-event-summary">' + esc(ev.summary || '') + '</span>' +
              '<span class="audit-event-duration">' + formatDuration(ev.durationMs) + '</span>' +
            '</div>';
          }).join('') +
          '</div>';
      }

      return '<div class="audit-entry">' +
        '<div class="audit-header">' +
          '<div style="display:flex;gap:8px;align-items:center;">' +
            '<span class="audit-id">' + esc(traceId) + '</span>' +
            '<span class="audit-trigger ' + esc(t.trigger || '') + '">' + esc(t.trigger || '-') + '</span>' +
            '<span class="audit-badge ' + esc(t.status || '') + '">' + esc(t.status || '-') + '</span>' +
          '</div>' +
          '<div class="audit-meta">' +
            '<span>' + formatDuration(t.durationMs) + '</span>' +
            '<span>' + evtCount + ' event' + (evtCount !== 1 ? 's' : '') + '</span>' +
            '<span>' + formatDate(t.startedAt || t.endedAt) + '</span>' +
          '</div>' +
        '</div>' +
        eventsHtml +
      '</div>';
    }).join('');

    if (append) {
      el.innerHTML += html;
    } else {
      el.innerHTML = html;
    }

    countEl.textContent = 'Showing ' + (auditOffset + data.traces.length) + ' of ' + data.total;
    auditOffset += data.traces.length;
    moreBtn.style.display = auditOffset < data.total ? '' : 'none';
  } catch (e) {
    if (!append) {
      document.getElementById('auditEntries').innerHTML = '<div class="empty">Failed to load audit log</div>';
    }
  }
}

document.getElementById('auditRefreshBtn').addEventListener('click', function() { loadAudit(false); });
document.getElementById('auditTriggerFilter').addEventListener('change', function() { loadAudit(false); });
document.getElementById('auditLoadMoreBtn').addEventListener('click', function() { loadAudit(true); });

// --- Config Tab ---
async function loadConfig() {
  try {
    const data = await api('config');
    document.getElementById('configEditor').value = JSON.stringify(data.config, null, 2);
    document.getElementById('configStatus').textContent = '';
  } catch (e) {
    document.getElementById('configStatus').textContent = 'Failed to load config';
    document.getElementById('configStatus').style.color = 'var(--error)';
  }
}

document.getElementById('configValidateBtn').addEventListener('click', () => {
  const statusEl = document.getElementById('configStatus');
  try {
    const parsed = JSON.parse(document.getElementById('configEditor').value);
    if (!parsed.gateway || !parsed.agents || !parsed.models || !parsed.cron) {
      statusEl.textContent = 'Missing required sections';
      statusEl.style.color = 'var(--error)';
      return;
    }
    statusEl.textContent = 'Valid JSON';
    statusEl.style.color = 'var(--success)';
  } catch (e) {
    statusEl.textContent = 'Invalid JSON: ' + e.message;
    statusEl.style.color = 'var(--error)';
  }
});

document.getElementById('configSaveBtn').addEventListener('click', async () => {
  if (!confirm('Save configuration? A restart will be required for changes to take effect.')) return;
  const statusEl = document.getElementById('configStatus');
  try {
    const parsed = JSON.parse(document.getElementById('configEditor').value);
    await api('config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: parsed })
    });
    statusEl.textContent = 'Saved';
    statusEl.style.color = 'var(--success)';
    showToast('Configuration saved');
  } catch (e) {
    statusEl.textContent = 'Save failed: ' + e.message;
    statusEl.style.color = 'var(--error)';
    showToast('Failed to save config', 'error');
  }
});

// --- Agent selector helpers ---
async function populateAgentSelects() {
  if (agentList.length > 0) return;
  try {
    const data = await api('model');
    if (data.agents) {
      agentList = Object.keys(data.agents);
    }
  } catch (e) {
    agentList = [];
  }

  [document.getElementById('memoryAgentSelect'), document.getElementById('templateAgentSelect')].forEach(sel => {
    if (sel.children.length > 0) return;
    agentList.forEach(id => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      sel.appendChild(opt);
    });
  });
}

document.getElementById('memoryAgentSelect').addEventListener('change', loadMemory);
document.getElementById('templateAgentSelect').addEventListener('change', loadTemplates);

// --- Digests Tab ---
async function loadDigests() {
  try {
    const data = await api('digests');
    const list = document.getElementById('digestList');
    if (!data.digests || data.digests.length === 0) {
      list.innerHTML = '<div class="empty">No digests found</div>';
      document.getElementById('digestDetail').innerHTML = '<div class="empty">Select a digest to view articles</div>';
      return;
    }
    list.innerHTML = data.digests.map(d =>
      '<div class="list-item" data-id="' + esc(d.id) + '">' +
      '<div class="list-item-title">' + esc(d.jobName) + '</div>' +
      '<div class="list-item-sub">' + d.articleCount + ' articles &middot; ' + formatDate(d.createdAt) + '</div>' +
      '</div>'
    ).join('');

    list.querySelectorAll('.list-item').forEach(item => {
      item.addEventListener('click', () => loadDigestDetail(item.dataset.id));
    });
  } catch (e) {
    document.getElementById('digestList').innerHTML = '<div class="empty">Failed to load digests</div>';
  }
}

function extractTitleFromUrl(url) {
  try {
    var u = new URL(url);
    var p = u.pathname.replace(/\\/+$/, '');
    var segs = p.split('/').filter(Boolean);

    // Reddit: /r/sub/comments/id/title_slug
    if (u.hostname.includes('reddit.com') && segs.length >= 5) {
      return decodeURIComponent((segs[4] || segs[segs.length - 1]).replace(/_/g, ' '));
    }
    // GitHub: /owner/repo
    if (u.hostname === 'github.com' && segs.length >= 2) {
      return segs[0] + '/' + segs[1];
    }
    // HN
    if (u.hostname === 'news.ycombinator.com') {
      var id = u.searchParams.get('id');
      return id ? 'Hacker News #' + id : 'Hacker News';
    }
    // X/Twitter
    if (u.hostname === 'x.com' || u.hostname === 'twitter.com') {
      if (segs.length >= 1) return '@' + segs[0];
    }
    // General
    var last = segs.pop() || '';
    var decoded = decodeURIComponent(last.replace(/[-_]/g, ' ')).trim();
    return decoded.length > 0 ? decoded : u.hostname;
  } catch(e) {
    return url;
  }
}

function formatDigestContent(text) {
  return renderMarkdown(text || '');
}

async function loadDigestDetail(id) {
  document.querySelectorAll('#digestList .list-item').forEach(i => {
    i.classList.toggle('active', i.dataset.id === id);
  });
  const detail = document.getElementById('digestDetail');
  try {
    const data = await api('digests/' + encodeURIComponent(id));
    const digest = data;

    let html = '<div class="digest-header">';
    html += '<div class="digest-title">' + esc(digest.jobName) + '</div>';
    html += '<div class="digest-meta">' + formatDate(digest.createdAt);
    if (digest.articles && digest.articles.length > 0) {
      html += ' &middot; ' + digest.articles.length + ' links extracted';
    }
    html += '</div></div>';

    // Use reader view for full summaries, article cards for truncated/missing ones
    var hasFull = digest.summary && digest.summary.length > 1000;
    if (hasFull) {
      html += '<div class="digest-reader">' + formatDigestContent(digest.summary) + '</div>';
    } else if (digest.articles && digest.articles.length > 0) {
      html += '<div class="digest-articles">';
      digest.articles.forEach(function(a) {
        var title = a.title;
        // If title looks like a bare URL, extract something readable
        if (/^https?:\\/\\//.test(title)) {
          title = extractTitleFromUrl(title);
        }
        var badge = '<span class="source-badge">' + esc(a.source) + '</span>';
        var stats = '';
        if (a.score != null) stats += '⬆️ ' + a.score;
        if (a.comments != null) stats += (stats ? ' · ' : '') + '💬 ' + a.comments;
        html += '<div class="digest-article-card">' +
          badge +
          '<a href="' + esc(a.url) + '" target="_blank" rel="noopener" class="article-title">' + esc(title) + '</a>' +
          (stats ? '<div class="article-stats">' + stats + '</div>' : '') +
          '</div>';
      });
      html += '</div>';
    } else {
      html += '<div class="empty">No content in this digest</div>';
    }

    detail.innerHTML = html;
  } catch (e) {
    detail.innerHTML = '<div class="empty">Failed to load digest</div>';
  }
}


// --- Skills Tab ---
async function loadSkills() {
  try {
    const data = await api('skills');
    const el = document.getElementById('skillsList');
    const countEl = document.getElementById('skillsCount');
    const skills = data.skills || [];

    countEl.textContent = skills.length + ' skill' + (skills.length !== 1 ? 's' : '');

    if (skills.length === 0) {
      el.innerHTML = '<div class="empty">No skills found. Create one or add SKILL.md files to ~/.skimpyclaw/skills/</div>';
      return;
    }

    el.innerHTML = skills.map(function(s) {
      var emoji = s.emoji || '\\u{1F527}';
      var statusBadge = '';
      if (!s.eligible) {
        statusBadge = '<span class="audit-badge error">\\u274C ' + esc(s.reason || 'ineligible') + '</span>';
      } else if (!s.enabled) {
        statusBadge = '<span class="audit-badge" style="background:rgba(176,124,26,0.16);color:var(--warning);">\\u26A0\\uFE0F disabled</span>';
      } else {
        statusBadge = '<span class="audit-badge ok">\\u2705 eligible</span>';
      }

      var tags = s.tags && s.tags.length > 0
        ? s.tags.map(function(t) { return '<span style="background:var(--surface-alt);padding:2px 6px;border-radius:4px;font-size:11px;color:var(--text-dim);">' + esc(t) + '</span>'; }).join(' ')
        : '';

      return '<div class="audit-entry" style="cursor:pointer;" data-skill="' + esc(s.name) + '">' +
        '<div class="audit-header">' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
            '<span style="font-size:18px;">' + emoji + '</span>' +
            '<span class="audit-id">' + esc(s.name) + '</span>' +
            statusBadge +
            (tags ? '<span style="display:flex;gap:4px;">' + tags + '</span>' : '') +
          '</div>' +
          '<div style="display:flex;gap:8px;align-items:center;">' +
            '<button class="btn btn-small" onclick="event.stopPropagation();toggleSkill(\\'' + esc(s.name) + '\\',' + (s.enabled ? 'false' : 'true') + ')">' +
              (s.enabled ? 'Disable' : 'Enable') +
            '</button>' +
            '<button class="btn btn-small btn-danger" onclick="event.stopPropagation();deleteSkill(\\'' + esc(s.name) + '\\')">Delete</button>' +
          '</div>' +
        '</div>' +
        '<div class="audit-summary"><span>' + esc(s.description || 'No description') + '</span></div>' +
      '</div>';
    }).join('');

    el.querySelectorAll('.audit-entry[data-skill]').forEach(function(entry) {
      entry.addEventListener('click', function() {
        loadSkillDetail(entry.getAttribute('data-skill'));
      });
    });
  } catch (e) {
    document.getElementById('skillsList').innerHTML = '<div class="empty">Failed to load skills</div>';
  }
}

async function loadSkillDetail(name) {
  var el = document.getElementById('skillDetail');
  try {
    var data = await api('skills/' + encodeURIComponent(name));
    el.style.display = 'block';
    el.innerHTML = '<div class="card">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
        '<div><span style="font-size:20px;">' + (data.emoji || '\\u{1F527}') + '</span> <strong style="font-size:18px;">' + esc(data.name) + '</strong></div>' +
        '<button class="btn btn-small" onclick="document.getElementById(\\'skillDetail\\').style.display=\\'none\\'">Close</button>' +
      '</div>' +
      '<div style="margin-bottom:8px;color:var(--text-dim);">' + esc(data.description || '') + '</div>' +
      '<div style="display:flex;gap:12px;margin-bottom:12px;font-size:13px;font-family:var(--mono);color:var(--text-dim);">' +
        '<span>Priority: ' + (data.priority || 100) + '</span>' +
        '<span>Eligible: ' + (data.eligible ? 'Yes' : 'No') + '</span>' +
        '<span>Enabled: ' + (data.enabled ? 'Yes' : 'No') + '</span>' +
      '</div>' +
      (data.requires ? '<div style="margin-bottom:8px;font-size:13px;"><strong>Requires:</strong> <code>' + esc(JSON.stringify(data.requires)) + '</code></div>' : '') +
      (data.contexts ? '<div style="margin-bottom:8px;font-size:13px;"><strong>Contexts:</strong> <code>' + esc(JSON.stringify(data.contexts)) + '</code></div>' : '') +
      '<div style="margin-top:12px;"><strong>Content:</strong></div>' +
      '<pre style="white-space:pre-wrap;font-size:13px;line-height:1.6;background:var(--surface-alt);padding:12px;border-radius:8px;margin-top:6px;max-height:400px;overflow-y:auto;">' + esc(data.body || '(empty)') + '</pre>' +
    '</div>';
  } catch (e) {
    el.style.display = 'block';
    el.innerHTML = '<div class="empty">Failed to load skill details</div>';
  }
}

async function toggleSkill(name, enabled) {
  try {
    await api('skills/' + encodeURIComponent(name), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled })
    });
    showToast('Skill ' + name + ' ' + (enabled ? 'enabled' : 'disabled'));
    loadSkills();
  } catch (e) {
    showToast('Failed to update skill: ' + e.message, 'error');
  }
}

async function deleteSkill(name) {
  if (!confirm('Delete skill "' + name + '"? This cannot be undone.')) return;
  try {
    await api('skills/' + encodeURIComponent(name), { method: 'DELETE' });
    showToast('Skill deleted: ' + name);
    document.getElementById('skillDetail').style.display = 'none';
    loadSkills();
  } catch (e) {
    showToast('Failed to delete skill: ' + e.message, 'error');
  }
}

document.getElementById('skillsRefreshBtn').addEventListener('click', loadSkills);
document.getElementById('skillsCreateBtn').addEventListener('click', function() {
  document.getElementById('skillsCreateForm').style.display = 'block';
  document.getElementById('skillNameInput').value = '';
  document.getElementById('skillContentInput').value = '';
});
document.getElementById('skillCancelCreateBtn').addEventListener('click', function() {
  document.getElementById('skillsCreateForm').style.display = 'none';
});
document.getElementById('skillSaveNewBtn').addEventListener('click', async function() {
  var name = document.getElementById('skillNameInput').value.trim();
  var content = document.getElementById('skillContentInput').value;
  if (!name) { showToast('Skill name required', 'error'); return; }
  if (!content) { showToast('Content required', 'error'); return; }
  try {
    await api('skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, content: content })
    });
    showToast('Skill created: ' + name);
    document.getElementById('skillsCreateForm').style.display = 'none';
    loadSkills();
  } catch (e) {
    showToast('Failed to create skill: ' + e.message, 'error');
  }
});

// --- Approvals Tab ---
let approvalsInterval = null;

function stopApprovalsPolling() {
  if (approvalsInterval) {
    clearInterval(approvalsInterval);
    approvalsInterval = null;
  }
}

function startApprovalsPolling() {
  loadApprovals();
  stopApprovalsPolling();
  if (document.getElementById('approvalsAutoRefresh').checked) {
    approvalsInterval = setInterval(loadApprovals, 5000);
  }
}

function formatCountdown(expiresAt, serverNow) {
  var now = serverNow ? new Date(serverNow).getTime() : Date.now();
  var exp = new Date(expiresAt).getTime();
  var remaining = Math.max(0, Math.round((exp - now) / 1000));
  if (remaining <= 0) return '<span class="approval-countdown">expired</span>';
  var m = Math.floor(remaining / 60);
  var s = remaining % 60;
  var cls = remaining < 60 ? 'approval-countdown urgent' : 'approval-countdown';
  return '<span class="' + cls + '">' + m + ':' + (s < 10 ? '0' : '') + s + '</span>';
}

async function loadApprovals() {
  try {
    var data = await api('approvals');
    var pending = data.pending || [];
    var recent = (data.recent || []).filter(function(a) { return a.status !== 'pending'; });
    var serverNow = data.now;

    var pendingEl = document.getElementById('approvalsPending');
    var recentEl = document.getElementById('approvalsRecent');
    var countEl = document.getElementById('approvalsCount');

    countEl.textContent = pending.length + ' pending';

    if (pending.length === 0) {
      pendingEl.innerHTML = '<div class="empty">No pending approvals</div>';
    } else {
      var html = '';
      for (var i = 0; i < pending.length; i++) {
        var a = pending[i];
        html += '<div class="audit-entry">';
        html += '<div class="audit-header">';
        html += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">';
        html += '<span class="audit-id">' + esc(a.id) + '</span>';
        html += '<span class="approval-tier tier-' + a.tier + '">TIER ' + a.tier + '</span>';
        html += '<span class="approval-status pending">PENDING</span>';
        html += formatCountdown(a.expiresAt, serverNow);
        html += '</div>';
        html += '<div class="audit-meta">';
        html += '<span>' + esc(a.reason) + '</span>';
        if (a.cwd) html += '<span>' + esc(a.cwd) + '</span>';
        html += '<span>' + formatDate(a.createdAt) + '</span>';
        html += '</div>';
        html += '</div>';
        html += '<div class="approval-command">' + esc(a.command) + '</div>';
        html += '<div class="approval-actions">';
        html += '<button class="btn btn-success btn-small" onclick="approveApproval(&#39;' + esc(a.id) + '&#39;)">Approve</button>';
        html += '<button class="btn btn-small" style="background:var(--error);color:#fff;border-color:var(--error);" onclick="denyApproval(&#39;' + esc(a.id) + '&#39;)">Deny</button>';
        html += '</div>';
        html += '</div>';
      }
      pendingEl.innerHTML = html;
    }

    if (recent.length === 0) {
      recentEl.innerHTML = '<div class="empty">No recent approvals</div>';
    } else {
      var rhtml = '';
      for (var j = 0; j < recent.length; j++) {
        var r = recent[j];
        rhtml += '<div class="audit-entry">';
        rhtml += '<div class="audit-header">';
        rhtml += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">';
        rhtml += '<span class="audit-id">' + esc(r.id) + '</span>';
        rhtml += '<span class="approval-tier tier-' + r.tier + '">TIER ' + r.tier + '</span>';
        rhtml += '<span class="approval-status ' + esc(r.status) + '">' + esc(r.status).toUpperCase() + '</span>';
        rhtml += '</div>';
        rhtml += '<div class="audit-meta">';
        rhtml += '<span>' + esc(r.reason) + '</span>';
        if (r.resolvedAt) rhtml += '<span>' + formatDate(r.resolvedAt) + '</span>';
        if (r.approvedBy) rhtml += '<span>by ' + esc(r.approvedBy) + '</span>';
        if (r.deniedBy) rhtml += '<span>by ' + esc(r.deniedBy) + '</span>';
        rhtml += '</div>';
        rhtml += '</div>';
        rhtml += '<div class="approval-command">' + esc(r.command) + '</div>';
        rhtml += '</div>';
      }
      recentEl.innerHTML = rhtml;
    }
  } catch (e) {
    document.getElementById('approvalsPending').innerHTML = '<div class="empty">Failed to load approvals</div>';
  }
}

async function approveApproval(id) {
  try {
    await api('approvals/' + id + '/approve', { method: 'POST' });
    showToast('Approved: ' + id);
    loadApprovals();
  } catch (e) {
    showToast('Failed to approve: ' + e.message, 'error');
  }
}

async function denyApproval(id) {
  try {
    await api('approvals/' + id + '/deny', { method: 'POST' });
    showToast('Denied: ' + id);
    loadApprovals();
  } catch (e) {
    showToast('Failed to deny: ' + e.message, 'error');
  }
}

document.getElementById('approvalsRefreshBtn').addEventListener('click', function() { loadApprovals(); });
document.getElementById('approvalsAutoRefresh').addEventListener('change', function() {
  if (this.checked) {
    startApprovalsPolling();
  } else {
    stopApprovalsPolling();
  }
});

// --- Health Tab (unified: diagnostics + environment + features) ---
const DOCTOR_CATEGORY_LABELS = {
  environment: 'Environment',
  configuration: 'Configuration',
  provider_auth: 'Provider Auth',
  channels: 'Channels',
  runtime: 'Runtime',
};
const DOCTOR_CATEGORY_ORDER = ['environment', 'configuration', 'provider_auth', 'channels', 'runtime'];

async function loadHealth() {
  const summaryEl = document.getElementById('doctorSummary');
  const categoriesEl = document.getElementById('doctorCategories');
  const tsEl = document.getElementById('doctorTimestamp');
  const envEl = document.getElementById('healthEnvVars');
  const featEl = document.getElementById('healthFeatures');
  try {
    const [doctorData, healthData] = await Promise.all([api('doctor'), api('health')]);
    const report = doctorData.report;

    // Timestamp
    if (tsEl) {
      const started = new Date(report.startedAt);
      const finished = new Date(report.finishedAt);
      const durationMs = finished - started;
      tsEl.textContent = 'Ran ' + finished.toLocaleTimeString() + ' (' + durationMs + 'ms)';
    }

    // Summary banner
    const total = report.checks.length;
    const passed = report.checks.filter(c => c.ok).length;
    const failed = report.checks.filter(c => !c.ok && c.fatal).length;
    const warned = report.checks.filter(c => !c.ok && !c.fatal).length;
    const overallColor = report.ok ? 'var(--success)' : (failed > 0 ? 'var(--error)' : 'var(--warning, #f59e0b)');
    const overallLabel = report.ok ? 'All checks passed' : (failed > 0 ? 'Fatal issues found' : 'Warnings detected');
    summaryEl.innerHTML =
      '<div style="display:flex;gap:24px;align-items:center;padding:8px 0;">' +
        '<span style="font-size:18px;font-weight:700;color:' + overallColor + ';">' + esc(overallLabel) + '</span>' +
        '<span style="font-size:13px;color:var(--text-dim);">' +
          '<span style="color:var(--success);font-weight:600;">' + passed + '</span> pass · ' +
          (warned > 0 ? '<span style="color:var(--warning, #f59e0b);font-weight:600;">' + warned + '</span> warn · ' : '') +
          (failed > 0 ? '<span style="color:var(--error);font-weight:600;">' + failed + '</span> fail · ' : '') +
          total + ' total' +
        '</span>' +
        '<span style="font-size:12px;color:var(--text-dim);">exit ' + report.exitCode + '</span>' +
      '</div>';

    // Group checks by category
    const grouped = {};
    for (const cat of DOCTOR_CATEGORY_ORDER) grouped[cat] = [];
    for (const ch of report.checks) {
      if (!grouped[ch.category]) grouped[ch.category] = [];
      grouped[ch.category].push(ch);
    }

    let html = '';
    for (const cat of DOCTOR_CATEGORY_ORDER) {
      const checks = grouped[cat];
      if (!checks || checks.length === 0) continue;
      const catLabel = DOCTOR_CATEGORY_LABELS[cat] || cat;
      const catPassed = checks.every(c => c.ok);
      const catIcon = catPassed ? '<span style="color:var(--success);">●</span>' : '<span style="color:var(--error);">●</span>';
      html += '<div class="card" style="margin-bottom:12px;">';
      html += '<div class="card-title">' + catIcon + ' ' + esc(catLabel) + '</div>';
      html += '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
      html += '<tr style="border-bottom:1px solid var(--border);">' +
        '<th style="text-align:left;padding:6px;">Check</th>' +
        '<th style="text-align:left;padding:6px;width:60px;">Status</th>' +
        '<th style="text-align:left;padding:6px;">Detail</th>' +
        '<th style="text-align:left;padding:6px;">Remedy</th>' +
      '</tr>';
      for (const ch of checks) {
        const isFatal = !ch.ok && ch.fatal;
        const color = ch.ok ? 'var(--success)' : 'var(--error)';
        const status = ch.ok ? 'PASS' : (isFatal ? 'FAIL' : 'WARN');
        html += '<tr style="border-bottom:1px solid var(--border);">';
        html += '<td style="padding:6px;font-family:var(--mono);font-size:12px;">' + esc(ch.name) + '</td>';
        html += '<td style="padding:6px;color:' + color + ';font-weight:600;">' + status + '</td>';
        html += '<td style="padding:6px;color:var(--text-dim);font-size:12px;">' + esc(ch.detail) + '</td>';
        html += '<td style="padding:6px;color:var(--text-dim);font-size:12px;">' + (ch.remedy ? esc(ch.remedy) : '') + '</td>';
        html += '</tr>';
      }
      html += '</table></div>';
    }
    categoriesEl.innerHTML = html;

    // Render env vars
    if (healthData.envVars && healthData.envVars.length > 0) {
      let envHtml = '<div style="font-size:13px;">';
      for (const ev of healthData.envVars) {
        const icon = ev.set ? '<span style="color:var(--success);">●</span>' : '<span style="color:var(--error);">○</span>';
        const label = ev.set ? 'set' : 'missing';
        envHtml += '<div style="padding:4px 0;display:flex;justify-content:space-between;border-bottom:1px solid var(--border);">';
        envHtml += '<span style="font-family:var(--mono);font-size:12px;">' + icon + ' ' + esc(ev.name) + '</span>';
        envHtml += '<span style="color:var(--text-dim);font-size:12px;">' + label + '</span>';
        envHtml += '</div>';
      }
      envHtml += '</div>';
      envEl.innerHTML = envHtml;
    } else {
      envEl.innerHTML = '<span style="color:var(--text-dim);">No env var references found</span>';
    }

    // Render features
    if (healthData.features) {
      let featHtml = '<div style="font-size:13px;">';
      for (const [name, enabled] of Object.entries(healthData.features)) {
        const icon = enabled ? '<span style="color:var(--success);">✓</span>' : '<span style="color:var(--text-dim);">✗</span>';
        featHtml += '<div style="padding:4px 0;border-bottom:1px solid var(--border);">' + icon + ' ' + esc(name) + '</div>';
      }
      featHtml += '</div>';
      featEl.innerHTML = featHtml;
    }
  } catch (err) {
    summaryEl.innerHTML = '<span style="color:var(--error);">Failed to load health data: ' + esc(err.message) + '</span>';
    categoriesEl.innerHTML = '';
  }
}

document.getElementById('healthRecheckBtn')?.addEventListener('click', () => loadHealth());

// --- Init ---
switchPage('overview');
</script>
</body>
</html>`;
