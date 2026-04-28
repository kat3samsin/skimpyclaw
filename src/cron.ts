// Cron scheduler using croner

import { Cron } from 'croner';
import { exec } from 'child_process';
import { existsSync, mkdirSync, appendFileSync, readFileSync, watch, type FSWatcher } from 'fs';
import { join, resolve } from 'path';
import { getLogsDir, getConfigPath, loadConfig, resolveAllowedPaths } from './config.js';
import type { Config, CronJob, ToolConfig } from './types.js';
import { homedir } from 'node:os';
import { runAgentTurn } from './agent.js';
import { startTrace, addEvent, endTrace } from './audit.js';
import { sendActiveChannelProactiveMessage, sendActiveChannelProactiveVoice, getActiveChannelId } from './channels.js';
import { sendToDiscordThread, sendToDiscordThreadWithVoice } from './channels/discord/index.js';
import { parseAndSaveDigest } from './digests.js';
import { synthesizeSpeech } from './voice.js';
import { toErrorMessage } from './utils.js';
import { sanitizeCronEnv } from './env-sanitizer.js';

function safeTimezone(tz: string | undefined): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (!tz) return fallback;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    console.warn(`[cron] Invalid timezone "${tz}", falling back to ${fallback}`);
    return fallback;
  }
}
interface ScheduledJob {
  id: string;
  name: string;
  job: Cron;
  nextRun?: Date;
}

const scheduledJobs: Map<string, ScheduledJob> = new Map();
let configWatcher: FSWatcher | null = null;

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
const activeExecutions: Set<string> = new Set();

export function getCronRunStatus(): { running: string[]; recent: CronLogEntry[] } {
  return {
    running: Array.from(runningJobs.keys()),
    recent: Array.from(runningJobs.values()),
  };
}

/**
 * Send a cron notification to the configured target.
 * If discordThreadId is set, only routes to that thread.
 * Active-channel fallback only applies when no discordThreadId is configured.
 * Optionally includes voice attachment if voiceBuffer and voiceFormat are provided.
 * Returns true if sent successfully.
 */
async function sendCronNotification(
  config: Config,
  message: string,
  discordThreadId?: string,
  voiceBuffer?: Uint8Array,
  voiceFormat?: string,
): Promise<boolean> {
  if (discordThreadId) {
    try {
      // Use voice-enabled sender for Discord threads if voice is provided
      if (voiceBuffer && voiceFormat) {
        const sent = await sendToDiscordThreadWithVoice(discordThreadId, message, voiceBuffer, voiceFormat);
        if (sent) return true;
        console.error(`[cron] Failed to send to Discord thread ${discordThreadId} with voice; active-channel fallback disabled for thread-targeted jobs`);
        return false;
      }

      const sent = await sendToDiscordThread(discordThreadId, message);
      if (sent) return true;
      console.error(`[cron] Failed to send to Discord thread ${discordThreadId}; active-channel fallback disabled for thread-targeted jobs`);
      return false;
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      console.error(`[cron] Discord thread delivery failed for ${discordThreadId}; active-channel fallback disabled: ${errorText}`);
      return false;
    }
  }

  // Fallback to active channel for non-thread-targeted jobs
  if (voiceBuffer && voiceFormat) {
    // Send voice to active channel if provided
    await sendActiveChannelProactiveVoice(config, voiceBuffer, voiceFormat);
  }
  return sendActiveChannelProactiveMessage(config, message);
}

function resolveDiscordThreadTarget(jobDef: CronJob): string | undefined {
  const threadId = jobDef.payload.discordThreadId?.trim();
  if (!threadId) return undefined;
  // Discord snowflakes are numeric IDs. Validate eagerly so invalid config falls back cleanly.
  if (!/^\d{17,20}$/.test(threadId)) {
    console.warn(`[cron] Invalid discordThreadId for job "${jobDef.id}": ${JSON.stringify(jobDef.payload.discordThreadId)}`);
    return undefined;
  }
  return threadId;
}

const CRON_AGENT_RETRY_DELAYS_MS = [5000, 15000];

export function isRetryableCronAgentError(err: unknown): boolean {
  const message = toErrorMessage(err).toLowerCase();
  return [
    'codex api 503',
    'upstream connect error',
    'connection refused',
    'connection reset',
    'remote connection failure',
    'fetch failed',
    'econnreset',
    'econnrefused',
    'etimedout',
    'overloaded_error',
    'temporarily unavailable',
  ].some(pattern => message.includes(pattern));
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function runCronAgentTurnWithRetry(jobId: string, run: () => Promise<string>): Promise<string> {
  for (let attempt = 0; attempt <= CRON_AGENT_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= CRON_AGENT_RETRY_DELAYS_MS.length || !isRetryableCronAgentError(err)) {
        throw err;
      }

      const delayMs = CRON_AGENT_RETRY_DELAYS_MS[attempt];
      appendCronLogLine(
        jobId,
        `Agent turn transient failure; retrying in ${(delayMs / 1000).toFixed(0)}s (${attempt + 1}/${CRON_AGENT_RETRY_DELAYS_MS.length}): ${toErrorMessage(err).slice(0, 180)}`,
      );
      await sleep(delayMs);
    }
  }

  throw new Error('Unreachable cron retry state');
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

  // Watch config.json for changes and re-initialize cron jobs
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    configWatcher = watch(getConfigPath(), () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        try {
          const newConfig = loadConfig();
          console.log('[cron] Config changed, reloading cron jobs...');
          for (const job of scheduledJobs.values()) {
            job.job.stop();
          }
          scheduledJobs.clear();
          for (const jobDef of newConfig.cron.jobs) {
            scheduleJob(jobDef, newConfig);
          }
          console.log(`[cron] Reloaded ${scheduledJobs.size} jobs`);
        } catch (err) {
          console.error('[cron] Failed to reload config:', err);
        }
      }, 1000);
    });
  } catch (err) {
    console.warn('[cron] Could not watch config file:', err);
  }
}

function scheduleJob(jobDef: CronJob, config: Config): void {
  if ((jobDef as any).enabled === false) {
    console.log(`[cron] Skipping disabled job: ${jobDef.id}`);
    return;
  }
  if (jobDef.schedule.kind !== 'cron') {
    console.warn(`[cron] Unsupported schedule kind: ${jobDef.schedule.kind}`);
    return;
  }

  const cronJob = new Cron(
    jobDef.schedule.expr!,
    {
      timezone: safeTimezone(jobDef.schedule.tz),
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
  if (activeExecutions.has(jobDef.id)) {
    const message = `Skipping overlapping run for job "${jobDef.id}" (previous run still active)`;
    console.warn(`[cron] ${message}`);
    appendCronLogLine(jobDef.id, `=== SKIPPED: overlap guard (${jobDef.id}) ===`);
    return;
  }

  activeExecutions.add(jobDef.id);

  const logEntry: CronLogEntry = {
    jobId: jobDef.id,
    jobName: jobDef.name,
    startedAt: new Date().toISOString(),
    status: 'running',
  };
  runningJobs.set(jobDef.id, logEntry);
  const discordThreadId = resolveDiscordThreadTarget(jobDef);

  // Track synthesized voice for final notification
  let synthesizedVoice: { buffer: Uint8Array; format: string } | null = null;

  // Log start immediately
  appendCronLogLine(jobDef.id, `=== STARTED: ${jobDef.name} (${jobDef.id}) ===`);
  appendCronLogLine(jobDef.id, `Model: ${jobDef.model || 'default'}`);
  appendCronLogLine(jobDef.id, `Payload: ${jobDef.payload.kind}`);

  // Notify channel at start
  try {
    await sendCronNotification(config, `🔄 Cron starting: ${jobDef.name}`, discordThreadId);
  } catch {
    // Non-critical
  }

  try {
    if (jobDef.payload.kind === 'agentTurn') {
      const message = expandVariables(resolveMessageSource(jobDef.payload.message || ''));
      appendCronLogLine(jobDef.id, `Agent turn started (prompt: ${message.slice(0, 100)}...)`);
      const defaultTools: ToolConfig = {
        enabled: true,
        allowedPaths: resolveAllowedPaths(config),
        maxIterations: 30,
        bashTimeout: 15000,
      };
      const tools = jobDef.payload.tools
        ? { ...jobDef.payload.tools, allowedPaths: resolveAllowedPaths(config, jobDef.payload.tools.allowedPaths) }
        : defaultTools;
      const response = await runCronAgentTurnWithRetry(
        jobDef.id,
        () => runAgentTurn(
          config.agents.default,
          message,
          config,
          jobDef.model,
          tools,
          undefined,
          {
            channel: getActiveChannelId() || 'telegram',
            trigger: 'cron',
            sessionId: jobDef.id,
            metadata: { jobName: jobDef.name, isCronJob: true },
          },
        ),
      );
      appendCronLogLine(jobDef.id, `Agent turn completed (${response.length} chars)`);

      // Parse dual output (voice + text) if delimiters present
      const { voice: voicePortion, text: textPortion } = parseDualOutput(response);
      if (voicePortion) {
        appendCronLogLine(jobDef.id, `Dual output parsed: voice=${voicePortion.length} chars, text=${textPortion.length} chars`);
      }

      // Use text portion for log output and notifications
      logEntry.output = textPortion.slice(0, 5000);

      // Parse and save digest from the text portion
      try {
        const digest = parseAndSaveDigest(jobDef.id, jobDef.name, textPortion);
        appendCronLogLine(jobDef.id, 'Digest saved');
        if (digest.articles.length > 0) {
          const digestMessage = digest.summary ?? textPortion;
          if (!digestMessage || !digestMessage.trim()) {
            appendCronLogLine(jobDef.id, 'Digest message is empty, skipping send');
          } else {
            try {
              const sent = await sendCronNotification(config, digestMessage, discordThreadId);
              if (sent) {
                appendCronLogLine(jobDef.id, `Digest sent to chat (${digestMessage.length} chars)`);
              } else if (discordThreadId) {
                appendCronLogLine(jobDef.id, `Digest thread delivery failed (threadId=${discordThreadId}); no active-channel fallback`);
              } else {
                appendCronLogLine(jobDef.id, 'Failed to send digest to chat');
              }
            } catch {
              appendCronLogLine(jobDef.id, 'Failed to send digest to chat');
            }
          }
        }
      } catch (digestErr) {
        const errMsg = digestErr instanceof Error ? digestErr.message : String(digestErr);
        appendCronLogLine(jobDef.id, `Failed to save digest: ${errMsg}`);
      }

      // Synthesize voice if configured (stored for final notification)
      if (jobDef.payload.sendAsVoice && config.voice) {
        try {
          // Use voice portion if available, fall back to text
          const voiceContent = voicePortion || textPortion;
          appendCronLogLine(jobDef.id, `Synthesizing voice (${voicePortion ? 'voice portion' : 'full text fallback'})...`);
          const speech = await synthesizeSpeech(voiceContent, config.voice);
          appendCronLogLine(jobDef.id, `Voice synthesized (${speech.format}, ${speech.provider}, ${speech.buffer.length} bytes)`);
          // Store for final notification instead of sending immediately
          synthesizedVoice = { buffer: speech.buffer, format: speech.format };
          appendCronLogLine(jobDef.id, 'Voice stored for final notification');
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
        const output = await executeScript(jobDef, config);
        logEntry.output = output.slice(0, 50000);
        appendCronLogLine(jobDef.id, `Script completed (${output.length} chars)`);
        addEvent(scriptTraceId, {
          type: 'script_complete',
          summary: `Output: ${output.slice(0, 150)}`,
          durationMs: 0,
        });
        await endTrace(scriptTraceId, 'ok');

        // Parse and save digest from script output (same as agentTurn path)
        try {
          const digest = parseAndSaveDigest(jobDef.id, jobDef.name, output);
          appendCronLogLine(jobDef.id, `Digest saved: ${digest.articles.length} articles`);
        } catch (digestErr) {
          const errMsg = digestErr instanceof Error ? digestErr.message : String(digestErr);
          appendCronLogLine(jobDef.id, `Failed to save digest: ${errMsg}`);
        }
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
    const msg = toErrorMessage(err);
    logEntry.status = msg.includes('TIMEOUT') || msg.includes('timed out') ? 'timeout' : 'error';
    logEntry.error = msg;
    appendCronLogLine(jobDef.id, `=== FAILED: ${logEntry.status} — ${msg.slice(0, 200)} ===`);
    throw err;
  } finally {
    logEntry.finishedAt = new Date().toISOString();
    logEntry.durationMs = new Date(logEntry.finishedAt).getTime() - new Date(logEntry.startedAt).getTime();
    writeCronLog(logEntry);
    runningJobs.delete(jobDef.id);
    activeExecutions.delete(jobDef.id);
    const elapsed = (logEntry.durationMs / 1000).toFixed(1);
    console.log(`[cron] Job ${jobDef.id} finished: ${logEntry.status} (${elapsed}s)`);

    // Notify active channel with optional voice attachment
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

      // Include synthesized voice if available
      if (synthesizedVoice) {
        appendCronLogLine(jobDef.id, `Sending notification with voice (${synthesizedVoice.format})`);
        const sent = await sendCronNotification(
          config,
          notification,
          discordThreadId,
          synthesizedVoice.buffer,
          synthesizedVoice.format,
        );
        if (!sent && discordThreadId) {
          appendCronLogLine(jobDef.id, `Final thread notification delivery failed (threadId=${discordThreadId}); no active-channel fallback`);
        }
      } else {
        const sent = await sendCronNotification(config, notification, discordThreadId);
        if (!sent && discordThreadId) {
          appendCronLogLine(jobDef.id, `Final thread notification delivery failed (threadId=${discordThreadId}); no active-channel fallback`);
        }
      }
    } catch (notifyErr) {
      console.error(`[cron] Failed to send notification: ${notifyErr}`);
    }
  }
}

async function executeScript(jobDef: CronJob, config: Config): Promise<string> {
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
      env: sanitizeCronEnv(),
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

  const promptsRoot = resolve(homedir(), '.skimpyclaw', 'prompts');
  const resolved = trimmed.startsWith('~/')
    ? resolve(homedir(), trimmed.slice(2))
    : trimmed.startsWith('/')
      ? resolve(trimmed)
      : resolve(promptsRoot, trimmed);
  const insidePromptsRoot = resolved === promptsRoot || resolved.startsWith(`${promptsRoot}/`);
  if (!insidePromptsRoot) {
    console.warn(`[cron] Rejected prompt path outside ~/.skimpyclaw/prompts: ${trimmed}`);
    return message;
  }

  if (existsSync(resolved)) {
    console.log(`[cron] Loading prompt from file: ${resolved}`);
    return readFileSync(resolved, 'utf-8');
  }

  console.warn(`[cron] Could not resolve prompt file: ${trimmed}`);
  // Not a valid file path — treat as regular message text
  return message;
}

/**
 * Parse dual-output format with ---VOICE--- and ---TEXT--- delimiters.
 * Returns voice (concise, no links) and text (full detail) portions.
 * If delimiters not found, returns full response as text with voice = null (backward compatible).
 */
export function parseDualOutput(response: string): { voice: string | null; text: string } {
  const voiceMarker = '---VOICE---';
  const textMarker = '---TEXT---';

  const voiceIdx = response.indexOf(voiceMarker);
  const textIdx = response.indexOf(textMarker);

  if (voiceIdx === -1 || textIdx === -1) {
    // No delimiters — backward compatible
    return { voice: null, text: response };
  }

  // Extract content between markers
  const voiceStart = voiceIdx + voiceMarker.length;
  const voice = response.slice(voiceStart, textIdx).trim();
  const text = response.slice(textIdx + textMarker.length).trim();

  return {
    voice: voice || null,
    text: text || response,
  };
}

function expandVariables(message: string): string {
  const now = new Date();
  const date = now.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const yyyy = now.getFullYear();
  const dateMmDdYyyy = `${mm}-${dd}-${yyyy}`;

  return message
    .replace(/\{\{date\}\}/g, date)
    .replace(/\{\{date_mm-dd-yyyy\}\}/g, dateMmDdYyyy)
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
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }
  for (const job of scheduledJobs.values()) {
    job.job.stop();
  }
  scheduledJobs.clear();
}
