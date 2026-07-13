// Code Agent Executor - Background execution logic

import { spawn, exec, execSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { chmodSync, createWriteStream, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';

/**
 * Ensure PATH contains the directory of the running node binary. The claude /
 * codex CLIs use `#!/usr/bin/env node` shebangs — when launchd-spawned processes
 * inherit a minimal PATH, `env node` fails and spawn returns ENOENT.
 */
function ensureNodeInPath(env: Record<string, string | undefined>): void {
  const nodeDir = dirname(process.execPath);
  const path = env.PATH ?? '';
  if (!path.split(':').includes(nodeDir)) {
    env.PATH = path ? `${nodeDir}:${path}` : nodeDir;
  }
}

import type { CodeAgentBackgroundOptions, ValidationResult } from './types.js';
import { toErrorMessage } from '../utils.js';
import { VALIDATE_TIMEOUT_MS } from './types.js';
import {
  getCodeAgentsDir,
  ensureCodeAgentsDir,
  writeCodeAgentTask,
  setCodeAgentCanceller,
  deleteCodeAgentCanceller,
  getCodeAgent,
} from './registry.js';
import { buildCodeAgentArgs, buildCodeAgentSpawnEnv, notifyCodeAgentResult } from './utils.js';
import { cleanupCodeAgentWorktree } from './worktrees.js';
import { CodeAgentOutputCollector } from './parser.js';
import { startTrace, addEvent, endTrace } from '../audit.js';
import { buildUsageRecord, recordUsage } from '../usage.js';

const CANCELLED_MESSAGE = 'Cancelled by user';
const STDERR_PREVIEW_CHARS = 2000;

function appendTail(current: string, chunk: string, maxChars: number): string {
  const combined = current + chunk;
  return combined.length > maxChars ? combined.slice(-maxChars) : combined;
}

/** Supported JS package managers. */
export type PackageManager = 'pnpm' | 'yarn' | 'npm' | 'bun';

/**
 * Detect the package manager for a project directory.
 * Detection order (first match wins):
 * 1. package.json `packageManager` field (e.g. "yarn@4.1.0")
 * 2. Lockfile presence: yarn.lock → yarn, pnpm-lock.yaml → pnpm, bun.lockb / bun.lock → bun, package-lock.json → npm
 * 3. Fallback: 'pnpm' (SkimpyClaw default)
 */
export function detectPackageManager(workdir: string): PackageManager {
  // 1. Check package.json packageManager field
  try {
    const pkgPath = join(workdir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (typeof pkg.packageManager === 'string') {
        const name = pkg.packageManager.split('@')[0].toLowerCase();
        if (name === 'yarn') return 'yarn';
        if (name === 'pnpm') return 'pnpm';
        if (name === 'npm') return 'npm';
        if (name === 'bun') return 'bun';
      }
    }
  } catch { /* ignore parse errors, fall through */ }

  // 2. Check lockfiles
  if (existsSync(join(workdir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(workdir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(workdir, 'bun.lockb')) || existsSync(join(workdir, 'bun.lock'))) return 'bun';
  if (existsSync(join(workdir, 'package-lock.json'))) return 'npm';

  // 3. Fallback
  return 'pnpm';
}

/**
 * Detect monorepo workspaces from package.json.
 * Returns workspace glob patterns or null if not a monorepo.
 */
function getWorkspacePatterns(workdir: string): string[] | null {
  try {
    const pkgPath = join(workdir, 'package.json');
    if (!existsSync(pkgPath)) return null;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    // yarn/npm: "workspaces": ["packages/*"] or "workspaces": { "packages": [...] }
    const ws = pkg.workspaces;
    if (Array.isArray(ws)) return ws;
    if (ws && Array.isArray(ws.packages)) return ws.packages;
    // pnpm: check pnpm-workspace.yaml
    const pnpmWsPath = join(workdir, 'pnpm-workspace.yaml');
    if (existsSync(pnpmWsPath)) {
      const content = readFileSync(pnpmWsPath, 'utf-8');
      const matches = content.match(/- ['"]?([^'"\n]+)['"]?/g);
      if (matches) return matches.map(m => m.replace(/^- ['"]?|['"]?$/g, ''));
    }
    return null;
  } catch {
    return null;
  }
}

function getChangedFiles(workdir: string): string[] {
  try {
    // Get changed files vs HEAD (staged + unstaged + untracked)
    const diff = execSync(
      'git diff --name-only HEAD 2>/dev/null; git diff --name-only --cached 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null',
      { cwd: workdir, timeout: 5000, encoding: 'utf-8' },
    ).trim();
    if (!diff) return [];

    return [...new Set(diff.split('\n').filter(Boolean))];
  } catch {
    return [];
  }
}

/**
 * Find which monorepo packages have changed files.
 * Returns package directories relative to workdir.
 */
function getChangedPackageDirs(workdir: string, files: string[]): string[] {
  // Extract unique top-level package directories (e.g. "packages/image-studio/src/foo.ts" → "packages/image-studio")
  const pkgDirs = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    // Look for package.json at each depth to find package boundary
    for (let depth = 1; depth <= Math.min(parts.length - 1, 4); depth++) {
      const candidate = parts.slice(0, depth).join('/');
      if (existsSync(join(workdir, candidate, 'package.json'))) {
        pkgDirs.add(candidate);
        break;
      }
    }
  }
  return [...pkgDirs];
}

// Reject any value that could break out of an unquoted shell argument.
// npm package names: optional "@scope/", then [a-zA-Z0-9._-]. Max 214 chars.
const NPM_PKG_NAME_RE = /^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/;
// Workspace directory paths derived from git: allow nested path segments only.
const SAFE_PATH_RE = /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/;

/**
 * Build scoped validation commands for a monorepo by detecting changed packages.
 * Returns a combined command that builds/tests only affected packages, or null
 * if this doesn't look like a monorepo or no packages were changed.
 */
function buildMonorepoValidationCommand(workdir: string, changedFiles: string[]): string | null {
  const wsPatterns = getWorkspacePatterns(workdir);
  if (!wsPatterns) return null;

  const changedDirs = getChangedPackageDirs(workdir, changedFiles);
  if (changedDirs.length === 0) return null;

  const pm = detectPackageManager(workdir);
  const parts: string[] = [];

  for (const dir of changedDirs) {
    // Defence-in-depth: `dir` flows into shell command strings below.
    if (!SAFE_PATH_RE.test(dir) || dir.length > 256) {
      console.warn(`[validation] Skipping unsafe package dir: ${JSON.stringify(dir)}`);
      continue;
    }

    const pkgJsonPath = join(workdir, dir, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;

    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      const pkgName = pkg.name;
      const scripts = pkg.scripts || {};

      if (!pkgName) continue;

      // pkgName comes from an untrusted package.json and is interpolated into
      // a shell command executed by exec(). Enforce npm's legal name charset
      // to prevent command injection via crafted "name" fields.
      if (typeof pkgName !== 'string' || pkgName.length > 214 || !NPM_PKG_NAME_RE.test(pkgName)) {
        console.warn(`[validation] Skipping package with unsafe name: ${JSON.stringify(pkgName)}`);
        continue;
      }

      // Build with workspace command
      if (scripts.build) {
        if (pm === 'pnpm') parts.push(`pnpm --filter ${pkgName} run build`);
        else if (pm === 'yarn') parts.push(`yarn workspace ${pkgName} build`);
        else if (pm === 'bun') parts.push(`bun --filter ${pkgName} run build`);
        else parts.push(`npm -w ${pkgName} run build`);
      }

      // Test: prefer package-scoped test, fall back to root test runner scoped to path
      if (scripts.test) {
        if (pm === 'pnpm') parts.push(`pnpm --filter ${pkgName} run test`);
        else if (pm === 'yarn') parts.push(`yarn workspace ${pkgName} test`);
        else if (pm === 'bun') parts.push(`bun --filter ${pkgName} run test`);
        else parts.push(`npm -w ${pkgName} run test`);
      } else {
        // No package-level test script — try running root test scoped to the package path
        // This handles monorepos like wp-calypso with `jest --testPathPattern`
        const rootPkg = JSON.parse(readFileSync(join(workdir, 'package.json'), 'utf-8'));
        const rootScripts = rootPkg.scripts || {};
        // Check for common monorepo test patterns
        if (rootScripts['test-packages']) {
          if (pm === 'yarn') parts.push(`yarn test-packages ${dir}`);
          else parts.push(`${pm} run test-packages ${dir}`);
        }
      }
    } catch { /* skip this package */ }
  }

  if (parts.length === 0) return null;

  console.log(`[validation] Monorepo: scoped to ${changedDirs.length} package(s): ${changedDirs.join(', ')}`);
  return parts.join(' && ');
}

/**
 * Walk up from a directory to find a monorepo root (directory with workspaces).
 * Returns the root path or null if not inside a monorepo.
 */
function findMonorepoRoot(startDir: string): string | null {
  let dir = startDir;
  const root = '/';
  while (dir !== root) {
    if (getWorkspacePatterns(dir)) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Build the validation command for a project directory.
 *
 * Resolution order:
 * 1. Per-project override from config `codeAgents.validationCommands`
 * 2. Monorepo auto-detection
 *    - Works both when workdir is the repo root AND when it's a package subdir
 *    - Changed package files use workspace-scoped validation
 *    - Changed root files use root validation
 *    - No changed files skip validation
 * 3. Auto-detect from package.json scripts (build + test)
 * 4. Empty string (skip validation) if no scripts found
 */
export function buildValidationCommand(workdir: string, validationCommands?: Record<string, string>): string {
  // 1. Check per-project overrides
  if (validationCommands) {
    const dirName = workdir.split('/').pop() || '';
    for (const [key, cmd] of Object.entries(validationCommands)) {
      if (key === dirName || workdir === key || workdir.endsWith(`/${key}`)) {
        return cmd;
      }
    }
  }

  const buildRootValidationCommand = (dir: string): string => {
    const pm = detectPackageManager(dir);
    const run = pm === 'npm' ? 'npm run' : pm;

    let hasBuild = false;
    let hasTest = false;
    try {
      const pkgPath = join(dir, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        const scripts = pkg.scripts || {};
        hasBuild = !!scripts.build;
        hasTest = !!scripts.test;
      }
    } catch { /* ignore */ }

    const parts: string[] = [];
    if (hasBuild) parts.push(`${run} build`);
    if (hasTest) parts.push(`${run} test`);

    return parts.join(' && ');
  };

  // 2. Monorepo auto-detection — scope to changed packages when possible.
  //    If workdir or any ancestor is a monorepo, we ALWAYS take this path:
  //    run scoped commands for changed packages, skip true no-op diffs, or
  //    run root validation for changed files outside workspace packages.
  const monorepoRoot = getWorkspacePatterns(workdir) ? workdir : findMonorepoRoot(workdir);
  if (monorepoRoot) {
    const changedFiles = getChangedFiles(monorepoRoot);
    const cmd = buildMonorepoValidationCommand(monorepoRoot, changedFiles);
    if (cmd) return cmd;
    if (changedFiles.length > 0) {
      console.log('[validation] Monorepo: root-level changes detected — running root validation.');
      return buildRootValidationCommand(monorepoRoot);
    }
    console.log('[validation] Monorepo detected with no changed files — skipping validation.');
    return '';
  }

  // 3. Simple project — use root package.json scripts
  return buildRootValidationCommand(workdir);
}

/** Run build/test validation. */
export function runValidation(workdir: string, validationCommands?: Record<string, string>): Promise<ValidationResult> {
  const cmd = buildValidationCommand(workdir, validationCommands);
  if (!cmd) {
    // No build/test scripts found — nothing to validate, pass by default
    return Promise.resolve({ passed: true, output: 'PASS (no build/test scripts found)' });
  }
  // If workdir is inside a monorepo, run from the repo root so workspace commands work
  const execDir = findMonorepoRoot(workdir) || workdir;
  return new Promise((resolve) => {
    exec(cmd, {
      cwd: execDir,
      timeout: VALIDATE_TIMEOUT_MS,
      maxBuffer: 5 * 1024 * 1024,
    }, (error, vStdout, vStderr) => {
      if (error) {
        resolve({
          passed: false,
          output: [`VALIDATION FAILED (exit ${error.code}):`, vStdout, vStderr].filter(Boolean).join('\n').slice(0, 8_000),
        });
      } else {
        resolve({ passed: true, output: 'PASS' });
      }
    });
  });
}

/** Background execution of a coding agent. Updates task status throughout. */
export async function runCodeAgentBackground(
  id: string,
  agent: string,
  task: string,
  workdir: string,
  validate: boolean,
  input: Record<string, any>,
  startedAt: Date,
  options?: CodeAgentBackgroundOptions,
): Promise<void> {
  const caTask = getCodeAgent(id);
  if (!caTask) {
    throw new Error(`Task ${id} not found in registry`);
  }

  let cancelled = false;
  let activeProc: ChildProcess | null = null;
  let activeTimer: NodeJS.Timeout | null = null;
  let activeExecProc: ChildProcess | null = null;

  const setActiveCanceller = (fn: () => void) => {
    setCodeAgentCanceller(id, () => {
      cancelled = true;
      try { fn(); } catch { /* best effort */ }
    });
  };
  setActiveCanceller(() => {});

  const ensureNotCancelled = () => {
    if (cancelled || caTask.status === 'cancelled') throw new Error(CANCELLED_MESSAGE);
  };

  // Start audit trace
  const traceId = startTrace('code_agent');
  addEvent(traceId, {
    type: 'spawn',
    summary: `${agent}: ${task.slice(0, 150)}`,
    durationMs: 0,
    detail: { agent, workdir, model: input.model, validate },
  });

  // Per-invocation timeout
  const defaultTimeout = options?.defaultTimeoutMinutes ?? 30;
  const maxTimeout = options?.maxTimeoutMinutes ?? 30;
  const timeoutMinutes = Math.min(input.timeout_minutes || defaultTimeout, maxTimeout);
  const timeoutMs = timeoutMinutes * 60 * 1000;

  const { cmd, args } = options?.buildArgs
    ? options.buildArgs()
    : buildCodeAgentArgs({
        task,
        agent,
        workdir,
        model: input.model,
        effort: input.effort,
        max_turns: input.max_turns,
        sessionId: caTask.cliSessionId,
      });

  let outputCollector = new CodeAgentOutputCollector();
  let stderrTail = '';

  // Full log file — untruncated stdout + stderr
  const logPath = join(getCodeAgentsDir(), `${id}.log`);
  ensureCodeAgentsDir();
  if (existsSync(logPath)) chmodSync(logPath, 0o600);
  const logStream = createWriteStream(logPath, { flags: 'w', mode: 0o600 });
  let logStreamEnded = false;
  const logWrite = (data: string | Buffer, source?: { pause: () => unknown; resume: () => unknown }) => {
    if (logStreamEnded) return;
    if (!logStream.write(data) && source) {
      source.pause();
      logStream.once('drain', () => source.resume());
    }
  };
  logWrite(`=== ${id} | ${agent} | ${new Date().toISOString()} ===\n`);
  logWrite(`Task: ${task.slice(0, 500)}\n`);
  logWrite(`Workdir: ${workdir}\n\n`);
  if (caTask.sourceWorkdir) logWrite(`Source workdir: ${caTask.sourceWorkdir}\n`);
  if (caTask.worktreePath) logWrite(`Worktree: ${caTask.worktreePath}\n`);

  try {
    ensureNotCancelled();
    const exitCode = await new Promise<number | null>((resolvePromise, reject) => {
      const spawnEnv = buildCodeAgentSpawnEnv();
      ensureNodeInPath(spawnEnv);
      if (options?.env) Object.assign(spawnEnv, options.env);

      const proc = spawn(cmd, args, {
        cwd: workdir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv,
      });
      activeProc = proc;

      let lastStatusWrite = 0;
      const STATUS_WRITE_INTERVAL = 3000;

      proc.stdout.on('data', (chunk: Buffer) => {
        outputCollector.push(chunk);
        logWrite(chunk, proc.stdout);
        const now = Date.now();
        if (now - lastStatusWrite > STATUS_WRITE_INTERVAL) {
          lastStatusWrite = now;
          const parsed = outputCollector.getLiveOutput();
          const live = stderrTail ? `[progress]\n${stderrTail}\n\n${parsed}` : parsed;
          caTask.liveOutput = live;
          writeCodeAgentTask(caTask);
        }
      });
      proc.stderr.on('data', (chunk: Buffer) => {
        stderrTail = appendTail(stderrTail, chunk.toString(), STDERR_PREVIEW_CHARS);
        logWrite(chunk, proc.stderr);
        const now = Date.now();
        if (now - lastStatusWrite > STATUS_WRITE_INTERVAL) {
          lastStatusWrite = now;
          const parsedOut = outputCollector.getLiveOutput();
          const live = `[progress]\n${stderrTail}\n\n${parsedOut}`;
          caTask.liveOutput = live;
          writeCodeAgentTask(caTask);
        }
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        // SIGKILL fallback after 5s
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* already dead */ }
        }, 5000);
      }, timeoutMs);
      activeTimer = timer;
      setActiveCanceller(() => {
        if (activeTimer) clearTimeout(activeTimer);
        activeTimer = null;
        try { activeProc?.kill('SIGTERM'); } catch { /* best effort */ }
      });

      proc.on('close', (code) => {
        outputCollector.finish();
        if (activeTimer) clearTimeout(activeTimer);
        activeTimer = null;
        activeProc = null;
        if (!logStreamEnded) {
          logStreamEnded = true;
          logStream.write(`\n=== EXIT ${code} | ${new Date().toISOString()} ===\n`);
          logStream.end();
        }
        if (cancelled || caTask.status === 'cancelled') {
          reject(new Error(CANCELLED_MESSAGE));
          return;
        }
        if (timedOut) {
          reject(new Error(`${agent} agent timed out after ${timeoutMinutes} minutes`));
        } else {
          resolvePromise(code);
        }
      });

      proc.on('error', (err) => {
        outputCollector.finish();
        if (activeTimer) clearTimeout(activeTimer);
        activeTimer = null;
        activeProc = null;
        if (!logStreamEnded) {
          logStreamEnded = true;
          logStream.write(`\n=== ERROR: ${err.message} ===\n`);
          logStream.end();
        }
        reject(err);
      });
    });
    ensureNotCancelled();

    // Parse output — stream-json format is newline-delimited JSON events
    let agentOutput: string;
    if (agent === 'claude') {
      const parsed = outputCollector.getClaudeOutput();
      agentOutput = parsed.text;
      // Store cost/token data from CLI result event
      if (parsed.totalCost != null) caTask.totalCost = (caTask.totalCost ?? 0) + parsed.totalCost;
      if (parsed.inputTokens != null) caTask.inputTokens = (caTask.inputTokens ?? 0) + parsed.inputTokens;
      if (parsed.outputTokens != null) caTask.outputTokens = (caTask.outputTokens ?? 0) + parsed.outputTokens;
      // Record in usage tracking
      if (parsed.totalCost != null || parsed.inputTokens != null) {
        recordUsage(buildUsageRecord({
          model: input.model || 'claude',
          provider: 'anthropic',
          inputTokens: parsed.inputTokens ?? 0,
          outputTokens: parsed.outputTokens ?? 0,
          inputCost: 0, // CLI doesn't break down input/output cost
          outputCost: 0,
          totalCost: parsed.totalCost ?? 0,
          trigger: 'code_agent',
          agentId: id,
        }));
      }
    } else {
      agentOutput = outputCollector.getCodexOutput();
    }

    if (exitCode !== 0) {
      addEvent(traceId, { type: 'error', summary: `${agent} exited with code ${exitCode}`, durationMs: Date.now() - startedAt.getTime() });
      await endTrace(traceId, 'error');
      Object.assign(caTask, {
        status: 'failed',
        endedAt: new Date().toISOString(),
        durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
        exitCode,
        outputPreview: agentOutput.slice(0, 5000),
        error: `Exited with code ${exitCode}`,
        liveOutput: undefined,
      });
      writeCodeAgentTask(caTask);
      await notifyCodeAgentResult(caTask);
      return;
    }

    // Post-validation gate
    if (validate) {
      caTask.status = 'validating';
      caTask.outputPreview = agentOutput.slice(0, 500);
      caTask.liveOutput = undefined;
      writeCodeAgentTask(caTask);

      const validationCmd = buildValidationCommand(workdir, options?.validationCommands);
      if (!validationCmd) {
        // No build/test scripts — skip validation, mark complete
        const endedAt = new Date();
        const duration = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
        addEvent(traceId, { type: 'validation', summary: 'Skipped (no build/test scripts found)', durationMs: Date.now() - startedAt.getTime() });
        await endTrace(traceId, 'ok');
        Object.assign(caTask, {
          status: 'completed',
          endedAt: endedAt.toISOString(),
          durationSeconds: duration,
          exitCode,
          validationPassed: true,
          validationOutput: undefined,
          outputPreview: agentOutput.slice(0, 5000),
        });
        writeCodeAgentTask(caTask);
        await notifyCodeAgentResult(caTask);
        return;
      }
      const runValidationPromise = (): Promise<string> => new Promise((res) => {
        const validationProc = exec(validationCmd, {
          cwd: workdir,
          timeout: VALIDATE_TIMEOUT_MS,
          maxBuffer: 5 * 1024 * 1024,
        }, (error, vStdout, vStderr) => {
          activeExecProc = null;
          if (error) {
            res([`VALIDATION FAILED (exit ${error.code}):`, vStdout, vStderr].filter(Boolean).join('\n').slice(0, 8_000));
          } else {
            res('PASS');
          }
        });
        activeExecProc = validationProc;
        setActiveCanceller(() => {
          try { activeExecProc?.kill('SIGTERM'); } catch { /* best effort */ }
          activeExecProc = null;
        });
      });

      let validateResult = await runValidationPromise();
      ensureNotCancelled();

      // Internal retry: if validation failed, re-run the agent with test errors injected
      if (validateResult !== 'PASS' && !caTask.retryCount) {
        caTask.retryCount = 1;
        caTask.status = 'running';
        caTask.validationOutput = validateResult;
        writeCodeAgentTask(caTask);

        addEvent(traceId, { type: 'validation', summary: 'Validation failed, retrying with error context', durationMs: Date.now() - startedAt.getTime() });

        // Re-run agent with the validation errors appended to the prompt
        const retryTask = `Fix build/test errors in the ${agent} codebase (workdir: ${workdir}).\n\nOriginal task summary: ${task.slice(0, 300)}\n\nErrors to fix:\n${validateResult.slice(0, 4_000)}`;
        outputCollector = new CodeAgentOutputCollector();
        stderrTail = '';

        const { cmd: retryCmd, args: retryArgs } = buildCodeAgentArgs({
          task: retryTask,
          agent,
          workdir,
          model: input.model,
          effort: input.effort,
          max_turns: input.max_turns,
        });

        const retryExitCode = await new Promise<number | null>((resolveRetry, rejectRetry) => {
          const spawnEnv = buildCodeAgentSpawnEnv();
          ensureNodeInPath(spawnEnv);
          const retryProc = spawn(retryCmd, retryArgs, {
            cwd: workdir,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: spawnEnv,
          });
          activeProc = retryProc;

          let lastStatusWrite = 0;
          retryProc.stdout.on('data', (chunk: Buffer) => {
            outputCollector.push(chunk);
            const now = Date.now();
            if (now - lastStatusWrite > 3000) {
              lastStatusWrite = now;
              const retryParsed = outputCollector.getLiveOutput();
              const live = stderrTail ? `[progress]\n${stderrTail}\n\n${retryParsed}` : retryParsed;
              caTask.liveOutput = live;
              writeCodeAgentTask(caTask);
            }
          });
          retryProc.stderr.on('data', (chunk: Buffer) => {
            stderrTail = appendTail(stderrTail, chunk.toString(), STDERR_PREVIEW_CHARS);
            const now = Date.now();
            if (now - lastStatusWrite > 3000) {
              lastStatusWrite = now;
              const parsedOut = outputCollector.getLiveOutput();
              const live = `[progress]\n${stderrTail}\n\n${parsedOut}`;
              caTask.liveOutput = live;
              writeCodeAgentTask(caTask);
            }
          });

          const retryTimer = setTimeout(() => {
            retryProc.kill('SIGTERM');
            // SIGKILL fallback after 5s
            setTimeout(() => {
              try { retryProc.kill('SIGKILL'); } catch { /* already dead */ }
            }, 5000);
          }, timeoutMs);
          activeTimer = retryTimer;
          setActiveCanceller(() => {
            if (activeTimer) clearTimeout(activeTimer);
            activeTimer = null;
            try { activeProc?.kill('SIGTERM'); } catch { /* best effort */ }
          });
          retryProc.on('close', (code) => {
            outputCollector.finish();
            if (activeTimer) clearTimeout(activeTimer);
            activeTimer = null;
            activeProc = null;
            if (cancelled || caTask.status === 'cancelled') {
              rejectRetry(new Error(CANCELLED_MESSAGE));
              return;
            }
            resolveRetry(code);
          });
          retryProc.on('error', (err) => {
            outputCollector.finish();
            if (activeTimer) clearTimeout(activeTimer);
            activeTimer = null;
            activeProc = null;
            rejectRetry(err);
          });
        });
        ensureNotCancelled();

        if (retryExitCode === 0) {
          if (agent === 'claude') {
            const retryParsed = outputCollector.getClaudeOutput();
            agentOutput = retryParsed.text;
            // Accumulate cost/tokens from retry run
            if (retryParsed.totalCost != null) caTask.totalCost = (caTask.totalCost ?? 0) + retryParsed.totalCost;
            if (retryParsed.inputTokens != null) caTask.inputTokens = (caTask.inputTokens ?? 0) + retryParsed.inputTokens;
            if (retryParsed.outputTokens != null) caTask.outputTokens = (caTask.outputTokens ?? 0) + retryParsed.outputTokens;
            if (retryParsed.totalCost != null || retryParsed.inputTokens != null) {
              recordUsage(buildUsageRecord({
                model: input.model || 'claude',
                provider: 'anthropic',
                inputTokens: retryParsed.inputTokens ?? 0,
                outputTokens: retryParsed.outputTokens ?? 0,
                inputCost: 0,
                outputCost: 0,
                totalCost: retryParsed.totalCost ?? 0,
                trigger: 'code_agent',
                agentId: id,
              }));
            }
          } else {
            agentOutput = outputCollector.getCodexOutput();
          }
          caTask.status = 'validating';
          caTask.liveOutput = undefined;
          writeCodeAgentTask(caTask);
          validateResult = await runValidationPromise();
          ensureNotCancelled();
        }
        // if retry exit code non-zero, fall through with original validateResult (still !== 'PASS')
      }

      const endedAt = new Date();
      const duration = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);

      if (validateResult !== 'PASS') {
        addEvent(traceId, { type: 'validation', summary: 'Build/test validation failed', durationMs: Date.now() - startedAt.getTime() });
        await endTrace(traceId, 'error');
        Object.assign(caTask, {
          status: 'failed',
          endedAt: endedAt.toISOString(),
          durationSeconds: duration,
          exitCode,
          validationPassed: false,
          validationOutput: validateResult.slice(0, 8_000),
          outputPreview: agentOutput.slice(0, 5000),
          error: 'Validation failed',
        });
        writeCodeAgentTask(caTask);
        await notifyCodeAgentResult(caTask);
        return;
      }

      addEvent(traceId, { type: 'validation', summary: 'Build/test validation passed', durationMs: Date.now() - startedAt.getTime() });
      await endTrace(traceId, 'ok');
      Object.assign(caTask, {
        status: 'completed',
        endedAt: endedAt.toISOString(),
        durationSeconds: duration,
        exitCode,
        validationPassed: true,
        validationOutput: undefined,
        outputPreview: agentOutput.slice(0, 5000),
      });
      writeCodeAgentTask(caTask);
      await notifyCodeAgentResult(caTask);
      return;
    }

    // No validation — mark complete
    addEvent(traceId, { type: 'complete', summary: `${agent} completed (no validation)`, durationMs: Date.now() - startedAt.getTime() });
    await endTrace(traceId, 'ok');
    Object.assign(caTask, {
      status: 'completed',
      endedAt: new Date().toISOString(),
      durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      exitCode,
      outputPreview: agentOutput.slice(0, 5000),
      liveOutput: undefined,
    });
    writeCodeAgentTask(caTask);
    await notifyCodeAgentResult(caTask);
  } catch (err) {
    const errMsg = toErrorMessage(err);
    addEvent(traceId, { type: 'error', summary: errMsg.slice(0, 200), durationMs: Date.now() - startedAt.getTime() });
    await endTrace(traceId, 'error');
    Object.assign(caTask, {
      status: errMsg.includes(CANCELLED_MESSAGE) || cancelled || caTask.status === 'cancelled'
        ? 'cancelled'
        : errMsg.includes('timed out')
          ? 'timeout'
          : 'failed',
      endedAt: new Date().toISOString(),
      durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      error: errMsg,
      liveOutput: undefined,
    });
    writeCodeAgentTask(caTask);
    if (caTask.status !== "cancelled") await notifyCodeAgentResult(caTask);
  } finally {
    if (activeTimer) clearTimeout(activeTimer);
    activeTimer = null;
    activeProc = null;
    activeExecProc = null;
    if (caTask.worktreePath && !['running', 'validating', 'pending'].includes(caTask.status)) {
      caTask.worktreeCleanup = cleanupCodeAgentWorktree({
        sourceWorkdir: caTask.sourceWorkdir,
        worktreePath: caTask.worktreePath,
        worktreeRef: caTask.worktreeRef,
        config: options?.worktreeConfig,
      });
      writeCodeAgentTask(caTask);
    }
    deleteCodeAgentCanceller(id);
  }
}
