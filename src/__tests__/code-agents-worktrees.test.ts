import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupCodeAgentWorktree,
  normalizeWorktreeRequest,
  prepareCodeAgentWorktree,
  shouldAutoWorktreeTask,
  shouldUseCodeAgentWorktree,
} from '../code-agents/worktrees.js';

const roots: string[] = [];

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'skimpyclaw-worktree-test-'));
  roots.push(root);
  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  mkdirSync(join(root, 'packages', 'demo'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# test\n');
  writeFileSync(join(root, 'packages', 'demo', 'package.json'), '{"name":"demo"}\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('code agent worktrees', () => {
  it('normalizes worktree requests', () => {
    expect(normalizeWorktreeRequest(true)).toBe(true);
    expect(normalizeWorktreeRequest('yes')).toBe(true);
    expect(normalizeWorktreeRequest('off')).toBe(false);
    expect(normalizeWorktreeRequest('auto')).toBe('auto');
    expect(normalizeWorktreeRequest('wat')).toBeUndefined();
  });

  it('defaults auto worktrees to review and rebase tasks only', () => {
    expect(shouldAutoWorktreeTask('Review PR https://github.com/org/repo/pull/123')).toBe(true);
    expect(shouldAutoWorktreeTask('rebase this branch from trunk')).toBe(true);
    expect(shouldAutoWorktreeTask('fix this css bug')).toBe(false);
    expect(shouldUseCodeAgentWorktree('fix this css bug', undefined, { mode: 'always' })).toBe(true);
    expect(shouldUseCodeAgentWorktree('Review PR', false, { mode: 'always' })).toBe(false);
  });

  it('creates a detached worktree and preserves subdirectory workdir', () => {
    const repo = makeRepo();
    const root = mkdtempSync(join(tmpdir(), 'skimpyclaw-worktrees-'));
    roots.push(root);

    const result = prepareCodeAgentWorktree({
      id: 'ca-123',
      sourceWorkdir: join(repo, 'packages', 'demo'),
      config: { root },
      required: true,
    });

    expect(result).toBeDefined();
    expect(result?.sourceWorkdir).toBe(realpathSync(join(repo, 'packages', 'demo')));
    expect(result?.runWorkdir).toBe(join(result!.worktreePath, 'packages', 'demo'));
    expect(existsSync(result!.worktreePath)).toBe(true);
    expect(existsSync(result!.runWorkdir)).toBe(true);
    expect(result?.worktreeRef).toMatch(/^[0-9a-f]{40}$/);
  });

  it('removes clean unchanged worktrees', () => {
    const repo = makeRepo();
    const root = mkdtempSync(join(tmpdir(), 'skimpyclaw-worktrees-'));
    roots.push(root);
    const result = prepareCodeAgentWorktree({
      id: 'ca-clean',
      sourceWorkdir: repo,
      config: { root },
      required: true,
    })!;

    const cleanup = cleanupCodeAgentWorktree(result);

    expect(cleanup.status).toBe('removed');
    expect(existsSync(result.worktreePath)).toBe(false);
  });

  it('preserves dirty worktrees', () => {
    const repo = makeRepo();
    const root = mkdtempSync(join(tmpdir(), 'skimpyclaw-worktrees-'));
    roots.push(root);
    const result = prepareCodeAgentWorktree({
      id: 'ca-dirty',
      sourceWorkdir: repo,
      config: { root },
      required: true,
    })!;
    writeFileSync(join(result.worktreePath, 'dirty.txt'), 'dirty\n');

    const cleanup = cleanupCodeAgentWorktree(result);

    expect(cleanup.status).toBe('preserved');
    expect(cleanup.reason).toContain('uncommitted changes');
    expect(existsSync(result.worktreePath)).toBe(true);
  });

  it('preserves worktrees whose HEAD changed', () => {
    const repo = makeRepo();
    const root = mkdtempSync(join(tmpdir(), 'skimpyclaw-worktrees-'));
    roots.push(root);
    const result = prepareCodeAgentWorktree({
      id: 'ca-head',
      sourceWorkdir: repo,
      config: { root },
      required: true,
    })!;
    writeFileSync(join(result.worktreePath, 'README.md'), '# changed\n');
    git(result.worktreePath, ['add', 'README.md']);
    git(result.worktreePath, ['commit', '-m', 'change']);

    const cleanup = cleanupCodeAgentWorktree(result);

    expect(cleanup.status).toBe('preserved');
    expect(cleanup.reason).toContain('HEAD changed');
    expect(existsSync(result.worktreePath)).toBe(true);
  });

  it('skips non-git directories in optional mode and errors in required mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skimpyclaw-not-git-'));
    roots.push(dir);

    expect(prepareCodeAgentWorktree({ id: 'ca-1', sourceWorkdir: dir })).toBeUndefined();
    expect(() => prepareCodeAgentWorktree({ id: 'ca-1', sourceWorkdir: dir, required: true }))
      .toThrow(/not inside a git repository/);
  });
});
