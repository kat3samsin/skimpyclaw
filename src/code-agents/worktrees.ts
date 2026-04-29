import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { basename, join, relative, resolve } from 'path';

export type CodeAgentWorktreeMode = 'off' | 'auto' | 'always';
export type CodeAgentWorktreeRequest = boolean | 'auto' | undefined;

export interface CodeAgentWorktreeConfig {
  enabled?: boolean;
  mode?: CodeAgentWorktreeMode;
  root?: string;
  cleanup?: boolean;
}

export interface PreparedCodeAgentWorktree {
  sourceWorkdir: string;
  worktreePath: string;
  runWorkdir: string;
  worktreeRef: string;
  gitRoot: string;
}

export interface CodeAgentWorktreeCleanupResult {
  status: 'removed' | 'preserved' | 'skipped' | 'failed';
  path?: string;
  reason?: string;
  at: string;
}

export function normalizeWorktreeRequest(value: unknown): CodeAgentWorktreeRequest {
  if (value === true || value === false || value === 'auto') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(normalized)) return true;
  if (['false', 'no', 'off', '0'].includes(normalized)) return false;
  if (normalized === 'auto') return 'auto';
  return undefined;
}

export function shouldAutoWorktreeTask(task: string): boolean {
  return /\b(rebase|review|re-review|pr review|pull request|compare|diff)\b/i.test(task)
    || /https?:\/\/[^\s]+\/pull\/\d+/i.test(task);
}

export function shouldUseCodeAgentWorktree(
  task: string,
  request: CodeAgentWorktreeRequest,
  config?: CodeAgentWorktreeConfig
): boolean {
  if (request === false) return false;
  if (request === true) return true;
  if (config?.enabled === false || config?.mode === 'off') return false;
  if (config?.mode === 'always') return true;
  return shouldAutoWorktreeTask(task);
}

function expandWorktreeRoot(root?: string): string {
  const raw = root?.trim() || '~/.skimpyclaw/worktrees';
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  return raw.replace(/\$\{HOME\}/g, homedir());
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function findGitRoot(workdir: string): string | null {
  try {
    return git(['rev-parse', '--show-toplevel'], workdir);
  } catch {
    return null;
  }
}

export function prepareCodeAgentWorktree(options: {
  id: string;
  sourceWorkdir: string;
  config?: CodeAgentWorktreeConfig;
  required?: boolean;
}): PreparedCodeAgentWorktree | undefined {
  const sourceWorkdir = realpathSync(resolve(options.sourceWorkdir));
  const rawGitRoot = findGitRoot(sourceWorkdir);
  if (!rawGitRoot) {
    if (options.required) {
      throw new Error(`Cannot create worktree: ${sourceWorkdir} is not inside a git repository.`);
    }
    return undefined;
  }
  const gitRoot = realpathSync(rawGitRoot);

  const worktreeRef = git(['rev-parse', '--verify', 'HEAD'], gitRoot);
  const root = resolve(expandWorktreeRoot(options.config?.root));
  const worktreePath = join(root, slug(basename(gitRoot)), options.id);
  if (existsSync(worktreePath)) {
    throw new Error(`Cannot create worktree: ${worktreePath} already exists.`);
  }

  mkdirSync(join(root, slug(basename(gitRoot))), { recursive: true });
  git(['worktree', 'add', '--detach', worktreePath, worktreeRef], gitRoot);

  const rel = relative(gitRoot, sourceWorkdir);
  const runWorkdir = rel && !rel.startsWith('..') && rel !== '.'
    ? join(worktreePath, rel)
    : worktreePath;

  return { sourceWorkdir, worktreePath, runWorkdir, worktreeRef, gitRoot };
}

export function cleanupCodeAgentWorktree(options: {
  sourceWorkdir?: string;
  worktreePath?: string;
  worktreeRef?: string;
  config?: CodeAgentWorktreeConfig;
}): CodeAgentWorktreeCleanupResult {
  const at = new Date().toISOString();
  const path = options.worktreePath;
  if (!path) return { status: 'skipped', reason: 'no worktree', at };
  if (options.config?.cleanup === false) {
    return { status: 'preserved', path, reason: 'cleanup disabled', at };
  }
  if (!existsSync(path)) return { status: 'skipped', path, reason: 'already removed', at };

  try {
    const worktreeRoot = realpathSync(path);
    const status = git(['status', '--porcelain'], worktreeRoot);
    if (status.trim()) {
      return { status: 'preserved', path, reason: 'worktree has uncommitted changes', at };
    }

    const currentRef = git(['rev-parse', '--verify', 'HEAD'], worktreeRoot);
    if (options.worktreeRef && currentRef !== options.worktreeRef) {
      return { status: 'preserved', path, reason: 'worktree HEAD changed', at };
    }

    const sourceGitRoot = options.sourceWorkdir ? findGitRoot(options.sourceWorkdir) : null;
    const controller = sourceGitRoot || worktreeRoot;
    git(['worktree', 'remove', '--force', worktreeRoot], controller);
    return { status: 'removed', path, at };
  } catch (err) {
    return {
      status: 'failed',
      path,
      reason: err instanceof Error ? err.message : String(err),
      at,
    };
  }
}
