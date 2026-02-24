// Code Agent Executor - Background execution logic

import { spawn, exec } from 'child_process';
import type { ChildProcess } from 'child_process';
import { createWriteStream } from 'fs';
import { join } from 'path';

// SKIMPYCLAW_ROOT for log paths
const SKIMPYCLAW_ROOT = join(import.meta.dirname || process.cwd(), '..', '..');
import type { CodeAgentTask, CodeAgentBackgroundOptions, ValidationResult } from './types.js';
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

const CANCELLED_MESSAGE = 'Cancelled by user';

/** Run build/test validation. Shared by solo agents and team orchestrator. */
export function runValidation(workdir: string): Promise<ValidationResult> {
  return new Promise((resolve) => {
    exec('pnpm build && pnpm test', {
      cwd: workdir,
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
  const defaultTimeout = options?.defaultTimeoutMinutes ?? 10;
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
  logStream.write(`=== ${id} | ${agent} | ${new Date().toISOString()} ===\n`);
  logStream.write(`Task: ${task.slice(0, 500)}\n`);
  logStream.write(`Workdir: ${workdir}\n\n`);

  try {
    ensureNotCancelled();
    const exitCode = await new Promise<number | null>((resolvePromise, reject) => {
      const spawnEnv = { ...process.env };
      delete spawnEnv.CLAUDECODE;
      // Apply extra env vars (e.g. team mode feature flag)
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
        stdout += chunk.toString();
        logStream.write(chunk);
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
        logStream.write(chunk);
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
        logStream.write(`\n=== EXIT ${code} | ${new Date().toISOString()} ===\n`);
        logStream.end();
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
        logStream.write(`\n=== ERROR: ${err.message} ===\n`);
        logStream.end();
        reject(err);
      });
    });
    ensureNotCancelled();

    // Parse output — stream-json format is newline-delimited JSON events
    let agentOutput: string;
    if (agent === 'claude') {
      const parsed = parseClaudeOutput(stdout);
      agentOutput = parsed.text;
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

      const runValidationPromise = (): Promise<string> => new Promise((res) => {
        const validationProc = exec('pnpm build && pnpm test', {
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
          const retryProc = spawn(retryCmd, retryArgs, {
            cwd: workdir,
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
            try { agentOutput = JSON.parse(stdout).result || stdout; } catch { agentOutput = stdout || stderr || '(no output)'; }
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
    const errMsg = err instanceof Error ? err.message : String(err);
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


