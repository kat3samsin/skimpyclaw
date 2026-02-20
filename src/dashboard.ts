// Dashboard frontend - serves the single-page dashboard UI

import { FastifyInstance } from 'fastify';

export function registerDashboard(fastify: FastifyInstance): void {
  fastify.get('/dashboard', async (_request, reply) => {
    reply.type('text/html').send(DASHBOARD_HTML);
  });
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>SkimpyClaw 👙🦞 Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/marked/lib/marked.umd.min.js"></script>
<style>
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

:root,
[data-theme="light"] {
  --bg: #ffffff;
  --surface: #ffffff;
  --surface-alt: #f0f2f5;
  --text: #161b22;
  --text-dim: #646d78;
  --accent: #111826;
  --highlight: #2c68f6;
  --success: #0f9c66;
  --warning: #b07c1a;
  --error: #ca3d4f;
  --border: #e3e6ea;
  --mono: 'JetBrains Mono', monospace;
  --sans: 'Manrope', 'Avenir Next', sans-serif;
}

[data-theme="dark"] {
  --bg: #12161b;
  --surface: #1a2028;
  --surface-alt: #232b36;
  --text: #edf1f6;
  --text-dim: #9cabbd;
  --accent: #f2f5fb;
  --highlight: #78a4ff;
  --success: #3bc98b;
  --warning: #d4a54f;
  --error: #e26f7d;
  --border: #2f3744;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: var(--sans);
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  font-size: 15px;
  font-weight: 400;
}

a { color: var(--highlight); text-decoration: none; }
a:hover { text-decoration: underline; }

.header {
  position: sticky;
  top: 0;
  z-index: 100;
  height: 64px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 0 26px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header h1 {
  font-size: 30px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.01em;
}

.header-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
}

.status-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--success);
  display: inline-block;
}

.status-dot.error { background: var(--error); }

.theme-toggle {
  border: 1px solid var(--border);
  background: var(--surface-alt);
  border-radius: 999px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text);
  transition: background 0.18s ease, border-color 0.18s ease;
}

.theme-toggle:hover {
  border-color: var(--text-dim);
  background: var(--surface);
}

.app-shell {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  min-height: calc(100vh - 64px);
}

.tabs {
  position: sticky;
  top: 64px;
  align-self: start;
  height: calc(100vh - 64px);
  overflow-y: auto;
  background: var(--surface-alt);
  border-right: 1px solid var(--border);
  padding: 16px 10px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.tab-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tab-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px 4px;
  font-size: 16px;
  font-weight: 600;
  color: #1f2937;
}

[data-theme="dark"] .tab-group-header {
  color: #d8e0ea;
}

.tab-group-title {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  line-height: 1;
}

.tab-group-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  font-size: 18px;
  line-height: 1;
  transform: translateY(-1px);
}

.tab-group-chevron {
  color: var(--text-dim);
  font-size: 12px;
}

.tab-static {
  margin: 2px 4px;
  padding: 9px 14px;
  border-radius: 10px;
  color: var(--text-dim);
  font-size: 13px;
  font-weight: 500;
}

.tab {
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: #8f96a1;
  font-family: var(--sans);
  font-size: 16px;
  font-weight: 500;
  padding: 9px 14px;
  margin: 2px 4px;
  text-align: left;
  cursor: pointer;
  transition: background 0.18s ease, border-color 0.18s ease, color 0.18s ease;
}

.tab:hover {
  background: #e6e8ec;
  color: var(--text);
  border-color: #e6e8ec;
}

[data-theme="dark"] .tab:hover {
  background: #2c3440;
  color: #ffffff;
  border-color: #2c3440;
}

.tab.active {
  background: #e6e8ec;
  color: #0f172a;
  border-color: #e6e8ec;
}

[data-theme="dark"] .tab.active {
  background: #2c3440;
  color: #ffffff;
  border-color: #2c3440;
}

.content {
  padding: 24px 30px 34px;
}

.tab-panel { display: none; }
.tab-panel.active { display: block; }

.section-title {
  font-size: 26px;
  font-weight: 600;
  letter-spacing: 0.01em;
  margin-bottom: 14px;
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 18px;
  margin-bottom: 14px;
}

.card-title {
  font-size: 14px;
  color: var(--text-dim);
  margin-bottom: 8px;
  font-weight: 500;
}

.card-value {
  font-size: 30px;
  font-weight: 600;
  line-height: 1.2;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}

.split {
  display: grid;
  grid-template-columns: minmax(260px, 330px) minmax(0, 1fr);
  gap: 14px;
  height: calc(100vh - 164px);
}

.split-list,
.split-detail {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
}

.split-list { overflow-y: auto; overflow-x: hidden; }
.split-detail { overflow-y: auto; padding: 16px; }

.list-item {
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  font-size: 15px;
  transition: background 0.18s ease;
}

.list-item:hover { background: var(--surface-alt); }
.list-item.active { background: var(--surface-alt); border-left: 3px solid var(--highlight); }

.list-item-title { font-weight: 600; margin-bottom: 4px; }
.list-item-sub { color: var(--text-dim); font-size: 13px; font-family: var(--mono); }

.chat-bubble {
  max-width: 84%;
  padding: 11px 14px;
  border-radius: 10px;
  margin-bottom: 8px;
  font-size: 15px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-bubble.user {
  background: var(--surface-alt);
  border: 1px solid var(--border);
  margin-left: auto;
}

.chat-bubble.assistant {
  background: var(--surface);
  border: 1px solid var(--border);
}

.chat-role {
  font-size: 11px;
  color: var(--text-dim);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-family: var(--mono);
}

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
  border-radius: 10px;
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
  border-left: 3px solid var(--highlight);
  margin: 10px 0;
  padding: 2px 0 2px 10px;
  color: var(--text-dim);
}

.btn {
  padding: 8px 14px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--accent);
  color: var(--bg);
  font-family: var(--sans);
  font-weight: 500;
  font-size: 15px;
  cursor: pointer;
  transition: opacity 0.18s ease;
}

.btn:hover { opacity: 0.88; }

.btn-small { padding: 5px 10px; font-size: 13px; }
.btn-danger { background: var(--error); border-color: var(--error); }
.btn-success { background: var(--success); border-color: var(--success); }

[data-theme="dark"] .btn { color: #111827; }

select,
input,
textarea {
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  font-family: var(--mono);
  font-size: 14px;
  width: 100%;
}

select:focus,
input:focus,
textarea:focus {
  outline: none;
  border-color: var(--highlight);
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

.log-viewer {
  background: var(--surface-alt);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  font-size: 13px;
  font-family: var(--mono);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  overflow-y: auto;
  max-height: calc(100vh - 260px);
}

.cron-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}
.cron-info { flex: 1; }
.cron-name { font-weight: 600; margin-bottom: 4px; font-size: 15px; }
.cron-schedule,
.cron-next { color: var(--text-dim); font-size: 13px; font-family: var(--mono); }
.cron-next { color: var(--success); margin-top: 2px; }

.unsaved { color: var(--warning); font-size: 13px; margin-left: 8px; font-family: var(--mono); }

.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.toast {
  position: fixed;
  bottom: 20px;
  right: 20px;
  padding: 10px 14px;
  border-radius: 10px;
  font-size: 13px;
  font-family: var(--mono);
  z-index: 1000;
  border: 1px solid var(--border);
}
.toast.success { background: rgba(15, 156, 102, 0.16); color: var(--text); }
.toast.error { background: rgba(202, 61, 79, 0.16); color: var(--text); }

.empty {
  text-align: center;
  padding: 42px 26px;
  color: var(--text-dim);
  font-size: 15px;
}

.toggle-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-dim);
  cursor: pointer;
}
.toggle-label input { width: auto; }

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
td:first-child { color: var(--highlight); }

/* Enhanced Mobile Styles */
@media (max-width: 1024px) {
  .app-shell {
    grid-template-columns: 1fr;
  }
  
  .tabs {
    position: static;
    height: auto;
    border-right: none;
    border-bottom: 1px solid var(--border);
    padding: 12px;
    flex-direction: row;
    gap: 12px;
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
  }
  
  .tab-group {
    flex-direction: row;
    flex-wrap: nowrap;
    gap: 6px;
    min-width: max-content;
  }
  
  .tab-group-header {
    display: none;
  }
  
  .tab {
    white-space: nowrap;
    padding: 10px 16px;
    margin: 0;
    font-size: 15px;
  }
  
  .content {
    padding: 16px;
  }
  
  .split {
    grid-template-columns: 1fr;
    height: auto;
    gap: 16px;
  }
  
  .split-list {
    max-height: 50vh;
  }
  
  .split-detail {
    min-height: 60vh;
  }
}

@media (max-width: 768px) {
  .header {
    padding: 0 16px;
    height: 56px;
  }
  
  .header h1 {
    font-size: 22px;
  }
  
  .header-controls {
    gap: 8px;
    font-size: 13px;
  }
  
  .theme-toggle {
    padding: 8px 12px;
    font-size: 16px;
  }
  
  .section-title {
    font-size: 20px;
  }
  
  .grid {
    grid-template-columns: 1fr;
    gap: 12px;
  }
  
  .card {
    padding: 14px;
  }
  
  .card-value {
    font-size: 24px;
  }
  
  .btn {
    padding: 10px 16px;
    font-size: 15px;
    min-height: 44px;
  }
  
  .btn-small {
    padding: 8px 12px;
    font-size: 14px;
    min-height: 38px;
  }
  
  select,
  input,
  textarea {
    padding: 12px;
    font-size: 16px;
  }
  
  .toolbar {
    gap: 10px;
  }
  
  .toolbar select,
  .toolbar input {
    min-width: 100%;
  }
  
  .cron-card {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  
  .cron-card .btn {
    width: 100%;
  }
  
  .list-item {
    padding: 14px;
  }
  
  .chat-bubble {
    max-width: 90%;
    font-size: 15px;
    padding: 12px 14px;
  }
  
  .split-list {
    max-height: 40vh;
  }
  
  .log-viewer {
    font-size: 12px;
    padding: 10px;
    max-height: 60vh;
  }
}

@media (max-width: 480px) {
  .header h1 {
    font-size: 18px;
  }
  
  .header-controls span {
    display: none;
  }
  
  .tabs {
    padding: 8px;
    gap: 8px;
  }
  
  .tab {
    padding: 8px 12px;
    font-size: 14px;
  }
  
  .content {
    padding: 12px;
  }
  
  .section-title {
    font-size: 18px;
  }
  
  .card {
    padding: 12px;
  }
  
  .card-value {
    font-size: 20px;
  }
  
  .toast {
    left: 10px;
    right: 10px;
    bottom: 10px;
    text-align: center;
  }
}

/* --- Coding Agent Tab --- */
.ca-status-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 20px 24px;
  margin-bottom: 16px;
}

.ca-status-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

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
.ca-status-badge.running { background: rgba(44, 104, 246, 0.16); color: var(--highlight); }
.ca-status-badge.validating { background: rgba(176, 124, 26, 0.16); color: var(--warning); }
.ca-status-badge.completed { background: rgba(15, 156, 102, 0.16); color: var(--success); }
.ca-status-badge.failed { background: rgba(202, 61, 79, 0.16); color: var(--error); }
.ca-status-badge.timeout { background: rgba(202, 61, 79, 0.16); color: var(--error); }

.ca-spinner {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: ca-spin 0.8s linear infinite;
}
@keyframes ca-spin { to { transform: rotate(360deg); } }

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
  border-radius: 8px;
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
  font-family: var(--font);
  max-height: 400px;
  overflow-y: auto;
}
.ca-output-md h1, .ca-output-md h2, .ca-output-md h3 {
  margin: 10px 0 4px;
  font-size: 14px;
}
.ca-output-md h2 { font-size: 15px; }
.ca-output-md h1 { font-size: 16px; }
.ca-output-md p { margin: 4px 0; }
.ca-output-md ul, .ca-output-md ol { margin: 4px 0; padding-left: 20px; }
.ca-output-md li { margin: 2px 0; }
.ca-output-md code {
  background: var(--surface);
  padding: 1px 5px;
  border-radius: 3px;
  font-family: var(--mono);
  font-size: 0.9em;
}
.ca-output-md pre {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  overflow-x: auto;
  font-size: 11px;
}
.ca-output-md pre code {
  background: none;
  padding: 0;
}

.ca-error {
  background: rgba(202, 61, 79, 0.08);
  border: 1px solid rgba(202, 61, 79, 0.2);
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
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 10px;
  font-size: 14px;
  cursor: pointer;
}
.ca-tree-child .ca-output {
  max-height: 300px;
  overflow-y: auto;
}

.audit-entry {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 14px 18px;
  margin-bottom: 10px;
  transition: background 0.18s ease;
}

.audit-entry:hover {
  background: var(--surface-alt);
}

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
  color: var(--highlight);
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

.audit-badge.ok { background: rgba(15, 156, 102, 0.16); color: var(--success); }
.audit-badge.error { background: rgba(202, 61, 79, 0.16); color: var(--error); }

.audit-trigger {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.audit-trigger.telegram { background: rgba(44, 104, 246, 0.16); color: var(--highlight); }
.audit-trigger.cron { background: rgba(176, 124, 26, 0.16); color: var(--warning); }
.audit-trigger.api { background: rgba(15, 156, 102, 0.16); color: var(--success); }
.audit-trigger.system { background: var(--surface-alt); color: var(--text-dim); border: 1px solid var(--border); }
.audit-trigger.discord { background: rgba(88, 101, 242, 0.16); color: #7289da; }
.audit-trigger.code_agent { background: rgba(147, 51, 234, 0.16); color: #9333ea; }

/* Approval badges */
.approval-status {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.approval-status.pending { background: rgba(176, 124, 26, 0.16); color: var(--warning); }
.approval-status.approved { background: rgba(15, 156, 102, 0.16); color: var(--success); }
.approval-status.denied { background: rgba(202, 61, 79, 0.16); color: var(--error); }
.approval-status.expired { background: var(--surface-alt); color: var(--text-dim); }

.approval-tier {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}

.approval-tier.tier-1 { background: var(--surface-alt); color: var(--text-dim); }
.approval-tier.tier-2 { background: rgba(176, 124, 26, 0.16); color: var(--warning); }
.approval-tier.tier-3 { background: rgba(202, 61, 79, 0.16); color: var(--error); }

.approval-command {
  font-family: var(--mono);
  font-size: 13px;
  background: var(--surface-alt);
  padding: 6px 10px;
  border-radius: 6px;
  margin: 6px 0;
  word-break: break-all;
  border: 1px solid var(--border);
}

.approval-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.approval-actions .btn { font-size: 12px; padding: 4px 12px; }

.approval-countdown {
  font-size: 12px;
  color: var(--text-dim);
  font-family: var(--mono);
}

.approval-countdown.urgent { color: var(--error); font-weight: 600; }

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
  color: var(--highlight);
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
  border-bottom: 1px solid var(--border);
  align-items: center;
}

.audit-event:last-child { border-bottom: none; }

.audit-event-type {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--highlight);
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

/* --- Digests Tab --- */
.digest-header {
  margin-bottom: 20px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}

.digest-title {
  font-size: 20px;
  font-weight: 600;
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
  font-size: 18px;
  font-weight: 700;
  margin: 28px 0 12px 0;
  color: var(--highlight);
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
}

.digest-reader h4.digest-h4 {
  font-size: 16px;
  font-weight: 600;
  margin: 20px 0 8px 0;
  color: var(--text);
}

.digest-reader hr.digest-hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 20px 0;
}

.digest-reader a.digest-link {
  color: var(--highlight);
  word-break: break-all;
  font-size: 13px;
  font-family: var(--mono);
}

.digest-reader a.digest-link:hover {
  text-decoration: underline;
}

.digest-reader strong {
  color: var(--text);
  font-weight: 600;
}

.digest-section-header {
  font-size: 16px;
  font-weight: 700;
  color: var(--highlight);
  margin: 24px 0 12px 0;
  padding: 8px 12px;
  background: var(--surface-alt);
  border-radius: 8px;
  border-left: 3px solid var(--highlight);
}

.digest-section-header:first-child {
  margin-top: 0;
}

.digest-item-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  margin-top: 12px;
  line-height: 1.4;
}

.digest-stats {
  font-size: 13px;
  color: var(--text-dim);
  font-family: var(--mono);
  margin: 2px 0;
}

.digest-link-line {
  font-size: 13px;
  margin: 2px 0 8px 0;
}

.digest-link-line .digest-link-icon {
  margin-right: 2px;
}

.digest-link-line .digest-link {
  color: var(--highlight);
  font-family: var(--mono);
  font-size: 12px;
  word-break: break-all;
}

.digest-link-line .digest-link:hover {
  text-decoration: underline;
}

.digest-line {
  font-size: 14px;
  color: var(--text-dim);
  line-height: 1.5;
  margin: 1px 0;
}

.digest-spacer {
  height: 4px;
}

.digest-hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 16px 0;
}

.digest-articles {
  padding: 8px 0;
}

.digest-article-card {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.digest-article-card:last-child {
  border-bottom: none;
}

.digest-article-card .source-badge {
  font-size: 11px;
  color: var(--highlight);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.digest-article-card .article-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  text-decoration: none;
  line-height: 1.3;
}

.digest-article-card .article-title:hover {
  text-decoration: underline;
  color: var(--highlight);
}

.digest-article-card .article-stats {
  font-size: 13px;
  color: var(--text-dim);
  font-family: var(--mono);
}

.article-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.article-item {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
  transition: background 0.18s ease, border-color 0.18s ease;
}

.article-item:hover {
  background: var(--surface-alt);
  border-color: var(--highlight);
}

.article-item.read {
  opacity: 0.7;
}

.article-item.read .article-title {
  text-decoration: line-through;
  color: var(--text-dim);
}

.article-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 6px;
}

.article-title {
  font-weight: 600;
  font-size: 15px;
  line-height: 1.4;
  flex: 1;
}

.article-title a {
  color: var(--text);
}

.article-title a:hover {
  color: var(--highlight);
}

.article-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.article-meta {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-dim);
  font-family: var(--mono);
  margin-bottom: 6px;
}

.article-source {
  color: var(--highlight);
  font-weight: 500;
}

.article-score, .article-comments {
  background: var(--surface-alt);
  padding: 2px 8px;
  border-radius: 999px;
}

.article-summary {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-dim);
}

.read-btn {
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 6px;
  background: var(--surface-alt);
  border: 1px solid var(--border);
  color: var(--text-dim);
  cursor: pointer;
  transition: all 0.18s ease;
}

.read-btn:hover {
  background: var(--highlight);
  color: #fff;
  border-color: var(--highlight);
}

.read-btn.mark-unread {
  background: var(--success);
  color: #fff;
  border-color: var(--success);
}
</style>
</head>
<body>
<div class="header">
  <h1>SkimpyClaw 👙🦞 Dashboard</h1>
  <div class="header-controls">
    <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" title="Switch theme">🌙</button>
    <span class="status-dot" id="statusDot"></span>
    <span id="headerStatus">Loading...</span>
  </div>
</div>

<div class="app-shell">
<div class="tabs" id="tabBar">
  <div class="tab-group">
    <div class="tab-group-header">
      <span class="tab-group-title"><span class="tab-group-icon">⚙</span> Settings</span>
    </div>
    <button class="tab active" data-tab="status">Status</button>
    <button class="tab" data-tab="history">History</button>
    <button class="tab" data-tab="memory">Memory</button>
    <button class="tab" data-tab="model">Model</button>
    <button class="tab" data-tab="templates">Templates</button>
    <button class="tab" data-tab="config">Config</button>
    <button class="tab" data-tab="health">Health</button>
  </div>
  <div class="tab-group">
    <div class="tab-group-header">
      <span class="tab-group-title"><span class="tab-group-icon">◔</span> Operations</span>
    </div>
    <button class="tab" data-tab="approvals">Approvals</button>
    <button class="tab" data-tab="cron">Cron</button>
    <button class="tab" data-tab="coding-agent">Coding Agent</button>
    <button class="tab" data-tab="audit">Audit</button>
    <button class="tab" data-tab="logs">Logs</button>
    <button class="tab" data-tab="digests">Digests</button>
    <button class="tab" data-tab="skills">Skills</button>
  </div>
</div>

<div class="content">
  <!-- Status Tab -->
  <div class="tab-panel active" id="panel-status">
    <div class="grid" id="statusGrid"></div>
    <h3 class="section-title">Cron Jobs</h3>
    <div id="statusCronJobs"></div>
  </div>

  <!-- History Tab -->
  <div class="tab-panel" id="panel-history">
    <div class="split">
      <div class="split-list" id="sessionList"></div>
      <div class="split-detail" id="sessionDetail">
        <div class="empty">Select a session to view conversation</div>
      </div>
    </div>
  </div>

  <!-- Memory Tab -->
  <div class="tab-panel" id="panel-memory">
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

  <!-- Cron Tab -->
  <div class="tab-panel" id="panel-cron">
    <div id="cronJobs"></div>
  </div>

  <!-- Model Tab -->
  <div class="tab-panel" id="panel-model">
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

  <!-- Templates Tab -->
  <div class="tab-panel" id="panel-templates">
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

  <!-- Approvals Tab -->
  <div class="tab-panel" id="panel-approvals">
    <div class="toolbar">
      <button class="btn btn-small" id="approvalsRefreshBtn">Refresh</button>
      <label class="toggle-label"><input type="checkbox" id="approvalsAutoRefresh" checked> Auto-refresh</label>
      <span id="approvalsCount" style="font-size:13px;color:var(--text-dim);margin-left:auto;"></span>
    </div>
    <div id="approvalsPending"></div>
    <h3 class="section-title" style="margin-top:20px;">Recent</h3>
    <div id="approvalsRecent"></div>
  </div>

  <!-- Coding Agent Tab -->
  <div class="tab-panel" id="panel-coding-agent">
    <div id="caStatus">
      <div class="empty">No coding agents have run yet. Send a coding task via Telegram or Discord.</div>
    </div>
  </div>

  <!-- Audit Tab -->
  <div class="tab-panel" id="panel-audit">
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

  <!-- Digests Tab -->
  <div class="tab-panel" id="panel-digests">
    <div class="split">
      <div class="split-list" id="digestList"></div>
      <div class="split-detail" id="digestDetail">
        <div class="empty">Select a digest to view articles</div>
      </div>
    </div>
  </div>

  <!-- Skills Tab -->
  <div class="tab-panel" id="panel-skills">
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

  <!-- Logs Tab -->
  <div class="tab-panel" id="panel-logs">
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

  <!-- Config Tab -->
  <div class="tab-panel" id="panel-config">
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

  <!-- Health Tab (unified: diagnostics + environment + features) -->
  <div class="tab-panel" id="panel-health">
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
  const saved = localStorage.getItem('skimpyclaw-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcon(saved);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('skimpyclaw-theme', next);
  updateThemeIcon(next);
}

function updateThemeIcon(theme) {
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = theme === 'dark' ? '\\u{1F319}' : '\\u{2600}\\u{FE0F}';
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

// --- Tab Navigation ---
document.getElementById('tabBar').addEventListener('click', (e) => {
  if (!e.target.classList.contains('tab')) return;
  const tabName = e.target.dataset.tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  e.target.classList.add('active');
  document.getElementById('panel-' + tabName).classList.add('active');
  onTabActivated(tabName);
});

function onTabActivated(tab) {
  // Clear status refresh when leaving status tab
  if (tab !== 'status' && statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }
  if (tab === 'status') startStatusRefresh();
  else if (tab === 'history') loadSessions();
  else if (tab === 'memory') loadMemory();
  else if (tab === 'approvals') startApprovalsPolling();
  else if (tab === 'cron') loadCronJobs();
  else if (tab === 'model') loadModel();
  else if (tab === 'templates') loadTemplates();
  else if (tab === 'coding-agent') startCaPolling();
  else if (tab === 'audit') loadAudit();
  else if (tab === 'logs') loadLogFiles();
  else if (tab === 'digests') loadDigests();
  else if (tab === 'skills') loadSkills();
  else if (tab === 'config') loadConfig();
  else if (tab === 'health') loadHealth();
}

// --- Status Tab ---
async function loadStatus() {
  try {
    const data = await api('status');
    document.getElementById('headerStatus').textContent = 'Online';
    document.getElementById('statusDot').classList.remove('error');
    const grid = document.getElementById('statusGrid');
    grid.innerHTML =
      '<div class="card"><div class="card-title">Uptime</div><div class="card-value">' + formatUptime(data.uptime) + '</div></div>' +
      '<div class="card"><div class="card-title">Model</div><div class="card-value" style="font-size:14px;">' + esc(data.model || '-') + '</div></div>' +
      '<div class="card"><div class="card-title">Agent</div><div class="card-value">' + esc(data.agent || '-') + '</div></div>' +
      '<div class="card"><div class="card-title">Last Message</div><div class="card-value" style="font-size:14px;">' + formatDate(data.lastMessage) + '</div></div>';

    const cronEl = document.getElementById('statusCronJobs');
    if (data.cronJobs && data.cronJobs.length > 0) {
      cronEl.innerHTML = data.cronJobs.map(j =>
        '<div class="card"><div class="cron-card"><div class="cron-info">' +
        '<div class="cron-name">' + esc(j.name || j.id) + '</div>' +
        '<div class="cron-next">Next: ' + formatDate(j.nextRun) + '</div>' +
        '</div></div></div>'
      ).join('');
    } else {
      cronEl.innerHTML = '<div class="empty">No cron jobs configured</div>';
    }
  } catch (e) {
    document.getElementById('headerStatus').textContent = 'Offline';
    document.getElementById('statusDot').classList.add('error');
  }
}

function startStatusRefresh() {
  loadStatus();
  statusInterval = setInterval(loadStatus, 5000);
}

// --- History Tab ---
async function loadSessions() {
  try {
    const data = await api('sessions');
    const list = document.getElementById('sessionList');
    if (!data.sessions || data.sessions.length === 0) {
      list.innerHTML = '<div class="empty">No sessions found</div>';
      return;
    }
    list.innerHTML = data.sessions.map(s =>
      '<div class="list-item' + (s.id === currentSessionId ? ' active' : '') + '" data-id="' + esc(s.id) + '">' +
      '<div class="list-item-title">' + esc(s.agentId || s.id) + '</div>' +
      '<div class="list-item-sub">' + s.turnCount + ' turns &middot; ' + formatDate(s.updatedAt || s.createdAt) + '</div>' +
      '</div>'
    ).join('');

    list.querySelectorAll('.list-item').forEach(item => {
      item.addEventListener('click', () => loadSession(item.dataset.id));
    });
  } catch (e) {
    document.getElementById('sessionList').innerHTML = '<div class="empty">Failed to load sessions</div>';
  }
}

async function loadSession(id) {
  currentSessionId = id;
  document.querySelectorAll('#sessionList .list-item').forEach(i => {
    i.classList.toggle('active', i.dataset.id === id);
  });
  const detail = document.getElementById('sessionDetail');
  try {
    const data = await api('sessions/' + encodeURIComponent(id));
    const session = data.session;
    if (!session.turns || session.turns.length === 0) {
      detail.innerHTML = '<div class="empty">No turns in this session</div>';
      return;
    }
    detail.innerHTML = session.turns.map(t => {
      const role = t.role || 'unknown';
      const content = typeof t.content === 'string' ? t.content :
                      (t.content && t.content.text ? t.content.text : JSON.stringify(t.content, null, 2));
      const renderedContent = role === 'assistant'
        ? renderMarkdown(content)
        : '<pre style="white-space:pre-wrap;font-size:13px;line-height:1.6;margin:0;">' + esc(content) + '</pre>';
      return '<div class="chat-role">' + esc(role) + (t.timestamp ? ' &middot; ' + formatDate(t.timestamp) : '') + '</div>' +
             '<div class="chat-bubble ' + esc(role) + '">' + renderedContent + '</div>';
    }).join('');
  } catch (e) {
    detail.innerHTML = '<div class="empty">Failed to load session</div>';
  }
}

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

// Stop polling when leaving the tab
var origOnTab = onTabActivated;
onTabActivated = function(tab) {
  if (tab !== 'coding-agent') stopCaPolling();
  if (tab !== 'approvals') stopApprovalsPolling();
  origOnTab(tab);
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
startStatusRefresh();
</script>
</body>
</html>`;
