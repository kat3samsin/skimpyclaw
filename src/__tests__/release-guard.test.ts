import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const guardPath = join(repoRoot, 'scripts', 'release-guard.sh');
const workflowPath = join(repoRoot, '.github', 'workflows', 'release.yml');
let tempDir: string;
let worktree: string;

function git(args: string[], cwd = worktree): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function runGuard(version: string, env: Record<string, string> = {}) {
  const baseEnv = { ...process.env };
  delete baseEnv.GITHUB_ACTIONS;
  delete baseEnv.GITHUB_REF;
  return spawnSync('bash', [guardPath, version], {
    cwd: worktree,
    encoding: 'utf8',
    env: { ...baseEnv, ...env },
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'skimpyclaw-release-guard-'));
  worktree = join(tempDir, 'worktree');
  const remote = join(tempDir, 'origin.git');
  execFileSync('git', ['init', '--quiet', '--bare', remote]);
  execFileSync('git', ['init', '--quiet', '-b', 'trunk', worktree]);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(worktree, 'package.json'), '{"name":"test","version":"0.4.0"}\n');
  git(['add', 'package.json']);
  git(['commit', '-m', 'initial']);
  git(['remote', 'add', 'origin', remote]);
  git(['push', '--quiet', '-u', 'origin', 'trunk']);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('release source guard', () => {
  it('accepts aligned local and Actions trunk releases', () => {
    expect(runGuard('0.4.1').status).toBe(0);
    expect(runGuard('0.4.1-rc.1', {
      GITHUB_ACTIONS: 'true',
      GITHUB_REF: 'refs/heads/trunk',
    }).status).toBe(0);
  });

  it('rejects local feature branches and detached HEAD', () => {
    git(['switch', '--quiet', '-c', 'feature']);
    const feature = runGuard('0.4.1');
    expect(feature.status).not.toBe(0);
    expect(feature.stderr).toContain('trunk');

    git(['switch', '--quiet', 'trunk']);
    git(['checkout', '--quiet', '--detach']);
    const detached = runGuard('0.4.1');
    expect(detached.status).not.toBe(0);
    expect(detached.stderr).toContain('detached');
  });

  it('rejects Actions feature refs and shell metacharacters', () => {
    const feature = runGuard('0.4.1', {
      GITHUB_ACTIONS: 'true',
      GITHUB_REF: 'refs/heads/feature',
    });
    expect(feature.status).not.toBe(0);
    const tag = runGuard('0.4.1', {
      GITHUB_ACTIONS: 'true',
      GITHUB_REF: 'refs/tags/v0.4.1',
    });
    expect(tag.status).not.toBe(0);

    const marker = join(tempDir, 'injected');
    const malicious = runGuard(`$(touch ${marker})`);
    expect(malicious.status).not.toBe(0);
    expect(() => readFileSync(marker)).toThrow();
  });

  it('rejects a local commit that is not the current remote trunk', () => {
    writeFileSync(join(worktree, 'local.txt'), 'not pushed\n');
    git(['add', 'local.txt']);
    git(['commit', '-m', 'local only']);

    const result = runGuard('0.4.1');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('origin/trunk');
  });

  it('keeps workflow input in the environment instead of shell source', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const localScript = readFileSync(join(repoRoot, 'scripts', 'release.sh'), 'utf8');
    const envMapping = 'RELEASE_VERSION: ${{ inputs.version }}';
    expect(workflow).toContain(envMapping);
    expect(workflow.replace(envMapping, '')).not.toContain('inputs.version');
    expect(workflow).not.toContain('github.event.inputs.version');
    expect(workflow).toContain('bash scripts/release-guard.sh "$RELEASE_VERSION"');
    expect(localScript.indexOf('release-guard.sh')).toBeLessThan(localScript.indexOf('npm publish'));
  });
});
