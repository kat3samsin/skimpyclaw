// Git worktree isolation for parallel coding agents.
// Each parallel child gets its own worktree so they can't overwrite each other.

import { execSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';

export interface WorktreeInfo {
  /** Absolute path to the worktree directory */
  path: string;
  /** Branch name created for this worktree */
  branch: string;
}

/**
 * Check if a directory is inside a git repo.
 */
export function isGitRepo(workdir: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: workdir,
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the git repo root directory.
 */
export function getGitRoot(workdir: string): string {
  return execSync('git rev-parse --show-toplevel', {
    cwd: workdir,
    timeout: 5000,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Stage and commit all current changes so worktrees branch from a clean state.
 * Returns the commit hash, or null if nothing to commit.
 */
export function commitPendingChanges(workdir: string, message: string): string | null {
  try {
    // Check for any changes (staged or unstaged)
    const status = execSync('git status --porcelain', {
      cwd: workdir,
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!status) return null;

    execSync('git add -A && git commit -m ' + JSON.stringify(message), {
      cwd: workdir,
      timeout: 10000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return execSync('git rev-parse HEAD', {
      cwd: workdir,
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Create a git worktree for a child agent.
 * Creates a new branch and worktree directory under .skimpyclaw-worktrees/.
 */
export function createWorktree(workdir: string, childId: string): WorktreeInfo {
  const gitRoot = getGitRoot(workdir);
  const worktreeDir = join(gitRoot, '.skimpyclaw-worktrees', childId);
  const branch = `skimpyclaw-team/${childId}`;

  // Clean up stale worktree/branch if they exist
  try {
    execSync(`git worktree remove --force ${JSON.stringify(worktreeDir)}`, {
      cwd: gitRoot,
      timeout: 10000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { /* didn't exist */ }
  try {
    execSync(`git branch -D ${JSON.stringify(branch)}`, {
      cwd: gitRoot,
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { /* didn't exist */ }

  // Create worktree on a new branch from HEAD
  execSync(`git worktree add -b ${JSON.stringify(branch)} ${JSON.stringify(worktreeDir)} HEAD`, {
    cwd: gitRoot,
    timeout: 15000,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return { path: worktreeDir, branch };
}

/**
 * Merge a child's worktree branch back into the current branch.
 * Returns { merged: true } on success, { merged: false, conflict: string } on conflict.
 */
export function mergeWorktree(
  workdir: string,
  branch: string,
  childId: string,
): { merged: boolean; conflict?: string } {
  const gitRoot = getGitRoot(workdir);
  try {
    // First check if the child branch has any changes compared to where it branched
    const diff = execSync(`git diff HEAD...${JSON.stringify(branch)} --stat`, {
      cwd: gitRoot,
      timeout: 10000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

    if (!diff) {
      // No changes on child branch — nothing to merge
      return { merged: true };
    }

    execSync(`git merge --no-edit ${JSON.stringify(branch)}`, {
      cwd: gitRoot,
      timeout: 15000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { merged: true };
  } catch (err) {
    // Merge conflict — abort and report
    try {
      execSync('git merge --abort', {
        cwd: gitRoot,
        timeout: 5000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { /* no merge in progress */ }

    const conflict = err instanceof Error ? err.message : String(err);
    return { merged: false, conflict: conflict.slice(0, 2000) };
  }
}

/**
 * Remove a worktree and its branch.
 */
export function removeWorktree(workdir: string, childId: string, branch: string): void {
  const gitRoot = getGitRoot(workdir);
  const worktreeDir = join(gitRoot, '.skimpyclaw-worktrees', childId);

  try {
    execSync(`git worktree remove --force ${JSON.stringify(worktreeDir)}`, {
      cwd: gitRoot,
      timeout: 10000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { /* already removed */ }

  // Clean up directory if git worktree remove didn't
  if (existsSync(worktreeDir)) {
    rmSync(worktreeDir, { recursive: true, force: true });
  }

  try {
    execSync(`git branch -D ${JSON.stringify(branch)}`, {
      cwd: gitRoot,
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { /* already deleted */ }
}

/**
 * Clean up all skimpyclaw worktrees in a repo (e.g. on crash recovery).
 */
export function cleanupAllWorktrees(workdir: string): void {
  const gitRoot = getGitRoot(workdir);
  const worktreeBaseDir = join(gitRoot, '.skimpyclaw-worktrees');

  // Prune stale worktree references
  try {
    execSync('git worktree prune', {
      cwd: gitRoot,
      timeout: 10000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { /* ignore */ }

  // Remove the directory
  if (existsSync(worktreeBaseDir)) {
    rmSync(worktreeBaseDir, { recursive: true, force: true });
  }

  // Delete all skimpyclaw-team/* branches
  try {
    const branches = execSync('git branch --list "skimpyclaw-team/*"', {
      cwd: gitRoot,
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (branches) {
      for (const b of branches.split('\n').map(s => s.trim()).filter(Boolean)) {
        try {
          execSync(`git branch -D ${JSON.stringify(b)}`, {
            cwd: gitRoot,
            timeout: 5000,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}
