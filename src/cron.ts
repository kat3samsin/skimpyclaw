// Cron scheduler using croner

import { Cron } from 'croner';
import { spawn } from 'child_process';
import { chmodSync, existsSync, mkdirSync, appendFileSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'fs';
import { dirname, join, resolve } from 'path';
import { getLogsDir, getConfigPath, loadConfig, resolveAllowedPaths } from './config.js';
import type { AbortSignalLike, Config, CronJob, ToolConfig } from './types.js';
import { homedir } from 'node:os';
import { runAgentTurn } from './agent.js';
import { startTrace, addEvent, endTrace } from './audit.js';
import { sendActiveChannelProactiveMessage, sendActiveChannelProactiveVoice, getActiveChannelId } from './channels.js';
import { sendToDiscordThread, sendToDiscordThreadWithVoice } from './channels/discord/index.js';
import { parseAndSaveDigest } from './digests.js';
import { synthesizeSpeech } from './voice.js';
import { formatDate, toErrorMessage } from './utils.js';
import { sanitizeCronEnv } from './env-sanitizer.js';
import { buildArtifactUrl, registerLocalArtifact } from './artifacts.js';
import { linkLocalHtmlArtifactsForDiscord } from './channels/discord/utils.js';
import { isPathAllowed } from './tools/path-utils.js';
import { redactSecretText } from './security.js';

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
  job: {
    stop(): void;
    nextRun(): Date | null | undefined;
  };
  nextRun?: Date;
}

const scheduledJobs: Map<string, ScheduledJob> = new Map();
let configWatcher: FSWatcher | null = null;
let configReloadTimer: ReturnType<typeof setTimeout> | null = null;

function assertUniqueCronJobIds(jobs: CronJob[]): void {
  const seen = new Set<string>();
  for (const job of jobs) {
    if (seen.has(job.id)) {
      throw new Error(`Duplicate cron job id: "${job.id}"`);
    }
    seen.add(job.id);
  }
}

function replaceScheduledJobs(config: Config): void {
  assertUniqueCronJobIds(config.cron.jobs);
  for (const job of scheduledJobs.values()) {
    job.job.stop();
  }
  scheduledJobs.clear();
  for (const jobDef of config.cron.jobs) {
    scheduleJob(jobDef, config);
  }
}

export interface CronRunTarget {
  id: string;
  name: string;
}

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

interface CronVoiceArtifact {
  buffer: Uint8Array;
  format: string;
  path?: string;
  url?: string;
}

function getCronLogDir(): string {
  const dir = join(getLogsDir(), 'cron');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(dir, 0o700);
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
  const error = entry.error ? `Error: ${redactSecretText(entry.error)}` : '';
  const output = entry.output ? `Output:\n${redactSecretText(entry.output)}` : '';

  const lines = [separator, header, status, duration, error, output]
    .filter(Boolean)
    .join('\n');

  appendFileSync(logPath, lines + '\n', { encoding: 'utf-8', mode: 0o600 });
  chmodSync(logPath, 0o600);
}

function appendCronLogLine(jobId: string, line: string): void {
  const logPath = getCronLogPath(jobId);
  const timestamp = new Date().toISOString();
  appendFileSync(logPath, `[${timestamp}] ${redactSecretText(line)}\n`, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(logPath, 0o600);
}

function safeArtifactExtension(format: string): string {
  const ext = format.toLowerCase().replace(/[^a-z0-9]/g, '');
  return ext || 'audio';
}

function saveCronVoiceArtifact(
  jobDef: CronJob,
  logEntry: CronLogEntry,
  voice: { buffer: Uint8Array; format: string },
  config: Config,
): Pick<CronVoiceArtifact, 'path' | 'url'> | null {
  if (!config.gateway?.port) return null;

  const startedAt = new Date(logEntry.startedAt);
  const date = Number.isNaN(startedAt.getTime()) ? formatDate(new Date()) : formatDate(startedAt);
  const ext = safeArtifactExtension(voice.format);
  const dir = join(homedir(), '.skimpyclaw', 'reports', 'voice', jobDef.id);
  const path = join(dir, `${date}.${ext}`);

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, Buffer.from(voice.buffer));
    const artifact = registerLocalArtifact(path);
    const url = artifact ? buildArtifactUrl(config, artifact) ?? undefined : undefined;
    return { path, url };
  } catch (err) {
    appendCronLogLine(jobDef.id, `Voice artifact save failed: ${toErrorMessage(err).slice(0, 180)}`);
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getMayoraReportDir(): string {
  return join(homedir(), '.skimpyclaw', 'reports', 'mayora-daily-briefing');
}

function replaceTemplateSlot(template: string, slot: string, value: string): string {
  return template.split(`{{${slot}}}`).join(value);
}

function renderMayoraVoiceBlock(safeVoiceUrl: string): string {
  const linkHtml = `<a class="voice-open-link" href="${safeVoiceUrl}">Open voice file</a>`;
  return `<section class="voice-link" data-voice-link><h2>Voice Briefing</h2><audio controls preload="metadata" src="${safeVoiceUrl}"></audio><p>${linkHtml}</p></section>`;
}

function displayDateFromIsoDate(date: string): string {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return date;
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day)).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function renderMayoraInlineText(value: string): string {
  let rendered = escapeHtml(value);
  rendered = rendered.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_match, label: string, url: string) => {
    const trimmedUrl = url.trim();
    if (!/^(https?:\/\/|\/)/.test(trimmedUrl)) return label;
    return `<a href="${escapeHtml(trimmedUrl)}">${label}</a>`;
  });
  return rendered
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_match, prefix: string, url: string) =>
      `${prefix}<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`,
    );
}

function renderMayoraLineGroups(lines: string[]): string[] {
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: { kind: 'ol' | 'ul'; items: string[]; start?: string } | null = null;
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${paragraph.map(renderMayoraInlineText).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const start = list.kind === 'ol' && list.start && list.start !== '1' ? ` start="${list.start}"` : '';
    html.push(`<${list.kind}${start}>${list.items.map(item => `<li>${renderMayoraInlineText(item)}</li>`).join('')}</${list.kind}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    html.push(`<blockquote>${quote.map(renderMayoraInlineText).join('<br>')}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    const heading = line.match(/^(#{2,4})\s+(.+)$/);
    if (heading) {
      flushAll();
      const level = heading[1].length === 2 ? 'h2' : 'h3';
      html.push(`<${level}>${renderMayoraInlineText(heading[2])}</${level}>`);
      continue;
    }

    const quoteLine = line.match(/^>\s?(.+)$/);
    if (quoteLine) {
      flushParagraph();
      flushList();
      quote.push(quoteLine[1]);
      continue;
    }

    const ordered = line.match(/^(\d+)\.\s+(.+)$/);
    const unordered = line.match(/^[-*]\s+(.+)$/);
    if (ordered || unordered) {
      flushParagraph();
      flushQuote();
      const kind = ordered ? 'ol' : 'ul';
      if (!list || list.kind !== kind) {
        flushList();
        list = { kind, items: [], start: ordered?.[1] };
      }
      list.items.push(ordered?.[2] ?? unordered?.[1] ?? line);
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line);
  }

  flushAll();
  return html;
}

function renderMayoraTextAsHtml(text: string, artifactPath: string): string {
  const blocks = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(block => block && !block.includes(`[Mayora Daily Briefing HTML](${artifactPath})`));
  const html: string[] = [];

  for (const block of blocks) {
    if (block === '---') {
      html.push('<hr />');
      continue;
    }
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
    html.push(...renderMayoraLineGroups(lines));
  }

  return `<section class="work"><h2>Briefing</h2>\n${html.join('\n')}\n</section>`;
}

function buildMayoraFallbackHtml(path: string, text: string, logEntry: CronLogEntry): string {
  const date = path.match(/(\d{4}-\d{2}-\d{2})\.html$/)?.[1] ?? formatDate(new Date(logEntry.startedAt));
  const title = displayDateFromIsoDate(date);
  const generatedAt = new Date().toLocaleString();
  const startedAt = new Date(logEntry.startedAt).toLocaleString();
  const mainContent = renderMayoraTextAsHtml(text, path);
  const sourceFreshness = [
    `<div><strong>Morning run</strong><br>${escapeHtml(logEntry.jobName)} completed before this HTML fallback was created.</div>`,
    `<div><strong>Started</strong><br>${escapeHtml(startedAt)}</div>`,
    `<div><strong>Generated</strong><br>${escapeHtml(generatedAt)}</div>`,
  ].join('\n');
  const sideContent = [
    '<section class="watch">',
    '<h2>Artifact status</h2>',
    '<p>This file was generated automatically from Mayora\'s completed text response because the agent did not write the HTML file itself.</p>',
    `<p class="meta">Path: <code>${escapeHtml(path)}</code></p>`,
    '</section>',
  ].join('\n');

  let template: string;
  try {
    template = readFileSync(join(homedir(), '.skimpyclaw', 'agents', 'mayora', 'HTML_TEMPLATE.html'), 'utf-8');
  } catch {
    template = [
      '<!doctype html><html lang="en"><head><meta charset="utf-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      '<title>{{TITLE}}</title></head><body><main>',
      '<header><h1>{{TITLE}}</h1><p>{{SUBTITLE}}</p></header>',
      '<section class="voice-link" data-voice-link hidden><h2>Voice Briefing</h2><audio controls preload="metadata" src="{{VOICE_URL}}"></audio><p><a class="voice-open-link" href="{{VOICE_URL}}">Open voice file</a></p></section>',
      '<div>{{SOURCE_FRESHNESS}}</div>{{MAIN_CONTENT}}<aside>{{SIDE_CONTENT}}</aside>',
      '</main></body></html>',
    ].join('');
  }

  return [
    ['TITLE', title],
    ['SUBTITLE', `Morning briefing for Katrina, backfilled from the completed ${logEntry.jobName} text output.`],
    ['VOICE_URL', ''],
    ['VOICE_LINK', ''],
    ['SOURCE_FRESHNESS', sourceFreshness],
    ['MAIN_CONTENT', mainContent],
    ['SIDE_CONTENT', sideContent],
  ].reduce((html, [slot, value]) => replaceTemplateSlot(html, slot, value), template);
}

function extractMayoraHtmlPaths(text: string, fallbackDate: string): string[] {
  const reportDir = getMayoraReportDir();
  const pathPattern = new RegExp(`${escapeRegExp(reportDir)}\\/[^\\s)>"']+\\.html`, 'g');
  const paths = new Set(text.match(pathPattern) ?? []);
  const dateMatch = text.match(/mayora-daily-briefing\/(\d{4}-\d{2}-\d{2})\.html/);
  if (dateMatch) {
    paths.add(join(reportDir, `${dateMatch[1]}.html`));
  }
  if (paths.size === 0) {
    paths.add(join(reportDir, `${fallbackDate}.html`));
  }
  return [...paths];
}

function ensureMayoraHtmlArtifact(jobDef: CronJob, agentId: string, logEntry: CronLogEntry, text: string): string {
  const isMayoraBriefing = jobDef.id === 'morning' || agentId === 'mayora' || text.includes('mayora-daily-briefing');
  if (!isMayoraBriefing) return text;

  const startedAt = new Date(logEntry.startedAt);
  const fallbackDate = Number.isNaN(startedAt.getTime()) ? formatDate(new Date()) : formatDate(startedAt);
  const paths = extractMayoraHtmlPaths(text, fallbackDate);
  const primaryPath = paths[0];

  for (const path of paths) {
    if (existsSync(path)) continue;
    try {
      mkdirSync(getMayoraReportDir(), { recursive: true });
      writeFileSync(path, buildMayoraFallbackHtml(path, text, logEntry), 'utf-8');
      appendCronLogLine(jobDef.id, `Mayora HTML fallback created: ${path}`);
    } catch (err) {
      appendCronLogLine(jobDef.id, `Mayora HTML fallback failed for ${path}: ${toErrorMessage(err).slice(0, 180)}`);
    }
  }

  return text.includes(primaryPath)
    ? text
    : `[Mayora Daily Briefing HTML](${primaryPath})\n\n${text}`;
}

export function ensureChiefHtmlArtifact(
  jobDef: CronJob,
  agentId: string,
  startedAt: string,
  text: string,
  pathExists: (path: string) => boolean = existsSync,
): string {
  const isDaily = jobDef.id === 'chief-newspaper' || agentId === 'chief';
  const isP2 = jobDef.id === 'chief-p2-reader' || agentId === 'chief-p2';
  if (!isDaily && !isP2) return text;

  const started = new Date(startedAt);
  const date = formatDate(Number.isNaN(started.getTime()) ? new Date() : started);
  const dailyReportDir = join(homedir(), '.skimpyclaw', 'reports', 'chief-daily-reader');
  const paths = isDaily
    ? [join(dailyReportDir, date, 'index.html'), join(dailyReportDir, `${date}.html`)]
    : [join(homedir(), '.skimpyclaw', 'reports', 'chief-p2-reader', `${date}.html`)];
  const missingPath = paths.find(path => !pathExists(path));
  if (missingPath) {
    // Chief reports deliberately hard-fail here so cron cannot record false success.
    throw new Error(`${isDaily ? 'Chief' : 'Chief P2'} report is missing required artifact: ${missingPath}`);
  }

  return text.includes(paths[0])
    ? text
    : `[${isDaily ? 'THE DAILY HTML' : 'Chief P2 Reader HTML'}](${paths[0]})\n\n${text}`;
}

function injectVoiceLinkIntoMayoraHtml(text: string, voiceUrl: string, jobId: string): void {
  if (!text.includes('mayora-daily-briefing') || !voiceUrl) return;

  const reportDir = getMayoraReportDir();
  const pathPattern = new RegExp(`${escapeRegExp(reportDir)}\\/[^\\s)>"']+\\.html`, 'g');
  const paths = [...new Set(text.match(pathPattern) ?? [])];
  if (paths.length === 0) return;

  const safeVoiceUrl = escapeHtml(voiceUrl);
  const voiceBlock = renderMayoraVoiceBlock(safeVoiceUrl);

  for (const path of paths) {
    try {
      if (!existsSync(path)) continue;
      const html = readFileSync(path, 'utf-8');
      let next = html;
      if (html.includes('{{VOICE_URL}}')) {
        next = html
          .replace('<section class="voice-link" data-voice-link hidden>', '<section class="voice-link" data-voice-link>')
          .replace(/\{\{VOICE_URL\}\}/g, safeVoiceUrl);
      } else if (html.includes('data-voice-link')) {
        next = html.replace(/<section class="voice-link" data-voice-link(?: hidden)?>[\s\S]*?<\/section>/, voiceBlock);
      } else if (html.includes('{{VOICE_LINK}}')) {
        next = html.replace('{{VOICE_LINK}}', voiceBlock);
      } else if (!html.includes(voiceUrl)) {
        next = html.replace('</header>', `</header>\n\n    ${voiceBlock}`);
      }
      if (next !== html) {
        writeFileSync(path, next);
        appendCronLogLine(jobId, `Voice link injected into Mayora HTML: ${path}`);
      }
    } catch (err) {
      appendCronLogLine(jobId, `Voice link injection failed for ${path}: ${toErrorMessage(err).slice(0, 180)}`);
    }
  }
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

function resolveCronAgentId(jobDef: CronJob, config: Config): string {
  const agentId = jobDef.agent || config.agents?.default;
  if (!agentId) {
    throw new Error(`Cron job "${jobDef.id}" needs an agent but no default agent is configured`);
  }
  if (!config.agents?.list?.[agentId]) {
    throw new Error(`Cron job "${jobDef.id}" references unknown agent "${agentId}"`);
  }
  return agentId;
}

/**
 * Send a cron notification to the resolved target.
 * A string routes directly to Discord, null fails closed, and undefined uses
 * the active non-Discord channel.
 * Optionally includes voice attachment if voiceBuffer and voiceFormat are provided.
 * Returns true if sent successfully.
 */
async function sendCronNotification(
  config: Config,
  message: string,
  discordTargetId?: string | null,
  voiceBuffer?: Uint8Array,
  voiceFormat?: string,
): Promise<boolean> {
  const linkedMessage = linkLocalHtmlArtifactsForDiscord(message, config);

  if (discordTargetId === null) return false;

  if (discordTargetId) {
    try {
      // The thread sender accepts both Discord threads and text channels.
      if (voiceBuffer && voiceFormat) {
        const sent = await sendToDiscordThreadWithVoice(discordTargetId, linkedMessage, voiceBuffer, voiceFormat);
        if (sent) return true;
        console.error(`[cron] Failed to send to Discord target ${discordTargetId} with voice; active-channel fallback disabled`);
        return false;
      }

      const sent = await sendToDiscordThread(discordTargetId, linkedMessage);
      if (sent) return true;
      console.error(`[cron] Failed to send to Discord target ${discordTargetId}; active-channel fallback disabled`);
      return false;
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      console.error(`[cron] Discord delivery failed for ${discordTargetId}; active-channel fallback disabled: ${redactSecretText(errorText)}`);
      return false;
    }
  }

  // Only non-Discord channels may use their normal active-channel fallback.
  if (voiceBuffer && voiceFormat) {
    await sendActiveChannelProactiveVoice(config, voiceBuffer, voiceFormat);
  }
  return sendActiveChannelProactiveMessage(config, linkedMessage);
}

function resolveDiscordNotificationTarget(jobDef: CronJob, config: Config): string | null | undefined {
  if (jobDef.payload.discordThreadId !== undefined) {
    const threadId = typeof jobDef.payload.discordThreadId === 'string'
      ? jobDef.payload.discordThreadId.trim()
      : '';
    if (/^\d{17,20}$/.test(threadId)) return threadId;
    console.warn(`[cron] Invalid discordThreadId for job "${jobDef.id}": ${JSON.stringify(jobDef.payload.discordThreadId)}`);
    return null;
  }

  if (getActiveChannelId() !== 'discord') return undefined;

  const configuredDefaultChannelId = config.channels.discord?.defaultChannelId;
  const defaultChannelId = typeof configuredDefaultChannelId === 'string'
    ? configuredDefaultChannelId.trim()
    : '';
  if (!defaultChannelId) {
    console.warn(`[cron] Discord notification skipped for job "${jobDef.id}": configure payload.discordThreadId or channels.discord.defaultChannelId`);
    return null;
  }
  if (!/^\d{17,20}$/.test(defaultChannelId)) {
    console.warn(`[cron] Invalid channels.discord.defaultChannelId: ${JSON.stringify(config.channels.discord?.defaultChannelId)}`);
    return null;
  }
  return defaultChannelId;
}

const DEFAULT_OBSIDIAN_VAULT_ROOT = join(
  homedir(),
  'Library',
  'Mobile Documents',
  'iCloud~md~obsidian',
  'Documents',
  '2ndBrain',
);

function obsidianVaultRoot(): string {
  return process.env.SKIMPYCLAW_OBSIDIAN_VAULT_ROOT || DEFAULT_OBSIDIAN_VAULT_ROOT;
}

function localDateParts(date = new Date()): { yyyy: string; mm: string; dd: string } {
  return {
    yyyy: String(date.getFullYear()),
    mm: String(date.getMonth() + 1).padStart(2, '0'),
    dd: String(date.getDate()).padStart(2, '0'),
  };
}

function obsidianDailyOutputPaths(date = new Date()): { note: string; digest: string; filename: string } {
  const { yyyy, mm, dd } = localDateParts(date);
  const filename = `${mm}-${dd}-${yyyy}.md`;
  return {
    filename,
    note: join(obsidianVaultRoot(), '2. Areas', 'Daily Notes', filename),
    digest: join(obsidianVaultRoot(), '2. Areas', 'Daily Digests', filename),
  };
}

function obsidianDisplayDate(date = new Date()): string {
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function isMorningRoutine(jobDef: CronJob): boolean {
  return jobDef.id === 'morning' || (jobDef.name || '').toLowerCase() === 'morning routine';
}

function cleanMorningBriefingText(text: string): string {
  return text
    .replace(/^\[Mayora Daily Briefing HTML\]\([^)]+\)\s*(?:[—-][^\n]*)?\n+/m, '')
    .trim();
}

function extractMarkdownSection(text: string, heading: string): string {
  const pattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, 'im');
  return pattern.exec(text)?.[1]?.trim() || '';
}

function checklistItemsFromText(text: string): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const match of text.matchAll(/^\s*[-*]\s+\[\s\]\s+(.+)$/gm)) {
    const item = match[1]?.trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    items.push(item);
    if (items.length >= 12) break;
  }
  return items;
}

function writeMissingFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

function buildFallbackDailyDigest(text: string, date = new Date()): string {
  const body = cleanMorningBriefingText(text);
  return [
    `# Daily Digest: ${obsidianDisplayDate(date)}`,
    '',
    body || 'Morning briefing completed, but no text output was available for the digest fallback.',
    '',
  ].join('\n');
}

function buildFallbackDailyNote(text: string, digestFilename: string, date = new Date()): string {
  const digestStem = digestFilename.replace(/\.md$/, '');
  const schedule = extractMarkdownSection(text, 'Schedule');
  const checklist = checklistItemsFromText(text);
  const workItems = checklist.length > 0
    ? checklist.map(item => `- [ ] ${item}`).join('\n')
    : '- [ ] Review today\'s Daily Digest.';

  return [
    '#daily-notes',
    '',
    `# Daily Note: ${obsidianDisplayDate(date)}`,
    '',
    'steps:: 0',
    'running:: 0',
    'miles:: 0',
    'weights:: 0',
    'protein:: 0',
    'calories:: 0',
    '',
    `> [[Dashboard]] | [[Reading]] | [[2. Areas/Daily Digests/${digestStem}|Daily Digest]]`,
    '',
    '---',
    '',
    '## SCHEDULE',
    '',
    schedule || '- Check calendar.',
    '',
    '---',
    '',
    '## TODO',
    '',
    '### Work',
    '',
    workItems,
    '',
    '### Habits',
    '',
    '- [ ] Log steps.',
    '- [ ] Log running.',
    '- [ ] Log miles.',
    '- [ ] Log weights.',
    '- [ ] Log protein.',
    '- [ ] Log calories.',
    '',
    '---',
    '',
    '## NOTES',
    '',
    '- Created by Morning Routine fallback because the agent response did not write the vault file directly.',
    '',
  ].join('\n');
}

function ensureMorningVaultOutputs(jobDef: CronJob, text: string): void {
  if (!isMorningRoutine(jobDef)) return;

  const paths = obsidianDailyOutputPaths();
  const created: string[] = [];

  if (!existsSync(paths.digest)) {
    writeMissingFile(paths.digest, buildFallbackDailyDigest(text));
    created.push('Daily Digest');
  }

  if (!existsSync(paths.note)) {
    writeMissingFile(paths.note, buildFallbackDailyNote(text, paths.filename));
    created.push('Daily Note');
  }

  if (created.length > 0) {
    appendCronLogLine(jobDef.id, `Created missing Obsidian vault outputs: ${created.join(', ')} (${paths.filename})`);
  }
}

function assertMorningVaultOutputs(jobDef: CronJob): void {
  if (!isMorningRoutine(jobDef)) return;

  const paths = obsidianDailyOutputPaths();
  const missing = [
    ['Daily Note', paths.note] as const,
    ['Daily Digest', paths.digest] as const,
  ].filter(([, path]) => !existsSync(path));

  if (missing.length === 0) {
    appendCronLogLine(jobDef.id, `Verified Obsidian vault outputs: ${paths.filename}`);
    return;
  }

  const detail = missing.map(([label, path]) => `${label} missing at ${path}`).join('; ');
  throw new Error(`Morning Routine did not create required Obsidian vault outputs for ${paths.filename}: ${detail}`);
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

/**
 * Run an agent turn with an optional wall-clock timeout.
 *
 * When `timeoutMs` is set, an AbortController is created and its signal is passed
 * to `run` so the tool loop can observe cancellation between iterations. We do NOT
 * use Promise.race here: racing would resolve while the underlying agent turn kept
 * executing (orphaned), which is how cron jobs ended up running for hours and
 * overlapping. Instead we abort the signal, let the run return on its own, then
 * throw a timeout error so an aborted/cancelled run is never reported as success.
 * The timer is always cleared once the run settles (completion or failure).
 *
 * When `timeoutMs` is unset (or <= 0), behavior is unchanged: `run` is invoked
 * with no abort signal and its result/error is returned/propagated as-is.
 */
export async function runAgentTurnWithTimeout(
  timeoutMs: number | undefined,
  run: (abortSignal?: AbortSignalLike) => Promise<string>,
  onTimeout?: () => void,
): Promise<string> {
  if (!timeoutMs || timeoutMs <= 0) {
    return run();
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timedOut = true;
    controller.abort();
    try {
      onTimeout?.();
    } catch {
      // Logging callback failures must not mask the timeout.
    }
  }, timeoutMs);
  (timer as { unref?: () => void }).unref?.();

  try {
    const result = await run(controller.signal);
    // The tool loop returns a "[Cancelled ...]" string on abort rather than
    // throwing, so check the flag after the run returns to avoid reporting a
    // timed-out turn as success.
    if (timedOut) {
      throw new Error(`Agent turn timed out after ${timeoutMs}ms`);
    }
    return result;
  } catch (err) {
    if (timedOut) {
      throw new Error(`Agent turn timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }
}

export function initCron(config: Config): void {
  replaceScheduledJobs(config);

  if (configReloadTimer) {
    clearTimeout(configReloadTimer);
    configReloadTimer = null;
  }

  console.log(`[cron] Initialized ${scheduledJobs.size} jobs`);

  // Watch config.json for changes and re-initialize cron jobs
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }
  try {
    configWatcher = watch(getConfigPath(), () => {
      if (configReloadTimer) clearTimeout(configReloadTimer);
      configReloadTimer = setTimeout(() => {
        configReloadTimer = null;
        try {
          const newConfig = loadConfig();
          console.log('[cron] Config changed, reloading cron jobs...');
          replaceScheduledJobs(newConfig);
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

  const runScheduledJob = async () => {
    console.log(`[cron] Running job: ${jobDef.name}`);
    try {
      await executeJobPayload(jobDef, config);
    } catch (err) {
      console.error(`[cron] Scheduled job "${jobDef.id}" failed: ${redactSecretText(toErrorMessage(err))}`);
    }
  };

  if (jobDef.schedule.kind === 'interval') {
    const intervalMs = jobDef.schedule.ms;
    if (!Number.isFinite(intervalMs) || intervalMs === undefined || intervalMs <= 0) {
      console.warn(`[cron] Invalid interval schedule for ${jobDef.id}: ms must be a positive number`);
      return;
    }

    let nextRun = new Date(Date.now() + intervalMs);
    const timer = setInterval(() => {
      nextRun = new Date(Date.now() + intervalMs);
      void runScheduledJob();
    }, intervalMs);

    const intervalJob = {
      stop: () => clearInterval(timer),
      nextRun: () => nextRun,
    };

    scheduledJobs.set(jobDef.id, {
      id: jobDef.id,
      name: jobDef.name,
      job: intervalJob,
      nextRun,
    });

    console.log(`[cron] Scheduled: ${jobDef.name} (every ${intervalMs}ms)`);
    return;
  }

  if (jobDef.schedule.kind !== 'cron') {
    console.warn(`[cron] Unsupported schedule kind: ${jobDef.schedule.kind}`);
    return;
  }

  if (!jobDef.schedule.expr) {
    console.warn(`[cron] Invalid cron schedule for ${jobDef.id}: expr is required`);
    return;
  }

  const cronJob = new Cron(
    jobDef.schedule.expr,
    {
      timezone: safeTimezone(jobDef.schedule.tz),
    },
    runScheduledJob,
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
  const discordTargetId = resolveDiscordNotificationTarget(jobDef, config);

  // Track synthesized voice for final notification
  let synthesizedVoice: CronVoiceArtifact | null = null;

  try {
    const resolvedAgentId = jobDef.payload.kind === 'agentTurn'
      ? resolveCronAgentId(jobDef, config)
      : 'n/a';

    // Log start immediately
    appendCronLogLine(jobDef.id, `=== STARTED: ${jobDef.name} (${jobDef.id}) ===`);
    appendCronLogLine(jobDef.id, `Agent: ${resolvedAgentId}`);
    appendCronLogLine(jobDef.id, `Model: ${jobDef.model || 'default'}`);
    appendCronLogLine(jobDef.id, `Payload: ${jobDef.payload.kind}`);

    // Notify channel at start
    try {
      await sendCronNotification(config, `🔄 Cron starting: ${jobDef.name}`, discordTargetId);
    } catch {
      // Non-critical
    }

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
      const timeoutMs = jobDef.payload.timeoutMs ?? 600000;
      const response = await runAgentTurnWithTimeout(
        timeoutMs,
        (abortSignal) => runCronAgentTurnWithRetry(
          jobDef.id,
          () => runAgentTurn(
            resolvedAgentId,
            message,
            config,
            jobDef.model,
            tools,
            undefined,
            {
              channel: discordTargetId ? 'discord' : getActiveChannelId() || 'telegram',
              trigger: 'cron',
              sessionId: jobDef.id,
              ...(abortSignal ? { abortSignal } : {}),
              metadata: {
                jobName: jobDef.name,
                isCronJob: true,
                ...(discordTargetId ? { discordThreadId: discordTargetId, isDm: false } : {}),
              },
            },
          ),
        ),
        () => appendCronLogLine(
          jobDef.id,
          `Agent turn timed out after ${timeoutMs}ms; aborting`,
        ),
      );
      appendCronLogLine(jobDef.id, `Agent turn completed (${response.length} chars)`);

      // Parse dual output (voice + text) if delimiters present
      const { voice: voicePortion, text: parsedTextPortion } = parseDualOutput(response);
      const mayoraText = ensureMayoraHtmlArtifact(jobDef, resolvedAgentId, logEntry, parsedTextPortion);
      const textPortion = ensureChiefHtmlArtifact(jobDef, resolvedAgentId, logEntry.startedAt, mayoraText);
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
              const sent = await sendCronNotification(config, digestMessage, discordTargetId);
              if (sent) {
                appendCronLogLine(jobDef.id, `Digest sent to chat (${digestMessage.length} chars)`);
              } else if (discordTargetId === null) {
                appendCronLogLine(jobDef.id, 'Digest notification skipped: no valid Discord target');
              } else if (discordTargetId) {
                appendCronLogLine(jobDef.id, `Digest Discord delivery failed (targetId=${discordTargetId}); no active-channel fallback`);
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

      ensureMorningVaultOutputs(jobDef, textPortion);
      assertMorningVaultOutputs(jobDef);

      // Synthesize voice if configured (stored for final notification)
      if (jobDef.payload.sendAsVoice && config.voice) {
        try {
          // Use voice portion if available, fall back to text
          const voiceContent = voicePortion || textPortion;
          appendCronLogLine(jobDef.id, `Synthesizing voice (${voicePortion ? 'voice portion' : 'full text fallback'})...`);
          const speech = await synthesizeSpeech(voiceContent, config.voice);
          appendCronLogLine(jobDef.id, `Voice synthesized (${speech.format}, ${speech.provider}, ${speech.buffer.length} bytes)`);
          const voiceArtifact = saveCronVoiceArtifact(jobDef, logEntry, speech, config);
          if (voiceArtifact?.path) {
            appendCronLogLine(jobDef.id, `Voice artifact saved: ${voiceArtifact.path}`);
          }
          if (voiceArtifact?.url) {
            injectVoiceLinkIntoMayoraHtml(textPortion, voiceArtifact.url, jobDef.id);
          }
          // Store for final notification instead of sending immediately
          synthesizedVoice = { buffer: speech.buffer, format: speech.format, ...(voiceArtifact ?? {}) };
          appendCronLogLine(jobDef.id, 'Voice stored for final notification');
        } catch (voiceErr) {
          const errMsg = voiceErr instanceof Error ? voiceErr.message : String(voiceErr);
          appendCronLogLine(jobDef.id, `Voice synthesis failed: ${errMsg}`);
          // Non-fatal — text notification still sends
        }
      }
    } else if (jobDef.payload.kind === 'script') {
      const scriptTraceId = startTrace('cron');
      const redactedScript = redactSecretText(jobDef.payload.script || '');
      addEvent(scriptTraceId, {
        type: 'script_start',
        summary: `${jobDef.name}: ${redactedScript.slice(0, 100)}`,
        durationMs: 0,
      });
      appendCronLogLine(jobDef.id, `Script started: ${redactedScript.slice(0, 100)}`);
      try {
        const output = await executeScript(jobDef, config);
        logEntry.output = output.slice(0, 50000);
        appendCronLogLine(jobDef.id, `Script completed (${output.length} chars)`);
        addEvent(scriptTraceId, {
          type: 'script_complete',
          summary: `Output: ${redactSecretText(output).slice(0, 150)}`,
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
          summary: redactSecretText(scriptErrMsg).slice(0, 150),
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

    // Notify the configured target with an optional voice attachment
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
      if (synthesizedVoice?.url) {
        notification += `\n\nVoice file: ${synthesizedVoice.url}`;
      }

      // Include synthesized voice if available
      let sent: boolean;
      if (synthesizedVoice) {
        appendCronLogLine(jobDef.id, `Sending notification with voice (${synthesizedVoice.format})`);
        sent = await sendCronNotification(
          config,
          notification,
          discordTargetId,
          synthesizedVoice.buffer,
          synthesizedVoice.format,
        );
      } else {
        sent = await sendCronNotification(config, notification, discordTargetId);
      }
      if (!sent) {
        if (discordTargetId === null) {
          appendCronLogLine(jobDef.id, 'Final notification skipped: no valid Discord target');
        } else if (discordTargetId) {
          appendCronLogLine(jobDef.id, `Final Discord notification delivery failed (targetId=${discordTargetId}); no active-channel fallback`);
        }
      }
    } catch (notifyErr) {
      console.error(`[cron] Failed to send notification: ${redactSecretText(toErrorMessage(notifyErr))}`);
    }
  }
}

async function executeScript(jobDef: CronJob, _config: Config): Promise<string> {
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
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let overflowError: Error | null = null;
    let timeoutError: Error | null = null;
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
    const redactedScript = redactSecretText(script);
    console.log(`[cron:script] Running: ${redactedScript.slice(0, 100)}${redactedScript.length > 100 ? '...' : ''}`);
    if (cwd) console.log(`[cron:script] cwd: ${cwd}`);

    const child = spawn(script, {
      cwd: cwd || undefined,
      env: sanitizeCronEnv(),
      shell: true,
      detached: true,
    });
    const maxBuffer = 10 * 1024 * 1024; // 10MB output buffer

    const clearTimers = (options?: { keepSigkillTimer?: boolean }) => {
      clearTimeout(timeout);
      if (!options?.keepSigkillTimer && sigkillTimer) clearTimeout(sigkillTimer);
    };

    const fail = (error: Error, options?: { keepSigkillTimer?: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimers(options);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.error(`[cron:script] Failed after ${elapsed}s: ${redactSecretText(error.message)}`);
      if (stderr) console.error(`[cron:script] stderr: ${redactSecretText(stderr).slice(0, 500)}`);
      reject(error);
    };

    const terminateForOverflow = () => {
      if (settled || overflowError || timeoutError) return;
      overflowError = new Error(`Script output exceeded maxBuffer of ${maxBuffer} bytes`);
      clearTimeout(timeout);
      if (!child.pid) {
        fail(overflowError);
        return;
      }

      const pid = child.pid;
      sigkillTimer = setTimeout(() => {
        killScriptProcessTree(pid, 'SIGKILL');
        sigkillTimer = null;
        fail(overflowError!);
      }, 1000);
      (sigkillTimer as { unref?: () => void }).unref?.();
      killScriptProcessTree(pid, 'SIGTERM');
    };

    const collectOutput = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
      if (settled || overflowError || timeoutError) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxBuffer - outputBytes);
      const accepted = bytes.subarray(0, remaining);
      if (accepted.length > 0) {
        if (target === 'stdout') stdout += accepted.toString();
        else stderr += accepted.toString();
        outputBytes += accepted.length;
      }
      if (bytes.length > remaining) terminateForOverflow();
    };

    const timeout = setTimeout(() => {
      timeoutError = new Error(`Script timed out after ${timeoutMs}ms`);
      if (!child.pid) {
        fail(timeoutError);
        return;
      }

      const pid = child.pid;
      sigkillTimer = setTimeout(() => {
        killScriptProcessTree(pid, 'SIGKILL');
        sigkillTimer = null;
        fail(timeoutError!);
      }, 5000);
      (sigkillTimer as { unref?: () => void }).unref?.();
      killScriptProcessTree(pid, 'SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer | string) => collectOutput('stdout', chunk));

    child.stderr.on('data', (chunk: Buffer | string) => collectOutput('stderr', chunk));

    child.on('error', (error) => {
      if (overflowError || timeoutError) return;
      fail(error);
    });

    child.on('close', (code, signal) => {
      if (overflowError) {
        if (sigkillTimer && child.pid && isScriptProcessTreeAlive(child.pid)) return;
        fail(overflowError);
        return;
      }
      if (timeoutError) {
        if (sigkillTimer && child.pid && isScriptProcessTreeAlive(child.pid)) return;
        fail(timeoutError);
        return;
      }
      clearTimers();
      if (settled) return;

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (code !== 0) {
        fail(new Error(`Command failed: ${script}${stderr ? `\n${stderr}` : ''}${signal ? `\nSignal: ${signal}` : ''}`));
        return;
      }
      console.log(`[cron:script] Completed in ${elapsed}s`);
      if (stdout) {
        const lines = stdout.trim().split('\n');
        const preview = lines.length > 5
          ? lines.slice(0, 3).join('\n') + `\n... (${lines.length} lines total)`
          : stdout.trim();
        console.log(`[cron:script] Output:\n${redactSecretText(preview)}`);
      }
      resolve(stdout || '');
    });

    // Log PID for debugging
    if (child.pid) {
      console.log(`[cron:script] PID: ${child.pid}`);
    }
  });
}

export function killScriptProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

function isScriptProcessTreeAlive(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
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
  if (!isPathAllowed(resolved, [promptsRoot])) {
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
  const jobDef = resolveCronJob(id, config);

  await executeJobPayload(jobDef, config);
}

export function triggerCronJob(id: string, config: Config): CronRunTarget {
  const jobDef = resolveCronJob(id, config);

  void executeJobPayload(jobDef, config).catch((error) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[cron] Manual job "${jobDef.id}" failed: ${redactSecretText(msg)}`);
  });

  return { id: jobDef.id, name: jobDef.name };
}

function resolveCronJob(id: string, config: Config): CronJob {
  const exact = config.cron.jobs.find(j => j.id === id);
  if (exact) {
    return exact;
  }

  const normalizedId = normalizeCronLookup(id);
  const normalizedMatches = config.cron.jobs.filter(j =>
    normalizeCronLookup(j.id) === normalizedId || normalizeCronLookup(j.name) === normalizedId,
  );

  if (normalizedMatches.length === 1) {
    return normalizedMatches[0];
  }

  if (normalizedMatches.length > 1) {
    throw new Error(`Cron job lookup is ambiguous: ${id}`);
  }

  throw new Error(`Cron job not found: ${id}`);
}

function normalizeCronLookup(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface CronJobDetail {
  id: string;
  name: string;
  schedule: { kind: string; expr?: string; ms?: number; tz?: string };
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
        ms: jobDef.schedule.ms,
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
  if (configReloadTimer) {
    clearTimeout(configReloadTimer);
    configReloadTimer = null;
  }
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }
  for (const job of scheduledJobs.values()) {
    job.job.stop();
  }
  scheduledJobs.clear();
}
