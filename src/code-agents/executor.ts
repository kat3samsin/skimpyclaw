// Code Agent Executor - Background execution logic

import { spawn, exec, execSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { createWriteStream, existsSync, readFileSync } from 'fs';
import { join } from 'path';

// SKIMPYCLAW_ROOT for log paths
const SKIMPYCLAW_ROOT = join(import.meta.dirname || process.cwd(), '..', '..');
import type { CodeAgentTask, CodeAgentBackgroundOptions, ValidationResult } from './types.js';
import { toErrorMessage } from '../utils.js';
import { CODE_AGENT_TIMEOUT_MS, VALIDATE_TIMEOUT_MS } from './types.js';
import {
  getCodeAgentsDir,
  ensureCodeAgentsDir,
  writeCodeAgentTask,
  storeCodeAgentTask,
  setCodeAgentCanceller,
  deleteCodeAgentCanceller,
  getCodeAgent,
} from './registry.js';
import { buildCodeAgentArgs, notifyCodeAgentResult, resolveModelAlias } from './utils.js';
import { parseStreamJsonForLive, parseClaudeOutput, parseCodexOutput } from './parser.js';
import { startTrace, addEvent, endTrace } from '../audit.js';
import { buildUsageRecord, recordUsage } from '../usage.js';
import type { SandboxConfig } from '../types.js';
import { ensureContainer, SANDBOX_DEFAULTS, getRuntime } from '../sandbox/index.js';

const CANCELLED_MESSAGE = 'Cancelled by user';

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

/**
 * Find which monorepo packages have changed files (git diff).
 * Returns package directories relative to workdir.
 */
function getChangedPackageDirs(workdir: string): string[] {
  try {
    // Get changed files vs HEAD (staged + unstaged + untracked)
    const diff = execSync(
      'git diff --name-only HEAD 2>/dev/null; git diff --name-only --cached 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null',
      { cwd: workdir, timeout: 5000, encoding: 'utf-8' },
    ).trim();
    if (!diff) return [];

    const files = [...new Set(diff.split('\n').filter(Boolean))];
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
  } catch {
    return [];
  }
}

/**
 * Build scoped validation commands for a monorepo by detecting changed packages.
 * Returns a combined command that builds/tests only affected packages, or null
 * if this doesn't look like a monorepo or no packages were changed.
 */
function buildMonorepoValidationCommand(workdir: string): string | null {
  const wsPatterns = getWorkspacePatterns(workdir);
  if (!wsPatterns) return null;

  const changedDirs = getChangedPackageDirs(workdir);
  if (changedDirs.length === 0) return null;

  const pm = detectPackageManager(workdir);
  const parts: string[] = [];

  for (const dir of changedDirs) {
    const pkgJsonPath = join(workdir, dir, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;

    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      const pkgName = pkg.name;
      const scripts = pkg.scripts || {};

      if (!pkgName) continue;

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
 * 2. Monorepo auto-detection: scope to changed packages only
 *    - Works both when workdir is the repo root AND when it's a package subdir
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

  // 2. Monorepo auto-detection — check workdir and parent dirs
  const monorepoCmd = buildMonorepoValidationCommand(workdir);
  if (monorepoCmd) return monorepoCmd;

  // Also check if workdir is a subpackage inside a monorepo
  const monorepoRoot = findMonorepoRoot(workdir);
  if (monorepoRoot && monorepoRoot !== workdir) {
    const rootCmd = buildMonorepoValidationCommand(monorepoRoot);
    if (rootCmd) return rootCmd;
  }

  // 3. Simple project — use root package.json scripts
  const pm = detectPackageManager(workdir);
  const run = pm === 'npm' ? 'npm run' : pm;

  let hasBuild = false;
  let hasTest = false;
  try {
    const pkgPath = join(workdir, 'package.json');
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

  if (parts.length === 0) {
    return '';
  }

  return parts.join(' && ');
}

/** Run build/test validation. Shared by solo agents and team orchestrator. */
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

  // Per-invocation timeout (configurable defaults for team vs solo)
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
        max_turns: input.max_turns,
      });

  let stdout = '';
  let stderr = '';

  // Full log file — untruncated stdout + stderr
  const logPath = join(getCodeAgentsDir(), `${id}.log`);
  ensureCodeAgentsDir();
  const logStream = createWriteStream(logPath, { flags: 'w' });
  let logStreamEnded = false;
  const logWrite = (data: string | Buffer) => { if (!logStreamEnded) logStream.write(data); };
  logWrite(`=== ${id} | ${agent} | ${new Date().toISOString()} ===\n`);
  logWrite(`Task: ${task.slice(0, 500)}\n`);
  logWrite(`Workdir: ${workdir}\n\n`);

  try {
    // Resolve sandbox container name if enabled (used for spawn wrapping)
    let sandboxContainer: string | undefined;
    if (options?.sandboxConfig?.enabled) {
      const merged = { ...SANDBOX_DEFAULTS, ...options.sandboxConfig };
      sandboxContainer = await ensureContainer(`code-${id}`, merged, options.allowedPaths || [workdir]);
      console.log(`[code-agent] Running in sandbox container: ${sandboxContainer}`);
    }

    ensureNotCancelled();
    const exitCode = await new Promise<number | null>((resolvePromise, reject) => {
      const spawnEnv = { ...process.env };
      delete spawnEnv.CLAUDECODE;
      // Remove stale GH_TOKEN so gh CLI falls back to keyring auth
      delete spawnEnv.GH_TOKEN;
      delete spawnEnv.GITHUB_TOKEN;
      // Apply extra env vars (e.g. team mode feature flag)
      if (options?.env) Object.assign(spawnEnv, options.env);

      // When sandbox is enabled, wrap the spawn: container exec <name> <cmd> <args>
      const spawnCmd = sandboxContainer ? getRuntime() : cmd;
      const spawnArgs = sandboxContainer ? ['exec', sandboxContainer, cmd, ...args] : args;

      const proc = spawn(spawnCmd, spawnArgs, {
        cwd: sandboxContainer ? undefined : workdir, // container has its own cwd
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv,
      });
      activeProc = proc;

      let lastStatusWrite = 0;
      const STATUS_WRITE_INTERVAL = 3000;

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        logWrite(chunk);
        const now = Date.now();
        if (now - lastStatusWrite > STATUS_WRITE_INTERVAL) {
          lastStatusWrite = now;
          // Parse stream-json into readable live output
          const parsed = parseStreamJsonForLive(stdout);
          const live = stderr ? `[progress]\n${stderr.slice(-2000)}\n\n${parsed}` : parsed;
          caTask.liveOutput = live;
          writeCodeAgentTask(caTask);
        }
      });
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        logWrite(chunk);
        const now = Date.now();
        if (now - lastStatusWrite > STATUS_WRITE_INTERVAL) {
          lastStatusWrite = now;
          const parsedOut = parseStreamJsonForLive(stdout);
          const live = `[progress]\n${stderr.slice(-2000)}\n\n${parsedOut}`;
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
      const parsed = parseClaudeOutput(stdout);
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
      agentOutput = parseCodexOutput(stdout);
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
      if (!options?.skipNotification) await notifyCodeAgentResult(caTask, (id) => getCodeAgent(id) ?? null);
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
        if (!options?.skipNotification) await notifyCodeAgentResult(caTask, (id) => getCodeAgent(id) ?? null);
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
        stdout = '';
        stderr = '';

        const { cmd: retryCmd, args: retryArgs } = buildCodeAgentArgs({
          task: retryTask,
          agent,
          workdir,
          model: input.model,
          max_turns: input.max_turns,
        });

        const retryExitCode = await new Promise<number | null>((resolveRetry, rejectRetry) => {
          const spawnEnv = { ...process.env };
          delete spawnEnv.CLAUDECODE;
          delete spawnEnv.GH_TOKEN;
          delete spawnEnv.GITHUB_TOKEN;
          const retrySpawnCmd = sandboxContainer ? getRuntime() : retryCmd;
          const retrySpawnArgs = sandboxContainer ? ['exec', sandboxContainer, retryCmd, ...retryArgs] : retryArgs;
          const retryProc = spawn(retrySpawnCmd, retrySpawnArgs, {
            cwd: sandboxContainer ? undefined : workdir,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: spawnEnv,
          });
          activeProc = retryProc;

          let lastStatusWrite = 0;
          retryProc.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
            const now = Date.now();
            if (now - lastStatusWrite > 3000) {
              lastStatusWrite = now;
              const retryParsed = parseStreamJsonForLive(stdout);
              const live = stderr ? `[progress]\n${stderr.slice(-2000)}\n\n${retryParsed}` : retryParsed;
              caTask.liveOutput = live;
              writeCodeAgentTask(caTask);
            }
          });
          retryProc.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
            const now = Date.now();
            if (now - lastStatusWrite > 3000) {
              lastStatusWrite = now;
              const parsedOut = parseStreamJsonForLive(stdout);
              const live = `[progress]\n${stderr.slice(-2000)}\n\n${parsedOut}`;
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
            if (activeTimer) clearTimeout(activeTimer);
            activeTimer = null;
            activeProc = null;
            rejectRetry(err);
          });
        });
        ensureNotCancelled();

        if (retryExitCode === 0) {
          if (agent === 'claude') {
            const retryParsed = parseClaudeOutput(stdout);
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
            agentOutput = stdout || '(no output)';
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
        if (!options?.skipNotification) await notifyCodeAgentResult(caTask, (id) => getCodeAgent(id) ?? null);
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
      if (!options?.skipNotification) await notifyCodeAgentResult(caTask, (id) => getCodeAgent(id) ?? null);
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
    if (!options?.skipNotification) await notifyCodeAgentResult(caTask, (id) => getCodeAgent(id) ?? null);
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
    if (!options?.skipNotification && caTask.status !== 'cancelled') await notifyCodeAgentResult(caTask, getCodeAgent);
  } finally {
    if (activeTimer) clearTimeout(activeTimer);
    activeTimer = null;
    activeProc = null;
    activeExecProc = null;
    deleteCodeAgentCanceller(id);
  }
}


