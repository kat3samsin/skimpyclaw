// Autoresearch Tool — autonomous experiment loop infrastructure
//
// Provides init_experiment, run_experiment, log_experiment tools.
// Domain-agnostic: the skill defines what to optimize.

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync, spawn } from 'child_process';
import type { ExecuteToolContext } from './execute-context.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExperimentConfig {
  name: string;
  metricName: string;
  metricUnit: string;
  direction: 'lower' | 'higher';
}

interface ExperimentResult {
  run: number;
  commit: string;
  metric: number;
  metrics: Record<string, number>;
  status: 'keep' | 'discard' | 'crash' | 'checks_failed';
  description: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// State (per-session, reconstructed from JSONL)
// ---------------------------------------------------------------------------

let sessionConfig: ExperimentConfig | null = null;
let sessionResults: ExperimentResult[] = [];
let lastRunChecksPass: boolean | null = null;

function getJsonlPath(cwd: string): string {
  return join(cwd, 'autoresearch.jsonl');
}

function reconstructState(cwd: string): void {
  const jsonlPath = getJsonlPath(cwd);
  sessionConfig = null;
  sessionResults = [];

  if (!existsSync(jsonlPath)) return;

  try {
    const lines = readFileSync(jsonlPath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'config') {
          sessionConfig = {
            name: entry.name,
            metricName: entry.metricName,
            metricUnit: entry.metricUnit || '',
            direction: entry.bestDirection || 'lower',
          };
          continue;
        }
        sessionResults.push(entry as ExperimentResult);
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file read error */ }
}

function isBetter(current: number, best: number, direction: 'lower' | 'higher'): boolean {
  return direction === 'lower' ? current < best : current > best;
}

function formatNum(n: number, unit: string): string {
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return s + (unit || '');
}

// ---------------------------------------------------------------------------
// init_experiment
// ---------------------------------------------------------------------------

export function executeInitExperiment(
  input: Record<string, any>,
  cwd: string,
): string {
  const name = input.name as string;
  const metricName = input.metric_name as string;
  const metricUnit = (input.metric_unit as string) || '';
  const direction = (input.direction as string) === 'higher' ? 'higher' : 'lower';

  if (!name || !metricName) {
    return 'Error: name and metric_name are required';
  }

  sessionConfig = { name, metricName, metricUnit, direction };
  sessionResults = [];
  lastRunChecksPass = null;

  const jsonlPath = getJsonlPath(cwd);
  const config = JSON.stringify({
    type: 'config',
    name,
    metricName,
    metricUnit,
    bestDirection: direction,
  });

  // Append for re-init, create for first
  if (existsSync(jsonlPath) && readFileSync(jsonlPath, 'utf-8').trim().length > 0) {
    appendFileSync(jsonlPath, config + '\n');
  } else {
    writeFileSync(jsonlPath, config + '\n');
  }

  return `✅ Experiment initialized: "${name}"\nMetric: ${metricName} (${metricUnit || 'unitless'}, ${direction} is better)\nConfig written to autoresearch.jsonl. Now run the baseline with run_experiment.`;
}

// ---------------------------------------------------------------------------
// run_experiment
// ---------------------------------------------------------------------------

export async function executeRunExperiment(
  input: Record<string, any>,
  cwd: string,
): Promise<string> {
  const command = input.command as string;
  if (!command) return 'Error: command is required';

  const timeoutMs = ((input.timeout_seconds as number) || 600) * 1000;
  const checksTimeoutMs = ((input.checks_timeout_seconds as number) || 300) * 1000;

  // Ensure state is loaded
  if (!sessionConfig) reconstructState(cwd);

  const t0 = Date.now();

  // Run the benchmark command
  let exitCode: number | null = null;
  let stdout = '';
  let timedOut = false;

  try {
    const result = await spawnWithTimeout(command, cwd, timeoutMs);
    exitCode = result.exitCode;
    stdout = result.output;
    timedOut = result.timedOut;
  } catch (err) {
    return `💥 FAILED to start command: ${err instanceof Error ? err.message : String(err)}`;
  }

  const durationSeconds = (Date.now() - t0) / 1000;
  const benchmarkPassed = exitCode === 0 && !timedOut;

  // Run backpressure checks if benchmark passed
  let checksPass: boolean | null = null;
  let checksTimedOut = false;
  let checksOutput = '';
  let checksDuration = 0;

  const checksPath = join(cwd, 'autoresearch.checks.sh');
  if (benchmarkPassed && existsSync(checksPath)) {
    const ct0 = Date.now();
    try {
      const checksResult = await spawnWithTimeout(`bash ${checksPath}`, cwd, checksTimeoutMs);
      checksDuration = (Date.now() - ct0) / 1000;
      checksTimedOut = checksResult.timedOut;
      checksPass = checksResult.exitCode === 0 && !checksResult.timedOut;
      checksOutput = checksResult.output;
    } catch (err) {
      checksDuration = (Date.now() - ct0) / 1000;
      checksPass = false;
      checksOutput = err instanceof Error ? err.message : String(err);
    }
  }

  lastRunChecksPass = checksPass;

  // Build response
  let text = '';
  if (timedOut) {
    text += `⏰ TIMEOUT after ${durationSeconds.toFixed(1)}s\n`;
  } else if (!benchmarkPassed) {
    text += `💥 FAILED (exit code ${exitCode}) in ${durationSeconds.toFixed(1)}s\n`;
  } else if (checksTimedOut) {
    text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
    text += `⏰ CHECKS TIMEOUT after ${checksDuration.toFixed(1)}s\n`;
    text += `Log this as 'checks_failed'.\n`;
  } else if (checksPass === false) {
    text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
    text += `💥 CHECKS FAILED in ${checksDuration.toFixed(1)}s\n`;
    text += `Log this as 'checks_failed'.\n`;
  } else {
    text += `✅ PASSED in ${durationSeconds.toFixed(1)}s\n`;
    if (checksPass === true) {
      text += `✅ Checks passed in ${checksDuration.toFixed(1)}s\n`;
    }
  }

  // Show current best
  if (sessionConfig && sessionResults.length > 0) {
    const kept = sessionResults.filter(r => r.status === 'keep' && r.metric > 0);
    if (kept.length > 0) {
      let best = kept[0].metric;
      for (const r of kept) {
        if (isBetter(r.metric, best, sessionConfig.direction)) best = r.metric;
      }
      text += `📊 Current best ${sessionConfig.metricName}: ${formatNum(best, sessionConfig.metricUnit)}\n`;
    }
  }

  // Last 80 lines of output
  const tailLines = stdout.split('\n').slice(-80).join('\n');
  text += `\nLast 80 lines of output:\n${tailLines}`;

  if (checksPass === false) {
    const checksTail = checksOutput.split('\n').slice(-80).join('\n');
    text += `\n\n── Checks output (last 80 lines) ──\n${checksTail}`;
  }

  // Truncate to avoid blowing up context
  if (text.length > 40000) {
    text = text.slice(0, 40000) + '\n\n[Truncated]';
  }

  return text;
}

// ---------------------------------------------------------------------------
// log_experiment
// ---------------------------------------------------------------------------

export function executeLogExperiment(
  input: Record<string, any>,
  cwd: string,
): string {
  const commit = (input.commit as string)?.slice(0, 7) || '';
  const metric = input.metric as number;
  const status = input.status as string;
  const description = input.description as string;
  const secondaryMetrics = (input.metrics as Record<string, number>) || {};

  if (!status || !description) {
    return 'Error: status and description are required';
  }
  if (!['keep', 'discard', 'crash', 'checks_failed'].includes(status)) {
    return `Error: status must be keep, discard, crash, or checks_failed (got "${status}")`;
  }

  // Gate: prevent "keep" when checks failed
  if (status === 'keep' && lastRunChecksPass === false) {
    return `❌ Cannot keep — autoresearch.checks.sh failed. Log as 'checks_failed' instead.`;
  }

  // Ensure state is loaded
  if (!sessionConfig) reconstructState(cwd);

  const result: ExperimentResult = {
    run: sessionResults.length + 1,
    commit,
    metric: metric ?? 0,
    metrics: secondaryMetrics,
    status: status as ExperimentResult['status'],
    description,
    timestamp: Date.now(),
  };

  // Git commit on keep, revert on discard/crash
  let gitMessage = '';
  if (status === 'keep') {
    try {
      const resultData: Record<string, unknown> = {
        status,
        [sessionConfig?.metricName || 'metric']: metric,
        ...secondaryMetrics,
      };
      const commitMsg = `${description}\n\nResult: ${JSON.stringify(resultData)}`;
      const gitOutput = execSync(
        `git add -A && git diff --cached --quiet && echo "NOTHING_TO_COMMIT" || git commit -m ${JSON.stringify(commitMsg)}`,
        { cwd, encoding: 'utf-8', timeout: 10000 }
      ).trim();

      if (gitOutput.includes('NOTHING_TO_COMMIT')) {
        gitMessage = '📝 Git: nothing to commit';
      } else {
        gitMessage = `📝 Git: committed`;
        // Get actual commit hash
        try {
          const sha = execSync('git rev-parse --short=7 HEAD', { cwd, encoding: 'utf-8', timeout: 5000 }).trim();
          if (sha) result.commit = sha;
        } catch { /* keep original */ }
      }
    } catch (err) {
      gitMessage = `⚠️ Git commit failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    // Revert changes on discard/crash/checks_failed
    try {
      execSync('git checkout -- . && git clean -fd', { cwd, timeout: 10000 });
      gitMessage = `📝 Git: reverted (${status})`;
    } catch {
      gitMessage = '⚠️ Git revert failed';
    }
  }

  sessionResults.push(result);
  lastRunChecksPass = null;

  // Append to JSONL
  try {
    appendFileSync(getJsonlPath(cwd), JSON.stringify(result) + '\n');
  } catch { /* best effort */ }

  // Build response
  let text = `Logged #${result.run}: ${status} — ${description}`;

  if (sessionConfig) {
    const baseline = sessionResults.length > 0 ? sessionResults[0].metric : null;
    if (baseline !== null) {
      text += `\nBaseline ${sessionConfig.metricName}: ${formatNum(baseline, sessionConfig.metricUnit)}`;
      if (status === 'keep' && metric > 0 && baseline !== 0) {
        const pct = ((metric - baseline) / baseline * 100).toFixed(1);
        const sign = metric > baseline ? '+' : '';
        text += ` | this: ${formatNum(metric, sessionConfig.metricUnit)} (${sign}${pct}%)`;
      }
    }
  }

  text += `\n${gitMessage}`;
  text += `\n(${sessionResults.length} experiments total)`;

  return text;
}

// ---------------------------------------------------------------------------
// Helper: spawn with timeout
// ---------------------------------------------------------------------------

function spawnWithTimeout(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;

    const proc = spawn('bash', ['-c', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 3000);
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output, timedOut });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, output: err.message, timedOut: false });
    });
  });
}
