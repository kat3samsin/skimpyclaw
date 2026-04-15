import type { FastifyInstance } from 'fastify';
import { resolve } from 'path';
import { homedir } from 'os';
import { existsSync, statSync } from 'fs';
import { spawn, execFile } from 'child_process';
import { validateBearerToken } from './utils.js';
import type { Config } from './types.js';
import { isPathAllowed } from './tools/path-utils.js';
import {
  listWorkItems,
  getWorkItem,
  createWorkItem,
  appendUserMessage,
  approvePlan,
  pauseWorkItem,
  resumeWorkItem,
  stopWorkItem,
  tickWorkItem,
} from './code-agents/review-loop.js';
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from './code-agents/review-loop-types.js';

const WORK_ID_RE = /^RL-\d{3,}$/;

function isValidWorkId(id: string): boolean {
  return WORK_ID_RE.test(id);
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

function resolveAndValidateWorkdir(
  rawWorkdir: string,
  projects: Record<string, string>,
  allowedPaths: string[],
): { ok: true; workdir: string } | { ok: false; error: string } {
  // Project name alias first
  if (projects[rawWorkdir]) {
    const wd = resolve(expandHome(projects[rawWorkdir]));
    if (!existsSync(wd) || !statSync(wd).isDirectory()) {
      return { ok: false, error: `project workdir does not exist: ${wd}` };
    }
    return { ok: true, workdir: wd };
  }
  const resolved = resolve(expandHome(rawWorkdir));
  const projectPaths = Object.values(projects).map(p => resolve(expandHome(p)));
  const effective = [...allowedPaths.map(expandHome), ...projectPaths];
  if (!isPathAllowed(resolved, effective)) {
    const aliases = Object.keys(projects);
    const hint = aliases.length ? ` (or project names: ${aliases.join(', ')})` : '';
    return {
      ok: false,
      error: `workdir not allowed. Permitted: ${allowedPaths.join(', ') || '(none)'}${hint}`,
    };
  }
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    return { ok: false, error: `workdir does not exist: ${resolved}` };
  }
  return { ok: true, workdir: resolved };
}

export function registerWorkAPI(fastify: FastifyInstance, config: Config): void {
  const runtimeConfig = config;

  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/dashboard/work')) return;
    const token = runtimeConfig.dashboard?.token;
    if (!token) return;
    if (!validateBearerToken(token, request.headers.authorization)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  fastify.get('/api/dashboard/work', async (request) => {
    const q = request.query as { status?: string };
    const all = listWorkItems();
    let filtered = all;
    if (q.status === 'active') {
      filtered = all.filter(i => ACTIVE_STATUSES.includes(i.status));
    } else if (q.status === 'done') {
      filtered = all.filter(i => TERMINAL_STATUSES.includes(i.status));
    }
    return { items: filtered };
  });

  fastify.get('/api/dashboard/work/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidWorkId(id)) {
      return reply.code(400).send({ error: 'invalid id format' });
    }
    const item = getWorkItem(id);
    if (!item) return reply.code(404).send({ error: 'not found' });
    return item;
  });

  fastify.post('/api/dashboard/work', async (request, reply) => {
    const body = request.body as any;
    if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
      return reply.code(400).send({ error: 'prompt is required' });
    }
    if (typeof body.workdir !== 'string' || !body.workdir.trim()) {
      return reply.code(400).send({ error: 'workdir is required' });
    }
    const projects = (runtimeConfig as any).projects ?? {};
    const allowedPaths = (runtimeConfig as any).tools?.allowedPaths ?? [];
    const wd = resolveAndValidateWorkdir(body.workdir, projects, allowedPaths);
    if (!wd.ok) {
      return reply.code(400).send({ error: wd.error });
    }
    const state = createWorkItem({
      prompt: body.prompt,
      workdir: wd.workdir,
      baseRef: typeof body.baseRef === 'string' ? body.baseRef : undefined,
      plannerModel: typeof body.plannerModel === 'string' ? body.plannerModel : undefined,
      devModel: typeof body.devModel === 'string' ? body.devModel : undefined,
      reviewerModel: typeof body.reviewerModel === 'string' ? body.reviewerModel : undefined,
      maxIterations: typeof body.maxIterations === 'number' ? body.maxIterations : undefined,
      autoApprove: body.autoApprove === true,
    });
    void tickWorkItem(state.id).catch(err => console.error('[api-work] tick error:', err));
    return reply.code(201).send(state);
  });

  fastify.post('/api/dashboard/work/:id/chat', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidWorkId(id)) return reply.code(400).send({ error: 'invalid id' });
    const body = request.body as any;
    if (!body || typeof body.content !== 'string' || !body.content.trim()) {
      return reply.code(400).send({ error: 'content is required' });
    }
    const state = appendUserMessage(id, body.content);
    if (!state) return reply.code(404).send({ error: 'not found' });
    void tickWorkItem(id).catch(err => console.error('[api-work] tick error:', err));
    return state;
  });

  fastify.post('/api/dashboard/work/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidWorkId(id)) return reply.code(400).send({ error: 'invalid id' });
    const state = approvePlan(id);
    if (!state) {
      const existing = getWorkItem(id);
      if (!existing) return reply.code(404).send({ error: 'not found' });
      return reply.code(409).send({ error: `cannot approve from status ${existing.status}` });
    }
    void tickWorkItem(id).catch(err => console.error('[api-work] tick error:', err));
    return state;
  });

  fastify.post('/api/dashboard/work/:id/pause', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidWorkId(id)) return reply.code(400).send({ error: 'invalid id' });
    const state = pauseWorkItem(id);
    if (!state) return reply.code(404).send({ error: 'not found' });
    return state;
  });

  fastify.post('/api/dashboard/work/:id/resume', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidWorkId(id)) return reply.code(400).send({ error: 'invalid id' });
    const state = resumeWorkItem(id);
    if (!state) return reply.code(404).send({ error: 'not found' });
    void tickWorkItem(id).catch(err => console.error('[api-work] tick error:', err));
    return state;
  });

  fastify.post('/api/dashboard/work/:id/stop', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidWorkId(id)) return reply.code(400).send({ error: 'invalid id' });
    const body = request.body as any;
    const reason = body && typeof body.reason === 'string' ? body.reason : undefined;
    const state = stopWorkItem(id, reason);
    if (!state) return reply.code(404).send({ error: 'not found' });
    return state;
  });

  // Native folder picker. macOS only; returns POSIX path or { cancelled: true }.
  fastify.post('/api/dashboard/work/pick-workdir', async (_request, reply) => {
    if (process.platform !== 'darwin') {
      return reply.code(501).send({ error: 'folder picker only supported on macOS' });
    }
    return new Promise((resolve) => {
      // Force the dialog to front: use SystemUIServer activation so the picker
      // surfaces even when the gateway is launchd-spawned with no UI context.
      const args = [
        '-e', 'tell application "System Events" to activate',
        '-e', 'set f to choose folder with prompt "Select workdir"',
        '-e', 'POSIX path of f',
      ];
      execFile('osascript', args, { timeout: 120_000 }, (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr ?? '') + err.message;
          if (/User canceled|-128/i.test(msg)) {
            resolve(reply.send({ cancelled: true }));
            return;
          }
          resolve(reply.code(500).send({ error: msg }));
          return;
        }
        const path = stdout.trim().replace(/\/$/, '');
        resolve(reply.send({ path }));
      });
    });
  });

  // Open the work item's workdir in the OS file manager. macOS: `open`.
  // Linux: `xdg-open`. Windows: `explorer`. Path is the stored workdir, which
  // was validated against allowedPaths at creation time.
  fastify.post('/api/dashboard/work/:id/open-workdir', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidWorkId(id)) return reply.code(400).send({ error: 'invalid id' });
    const item = getWorkItem(id);
    if (!item) return reply.code(404).send({ error: 'not found' });
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'explorer'
      : 'xdg-open';
    try {
      spawn(cmd, [item.workdir], { detached: true, stdio: 'ignore' }).unref();
      return { opened: true, workdir: item.workdir };
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? 'failed to open' });
    }
  });
}
