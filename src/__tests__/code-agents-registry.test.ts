import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareCodeAgentWorktree } from '../code-agents/worktrees.js';

const roots: string[] = [];

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'skimpyclaw-registry-test-'));
  roots.push(root);
  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  writeFileSync(join(root, 'README.md'), '# test\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('os');
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('code agent registry', () => {
  it('cleans interrupted clean worktrees on restore', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'skimpyclaw-home-'));
    roots.push(fakeHome);
    const repo = makeRepo();
    const worktreeRoot = join(fakeHome, 'worktrees');
    const worktree = prepareCodeAgentWorktree({
      id: 'ca-1',
      sourceWorkdir: repo,
      config: { root: worktreeRoot },
      required: true,
    })!;

    const codeAgentsDir = join(fakeHome, '.skimpyclaw', 'logs', 'code-agents');
    mkdirSync(codeAgentsDir, { recursive: true });
    const taskPath = join(codeAgentsDir, 'ca-1.json');
    writeFileSync(taskPath, JSON.stringify({
      id: 'ca-1',
      agent: 'codex',
      task: 'Review PR read-only',
      status: 'running',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      workdir: worktree.runWorkdir,
      sourceWorkdir: worktree.sourceWorkdir,
      worktreePath: worktree.worktreePath,
      worktreeRef: worktree.worktreeRef,
    }, null, 2));

    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof import('os')>('os');
      return { ...actual, homedir: () => fakeHome };
    });
    const registry = await import('../code-agents/registry.js');

    registry.restoreCodeAgentTasks({});

    const task = registry.getCodeAgent('ca-1');
    expect(task?.status).toBe('failed');
    expect(task?.error).toBe('Process interrupted (server restarted)');
    expect(task?.worktreeCleanup?.status).toBe('removed');
    expect(existsSync(worktree.worktreePath)).toBe(false);

    const persisted = JSON.parse(readFileSync(taskPath, 'utf-8'));
    expect(persisted.worktreeCleanup.status).toBe('removed');
  });
});
