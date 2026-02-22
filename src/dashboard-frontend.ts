import { existsSync, readFileSync } from 'fs';
import { extname, isAbsolute, join, relative, resolve } from 'path';
import type { FastifyInstance } from 'fastify';

export interface DashboardFrontendOptions {
  frameworkDistDir?: string;
  botName?: string;
  botEmoji?: string;
}

export function registerDashboard(
  fastify: FastifyInstance,
  options: DashboardFrontendOptions = {},
): void {
  const botName = options.botName ?? 'SkimpyClaw';
  const botEmoji = options.botEmoji ?? '👙🦞';
  const frameworkDistDir = resolve(options.frameworkDistDir ?? join(process.cwd(), 'dist', 'dashboard'));
  const frameworkIndexPath = join(frameworkDistDir, 'index.html');

  const serveFrameworkIndex = async (_request: unknown, reply: any) => {
    if (!existsSync(frameworkIndexPath)) {
      reply.code(503).type('text/plain').send('Dashboard frontend is not built. Run `pnpm dashboard:build`.');
      return;
    }

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

  // Serve root-level static files from dist (e.g. favicon.svg)
  const ALLOWED_ROOT_STATIC_EXTS = new Set(['.svg', '.png', '.ico', '.webmanifest', '.xml']);
  fastify.get<{ Params: { file: string } }>('/:file', async (request, reply) => {
    const fileName = request.params.file;
    const ext = extname(fileName).toLowerCase();
    if (!ALLOWED_ROOT_STATIC_EXTS.has(ext)) {
      reply.callNotFound();
      return;
    }
    const filePath = resolve(frameworkDistDir, fileName);
    const rel = relative(frameworkDistDir, filePath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes('/') || !existsSync(filePath)) {
      reply.code(404).send('Not found');
      return;
    }
    const buffer = readFileSync(filePath);
    reply.type(getMimeType(filePath)).send(buffer);
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
