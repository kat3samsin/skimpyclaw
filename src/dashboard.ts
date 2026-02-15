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

.ca-error {
  background: rgba(202, 61, 79, 0.08);
  border: 1px solid rgba(202, 61, 79, 0.2);
  color: var(--error);
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
  </div>
  <div class="tab-group">
    <div class="tab-group-header">
      <span class="tab-group-title"><span class="tab-group-icon">◔</span> Operations</span>
    </div>
    <button class="tab" data-tab="cron">Cron</button>
    <button class="tab" data-tab="coding-agent">Coding Agent</button>
    <button class="tab" data-tab="audit">Audit</button>
    <button class="tab" data-tab="logs">Logs</button>
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
  else if (tab === 'cron') loadCronJobs();
  else if (tab === 'model') loadModel();
  else if (tab === 'templates') loadTemplates();
  else if (tab === 'coding-agent') startCaPolling();
  else if (tab === 'audit') loadAudit();
  else if (tab === 'logs') loadLogFiles();
  else if (tab === 'config') loadConfig();
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
      return '<div class="chat-role">' + esc(role) + (t.timestamp ? ' &middot; ' + formatDate(t.timestamp) : '') + '</div>' +
             '<div class="chat-bubble ' + esc(role) + '">' + esc(content) + '</div>';
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
    el.innerHTML = '<pre style="white-space:pre-wrap;font-size:13px;line-height:1.6;">' + esc(data.content || '(empty)') + '</pre>';
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

  var html = '<table style="width:100%;border-collapse:collapse;font-size:14px;">' +
    '<thead><tr style="border-bottom:2px solid var(--border);text-align:left;">' +
    '<th style="padding:8px 12px;">ID</th>' +
    '<th style="padding:8px 12px;">Status</th>' +
    '<th style="padding:8px 12px;">Agent</th>' +
    '<th style="padding:8px 12px;">Task</th>' +
    '<th style="padding:8px 12px;">Duration</th>' +
    '</tr></thead><tbody>';

  for (var i = 0; i < agents.length; i++) {
    var a = agents[i];
    var isActive = a.status === 'running' || a.status === 'validating';
    var spinner = isActive ? '<span class="ca-spinner"></span> ' : '';
    var secs = a.durationSeconds != null ? a.durationSeconds
      : Math.round((Date.now() - new Date(a.startedAt).getTime()) / 1000);
    var elapsed = secs < 60 ? secs + 's' : Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
    var taskPreview = (a.task || '').length > 80 ? a.task.slice(0, 80) + '...' : (a.task || '');

    html += '<tr style="border-bottom:1px solid var(--border);cursor:pointer;" onclick="toggleCaDetail(\\'' + esc(a.id) + '\\')">' +
      '<td style="padding:8px 12px;font-family:var(--mono);font-weight:600;">' + esc(a.id) + '</td>' +
      '<td style="padding:8px 12px;"><span class="ca-status-badge ' + esc(a.status) + '">' + spinner + esc(a.status.toUpperCase()) + '</span></td>' +
      '<td style="padding:8px 12px;">' + esc(a.agent || '-') + '</td>' +
      '<td style="padding:8px 12px;">' + esc(taskPreview) + '</td>' +
      '<td style="padding:8px 12px;font-family:var(--mono);">' + elapsed + '</td>' +
      '</tr>';

    // Expandable detail row
    html += '<tr id="ca-detail-' + esc(a.id) + '" style="display:none;"><td colspan="5" style="padding:12px 16px;">';
    html += '<div class="ca-meta">';
    if (a.model) html += '<span>Model: ' + esc(a.model) + '</span>';
    if (a.startedAt) html += '<span>Started: ' + formatDate(a.startedAt) + '</span>';
    if (a.endedAt) html += '<span>Ended: ' + formatDate(a.endedAt) + '</span>';
    if (a.validationPassed != null) html += '<span>Tests: ' + (a.validationPassed ? 'PASS' : 'FAIL') + '</span>';
    if (a.workdir) html += '<span>Dir: ' + esc(a.workdir) + '</span>';
    html += '</div>';

    if (a.task) html += '<div class="ca-task" style="margin-top:8px;">' + esc(a.task) + '</div>';

    var output = a.liveOutput || a.outputPreview;
    if (output) html += '<div class="ca-output" style="margin-top:8px;">' + esc(output) + '</div>';
    if (a.error) html += '<div class="ca-output ca-error" style="margin-top:8px;">' + esc(a.error) + '</div>';
    html += '</td></tr>';
  }

  html += '</tbody></table>';
  el.innerHTML = html;

  // Auto-scroll live output for active agents
  for (var j = 0; j < agents.length; j++) {
    if (agents[j].status === 'running' || agents[j].status === 'validating') {
      var detailEl = document.getElementById('ca-detail-' + agents[j].id);
      if (detailEl && detailEl.style.display !== 'none') {
        var outputEl = detailEl.querySelector('.ca-output');
        if (outputEl) outputEl.scrollTop = outputEl.scrollHeight;
      }
    }
  }
}

function toggleCaDetail(id) {
  var row = document.getElementById('ca-detail-' + id);
  if (row) {
    row.style.display = row.style.display === 'none' ? '' : 'none';
  }
}

// Stop polling when leaving the tab
var origOnTab = onTabActivated;
onTabActivated = function(tab) {
  if (tab !== 'coding-agent') stopCaPolling();
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

// --- Init ---
startStatusRefresh();
</script>
</body>
</html>`;
