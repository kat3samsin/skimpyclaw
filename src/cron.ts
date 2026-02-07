// Cron scheduler using croner

import { Cron } from 'croner';
import { exec } from 'child_process';
import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { getLogsDir } from './config.js';
import type { Config, CronJob } from './types.js';
import { runAgentTurn } from './agent.js';

interface ScheduledJob {
  id: string;
  name: string;
  job: Cron;
  nextRun?: Date;
}

const scheduledJobs: Map<string, ScheduledJob> = new Map();

// --- Cron Logging ---

interface CronLogEntry {
  jobId: string;
  jobName: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status: 'running' | 'success' | 'error' | 'timeout';
  error?: string;
  output?: string;
}

function getCronLogDir(): string {
  const dir = join(getLogsDir(), 'cron');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getCronLogPath(jobId: string): string {
  const date = new Date().toISOString().split('T')[0];
  return join(getCronLogDir(), `${jobId}-${date}.log`);
}

function writeCronLog(entry: CronLogEntry): void {
  const logPath = getCronLogPath(entry.jobId);
  const separator = '\n' + '='.repeat(60) + '\n';
  const header = `[${entry.startedAt}] ${entry.jobName} (${entry.jobId})`;
  const status = `Status: ${entry.status}`;
  const duration = entry.durationMs != null ? `Duration: ${(entry.durationMs / 1000).toFixed(1)}s` : '';
  const error = entry.error ? `Error: ${entry.error}` : '';
  const output = entry.output ? `Output:\n${entry.output}` : '';

  const lines = [separator, header, status, duration, error, output]
    .filter(Boolean)
    .join('\n');

  appendFileSync(logPath, lines + '\n');
}

// Track currently running jobs for status queries
const runningJobs: Map<string, CronLogEntry> = new Map();

export function getCronRunStatus(): { running: string[]; recent: CronLogEntry[] } {
  return {
    running: Array.from(runningJobs.keys()),
    recent: Array.from(runningJobs.values()),
  };
}

export function initCron(config: Config): void {
  // Clear existing jobs
  for (const job of scheduledJobs.values()) {
    job.job.stop();
  }
  scheduledJobs.clear();

  // Schedule new jobs
  for (const jobDef of config.cron.jobs) {
    scheduleJob(jobDef, config);
  }

  console.log(`[cron] Initialized ${scheduledJobs.size} jobs`);
}

function scheduleJob(jobDef: CronJob, config: Config): void {
  if (jobDef.schedule.kind !== 'cron') {
    console.warn(`[cron] Unsupported schedule kind: ${jobDef.schedule.kind}`);
    return;
  }

  const cronJob = new Cron(
    jobDef.schedule.expr!,
    {
      timezone: jobDef.schedule.tz || 'America/Chicago',
    },
    async () => {
      console.log(`[cron] Running job: ${jobDef.name}`);
      await executeJobPayload(jobDef, config);
    }
  );

  scheduledJobs.set(jobDef.id, {
    id: jobDef.id,
    name: jobDef.name,
    job: cronJob,
    nextRun: cronJob.nextRun() ?? undefined,
  });

  console.log(`[cron] Scheduled: ${jobDef.name} (${jobDef.schedule.expr})`);
}

async function executeJobPayload(jobDef: CronJob, config: Config): Promise<void> {
  const logEntry: CronLogEntry = {
    jobId: jobDef.id,
    jobName: jobDef.name,
    startedAt: new Date().toISOString(),
    status: 'running',
  };
  runningJobs.set(jobDef.id, logEntry);

  try {
    if (jobDef.payload.kind === 'agentTurn') {
      const message = expandVariables(jobDef.payload.message || '');
      const response = await runAgentTurn(config.agents.default, message, config, jobDef.model, jobDef.payload.tools);
      logEntry.output = response.slice(0, 5000);
    } else if (jobDef.payload.kind === 'script') {
      const output = await executeScript(jobDef);
      logEntry.output = output.slice(0, 50000);
    }

    logEntry.status = 'success';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logEntry.status = msg.includes('TIMEOUT') || msg.includes('timed out') ? 'timeout' : 'error';
    logEntry.error = msg;
    throw err;
  } finally {
    logEntry.finishedAt = new Date().toISOString();
    logEntry.durationMs = new Date(logEntry.finishedAt).getTime() - new Date(logEntry.startedAt).getTime();
    writeCronLog(logEntry);
    runningJobs.delete(jobDef.id);
    console.log(`[cron] Job ${jobDef.id} finished: ${logEntry.status} (${(logEntry.durationMs / 1000).toFixed(1)}s)`);
  }
}

async function executeScript(jobDef: CronJob): Promise<string> {
  const script = expandVariables(jobDef.payload.script || '');
  if (!script) {
    throw new Error(`Script payload is empty for job: ${jobDef.id}`);
  }

  const cwd = jobDef.payload.cwd;
  if (cwd && !existsSync(cwd)) {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }

  const timeoutMs = jobDef.payload.timeoutMs || 600000; // 10 min default

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    console.log(`[cron:script] Running: ${script.slice(0, 100)}${script.length > 100 ? '...' : ''}`);
    if (cwd) console.log(`[cron:script] cwd: ${cwd}`);

    const child = exec(script, {
      cwd: cwd || undefined,
      timeout: timeoutMs,
      env: { ...process.env },
      maxBuffer: 10 * 1024 * 1024, // 10MB output buffer
    }, (error, stdout, stderr) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (error) {
        console.error(`[cron:script] Failed after ${elapsed}s: ${error.message}`);
        if (stderr) console.error(`[cron:script] stderr: ${stderr.slice(0, 500)}`);
        reject(error);
        return;
      }

      console.log(`[cron:script] Completed in ${elapsed}s`);
      if (stdout) {
        const lines = stdout.trim().split('\n');
        const preview = lines.length > 5
          ? lines.slice(0, 3).join('\n') + `\n... (${lines.length} lines total)`
          : stdout.trim();
        console.log(`[cron:script] Output:\n${preview}`);
      }
      resolve(stdout || '');
    });

    // Log PID for debugging
    if (child.pid) {
      console.log(`[cron:script] PID: ${child.pid}`);
    }
  });
}


function expandVariables(message: string): string {
  const now = new Date();
  const date = now.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return message
    .replace(/\{\{date\}\}/g, date)
    .replace(/\{\{time\}\}/g, now.toLocaleTimeString())
    .replace(/\{\{iso\}\}/g, now.toISOString());
}

export function getCronJobs(): { id: string; name: string; nextRun?: Date }[] {
  return Array.from(scheduledJobs.values()).map(j => ({
    id: j.id,
    name: j.name,
    nextRun: j.job.nextRun() ?? undefined,
  }));
}

export async function runCronJob(id: string, config: Config): Promise<void> {
  const jobDef = config.cron.jobs.find(j => j.id === id);
  if (!jobDef) {
    throw new Error(`Cron job not found: ${id}`);
  }

  await executeJobPayload(jobDef, config);
}

export interface CronJobDetail {
  id: string;
  name: string;
  schedule: { kind: string; expr?: string; tz?: string };
  payload: { kind: string; message?: string };
  model?: string;
  nextRun?: Date;
}

export function getCronJobDetails(config: Config): CronJobDetail[] {
  return config.cron.jobs.map(jobDef => {
    const scheduled = scheduledJobs.get(jobDef.id);
    return {
      id: jobDef.id,
      name: jobDef.name,
      schedule: {
        kind: jobDef.schedule.kind,
        expr: jobDef.schedule.expr,
        tz: jobDef.schedule.tz,
      },
      payload: {
        kind: jobDef.payload.kind,
        message: jobDef.payload.message,
      },
      model: jobDef.model,
      nextRun: scheduled?.job.nextRun() ?? undefined,
    };
  });
}

export function stopCron(): void {
  for (const job of scheduledJobs.values()) {
    job.job.stop();
  }
  scheduledJobs.clear();
}
