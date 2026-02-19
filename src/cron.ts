// Cron scheduler using croner

import { Cron } from 'croner';
import { exec } from 'child_process';
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { getLogsDir } from './config.js';
import type { Config, CronJob } from './types.js';
import { runAgentTurn } from './agent.js';
import { startTrace, addEvent, endTrace } from './audit.js';
import { sendActiveChannelProactiveMessage, sendActiveChannelProactiveVoice, getActiveChannelId } from './channels.js';
import { parseAndSaveDigest } from './digests.js';
import { synthesizeSpeech } from './voice.js';

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

function appendCronLogLine(jobId: string, line: string): void {
  const logPath = getCronLogPath(jobId);
  const timestamp = new Date().toISOString();
  appendFileSync(logPath, `[${timestamp}] ${line}\n`);
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

  // Log start immediately
  appendCronLogLine(jobDef.id, `=== STARTED: ${jobDef.name} (${jobDef.id}) ===`);
  appendCronLogLine(jobDef.id, `Model: ${jobDef.model || 'default'}`);
  appendCronLogLine(jobDef.id, `Payload: ${jobDef.payload.kind}`);

  // Notify channel at start
  try {
    await sendActiveChannelProactiveMessage(config, `🔄 Cron starting: ${jobDef.name}`);
  } catch {
    // Non-critical
  }

  try {
    if (jobDef.payload.kind === 'agentTurn') {
      const message = expandVariables(resolveMessageSource(jobDef.payload.message || ''));
      appendCronLogLine(jobDef.id, `Agent turn started (prompt: ${message.slice(0, 100)}...)`);
      const response = await runAgentTurn(
        config.agents.default,
        message,
        config,
        jobDef.model,
        jobDef.payload.tools,
        undefined,
        {
          channel: getActiveChannelId() || 'telegram',
          trigger: 'cron',
          sessionId: jobDef.id,
          metadata: { jobName: jobDef.name },
        }
      );
      logEntry.output = response.slice(0, 5000);
      appendCronLogLine(jobDef.id, `Agent turn completed (${response.length} chars)`);
      // Parse and save digest from the response
      try {
        parseAndSaveDigest(jobDef.id, jobDef.name, response);
        appendCronLogLine(jobDef.id, 'Digest saved');
      } catch (digestErr) {
        const errMsg = digestErr instanceof Error ? digestErr.message : String(digestErr);
        appendCronLogLine(jobDef.id, `Failed to save digest: ${errMsg}`);
      }

      // Synthesize and send voice if configured
      if (jobDef.payload.sendAsVoice && config.voice) {
        try {
          appendCronLogLine(jobDef.id, 'Synthesizing voice...');
          const speech = await synthesizeSpeech(response, config.voice);
          appendCronLogLine(jobDef.id, `Voice synthesized (${speech.format}, ${speech.provider}, ${speech.buffer.length} bytes)`);
          const sent = await sendActiveChannelProactiveVoice(config, speech.buffer, speech.format);
          if (sent) {
            appendCronLogLine(jobDef.id, 'Voice message sent to active channel');
          } else {
            appendCronLogLine(jobDef.id, 'No active channel for voice message');
          }
        } catch (voiceErr) {
          const errMsg = voiceErr instanceof Error ? voiceErr.message : String(voiceErr);
          appendCronLogLine(jobDef.id, `Voice synthesis failed: ${errMsg}`);
          // Non-fatal — text notification still sends
        }
      }
    } else if (jobDef.payload.kind === 'script') {
      const scriptTraceId = startTrace('cron');
      addEvent(scriptTraceId, {
        type: 'script_start',
        summary: `${jobDef.name}: ${(jobDef.payload.script || '').slice(0, 100)}`,
        durationMs: 0,
      });
      appendCronLogLine(jobDef.id, `Script started: ${(jobDef.payload.script || '').slice(0, 100)}`);
      try {
        const output = await executeScript(jobDef);
        logEntry.output = output.slice(0, 50000);
        appendCronLogLine(jobDef.id, `Script completed (${output.length} chars)`);
        addEvent(scriptTraceId, {
          type: 'script_complete',
          summary: `Output: ${output.slice(0, 150)}`,
          durationMs: 0,
        });
        await endTrace(scriptTraceId, 'ok');
      } catch (scriptErr) {
        const scriptErrMsg = scriptErr instanceof Error ? scriptErr.message : String(scriptErr);
        addEvent(scriptTraceId, {
          type: 'script_error',
          summary: scriptErrMsg.slice(0, 150),
          durationMs: 0,
        });
        await endTrace(scriptTraceId, 'error');
        throw scriptErr;
      }
    }

    logEntry.status = 'success';
    appendCronLogLine(jobDef.id, `=== COMPLETED: success ===`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logEntry.status = msg.includes('TIMEOUT') || msg.includes('timed out') ? 'timeout' : 'error';
    logEntry.error = msg;
    appendCronLogLine(jobDef.id, `=== FAILED: ${logEntry.status} — ${msg.slice(0, 200)} ===`);
    throw err;
  } finally {
    logEntry.finishedAt = new Date().toISOString();
    logEntry.durationMs = new Date(logEntry.finishedAt).getTime() - new Date(logEntry.startedAt).getTime();
    writeCronLog(logEntry);
    runningJobs.delete(jobDef.id);
    const elapsed = (logEntry.durationMs / 1000).toFixed(1);
    console.log(`[cron] Job ${jobDef.id} finished: ${logEntry.status} (${elapsed}s)`);

    // Notify active channel
    try {
      const icon = logEntry.status === 'success' ? '✅' : logEntry.status === 'timeout' ? '⏰' : '❌';
      let notification = `${icon} Cron: ${jobDef.name} — ${logEntry.status} (${elapsed}s)`;
      if (logEntry.error) {
        notification += `\nError: ${logEntry.error.slice(0, 200)}`;
      }
      // Send status + output preview (truncated at 4000 chars for Telegram limit)
      if (logEntry.status === 'success' && logEntry.output) {
        const output = logEntry.output.length > 4000
          ? logEntry.output.slice(0, 4000) + '...'
          : logEntry.output;
        notification += `\n\n${output}`;
      }
      await sendActiveChannelProactiveMessage(config, notification);
    } catch (notifyErr) {
      console.error(`[cron] Failed to send notification: ${notifyErr}`);
    }
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


/**
 * If message is a path to a .md file, read and return its contents.
 * Supports ~ home expansion. Otherwise returns the string as-is.
 */
function resolveMessageSource(message: string): string {
  const trimmed = message.trim();
  if (!trimmed.endsWith('.md')) return message;

  // Expand ~ to home directory
  const resolved = trimmed.startsWith('~/')
    ? join(process.env.HOME || '', trimmed.slice(2))
    : trimmed;

  if (existsSync(resolved)) {
    console.log(`[cron] Loading prompt from file: ${resolved}`);
    return readFileSync(resolved, 'utf-8');
  }

  // Not a valid file path — treat as regular message text
  return message;
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
