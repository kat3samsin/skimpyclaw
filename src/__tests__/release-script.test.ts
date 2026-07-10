import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
let tempDir: string;
let worktree: string;
let remote: string;
let fakeBin: string;
let commandLog: string;

function git(args: string[], cwd = worktree): string {
  return execFileSync(realGit, args, { cwd, encoding: 'utf8' }).trim();
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function runRelease(version: string, env: Record<string, string> = {}) {
  const baseEnv = { ...process.env };
  delete baseEnv.GITHUB_ACTIONS;
  delete baseEnv.GITHUB_REF;
  return spawnSync('bash', ['scripts/release.sh', version], {
    cwd: worktree,
    encoding: 'utf8',
    env: {
      ...baseEnv,
      PATH: `${fakeBin}:${baseEnv.PATH}`,
      RELEASE_TEST_LOG: commandLog,
      ...env,
    },
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'skimpyclaw-release-script-'));
  worktree = join(tempDir, 'worktree');
  remote = join(tempDir, 'origin.git');
  fakeBin = join(tempDir, 'bin');
  commandLog = join(tempDir, 'commands.log');
  mkdirSync(fakeBin);
  mkdirSync(join(worktree, 'scripts'), { recursive: true });
  mkdirSync(join(worktree, 'web', 'dashboard'), { recursive: true });
  execFileSync(realGit, ['init', '--quiet', '--bare', remote]);
  execFileSync(realGit, ['init', '--quiet', '-b', 'trunk', worktree]);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  copyFileSync(join(sourceRoot, 'scripts', 'release.sh'), join(worktree, 'scripts', 'release.sh'));
  copyFileSync(join(sourceRoot, 'scripts', 'release-guard.sh'), join(worktree, 'scripts', 'release-guard.sh'));
  writeFileSync(join(worktree, 'package.json'), '{"name":"skimpyclaw-release-test","version":"0.4.0"}\n');
  writeFileSync(commandLog, '');

  writeExecutable(join(fakeBin, 'pnpm'), `#!/usr/bin/env bash
set -euo pipefail
echo "pnpm $*" >> "$RELEASE_TEST_LOG"
if [[ "\${FAIL_BUILD:-0}" == "1" && "\${1:-}" == "build" ]]; then
  exit 17
fi
`);
  writeExecutable(join(fakeBin, 'npm'), `#!/usr/bin/env bash
set -euo pipefail
echo "npm $*" >> "$RELEASE_TEST_LOG"
case "\${1:-}" in
  version)
    node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync("package.json","utf8")); p.version=process.argv[1]; fs.writeFileSync("package.json", JSON.stringify(p, null, 2)+"\\n");' "$2"
    ;;
  publish)
    version="$(node -p 'require("./package.json").version')"
    head="$(git rev-parse HEAD)"
    remote_branch="$(git ls-remote origin refs/heads/trunk)"
    remote_branch="\${remote_branch%%$'\\t'*}"
    remote_tag="$(git ls-remote origin "refs/tags/v\${version}^{}")"
    remote_tag="\${remote_tag%%$'\\t'*}"
    [[ "$head" == "$remote_branch" && "$head" == "$remote_tag" ]] || exit 91
    [[ "\${FAIL_PUBLISH:-0}" != "1" ]] || exit 42
    ;;
esac
`);
  writeExecutable(join(fakeBin, 'git'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${FAIL_ATOMIC_PUSH:-0}" == "1" && "\${1:-}" == "push" && "\${2:-}" == "--atomic" ]]; then
  exit 33
fi
if [[ "\${REPLACE_TAG_AFTER_PUSH:-0}" == "1" && "\${1:-}" == "push" && "\${2:-}" == "--atomic" ]]; then
  ${JSON.stringify(realGit)} "$@"
  ${JSON.stringify(realGit)} push --quiet --force origin "+HEAD:refs/tags/v0.4.1"
  exit 0
fi
exec ${JSON.stringify(realGit)} "$@"
`);

  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'initial']);
  git(['remote', 'add', 'origin', remote]);
  git(['push', '--quiet', '-u', 'origin', 'trunk']);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('release script durability', () => {
  it('pushes the release commit and tag atomically before publishing', () => {
    const result = runRelease('0.4.1');
    expect(result.status, result.stderr).toBe(0);

    const commands = readFileSync(commandLog, 'utf8').trim().split('\n');
    const packIndex = commands.indexOf('npm pack --dry-run');
    const publishIndex = commands.indexOf('npm publish --access public');
    expect(packIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThanOrEqual(0);
    expect(packIndex).toBeLessThan(publishIndex);
    expect(git(['log', '-1', '--pretty=%s'])).toBe('release: v0.4.1');
    expect(git(['rev-parse', 'v0.4.1^{commit}'])).toBe(git(['rev-parse', 'HEAD']));
  });

  it('never publishes when the atomic push fails', () => {
    const result = runRelease('0.4.1', { FAIL_ATOMIC_PUSH: '1' });
    expect(result.status).not.toBe(0);
    expect(readFileSync(commandLog, 'utf8')).not.toContain('npm publish');
  });

  it('never packs, commits, pushes, or publishes after a failed build', () => {
    const initialHead = git(['rev-parse', 'HEAD']);
    const result = runRelease('0.4.1', { FAIL_BUILD: '1' });

    expect(result.status).not.toBe(0);
    expect(git(['rev-parse', 'HEAD'])).toBe(initialHead);
    const commands = readFileSync(commandLog, 'utf8');
    expect(commands).not.toContain('npm pack');
    expect(commands).not.toContain('npm publish');
    expect(git(['tag', '--list', 'v0.4.1'])).toBe('');
  });

  it('rejects a remote tag changed to lightweight after the atomic push', () => {
    const result = runRelease('0.4.1', { REPLACE_TAG_AFTER_PUSH: '1' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not both durable');
    expect(readFileSync(commandLog, 'utf8')).not.toContain('npm publish');
  });

  it('reuses the exact durable Git record after a publish failure', () => {
    const first = runRelease('0.4.1', { FAIL_PUBLISH: '1' });
    expect(first.status).not.toBe(0);
    const releaseHead = git(['rev-parse', 'HEAD']);
    const commitCount = git(['rev-list', '--count', 'HEAD']);
    writeFileSync(commandLog, '');

    const retry = runRelease('0.4.1');
    expect(retry.status, retry.stderr).toBe(0);
    expect(git(['rev-parse', 'HEAD'])).toBe(releaseHead);
    expect(git(['rev-list', '--count', 'HEAD'])).toBe(commitCount);
    const retryCommands = readFileSync(commandLog, 'utf8');
    expect(retryCommands).not.toContain('npm version');
    expect(retryCommands).toContain('npm publish --access public');
  });

  it('rejects a release tag that points to another commit', () => {
    const oldHead = git(['rev-parse', 'HEAD']);
    writeFileSync(join(worktree, 'next.txt'), 'next\n');
    git(['add', 'next.txt']);
    git(['commit', '--quiet', '-m', 'next']);
    git(['push', '--quiet', 'origin', 'trunk']);
    git(['tag', '-a', 'v0.4.1', oldHead, '-m', 'mismatched']);
    git(['push', '--quiet', 'origin', 'v0.4.1']);

    const result = runRelease('0.4.1');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not point to release HEAD');
    expect(readFileSync(commandLog, 'utf8')).not.toContain('npm publish');
  });

  it('keeps release orchestration in the tested script', () => {
    const workflow = readFileSync(join(sourceRoot, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(workflow).toContain('bash scripts/release.sh "$RELEASE_VERSION"');
    expect(workflow).not.toContain('npm publish --access public');
  });
});
