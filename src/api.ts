// Dashboard API endpoints

import { FastifyInstance } from 'fastify';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync } from 'fs';
import { validateBearerToken } from './utils.js';
import { join, basename, resolve } from 'path';
import { homedir } from 'os';
import type { Config } from './types.js';
import {
  loadConfig,
  loadRawConfig,
  saveConfig,
  getSessionsDir,
  getLogsDir,
  getAgentDir,
  isValidAgentId,
  listMemoryFiles,
  readMemoryFile,
} from './config.js';
import {
  TEMPLATE_FILES,
  getAgentTemplateContent,
  saveAgentTemplate,
} from './agent.js';
import { getCronJobs, getCronJobDetails, runCronJob } from './cron.js';
import { getCurrentModel, setCurrentModel, getLastMessage, setGatewayConfig } from './gateway.js';
import { redactSecrets } from './security.js';

import { readAuditTraces } from './audit.js';
import { getUsageSummary, readUsageRecords } from './usage.js';
import { getAllCodeAgents, getCodeAgent, cancelCodeAgent } from './tools.js';
import { listApprovals, getApproval, approveRequest, denyRequest } from './exec-approval.js';
import { getDigests, getDigest, deleteDigest, updateArticleReadStatus } from './digests.js';
import { loadSkills } from './skills.js';
import type { SkillConfig } from './skills-types.js';
import { runDoctor as runDoctorChecks } from './doctor/runner.js';
import { sendActiveChannelProactiveMessage, getActiveChannelId } from './channels.js';
import { runAgentTurn, initProviders } from './agent.js';
import { initCron } from './cron.js';
import { initHeartbeat, stopHeartbeat } from './heartbeat.js';
import { initActiveChannel, stopActiveChannel, startActiveChannel } from './channels.js';
import { setCodeAgentConfig } from './tools.js';
import { resolveModelSelection } from './model-selection.js';
import { readSessionEntriesFromFile } from './sessions.js';

const DEFAULT_MODEL_ALIASES: Record<string, string> = {
  'claude-fast': 'anthropic/claude-haiku-4-5',
  'claude-think': 'anthropic/claude-sonnet-4-6',
  'claude-opus': 'anthropic/claude-opus-4-7',
  'codex5.1': 'codex/gpt-5.1-codex',
  'codex5.2': 'codex/gpt-5.2-codex',
  'codex5.3': 'codex/gpt-5.3-codex',
  minimax: 'minimax/MiniMax-M2.5',
  kimi: 'kimi/kimi-for-coding',
};

function validateFilename(filename: string): boolean {
  return !filename.includes('..') && filename === basename(filename);
}

// Use isValidAgentId from config.ts

function validateSkillName(name: string): boolean {
  return /^[a-zA-Z0-9-]+$/.test(name) && name.length <= 100;
}

function getSkillsDir(cfg: Config): string {
  return cfg.skills?.directory || join(homedir(), '.skimpyclaw', 'skills');
}

function resolveCronPromptPath(inputPath: string): string | null {
  const trimmed = inputPath.trim();
  if (!trimmed || !trimmed.endsWith('.md') || trimmed.includes('\0')) return null;

  const home = homedir();
  const promptsRoot = resolve(home, '.skimpyclaw', 'prompts');
  const expanded = trimmed.startsWith('~/')
    ? resolve(home, trimmed.slice(2))
    : trimmed.startsWith('/')
      ? resolve(trimmed)
      : resolve(promptsRoot, trimmed);

  if (!expanded.startsWith(`${promptsRoot}/`) && expanded !== promptsRoot) {
    return null;
  }
  return expanded;
}

interface TodoItem {
  id: number;
  text: string;
  completed: boolean;
  lineIndex: number;
  prefix: string;
}

function getTodoPath(): string {
  return process.env.SKIMPYCLAW_TODO_PATH || join(process.cwd(), 'TODO.md');
}

function parseTodoItems(content: string): TodoItem[] {
  const lines = content.split('\n');
  const items: TodoItem[] = [];
  let id = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*-\s*)\[( |x|X)\]\s+(.*)$/);
    if (!match) continue;

    items.push({
      id: id++,
      text: match[3],
      completed: match[2].toLowerCase() === 'x',
      lineIndex: i,
      prefix: match[1],
    });
  }

  return items;
}

export function registerDashboardAPI(fastify: FastifyInstance, config: Config): void {
  // Mutable live config reference - updated on reload
  let runtimeConfig = config;

  // --- Auth middleware for all dashboard routes ---
  fastify.addHook('onRequest', async (request, reply) => {
    const url = request.url;
    // Only protect API routes - the dashboard HTML page must load without auth
    // so it can display the token prompt
    if (!url.startsWith('/api/dashboard')) {
      return; // Not a dashboard API route, skip auth
    }

    const token = runtimeConfig.dashboard?.token;
    if (!token) {
      return; // No token configured, allow access
    }

    if (!validateBearerToken(token, request.headers.authorization)) {
      return reply.code(401).send({ error: 'Unauthorized: Invalid or missing token' });
    }
  });

  // --- Status ---
  fastify.get('/api/dashboard/status', async () => {
    const jobs = getCronJobs();
    const uptime = process.uptime();

    const sandboxCfg = runtimeConfig.sandbox;
    return {
      uptime,
      model: getCurrentModel(),
      agent: runtimeConfig.agents.default,
      lastMessage: getLastMessage(),
      activeChannel: getActiveChannelId() ?? runtimeConfig.channels.active ?? null,
      cronJobs: jobs,
      sandbox: sandboxCfg?.enabled ? {
        enabled: true,
        runtime: sandboxCfg.runtime ?? 'container',
        image: sandboxCfg.image ?? 'skimpyclaw-sandbox',
      } : { enabled: false },
    };
  });

  // --- Sessions ---
  fastify.get('/api/dashboard/sessions', async () => {
    const sessionsDir = getSessionsDir();
    if (!existsSync(sessionsDir)) {
      return { sessions: [] };
    }

    const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    const sessions = files.map(file => {
      try {
        const content = readFileSync(join(sessionsDir, file), 'utf-8');
        const session = JSON.parse(content);
        return {
          id: session.id || file.replace('.json', ''),
          agentId: session.agentId,
          model: session.model,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          turnCount: session.turns?.length || 0,
        };
      } catch {
        return null;
      }
    }).filter(Boolean);

    // Sort newest first
    sessions.sort((a: any, b: any) => {
      const dateA = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const dateB = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return dateB - dateA;
    });

    return { sessions };
  });

  // --- Conversations (Telegram/Discord chat history from .jsonl sessions) ---
  fastify.get<{ Querystring: { channel?: string } }>('/api/dashboard/conversations', async (request) => {
    const sessionsDir = getSessionsDir();
    if (!existsSync(sessionsDir)) {
      return { conversations: [] };
    }

    const channelFilter = request.query.channel;
    const files = readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
    const conversations = files.map(file => {
      const id = file.replace('.jsonl', '');
      const [channel, ...rest] = id.split('-');
      const chatId = rest.join('-');
      if ((channel !== 'telegram' && channel !== 'discord') || !chatId) return null;
      if (channelFilter && channel !== channelFilter) return null;

      try {
        const entries = readSessionEntriesFromFile(join(sessionsDir, file));

        const last = entries[entries.length - 1];
        const preview = last?.user || last?.assistant || '';
        return {
          id,
          channel,
          chatId,
          updatedAt: last?.ts || new Date(0).toISOString(),
          messageCount: entries.length * 2,
          preview: preview.slice(0, 140),
        };
      } catch {
        return null;
      }
    }).filter(Boolean) as Array<{
      id: string;
      channel: string;
      chatId: string;
      updatedAt: string;
      messageCount: number;
      preview: string;
    }>;

    conversations.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return { conversations };
  });

  fastify.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>('/api/dashboard/conversations/:id', async (request, reply) => {
    const { id } = request.params;
    if (!/^[a-zA-Z0-9_-]+-[a-zA-Z0-9:_-]+$/.test(id) || id.includes('..')) {
      return reply.code(400).send({ error: 'Invalid conversation id' });
    }

    const sessionsDir = getSessionsDir();
    const filePath = join(sessionsDir, `${id}.jsonl`);
    if (!existsSync(filePath)) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }

    try {
      const limitRaw = Number.parseInt(request.query.limit || '80', 10);
      const offsetRaw = Number.parseInt(request.query.offset || '0', 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 80;
      const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

      const entries = readSessionEntriesFromFile(filePath);
      const messages: Array<{ ts: string; role: 'user' | 'assistant'; content: string }> = [];

      for (const entry of entries) {
        const ts = entry.ts || new Date().toISOString();
        if (entry.user) messages.push({ ts, role: 'user', content: entry.user });
        if (entry.assistant) messages.push({ ts, role: 'assistant', content: entry.assistant });
      }

      const total = messages.length;
      const end = Math.max(0, total - offset);
      const start = Math.max(0, end - limit);
      const sliced = messages.slice(start, end);
      return {
        id,
        messages: sliced,
        total,
        hasMore: start > 0,
      };
    } catch {
      return reply.code(500).send({ error: 'Failed to read conversation' });
    }
  });

  fastify.get<{ Params: { id: string } }>('/api/dashboard/sessions/:id', async (request, reply) => {
    const { id } = request.params;
    if (!validateFilename(id)) {
      return reply.code(400).send({ error: 'Invalid session id' });
    }

    const sessionsDir = getSessionsDir();
    const filePath = join(sessionsDir, `${id}.json`);
    if (!existsSync(filePath)) {
      return reply.code(404).send({ error: 'Session not found' });
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const session = JSON.parse(content);
      return { session };
    } catch {
      return reply.code(500).send({ error: 'Failed to read session' });
    }
  });

  // --- Memory ---
  fastify.get<{ Params: { agentId: string } }>('/api/dashboard/memory/:agentId', async (request, reply) => {
    const { agentId } = request.params;
    if (!isValidAgentId(agentId)) {
      return reply.code(400).send({ error: 'Invalid agent ID' });
    }
    const files = listMemoryFiles(agentId);
    return { files };
  });

  fastify.get<{
    Params: { agentId: string; filename: string };
  }>('/api/dashboard/memory/:agentId/:filename', async (request, reply) => {
    const { agentId, filename } = request.params;
    if (!isValidAgentId(agentId)) {
      return reply.code(400).send({ error: 'Invalid agent ID' });
    }

    // Special case: "curated" reads MEMORY.md from the agent root
    if (filename === 'curated') {
      const memoryMdPath = join(getAgentDir(agentId), 'MEMORY.md');
      if (!existsSync(memoryMdPath)) {
        return reply.code(404).send({ error: 'MEMORY.md not found' });
      }
      const content = readFileSync(memoryMdPath, 'utf-8');
      return { content };
    }

    if (!validateFilename(filename)) {
      return reply.code(400).send({ error: 'Invalid filename' });
    }

    try {
      const content = readMemoryFile(agentId, filename);
      return { content };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      if (msg === 'File not found') {
        return reply.code(404).send({ error: msg });
      }
      return reply.code(400).send({ error: msg });
    }
  });

  // --- Cron ---
  fastify.get('/api/dashboard/cron', async () => {
    const jobs = getCronJobDetails(runtimeConfig);
    return { jobs };
  });

  fastify.get<{ Querystring: { path?: string } }>('/api/dashboard/cron/prompt-file', async (request, reply) => {
    const inputPath = request.query.path?.trim();
    if (!inputPath) {
      return reply.code(400).send({ error: 'path required' });
    }

    const resolvedPath = resolveCronPromptPath(inputPath);
    if (!resolvedPath) {
      return reply.code(400).send({ error: 'Invalid prompt path' });
    }
    if (!existsSync(resolvedPath)) {
      return reply.code(404).send({ error: 'Prompt file not found' });
    }
    if (!statSync(resolvedPath).isFile()) {
      return reply.code(400).send({ error: 'Prompt path is not a file' });
    }

    try {
      const content = readFileSync(resolvedPath, 'utf-8');
      return { path: inputPath, resolvedPath, content };
    } catch {
      return reply.code(500).send({ error: 'Failed to read prompt file' });
    }
  });

  // --- Messages ---
  fastify.post<{ Body: { message: string } }>('/api/dashboard/messages/send', async (request, reply) => {
    const message = request.body?.message?.trim();
    if (!message) {
      return reply.code(400).send({ error: 'message required' });
    }

    try {
      const sent = await sendActiveChannelProactiveMessage(runtimeConfig, message);
      if (!sent) {
        return reply.code(400).send({ error: 'No active channel target configured' });
      }
      const activeChannel = getActiveChannelId();
      return {
        sent: true,
        channel: activeChannel,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(500).send({ error: msg });
    }
  });

  fastify.post<{ Body: { message: string; model?: string } }>('/api/dashboard/messages/agent', async (request, reply) => {
    const message = request.body?.message?.trim();
    if (!message) {
      return reply.code(400).send({ error: 'message required' });
    }

    try {
      const response = await runAgentTurn(
        runtimeConfig.agents.default,
        message,
        runtimeConfig,
        request.body?.model || getCurrentModel(),
        undefined,
        undefined,
        {
          channel: 'dashboard',
          trigger: 'api',
          metadata: { source: 'dashboard_messages' },
        },
      );

      return {
        ok: true,
        response,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(500).send({ error: msg });
    }
  });

  fastify.post<{ Params: { id: string } }>('/api/dashboard/cron/:id/run', async (request, reply) => {
    const { id } = request.params;
    try {
      await runCronJob(id, runtimeConfig);
      return { status: 'triggered', id };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(404).send({ error: msg });
    }
  });

  // --- Model ---
  fastify.get('/api/dashboard/model', async () => {
    const aliases = runtimeConfig.models?.aliases || {};
    const mergedAliases = Object.keys(aliases).length > 0
      ? aliases
      : DEFAULT_MODEL_ALIASES;
    const currentModel = getCurrentModel()
      || runtimeConfig.agents?.list?.[runtimeConfig.agents?.default]?.model
      || 'claude-opus';

    return {
      current: currentModel,
      aliases: mergedAliases,
      agents: Object.fromEntries(
        Object.entries(runtimeConfig.agents.list).map(([id, agent]) => [id, agent.model])
      ),
    };
  });

  fastify.post<{ Body: { model: string } }>('/api/dashboard/model', async (request, reply) => {
    const modelInput = request.body?.model;
    if (!modelInput) {
      return reply.code(400).send({ error: 'model required' });
    }

    const selection = resolveModelSelection(modelInput, runtimeConfig);
    if (!selection.ok || !selection.resolved) {
      return reply.code(400).send({ error: selection.error || 'Invalid model selection' });
    }

    setCurrentModel(selection.resolved);
    return { model: selection.resolved };
  });

  // --- Templates ---
  fastify.get<{ Params: { agentId: string } }>('/api/dashboard/templates/:agentId', async (request, reply) => {
    const { agentId } = request.params;
    if (!isValidAgentId(agentId)) {
      return reply.code(400).send({ error: 'Invalid agent ID' });
    }
    const agentDir = getAgentDir(agentId);

    const templates = TEMPLATE_FILES.map(name => {
      const filePath = join(agentDir, name);
      const fileExists = existsSync(filePath);
      return {
        name,
        exists: fileExists,
        size: fileExists ? statSync(filePath).size : 0,
      };
    });

    return { templates };
  });

  fastify.get<{
    Params: { agentId: string; name: string };
  }>('/api/dashboard/templates/:agentId/:name', async (request, reply) => {
    const { agentId, name } = request.params;
    if (!isValidAgentId(agentId)) {
      return reply.code(400).send({ error: 'Invalid agent ID' });
    }
    const content = getAgentTemplateContent(agentId, name);
    if (content === null) {
      return reply.code(404).send({ error: 'Template not found' });
    }
    return { name, content };
  });

  fastify.put<{
    Params: { agentId: string; name: string };
    Body: { content: string };
  }>('/api/dashboard/templates/:agentId/:name', async (request, reply) => {
    const { agentId, name } = request.params;
    if (!isValidAgentId(agentId)) {
      return reply.code(400).send({ error: 'Invalid agent ID' });
    }
    const { content } = request.body;

    if (typeof content !== 'string') {
      return reply.code(400).send({ error: 'content required' });
    }

    try {
      saveAgentTemplate(agentId, name, content);
      return { saved: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(400).send({ error: msg });
    }
  });

  // --- Logs ---
  // Recursively collect log files from a directory
  function collectLogFiles(dir: string, prefix = ''): { name: string; size: number; modified: string }[] {
    if (!existsSync(dir)) return [];

    const results: { name: string; size: number; modified: string }[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const displayName = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push(...collectLogFiles(join(dir, entry.name), displayName));
      } else if (/\.(log|txt)$/i.test(entry.name)) {
        const filePath = join(dir, entry.name);
        const stat = statSync(filePath);
        results.push({ name: displayName, size: stat.size, modified: stat.mtime.toISOString() });
      }
    }
    return results;
  }

  fastify.get('/api/dashboard/logs', async () => {
    const logsDir = getLogsDir();
    const files = collectLogFiles(logsDir).sort((a, b) => b.modified.localeCompare(a.modified));
    return { files };
  });

  // --- TODOs ---
  fastify.get('/api/dashboard/todos', async (request, reply) => {
    const todoPath = getTodoPath();
    if (!existsSync(todoPath)) {
      return reply.code(404).send({ error: `TODO file not found: ${todoPath}` });
    }

    const content = readFileSync(todoPath, 'utf-8');
    const items = parseTodoItems(content).map(({ prefix: _prefix, lineIndex: _lineIndex, ...item }) => item);
    const completed = items.filter(i => i.completed).length;

    return {
      path: todoPath,
      total: items.length,
      completed,
      remaining: items.length - completed,
      items,
    };
  });

  fastify.put<{
    Params: { id: string };
    Body: { completed?: boolean };
  }>('/api/dashboard/todos/:id', async (request, reply) => {
    const todoId = Number.parseInt(request.params.id, 10);
    if (Number.isNaN(todoId) || todoId < 0) {
      return reply.code(400).send({ error: 'Invalid todo id' });
    }

    const todoPath = getTodoPath();
    if (!existsSync(todoPath)) {
      return reply.code(404).send({ error: `TODO file not found: ${todoPath}` });
    }

    const content = readFileSync(todoPath, 'utf-8');
    const hadTrailingNewline = content.endsWith('\n');
    const lines = content.split('\n');
    const items = parseTodoItems(content);
    const target = items.find(i => i.id === todoId);
    if (!target) {
      return reply.code(404).send({ error: 'TODO item not found' });
    }

    const nextCompleted = typeof request.body?.completed === 'boolean'
      ? request.body.completed
      : !target.completed;
    lines[target.lineIndex] = `${target.prefix}[${nextCompleted ? 'x' : ' '}] ${target.text}`;
    const nextContent = lines.join('\n') + (hadTrailingNewline ? '\n' : '');
    writeFileSync(todoPath, nextContent, 'utf-8');

    const updatedItems = parseTodoItems(nextContent).map(({ prefix: _prefix, lineIndex: _lineIndex, ...item }) => item);
    const completed = updatedItems.filter(i => i.completed).length;
    return {
      updated: true,
      item: updatedItems.find(i => i.id === todoId),
      total: updatedItems.length,
      completed,
      remaining: updatedItems.length - completed,
      items: updatedItems,
    };
  });

  fastify.get<{
    Params: { filename: string };
    Querystring: { tail?: string };
  }>('/api/dashboard/logs/:filename', async (request, reply) => {
    const { filename } = request.params;
    const tail = request.query.tail ? parseInt(request.query.tail, 10) : undefined;

    // Allow subdirectory paths like "cron/morning-2026-02-05.log" but block traversal
    if (filename.includes('..')) {
      return reply.code(400).send({ error: 'Invalid filename' });
    }

    const logsDir = getLogsDir();
    const filePath = join(logsDir, filename);

    // Ensure resolved path stays within logs dir
    if (!resolve(filePath).startsWith(resolve(logsDir))) {
      return reply.code(400).send({ error: 'Invalid filename' });
    }

    if (!existsSync(filePath)) {
      return reply.code(404).send({ error: 'Log file not found' });
    }

    const content = readFileSync(filePath, 'utf-8');
    const allLines = content.split('\n');

    if (tail && tail > 0) {
      const tailedLines = allLines.slice(-tail);
      return { content: tailedLines.join('\n'), lines: allLines.length };
    }

    return { content, lines: allLines.length };
  });

  // --- Config ---
  fastify.get('/api/dashboard/config', async () => {
    // Reload from disk each time to get fresh state
    const freshConfig = loadConfig();
    const redacted = redactSecrets(freshConfig as unknown as Record<string, any>);
    return { config: redacted };
  });

  fastify.put<{ Body: { config: any } }>('/api/dashboard/config', async (request, reply) => {
    const { config: newConfig } = request.body;

    if (!newConfig || typeof newConfig !== 'object') {
      return reply.code(400).send({ error: 'config object required' });
    }

    // Basic structural validation
    if (!newConfig.gateway || !newConfig.agents || !newConfig.models || !newConfig.cron) {
      return reply.code(400).send({ error: 'Missing required config sections (gateway, agents, models, cron)' });
    }

    // Load the raw config (without env var expansion) to preserve ${VAR} references
    const existingRaw = loadRawConfig();

    // Merge secrets back - walk the new config and replace [REDACTED] with existing values
    const merged = mergeSecrets(newConfig, existingRaw);

    try {
      saveConfig(merged as Config);
      return { saved: true, restartRequired: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(500).send({ error: msg });
    }
  });

  fastify.post('/api/dashboard/restart', async () => {
    // Respond first, then terminate so process manager (launchd/systemd) can restart.
    setTimeout(() => process.exit(0), 150);
    return { restarting: true };
  });

  fastify.post('/api/dashboard/reload', async (_request, reply) => {
    try {
      const newConfig = loadConfig();

      // Update runtimeConfig BEFORE reinit calls that depend on it
      runtimeConfig = newConfig;

      // Update gateway's live config reference
      setGatewayConfig(newConfig);

      // Reinitialize providers (clears stale state first)
      initProviders(newConfig);

      // Reinitialize code agent config
      setCodeAgentConfig(newConfig);

      // Reinitialize cron scheduler
      initCron(newConfig);

      // Reinitialize heartbeat (stop existing timer first, then start new one)
      stopHeartbeat();
      initHeartbeat(newConfig);

      // Reinitialize active channel (best-effort restart sequence)
      try {
        await stopActiveChannel();
        await initActiveChannel(newConfig);
        await startActiveChannel();
      } catch (channelErr) {
        const msg = channelErr instanceof Error ? channelErr.message : String(channelErr);
        console.warn('[reload] Channel restart warning:', msg);
      }

      console.log('[reload] Config reloaded successfully');
      return { reloaded: true, timestamp: new Date().toISOString() };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[reload] Failed to reload config:', msg);
      return reply.code(500).send({ error: `Reload failed: ${msg}` });
    }
  });

  fastify.post('/api/dashboard/mcp/reconnect', async () => {
    const { reconnectMcp } = await import('./tools.js');
    await reconnectMcp();
    return { reconnected: true, timestamp: new Date().toISOString() };
  });

  // --- Audit Log ---
  // Reads from ~/.skimpyclaw/logs/audit/YYYY-MM-DD.jsonl files
  fastify.get<{
    Querystring: { limit?: string; offset?: string; trigger?: string };
  }>('/api/dashboard/audit', async (request) => {
    const limit = Math.min(parseInt(request.query.limit || '50', 10), 200);
    const offset = parseInt(request.query.offset || '0', 10);
    const triggerFilter = request.query.trigger;

    const { traces, total } = await readAuditTraces({ limit, offset, trigger: triggerFilter });

    return { traces, total, limit, offset };
  });

  // --- Usage ---
  fastify.get('/api/dashboard/usage', async () => {
    return getUsageSummary();
  });

  fastify.get<{
    Querystring: { limit?: string; offset?: string; model?: string };
  }>('/api/dashboard/usage/records', async (request) => {
    const limit = Math.min(parseInt(request.query.limit || '50', 10), 200);
    const offset = parseInt(request.query.offset || '0', 10);
    const model = request.query.model;

    const { records, total } = readUsageRecords({ limit, offset, model });
    return { records, total, limit, offset };
  });

  // --- Health ---
  fastify.get('/api/dashboard/health', async () => {
    const { report } = await runDoctorChecks();

    // Build feature toggles summary from config
    const features: Record<string, boolean> = {
      telegram: runtimeConfig.channels.telegram?.enabled ?? false,
      discord: runtimeConfig.channels.discord?.enabled ?? false,
      browser: Boolean(
        runtimeConfig.channels.telegram?.tools?.browser?.enabled
        || runtimeConfig.channels.discord?.tools?.browser?.enabled
        || runtimeConfig.heartbeat?.tools?.browser?.enabled,
      ),
      voice: Boolean(runtimeConfig.voice?.enabled),
    };

    // Check which env vars are set vs missing by reading raw config for ${VAR} refs
    const envVars: Array<{ name: string; set: boolean }> = [];
    try {
      const raw = loadRawConfig();
      const rawStr = JSON.stringify(raw);
      const matches = rawStr.matchAll(/\$\{(\w+)\}/g);
      const seen = new Set<string>();
      for (const m of matches) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        envVars.push({ name: m[1], set: process.env[m[1]] !== undefined });
      }
    } catch {
      // Config not readable — health checks will report this
    }

    return {
      ok: report.ok,
      checks: report.checks,
      features,
      envVars,
    };
  });

  // --- Doctor ---
  fastify.get('/api/dashboard/doctor', async () => {
    const { report } = await runDoctorChecks();
    return { report };
  });

  // --- Code Agents (Multi-Agent) ---
  fastify.get('/api/dashboard/code-agents', async () => {
    const agents = getAllCodeAgents();
    return { agents };
  });

  fastify.get<{ Params: { id: string } }>('/api/dashboard/code-agents/:id', async (request, reply) => {
    const { id } = request.params;
    const agent = getCodeAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: 'Code agent not found' });
    }
    return agent;
  });

  fastify.post<{ Params: { id: string } }>('/api/dashboard/code-agents/:id/cancel', async (request, reply) => {
    const { id } = request.params;
    const agent = cancelCodeAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: 'Code agent not found' });
    }
    return { cancelled: agent.status === 'cancelled', id, status: agent.status };
  });

  // --- Exec Approvals ---
  fastify.get('/api/dashboard/approvals', async (request) => {
    const pending = listApprovals();
    const recent = listApprovals({ includeResolved: true, limit: 50 });
    return { pending, recent, now: new Date().toISOString() };
  });

  fastify.post<{ Params: { id: string } }>('/api/dashboard/approvals/:id/approve', async (request, reply) => {
    const { id } = request.params;
    const approval = getApproval(id);
    if (!approval) {
      return reply.code(404).send({ error: 'Approval request not found' });
    }
    if (approval.status !== 'pending') {
      return reply.code(400).send({ error: `Request is already ${approval.status}` });
    }
    const success = approveRequest(id, 'dashboard');
    if (!success) {
      return reply.code(400).send({ error: 'Failed to approve request' });
    }
    return { approved: true, id, command: approval.command };
  });

  fastify.post<{ Params: { id: string } }>('/api/dashboard/approvals/:id/deny', async (request, reply) => {
    const { id } = request.params;
    const approval = getApproval(id);
    if (!approval) {
      return reply.code(404).send({ error: 'Approval request not found' });
    }
    if (approval.status !== 'pending') {
      return reply.code(400).send({ error: `Request is already ${approval.status}` });
    }
    const success = denyRequest(id, 'dashboard');
    if (!success) {
      return reply.code(400).send({ error: 'Failed to deny request' });
    }
    return { denied: true, id, command: approval.command };
  });

  // --- Digests ---
  fastify.get('/api/dashboard/digests', async () => {
    const digests = getDigests();
    return { digests };
  });

  fastify.get<{ Params: { id: string } }>('/api/dashboard/digests/:id', async (request, reply) => {
    const { id } = request.params;
    const digest = getDigest(id);
    if (!digest) {
      return reply.code(404).send({ error: 'Digest not found' });
    }
    return digest;
  });

  fastify.delete<{ Params: { id: string } }>('/api/dashboard/digests/:id', async (request, reply) => {
    const { id } = request.params;
    const deleted = deleteDigest(id);
    if (!deleted) {
      return reply.code(404).send({ error: 'Digest not found' });
    }
    return { deleted: true };
  });

  fastify.post<{ Params: { digestId: string; articleId: string }; Body: { read?: boolean } }>('/api/dashboard/digests/:digestId/articles/:articleId/read', async (request, reply) => {
    const { digestId, articleId } = request.params;
    const read = typeof request.body?.read === 'boolean' ? request.body.read : true;
    const updated = updateArticleReadStatus(digestId, articleId, read);
    if (!updated) {
      return reply.code(404).send({ error: 'Digest or article not found' });
    }
    return { updated: true, read };
  });

  // --- Skills ---
  fastify.get('/api/dashboard/skills', async () => {
    const skillConfig = (runtimeConfig as any).skills as SkillConfig | undefined;
    // Use active channel's toolConfig so eligibility checks reflect actual tool availability
    const activeChannel = runtimeConfig.channels?.active || 'telegram';
    const toolConfig = (runtimeConfig.channels as any)?.[activeChannel]?.tools;
    const skills = loadSkills(skillConfig, toolConfig);
    return {
      skills: skills.map(s => ({
        name: s.name,
        description: s.frontmatter.description,
        emoji: s.frontmatter.emoji,
        tags: s.frontmatter.tags,
        enabled: s.frontmatter.enabled !== false,
        eligible: s.eligible,
        reason: s.reason,
        priority: s.frontmatter.priority,
        contexts: s.frontmatter.contexts,
        requires: s.frontmatter.requires,
      })),
    };
  });

  fastify.get<{ Params: { name: string } }>('/api/dashboard/skills/:name', async (request, reply) => {
    const { name } = request.params;
    if (!validateSkillName(name)) {
      return reply.code(400).send({ error: 'Invalid skill name' });
    }

    const skillConfig = (runtimeConfig as any).skills as SkillConfig | undefined;
    const activeChannel = runtimeConfig.channels?.active || 'telegram';
    const toolConfig = (runtimeConfig.channels as any)?.[activeChannel]?.tools;
    const skills = loadSkills(skillConfig, toolConfig);
    const skill = skills.find(s => s.name === name);
    if (!skill) {
      return reply.code(404).send({ error: 'Skill not found' });
    }

    // Read the raw SKILL.md content
    const skillPath = join(skill.dirPath, 'SKILL.md');
    let rawContent = '';
    if (existsSync(skillPath)) {
      rawContent = readFileSync(skillPath, 'utf-8');
    }

    return {
      name: skill.name,
      description: skill.frontmatter.description,
      emoji: skill.frontmatter.emoji,
      tags: skill.frontmatter.tags,
      enabled: skill.frontmatter.enabled !== false,
      eligible: skill.eligible,
      reason: skill.reason,
      priority: skill.frontmatter.priority,
      contexts: skill.frontmatter.contexts,
      requires: skill.frontmatter.requires,
      body: skill.body,
      rawContent,
    };
  });

  fastify.put<{
    Params: { name: string };
    Body: { enabled?: boolean; content?: string };
  }>('/api/dashboard/skills/:name', async (request, reply) => {
    const { name } = request.params;
    if (!validateSkillName(name)) {
      return reply.code(400).send({ error: 'Invalid skill name' });
    }

    // Verify skill exists
    const skillDir = join(getSkillsDir(runtimeConfig), name);
    if (!existsSync(join(skillDir, 'SKILL.md'))) {
      return reply.code(404).send({ error: 'Skill not found' });
    }

    const { enabled, content } = request.body;
    const hasEnabled = typeof enabled === 'boolean';
    const hasContent = typeof content === 'string';
    if (!hasEnabled && !hasContent) {
      return reply.code(400).send({ error: 'enabled (boolean) or content (string) required' });
    }

    if (hasEnabled) {
      // Update config.skills.entries[name]
      const raw = loadRawConfig();
      if (!raw.skills) raw.skills = {};
      if (!raw.skills.entries) raw.skills.entries = {};
      raw.skills.entries[name] = enabled;
      saveConfig(raw as Config);
    }

    if (hasContent) {
      writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf-8');
    }

    return { updated: true, name, enabled, contentUpdated: hasContent, restartRequired: hasEnabled };
  });

  fastify.post<{
    Body: { name: string; content: string };
  }>('/api/dashboard/skills', async (request, reply) => {
    const { name, content } = request.body;
    if (!name || !validateSkillName(name)) {
      return reply.code(400).send({ error: 'Invalid or missing skill name (alphanumeric + hyphens only)' });
    }
    if (!content || typeof content !== 'string') {
      return reply.code(400).send({ error: 'content (string) required' });
    }

    const skillsDir = getSkillsDir(runtimeConfig);
    const skillDir = join(skillsDir, name);

    if (existsSync(join(skillDir, 'SKILL.md'))) {
      return reply.code(409).send({ error: 'Skill already exists' });
    }

    // Ensure directories exist
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf-8');

    return { created: true, name };
  });

  fastify.delete<{ Params: { name: string } }>('/api/dashboard/skills/:name', async (request, reply) => {
    const { name } = request.params;
    if (!validateSkillName(name)) {
      return reply.code(400).send({ error: 'Invalid skill name' });
    }

    const skillDir = join(getSkillsDir(runtimeConfig), name);
    if (!existsSync(skillDir)) {
      return reply.code(404).send({ error: 'Skill not found' });
    }

    rmSync(skillDir, { recursive: true, force: true });

    // Also remove from config entries if present
    const raw = loadRawConfig();
    if (raw.skills?.entries?.[name] !== undefined) {
      delete raw.skills.entries[name];
      saveConfig(raw as Config);
      return { deleted: true, name, restartRequired: true };
    }

    return { deleted: true, name };
  });

}

/**
 * Recursively merge secrets back from existingObj where newObj has [REDACTED].
 */
function mergeSecrets(newObj: any, existingObj: any): any {
  if (!newObj || typeof newObj !== 'object' || !existingObj || typeof existingObj !== 'object') {
    return newObj;
  }

  if (Array.isArray(newObj)) {
    const existingArr = Array.isArray(existingObj) ? existingObj : [];
    return newObj.map((item, i) => mergeSecrets(item, existingArr[i]));
  }

  const result: any = { ...newObj };

  for (const key of Object.keys(result)) {
    if (result[key] === '[REDACTED]' && existingObj[key] !== undefined) {
      result[key] = existingObj[key];
    } else if (result[key] && typeof result[key] === 'object') {
      result[key] = mergeSecrets(result[key], existingObj[key]);
    }
  }

  return result;
}
