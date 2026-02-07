// Dashboard API endpoints

import { FastifyInstance } from 'fastify';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import type { Config } from './types.js';
import {
  loadConfig,
  loadRawConfig,
  getConfigPath,
  saveConfig,
  getSessionsDir,
  getLogsDir,
  getAgentDir,
  listMemoryFiles,
  readMemoryFile,
} from './config.js';
import {
  TEMPLATE_FILES,
  getAgentTemplateContent,
  saveAgentTemplate,
} from './agent.js';
import { getCronJobs, getCronJobDetails, runCronJob } from './cron.js';
import { getCurrentModel, setCurrentModel, getLastMessage } from './gateway.js';
import { redactSecrets } from './security.js';

function validateFilename(filename: string): boolean {
  return !filename.includes('..') && filename === basename(filename);
}

function validateAgentId(agentId: string): boolean {
  // Agent IDs should be simple identifiers: alphanumeric, hyphens, underscores
  return /^[a-zA-Z0-9_-]+$/.test(agentId);
}

function validateModelString(model: string): boolean {
  // Allow alphanumeric, hyphens, underscores, dots, slashes (for provider/model format)
  return /^[a-zA-Z0-9_./-]+$/.test(model) && model.length <= 100;
}

export function registerDashboardAPI(fastify: FastifyInstance, config: Config): void {
  // --- Auth middleware for all dashboard routes ---
  fastify.addHook('onRequest', async (request, reply) => {
    const url = request.url;
    // Only protect API routes - the dashboard HTML page must load without auth
    // so it can display the token prompt
    if (!url.startsWith('/api/dashboard')) {
      return; // Not a dashboard API route, skip auth
    }

    const token = config.dashboard?.token;
    if (!token) {
      return; // No token configured, allow access
    }

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Unauthorized: Bearer token required' });
    }

    const providedToken = authHeader.slice(7);
    if (providedToken !== token) {
      return reply.code(401).send({ error: 'Unauthorized: Invalid token' });
    }
  });

  // --- Status ---
  fastify.get('/api/dashboard/status', async () => {
    const jobs = getCronJobs();
    const uptime = process.uptime();
    return {
      uptime,
      model: getCurrentModel(),
      agent: config.agents.default,
      lastMessage: getLastMessage(),
      cronJobs: jobs,
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
    if (!validateAgentId(agentId)) {
      return reply.code(400).send({ error: 'Invalid agent ID' });
    }
    const files = listMemoryFiles(agentId);
    return { files };
  });

  fastify.get<{
    Params: { agentId: string; filename: string };
  }>('/api/dashboard/memory/:agentId/:filename', async (request, reply) => {
    const { agentId, filename } = request.params;
    if (!validateAgentId(agentId)) {
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
    const jobs = getCronJobDetails(config);
    return { jobs };
  });

  fastify.post<{ Params: { id: string } }>('/api/dashboard/cron/:id/run', async (request, reply) => {
    const { id } = request.params;
    try {
      await runCronJob(id, config);
      return { status: 'triggered', id };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(404).send({ error: msg });
    }
  });

  // --- Model ---
  fastify.get('/api/dashboard/model', async () => {
    return {
      current: getCurrentModel(),
      aliases: config.models.aliases,
      agents: Object.fromEntries(
        Object.entries(config.agents.list).map(([id, agent]) => [id, agent.model])
      ),
    };
  });

  fastify.post<{ Body: { model: string } }>('/api/dashboard/model', async (request, reply) => {
    const { model } = request.body;
    if (!model) {
      return reply.code(400).send({ error: 'model required' });
    }
    if (!validateModelString(model)) {
      return reply.code(400).send({ error: 'Invalid model string' });
    }
    setCurrentModel(model);
    return { model };
  });

  // --- Templates ---
  fastify.get<{ Params: { agentId: string } }>('/api/dashboard/templates/:agentId', async (request, reply) => {
    const { agentId } = request.params;
    if (!validateAgentId(agentId)) {
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
    if (!validateAgentId(agentId)) {
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
    if (!validateAgentId(agentId)) {
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
    const { resolve } = await import('path');
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
      return { saved: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(500).send({ error: msg });
    }
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
