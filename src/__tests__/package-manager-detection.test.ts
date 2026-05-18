import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';

// Import the real functions (no mocks needed — these are pure fs reads)
import { detectPackageManager, buildValidationCommand } from '../code-agents/executor.js';

function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
}

function gitCommitAll(dir: string, msg: string): void {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dir });
}

describe('detectPackageManager', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pm-detect-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns pnpm as fallback when no indicators present', () => {
    expect(detectPackageManager(tempDir)).toBe('pnpm');
  });

  it('detects yarn from packageManager field', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'test',
      packageManager: 'yarn@4.1.0',
    }));
    expect(detectPackageManager(tempDir)).toBe('yarn');
  });

  it('detects pnpm from packageManager field', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'test',
      packageManager: 'pnpm@9.0.0',
    }));
    expect(detectPackageManager(tempDir)).toBe('pnpm');
  });

  it('detects npm from packageManager field', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'test',
      packageManager: 'npm@10.0.0',
    }));
    expect(detectPackageManager(tempDir)).toBe('npm');
  });

  it('detects bun from packageManager field', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'test',
      packageManager: 'bun@1.0.0',
    }));
    expect(detectPackageManager(tempDir)).toBe('bun');
  });

  it('detects yarn from yarn.lock', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'test' }));
    writeFileSync(join(tempDir, 'yarn.lock'), '');
    expect(detectPackageManager(tempDir)).toBe('yarn');
  });

  it('detects pnpm from pnpm-lock.yaml', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'test' }));
    writeFileSync(join(tempDir, 'pnpm-lock.yaml'), '');
    expect(detectPackageManager(tempDir)).toBe('pnpm');
  });

  it('detects npm from package-lock.json', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'test' }));
    writeFileSync(join(tempDir, 'package-lock.json'), '{}');
    expect(detectPackageManager(tempDir)).toBe('npm');
  });

  it('detects bun from bun.lockb', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'test' }));
    writeFileSync(join(tempDir, 'bun.lockb'), '');
    expect(detectPackageManager(tempDir)).toBe('bun');
  });

  it('detects bun from bun.lock', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'test' }));
    writeFileSync(join(tempDir, 'bun.lock'), '');
    expect(detectPackageManager(tempDir)).toBe('bun');
  });

  it('packageManager field takes priority over lockfile', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'test',
      packageManager: 'yarn@4.1.0',
    }));
    // Also has a pnpm lockfile — packageManager should win
    writeFileSync(join(tempDir, 'pnpm-lock.yaml'), '');
    expect(detectPackageManager(tempDir)).toBe('yarn');
  });

  it('handles malformed package.json gracefully', () => {
    writeFileSync(join(tempDir, 'package.json'), 'not valid json{{{');
    expect(detectPackageManager(tempDir)).toBe('pnpm');
  });

  // wp-calypso case: yarn project with yarn.lock
  it('detects yarn for wp-calypso-like project', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'wp-calypso',
      scripts: { build: 'yarn build:client', test: 'jest' },
    }));
    writeFileSync(join(tempDir, 'yarn.lock'), '# yarn lockfile v1\n');
    expect(detectPackageManager(tempDir)).toBe('yarn');
  });
});

describe('buildValidationCommand', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pm-cmd-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns pnpm build && pnpm test for pnpm project with both scripts', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'test',
      scripts: { build: 'tsc', test: 'vitest' },
    }));
    writeFileSync(join(tempDir, 'pnpm-lock.yaml'), '');
    expect(buildValidationCommand(tempDir)).toBe('pnpm build && pnpm test');
  });

  it('returns yarn build && yarn test for yarn project with both scripts', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'test',
      scripts: { build: 'tsc', test: 'jest' },
    }));
    writeFileSync(join(tempDir, 'yarn.lock'), '');
    expect(buildValidationCommand(tempDir)).toBe('yarn build && yarn test');
  });

  it('returns npm run build && npm run test for npm project with both scripts', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'test',
      scripts: { build: 'tsc', test: 'jest' },
    }));
    writeFileSync(join(tempDir, 'package-lock.json'), '{}');
    expect(buildValidationCommand(tempDir)).toBe('npm run build && npm run test');
  });

  it('returns bun build && bun test for bun project with both scripts', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'test',
      scripts: { build: 'bun build', test: 'bun test' },
    }));
    writeFileSync(join(tempDir, 'bun.lockb'), '');
    expect(buildValidationCommand(tempDir)).toBe('bun build && bun test');
  });

  it('returns only test command when build script is missing', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'test',
      scripts: { test: 'jest' },
    }));
    writeFileSync(join(tempDir, 'yarn.lock'), '');
    expect(buildValidationCommand(tempDir)).toBe('yarn test');
  });

  it('returns only build command when test script is missing', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'test',
      scripts: { build: 'tsc' },
    }));
    writeFileSync(join(tempDir, 'yarn.lock'), '');
    expect(buildValidationCommand(tempDir)).toBe('yarn build');
  });

  it('returns empty when no package.json exists', () => {
    // No package.json, no lockfile → nothing to validate
    expect(buildValidationCommand(tempDir)).toBe('');
  });

  it('returns empty when scripts object is empty', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'test',
      scripts: {},
    }));
    writeFileSync(join(tempDir, 'yarn.lock'), '');
    expect(buildValidationCommand(tempDir)).toBe('');
  });

  // wp-calypso scenario
  it('generates yarn commands for wp-calypso-like project', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'wp-calypso',
      packageManager: 'yarn@4.5.0',
      scripts: { build: 'yarn workspaces foreach build', test: 'jest' },
    }));
    writeFileSync(join(tempDir, 'yarn.lock'), '# yarn lockfile v1\n');
    expect(buildValidationCommand(tempDir)).toBe('yarn build && yarn test');
  });

  // Regression: monorepo with no changed packages must NOT fall through to
  // whole-repo build/test. (Previously, rebases/reviews on wp-calypso ran the
  // entire jest suite because git diff HEAD was empty after the rebase.)
  it('returns empty for a monorepo with no changed packages', () => {
    gitInit(tempDir);
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'monorepo-root',
      workspaces: ['packages/*'],
      scripts: { build: 'tsc', test: 'jest' },
    }));
    writeFileSync(join(tempDir, 'yarn.lock'), '');
    mkdirSync(join(tempDir, 'packages', 'a'), { recursive: true });
    writeFileSync(join(tempDir, 'packages', 'a', 'package.json'), JSON.stringify({
      name: 'pkg-a',
      scripts: { build: 'tsc', test: 'jest' },
    }));
    gitCommitAll(tempDir, 'init');

    expect(buildValidationCommand(tempDir)).toBe('');
  });

  it('returns empty when workdir is a subpackage of a monorepo with no changes', () => {
    gitInit(tempDir);
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'monorepo-root',
      workspaces: ['packages/*'],
      scripts: { build: 'tsc', test: 'jest' },
    }));
    writeFileSync(join(tempDir, 'yarn.lock'), '');
    mkdirSync(join(tempDir, 'packages', 'a'), { recursive: true });
    writeFileSync(join(tempDir, 'packages', 'a', 'package.json'), JSON.stringify({
      name: 'pkg-a',
      scripts: { build: 'tsc', test: 'jest' },
    }));
    gitCommitAll(tempDir, 'init');

    expect(buildValidationCommand(join(tempDir, 'packages', 'a'))).toBe('');
  });

  it('runs root validation for monorepo changes outside workspace packages', () => {
    gitInit(tempDir);
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'monorepo-root',
      workspaces: ['packages/*'],
      scripts: { build: 'tsc', test: 'jest' },
    }));
    writeFileSync(join(tempDir, 'yarn.lock'), '');
    mkdirSync(join(tempDir, 'packages', 'a'), { recursive: true });
    writeFileSync(join(tempDir, 'packages', 'a', 'package.json'), JSON.stringify({
      name: 'pkg-a',
      scripts: { build: 'tsc', test: 'jest' },
    }));
    gitCommitAll(tempDir, 'init');

    writeFileSync(join(tempDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true },
    }));

    expect(buildValidationCommand(tempDir)).toBe('yarn build && yarn test');
  });

  it('still scopes to changed packages in a monorepo when there are changes', () => {
    gitInit(tempDir);
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'monorepo-root',
      workspaces: ['packages/*'],
      scripts: { build: 'tsc', test: 'jest' },
    }));
    writeFileSync(join(tempDir, 'yarn.lock'), '');
    mkdirSync(join(tempDir, 'packages', 'a'), { recursive: true });
    writeFileSync(join(tempDir, 'packages', 'a', 'package.json'), JSON.stringify({
      name: 'pkg-a',
      scripts: { build: 'tsc', test: 'jest' },
    }));
    gitCommitAll(tempDir, 'init');

    // Modify a file in pkg-a
    writeFileSync(join(tempDir, 'packages', 'a', 'index.ts'), 'export const x = 1;\n');
    execFileSync('git', ['add', 'packages/a/index.ts'], { cwd: tempDir });

    const cmd = buildValidationCommand(tempDir);
    expect(cmd).toContain('yarn workspace pkg-a build');
    expect(cmd).toContain('yarn workspace pkg-a test');
  });
});
