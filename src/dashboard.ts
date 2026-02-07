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
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SkimpyClaw Dashboard</title>
<style>
/* Dark theme (default) */
:root, [data-theme="dark"] {
  --bg: #1a1a2e;
  --surface: #16213e;
  --text: #e0e0e0;
  --text-dim: #8892a4;
  --accent: #0f3460;
  --highlight: #e94560;
  --success: #4ecca3;
  --warning: #f0a500;
  --error: #e94560;
  --border: #2a2a4a;
  --mono: 'SF Mono', 'Fira Code', 'Consolas', monospace;
}

/* Light theme - Bikini Bubblegum Pop */
[data-theme="light"] {
  --bg: #ffffff;
  --surface: #ffffff;
  --text: #2d1b2e;
  --text-dim: #8b6a8d;
  --accent: #fce4ec;
  --highlight: #e91e8c;
  --success: #00b894;
  --warning: #fdcb6e;
  --error: #e84393;
  --border: #f0c6d4;
  --mono: 'SF Mono', 'Fira Code', 'Consolas', monospace;
}

/* Light theme refinements for accessibility (WCAG AA contrast) */
[data-theme="light"] .card { box-shadow: 0 1px 4px rgba(233, 30, 140, 0.08); }
[data-theme="light"] .header { background: linear-gradient(135deg, #fce4ec 0%, #f8bbd0 50%, #f0f4ff 100%); border-bottom-color: #f0c6d4; }
[data-theme="light"] .tabs { background: #fff5f8; }
[data-theme="light"] .tab.active { color: #c2185b; border-bottom-color: #e91e8c; }
[data-theme="light"] .tab:hover { color: #ad1457; }
[data-theme="light"] .btn { background: #fce4ec; color: #880e4f; border-color: #f0c6d4; }
[data-theme="light"] .btn:hover { background: #e91e8c; color: #fff; }
[data-theme="light"] .btn-success:hover { background: #00b894; color: #fff; }
[data-theme="light"] .btn-danger:hover { background: #e84393; color: #fff; }
[data-theme="light"] select, [data-theme="light"] input, [data-theme="light"] textarea { background: #fff; border-color: #f0c6d4; color: #2d1b2e; }
[data-theme="light"] .log-viewer { background: #fff9fb; border-color: #f0c6d4; }
[data-theme="light"] .chat-bubble.user { background: #fce4ec; }
[data-theme="light"] .chat-bubble.assistant { background: #fff; border-color: #f0c6d4; }
[data-theme="light"] .list-item:hover { background: #fce4ec; }
[data-theme="light"] .list-item.active { background: #fce4ec; border-left-color: #e91e8c; }
[data-theme="light"] .toast.success { background: #00b894; color: #fff; }
[data-theme="light"] .toast.error { background: #e84393; color: #fff; }
[data-theme="light"] a { color: #c2185b; }

/* Theme toggle button */
.theme-toggle {
  background: none;
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 4px 12px;
  cursor: pointer;
  font-size: 14px;
  color: var(--text);
  transition: background 0.2s;
  margin-right: 12px;
}
.theme-toggle:hover { background: var(--accent); }
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: var(--mono);
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
}
a { color: var(--highlight); text-decoration: none; }
a:hover { text-decoration: underline; }

/* Header */
.header {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 12px 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.header h1 {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 1px;
}
.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--success);
  display: inline-block;
  margin-right: 8px;
}
.status-dot.error { background: var(--error); }

/* Tabs */
.tabs {
  display: flex;
  background: var(--surface);
  border-bottom: 2px solid var(--border);
  padding: 0 16px;
  overflow-x: auto;
}
.tab {
  padding: 10px 18px;
  cursor: pointer;
  border: none;
  background: none;
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: 13px;
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
  transition: color 0.2s, border-color 0.2s;
  white-space: nowrap;
}
.tab:hover { color: var(--text); }
.tab.active {
  color: var(--highlight);
  border-bottom-color: var(--highlight);
}

/* Content */
.content {
  padding: 20px 24px;
  max-width: 1400px;
  margin: 0 auto;
}
.tab-panel { display: none; }
.tab-panel.active { display: block; }

/* Cards */
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px;
  margin-bottom: 12px;
}
.card-title {
  font-size: 12px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 8px;
}
.card-value {
  font-size: 20px;
  font-weight: 600;
}

/* Grid */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 12px;
  margin-bottom: 20px;
}

/* Two-column layout */
.split {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 16px;
  height: calc(100vh - 140px);
}
.split-list {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow-y: auto;
}
.split-detail {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow-y: auto;
  padding: 16px;
}

/* List items */
.list-item {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s;
}
.list-item:hover { background: var(--accent); }
.list-item.active { background: var(--accent); border-left: 3px solid var(--highlight); }
.list-item-title { font-weight: 600; margin-bottom: 2px; }
.list-item-sub { color: var(--text-dim); font-size: 11px; }

/* Chat bubbles */
.chat-bubble {
  max-width: 80%;
  padding: 10px 14px;
  border-radius: 8px;
  margin-bottom: 8px;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.chat-bubble.user {
  background: var(--accent);
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
}

/* Buttons */
.btn {
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--accent);
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}
.btn:hover { background: var(--highlight); }
.btn-small { padding: 4px 10px; font-size: 11px; }
.btn-danger { border-color: var(--error); }
.btn-danger:hover { background: var(--error); }
.btn-success { border-color: var(--success); }
.btn-success:hover { background: var(--success); color: var(--bg); }

/* Forms */
select, input, textarea {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px 10px;
  font-family: var(--mono);
  font-size: 13px;
  width: 100%;
}
select:focus, input:focus, textarea:focus {
  outline: none;
  border-color: var(--highlight);
}
textarea {
  resize: vertical;
  min-height: 300px;
  line-height: 1.5;
}
label {
  display: block;
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* Log viewer */
.log-viewer {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 12px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  overflow-y: auto;
  max-height: calc(100vh - 260px);
}

/* Cron cards */
.cron-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.cron-info { flex: 1; }
.cron-name { font-weight: 600; margin-bottom: 4px; }
.cron-schedule { color: var(--text-dim); font-size: 12px; }
.cron-next { color: var(--success); font-size: 12px; margin-top: 2px; }

/* Unsaved indicator */
.unsaved { color: var(--warning); font-size: 12px; margin-left: 8px; }

/* Toolbar */
.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

/* Toast notifications */
.toast {
  position: fixed;
  bottom: 20px;
  right: 20px;
  padding: 10px 18px;
  border-radius: 6px;
  font-size: 13px;
  z-index: 1000;
  animation: fadeIn 0.2s;
}
.toast.success { background: var(--success); color: var(--bg); }
.toast.error { background: var(--error); color: white; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

/* Empty state */
.empty {
  text-align: center;
  padding: 40px;
  color: var(--text-dim);
  font-size: 14px;
}

/* Checkbox toggle */
.toggle-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
}
.toggle-label input { width: auto; }
</style>
</head>
<body>
<div class="header">
  <h1>SkimpyClaw Dashboard</h1>
  <div style="display:flex;align-items:center;">
    <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" title="Switch theme">🌙</button>
    <span class="status-dot" id="statusDot"></span><span id="headerStatus">Loading...</span>
  </div>
</div>

<div class="tabs" id="tabBar">
  <button class="tab active" data-tab="status">Status</button>
  <button class="tab" data-tab="history">History</button>
  <button class="tab" data-tab="memory">Memory</button>
  <button class="tab" data-tab="cron">Cron</button>
  <button class="tab" data-tab="model">Model</button>
  <button class="tab" data-tab="templates">Templates</button>
  <button class="tab" data-tab="logs">Logs</button>
  <button class="tab" data-tab="config">Config</button>
</div>

<div class="content">
  <!-- Status Tab -->
  <div class="tab-panel active" id="panel-status">
    <div class="grid" id="statusGrid"></div>
    <h3 style="margin-bottom:12px;font-size:14px;">Cron Jobs</h3>
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
  if (btn) btn.textContent = theme === 'dark' ? '\\u{1F319}' : '\\u{1F338}';
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
      '<div class="cron-schedule">Schedule: ' + esc(j.schedule || '-') + '</div>' +
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
