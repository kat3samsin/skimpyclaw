import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCRIPT_PATH = resolve(process.cwd(), 'scripts', 'secret-scan.sh');
const FAKE_GITHUB_TOKEN = `ghp_${'A'.repeat(36)}`;

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
}

function commitFile(dir: string, filename: string, content: string, message: string): string {
  writeFileSync(join(dir, filename), content, 'utf-8');
  git(dir, ['add', filename]);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

function runScan(dir: string, localSha: string, remoteSha: string) {
  return spawnSync('bash', [SCRIPT_PATH, '--pre-push', 'origin', 'unused'], {
    cwd: dir,
    encoding: 'utf-8',
    input: `refs/heads/topic ${localSha} refs/heads/topic ${remoteSha}\n`,
  });
}

function runScanMode(dir: string, args: string[]) {
  return spawnSync('bash', [SCRIPT_PATH, ...args], {
    cwd: dir,
    encoding: 'utf-8',
  });
}

describe('pre-push secret scan', () => {
  let repo: string;
  let baseSha: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'skimpy-secret-scan-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    baseSha = commitFile(repo, 'README.md', '# clean\n', 'base');
    git(repo, ['update-ref', 'refs/remotes/origin/trunk', baseSha]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('passes a clean existing-branch update', () => {
    const tipSha = commitFile(repo, 'clean.txt', 'nothing sensitive\n', 'clean');

    const result = runScan(repo, tipSha, baseSha);

    expect(result.status).toBe(0);
  });

  it('blocks a secret introduced on a new branch', () => {
    const tipSha = commitFile(repo, 'secret.txt', `${FAKE_GITHUB_TOKEN}\n`, 'add secret');

    const result = runScan(repo, tipSha, '0'.repeat(baseSha.length));

    expect(result.status).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('Potential secret match');
    expect(output).not.toContain(FAKE_GITHUB_TOKEN);
  });

  it('does not rescan commits already present on the destination remote', () => {
    const remoteSha = commitFile(repo, 'existing-secret.txt', `${FAKE_GITHUB_TOKEN}\n`, 'remote history');
    git(repo, ['update-ref', 'refs/remotes/origin/trunk', remoteSha]);
    const tipSha = commitFile(repo, 'clean.txt', 'nothing sensitive\n', 'clean topic commit');

    const result = runScan(repo, tipSha, '0'.repeat(baseSha.length));

    expect(result.status).toBe(0);
  });

  it('blocks an add-then-delete secret on a new branch', () => {
    commitFile(repo, 'secret.txt', `${FAKE_GITHUB_TOKEN}\n`, 'add secret');
    git(repo, ['rm', 'secret.txt']);
    git(repo, ['commit', '-q', '-m', 'remove secret']);
    const tipSha = git(repo, ['rev-parse', 'HEAD']);

    const result = runScan(repo, tipSha, '0'.repeat(baseSha.length));

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('Potential secret match');
  });

  it('blocks a secret in a file Git classifies as binary', () => {
    writeFileSync(join(repo, 'binary.bin'), Buffer.concat([
      Buffer.from([0xff, 0x00]),
      Buffer.from(`${FAKE_GITHUB_TOKEN}\n`),
    ]));
    git(repo, ['add', 'binary.bin']);
    git(repo, ['commit', '-q', '-m', 'add binary secret']);
    const tipSha = git(repo, ['rev-parse', 'HEAD']);

    const result = runScan(repo, tipSha, baseSha);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('Potential secret match');
  });

  it('blocks a secret that was added and deleted before push', () => {
    commitFile(repo, 'secret.txt', `${FAKE_GITHUB_TOKEN}\n`, 'add secret');
    git(repo, ['rm', 'secret.txt']);
    git(repo, ['commit', '-q', '-m', 'remove secret']);
    const tipSha = git(repo, ['rev-parse', 'HEAD']);

    const result = runScan(repo, tipSha, baseSha);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('Potential secret match');
  });

  it('fails closed when a pushed revision cannot be enumerated', () => {
    const tipSha = commitFile(repo, 'clean.txt', 'nothing sensitive\n', 'clean');

    const result = runScan(repo, tipSha, 'f'.repeat(40));

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('Unable to enumerate pushed commits');
  });

  it('blocks a secret in an explicit CI commit range', () => {
    const tipSha = commitFile(repo, 'secret.txt', `${FAKE_GITHUB_TOKEN}\n`, 'add secret');

    const result = runScanMode(repo, ['--range', baseSha, tipSha]);

    expect(result.status).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('Potential secret match');
    expect(output).not.toContain(FAKE_GITHUB_TOKEN);
  });

  it('blocks an add-then-delete secret during a full-history scan', () => {
    commitFile(repo, 'secret.txt', `${FAKE_GITHUB_TOKEN}\n`, 'add secret');
    git(repo, ['rm', 'secret.txt']);
    git(repo, ['commit', '-q', '-m', 'remove secret']);

    const result = runScanMode(repo, ['--all']);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('Potential secret match');
  });
});
