// Telegram Command Handlers

import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { spawnSync } from 'child_process';
import type { Config } from '../../types.js';
import { getCurrentModel, setCurrentModel, getLastMessage } from '../../gateway.js';
import { getCronJobs, runCronJob } from '../../cron.js';
import { runHeartbeatCheck } from '../../heartbeat.js';
import { cancelTask, getActiveTasks, getRecentTasks } from '../../subagent.js';
import { getActiveCodeAgents, getRecentCodeAgents } from '../../code-agents/index.js';
import { listApprovals, approveRequest, denyRequest, getApproval, onApprovalEvent } from '../../exec-approval.js';
import { loadSkills } from '../../skills.js';
import type { SkillConfig } from '../../skills-types.js';
import { loadRawConfig, saveConfig } from '../../config.js';
import { readFileSync } from 'fs';
import { runAgentTurn } from '../../agent.js';
import { formatAliases, formatModelSelectionError, getModelSelectionUsage, resolveModelSelection } from '../../model-selection.js';
import { state, LAUNCHD_LABEL, BOT_COMMANDS } from './types.js';
import {
  buildHelpText,
  getHistory,
  addToHistory,
  clearHistory,
  getRunContext,
  getDefaultTelegramToolConfig,
  getTelegramDefaultChatId,
  getRecentMemoryFiles,
  startTypingIndicator,
  sendLongMessage,
  sendLongMessageHtml,
  escapeHtml,
} from './utils.js';

// Handler functions for each command
export async function handleHelp(ctx: Context, cfg: Config): Promise<void> {
  await ctx.reply(buildHelpText(cfg));
}

export async function handleStart(ctx: Context, cfg: Config): Promise<void> {
  await ctx.reply(buildHelpText(cfg));
}

export async function handleModel(ctx: Context, cfg: Config): Promise<void> {
  const modelAlias = String(ctx.match || '');
  if (!modelAlias) {
    const current = getCurrentModel();
    const aliases = formatAliases(cfg);
    await ctx.reply(
      `Current: ${current}\nAliases: ${aliases}\n\nUsage: /model <alias|provider/model|model-id>\n${getModelSelectionUsage()}`
    );
    return;
  }

  const selection = resolveModelSelection(modelAlias, cfg);
  if (!selection.ok || !selection.resolved) {
    const errorMessage = selection.error || 'Invalid model selection';
    await ctx.reply(formatModelSelectionError(errorMessage, cfg));
    return;
  }
  setCurrentModel(selection.resolved);
  if (selection.aliasUsed) {
    await ctx.reply(`Model switched to: ${selection.aliasUsed} (${selection.resolved})`);
  } else {
    await ctx.reply(`Model switched to: ${selection.resolved}`);
  }
}

export async function handleStatus(ctx: Context, cfg: Config): Promise<void> {
  const model = getCurrentModel();
  const last = getLastMessage();
  const jobs = getCronJobs();
  const activeTasks = getActiveTasks();
  const recentTasks = getRecentTasks(20);

  const jobList = jobs
    .map((j) => `  - ${j.name}: ${j.nextRun?.toLocaleString() || 'unknown'}`)
    .join('\n');

  const pendingCount = activeTasks.filter((t) => t.status === 'pending').length;
  const runningCount = activeTasks.filter((t) => t.status === 'running').length;
  const maxConcurrent = cfg.subagents?.maxConcurrent ?? 5;

  const recentCompleted = recentTasks.filter((t) => t.status === 'completed').length;
  const recentFailed = recentTasks.filter((t) => t.status === 'failed').length;
  const recentCancelled = recentTasks.filter((t) => t.status === 'cancelled').length;

  const activePreview = activeTasks
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 3)
    .map((task) => {
      const started = task.startedAt || task.createdAt;
      const elapsedSeconds = Math.max(0, Math.round((Date.now() - started.getTime()) / 1000));
      const elapsed = elapsedSeconds < 60 ? `${elapsedSeconds}s` : `${Math.round(elapsedSeconds / 60)}m`;
      const label = task.label ? ` (${task.label})` : '';
      return `  - ${task.id} [${task.type}] ${task.status}${label} • ${elapsed}`;
    })
    .join('\n');

  // Coding agents status (multi-agent)
  const caActive = getActiveCodeAgents();
  const caRecent = getRecentCodeAgents(20);
  const caMap = new Map<string, typeof caActive[0]>();
  for (const agent of caActive) caMap.set(agent.id, agent);
  for (const agent of caRecent) caMap.set(agent.id, agent);
  const caAll = Array.from(caMap.values());
  let caLine = 'Coding Agents: idle';
  if (caAll.length > 0) {
    const runningCount = caAll.filter((t) => t.status === 'running').length;
    const completedCount = caAll.filter((t) => t.status === 'completed').length;
    const failedCount = caAll.filter((t) => t.status === 'failed' || t.status === 'timeout').length;
    const parts: string[] = [];
    if (runningCount) parts.push(`${runningCount} running`);
    if (completedCount) parts.push(`${completedCount} completed`);
    if (failedCount) parts.push(`${failedCount} failed`);
    caLine = `Coding Agents: ${parts.join(', ') || 'idle'}`;
    const caPreview = caAll
      .slice(0, 5)
      .map((t) => {
        const elapsed = t.durationSeconds != null
          ? t.durationSeconds < 60 ? `${t.durationSeconds}s` : `${Math.floor(t.durationSeconds / 60)}m ${t.durationSeconds % 60}s`
          : Math.round((Date.now() - new Date(t.startedAt).getTime()) / 1000) + 's';
        const taskPreview = t.task.length > 50 ? t.task.slice(0, 50) + '...' : t.task;
        return `  ${t.id}: ${t.status.toUpperCase()} (${t.agent}, ${elapsed}) — ${taskPreview}`;
      })
      .join('\n');
    if (caPreview) caLine += '\n' + caPreview;
  }

  await ctx.reply(
    `Agent: ${cfg.agents.default}\n` +
    `Model: ${model}\n` +
    `Last message: ${last?.toLocaleString() || 'never'}\n` +
    `Silence until: ${state.silenceUntil?.toLocaleTimeString() || 'not silenced'}\n\n` +
    `${caLine}\n\n` +
    `Subagents: ${activeTasks.length}/${maxConcurrent} active (running: ${runningCount}, pending: ${pendingCount})\n` +
    `Recent (last ${recentTasks.length}): ✅ ${recentCompleted} • ❌ ${recentFailed} • 🚫 ${recentCancelled}\n` +
    `${activePreview ? `Active now:\n${activePreview}\n\n` : '\n'}` +
    `Scheduled jobs:\n${jobList || '  (none)'}`
  );
}

export async function handleCron(ctx: Context, cfg: Config): Promise<void> {
  const args = String(ctx.match || '').split(' ');
  const subcommand = args[0];

  if (subcommand === 'list' || !subcommand) {
    const jobs = getCronJobs();
    if (jobs.length === 0) {
      await ctx.reply('No scheduled jobs.');
      return;
    }

    const list = jobs
      .map((j) => `${j.id}: ${j.name} (next: ${j.nextRun?.toLocaleString() || '?'})`)
      .join('\n');
    await ctx.reply(`Scheduled jobs:\n${list}`);
    return;
  }

  if (subcommand === 'run') {
    const jobId = args[1];
    if (!jobId) {
      await ctx.reply('Usage: /cron run <job-id>');
      return;
    }

    await ctx.replyWithChatAction('typing');
    try {
      await runCronJob(jobId, cfg);
      await ctx.reply(`Triggered: ${jobId}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`Error: ${msg}`);
    }
    return;
  }

  await ctx.reply('Usage: /cron list | /cron run <id>');
}

export async function handleHeartbeat(ctx: Context, cfg: Config): Promise<void> {
  const stopTyping = startTypingIndicator(ctx);
  try {
    const response = await runHeartbeatCheck(cfg);
    await sendLongMessage(ctx, `🫀 ${response}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    await ctx.reply(`Heartbeat error: ${msg}`);
  } finally {
    stopTyping();
  }
}

export async function handleRestart(ctx: Context, cfg: Config): Promise<void> {
  const isLaunchd = !!process.env.SKIMPYCLAW_LAUNCHD;
  if (isLaunchd) {
    await ctx.reply('🦞 Restarting via launchd...');
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const target = uid !== undefined ? `gui/${uid}/${LAUNCHD_LABEL}` : LAUNCHD_LABEL;
    const res = spawnSync('launchctl', ['kickstart', '-k', target], {
      encoding: 'utf8',
      timeout: 3000
    });
    if (res.error || res.status !== 0) {
      await ctx.reply(`Restart failed: ${res.stderr || res.error?.message || 'unknown error'}`);
    }
  } else {
    await ctx.reply('🦞 Restarting (dev mode)...');
    setTimeout(() => process.exit(0), 500);
  }
}

export async function handleTasks(ctx: Context, cfg: Config): Promise<void> {
  const active = getActiveTasks();
  const recent = getRecentTasks(5);

  if (recent.length === 0) {
    await ctx.reply('No agent tasks yet. Subagents spawn automatically for complex requests.');
    return;
  }

  const formatTask = (t: (typeof recent)[0]) => {
    const elapsed = ((t.completedAt || new Date()).getTime() - t.createdAt.getTime()) / 1000;
    const elapsedStr = elapsed < 60 ? `${Math.round(elapsed)}s` : `${Math.round(elapsed / 60)}m`;
    const status: Record<string, string> = {
      pending: '⏳ Pending',
      running: `🔄 Running (${elapsedStr})`,
      completed: `✅ Done (${elapsedStr})`,
      failed: `❌ Failed (${elapsedStr})`,
      cancelled: '🚫 Cancelled'
    };
    const promptPreview = t.prompt.slice(0, 60) + (t.prompt.length > 60 ? '...' : '');
    return `${t.id}: ${status[t.status] || t.status} [${t.type}] ${promptPreview}`;
  };

  const lines = [...active, ...recent].slice(0, 10).map(formatTask).join('\n');
  await ctx.reply(`Agent tasks:\n\n${lines}`);
}

export async function handleCancel(ctx: Context, cfg: Config): Promise<void> {
  const id = String(ctx.match || '').trim();
  if (!id) {
    await ctx.reply('Usage: /cancel <task-id>\nExample: /cancel t1');
    return;
  }

  const task = cancelTask(id);
  if (!task) {
    await ctx.reply(`No task found: ${id}`);
    return;
  }

  if (task.status === 'cancelled') {
    await ctx.reply(`Cancelled ${id}.`);
  } else {
    await ctx.reply(`Task ${id} is already ${task.status}.`);
  }
}

export async function handleSkills(ctx: Context, cfg: Config): Promise<void> {
  const skillConfig = (cfg as any).skills as SkillConfig | undefined;
  const skills = loadSkills(skillConfig);

  if (skills.length === 0) {
    await ctx.reply('No skills found. Add skills to ~/.skimpyclaw/skills/');
    return;
  }

  const lines = skills.map(s => {
    const emoji = s.frontmatter.emoji || '🔧';
    let status: string;
    if (!s.eligible) {
      status = `❌ ${s.reason || 'ineligible'}`;
    } else if (s.frontmatter.enabled === false) {
      status = '⚠️ disabled';
    } else {
      status = '✅ eligible';
    }
    return `${emoji} ${s.name} — ${status}`;
  });

  await sendLongMessage(ctx, `Skills (${skills.length}):\n\n${lines.join('\n')}\n\nUse /skill <name> for details`);
}

export async function handleSkill(ctx: Context, cfg: Config): Promise<void> {
  const args = String(ctx.match || '').trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase();

  if (!subcommand) {
    await ctx.reply('Usage:\n/skill <name> — Show details\n/skill enable <name>\n/skill disable <name>');
    return;
  }

  if (subcommand === 'enable' || subcommand === 'disable') {
    const skillName = args[1];
    if (!skillName) {
      await ctx.reply(`Usage: /skill ${subcommand} <name>`);
      return;
    }

    const enabled = subcommand === 'enable';
    try {
      const raw = loadRawConfig();
      if (!raw.skills) raw.skills = {};
      if (!raw.skills.entries) raw.skills.entries = {};
      raw.skills.entries[skillName] = enabled;
      saveConfig(raw as any);
      await ctx.reply(`Skill "${skillName}" ${enabled ? 'enabled' : 'disabled'}.`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`Error: ${msg}`);
    }
    return;
  }

  // Show skill details
  const skillName = subcommand;
  const skillConfig = (cfg as any).skills as SkillConfig | undefined;
  const skills = loadSkills(skillConfig);
  const skill = skills.find(s => s.name === skillName);

  if (!skill) {
    await ctx.reply(`Skill "${skillName}" not found.\nUse /skills to see available skills.`);
    return;
  }

  const emoji = skill.frontmatter.emoji || '🔧';
  const status = skill.eligible
    ? (skill.frontmatter.enabled !== false ? '✅ Eligible' : '⚠️ Disabled')
    : `❌ ${skill.reason || 'Ineligible'}`;
  const tags = skill.frontmatter.tags?.join(', ') || 'none';
  const contexts = skill.frontmatter.contexts ? JSON.stringify(skill.frontmatter.contexts) : 'all';
  const reqs = skill.frontmatter.requires
    ? Object.entries(skill.frontmatter.requires)
        .filter(([_, v]) => v && (v as any[]).length > 0)
        .map(([k, v]) => `${k}: ${(v as string[]).join(', ')}`)
        .join('\n  ') || 'none'
    : 'none';

  const detail = `${emoji} ${skill.name}\n\n` +
    `${skill.frontmatter.description}\n\n` +
    `Status: ${status}\n` +
    `Priority: ${skill.frontmatter.priority ?? 100}\n` +
    `Tags: ${tags}\n` +
    `Contexts: ${contexts}\n` +
    `Requires:\n  ${reqs}`;

  await sendLongMessage(ctx, detail);
}

export async function handleApprovals(ctx: Context, cfg: Config): Promise<void> {
  const pending = listApprovals();
  if (pending.length === 0) {
    await ctx.reply('No pending exec approvals.');
    return;
  }

  for (const approval of pending.slice(0, 10)) {
    const cmdPreview = approval.command.length > 80
      ? approval.command.slice(0, 80) + '...'
      : approval.command;
    const expiresIn = Math.max(0, Math.round((approval.expiresAt.getTime() - Date.now()) / 1000));
    const expiresStr = expiresIn < 60 ? `${expiresIn}s` : `${Math.floor(expiresIn / 60)}m`;

    const keyboard = new InlineKeyboard()
      .text('✅ Approve', `approve:${approval.id}`)
      .text('❌ Deny', `deny:${approval.id}`);

    await ctx.reply(
      `⛔ Approval #${approval.id}\n` +
      `Tier ${approval.tier}: ${approval.reason}\n` +
      `Command: ${cmdPreview}\n` +
      `${approval.cwd ? `CWD: ${approval.cwd}\n` : ''}` +
      `Expires in: ${expiresStr}`,
      { reply_markup: keyboard }
    );
  }
}

export async function handleApprove(ctx: Context, cfg: Config): Promise<void> {
  const id = String(ctx.match || '').trim();
  if (!id) {
    await ctx.reply('Usage: /approve <id>');
    return;
  }
  const approvedBy = ctx.from?.username || ctx.from?.id?.toString() || 'telegram';
  const success = approveRequest(id, approvedBy);
  if (success) {
    await ctx.reply(`✅ Approved #${id}`);
  } else {
    const existing = getApproval(id);
    if (existing) {
      await ctx.reply(`Cannot approve #${id} — status is already "${existing.status}".`);
    } else {
      await ctx.reply(`No pending approval found with ID "${id}".`);
    }
  }
}

export async function handleDeny(ctx: Context, cfg: Config): Promise<void> {
  const id = String(ctx.match || '').trim();
  if (!id) {
    await ctx.reply('Usage: /deny <id>');
    return;
  }
  const deniedBy = ctx.from?.username || ctx.from?.id?.toString() || 'telegram';
  const success = denyRequest(id, deniedBy);
  if (success) {
    await ctx.reply(`❌ Denied #${id}`);
  } else {
    const existing = getApproval(id);
    if (existing) {
      await ctx.reply(`Cannot deny #${id} — status is already "${existing.status}".`);
    } else {
      await ctx.reply(`No pending approval found with ID "${id}".`);
    }
  }
}

export async function handleNew(ctx: Context, cfg: Config): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId) await clearHistory(chatId);
  await ctx.reply('Conversation cleared. Starting fresh.');
}

export async function handleCompact(ctx: Context, cfg: Config): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const history = await getHistory(chatId);
  if (history.length === 0) {
    await ctx.reply('No conversation history to compact.');
    return;
  }

  const stopTyping = startTypingIndicator(ctx);
  try {
    const historyText = history.map((m) => `${m.role}: ${m.content}`).join('\n');
    const summary = await runAgentTurn(
      cfg.agents.default,
      `Summarize this conversation in 2-3 sentences so you can remember the context:\n\n${historyText}`,
      cfg,
      getCurrentModel(),
      undefined,
      undefined,
      getRunContext(ctx)
    );
    await clearHistory(chatId);
    state.chatHistory.set(chatId, [
      { role: 'user', content: 'Summary of our previous conversation:' },
      { role: 'assistant', content: summary }
    ]);
    state.loadedFromDisk.add(chatId);
    await ctx.reply(`Compacted ${history.length} messages into a summary.`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    await ctx.reply(`Error: ${msg}`);
  } finally {
    stopTyping();
  }
}

export async function handleSilence(ctx: Context, cfg: Config): Promise<void> {
  const minutes = parseInt(String(ctx.match || '')) || 30;
  state.silenceUntil = new Date(Date.now() + minutes * 60 * 1000);
  await ctx.reply(`Proactive messages silenced until ${state.silenceUntil.toLocaleTimeString()}`);
}

export async function handleMemory(ctx: Context, cfg: Config): Promise<void> {
  const arg = String(ctx.match || '').trim();
  const recentFiles = getRecentMemoryFiles(10);

  if (recentFiles.length === 0) {
    await ctx.reply('No memory entries found.');
    return;
  }

  if (arg) {
    const match = recentFiles.find(
      (f) => f.date === arg || f.name === arg || f.name === `${arg}.md`
    );
    if (!match) {
      await ctx.reply(`No memory entry for "${arg}".\n\nAvailable: ${recentFiles.map((f) => f.date).join(', ')}`);
      return;
    }

    try {
      const content = readFileSync(match.path, 'utf-8');
      const preview = content.length > 3500 ? content.slice(0, 3500) + '\n\n... (truncated)' : content;
      await sendLongMessage(ctx, `📝 Memory: ${match.date}\n\n${preview}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`Error reading memory: ${msg}`);
    }
    return;
  }

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes}B`;
    return `${(bytes / 1024).toFixed(1)}KB`;
  };

  const list = recentFiles.map((f) => `  ${f.date} (${formatSize(f.size)})`).join('\n');
  await ctx.reply(
    `📝 Recent memory entries:\n\n${list}\n\n` +
    `View one: /memory <date>\nExample: /memory ${recentFiles[0].date}`
  );
}

// Export all handlers
export const commandHandlers = {
  help: handleHelp,
  start: handleStart,
  model: handleModel,
  status: handleStatus,
  cron: handleCron,
  heartbeat: handleHeartbeat,
  restart: handleRestart,
  tasks: handleTasks,
  cancel: handleCancel,
  skills: handleSkills,
  skill: handleSkill,
  approvals: handleApprovals,
  approve: handleApprove,
  deny: handleDeny,
  new: handleNew,
  compact: handleCompact,
  silence: handleSilence,
  memory: handleMemory,
};

// Subscribe to approval events for proactive notifications
export function subscribeToApprovalEvents(bot: any, cfg: Config): void {
  onApprovalEvent('created', (event) => {
    if (!bot) return;
    const { approval } = event;
    const meta = approval.channelMeta;

    if (meta?.channel && meta.channel !== 'telegram') return;

    let targetChatId: number | undefined;
    if (meta?.channel === 'telegram' && meta.chatId) {
      targetChatId = typeof meta.chatId === 'number' ? meta.chatId : Number(meta.chatId);
    }
    if (!targetChatId) {
      targetChatId = getTelegramDefaultChatId(cfg) ?? undefined;
    }
    if (!targetChatId || !Number.isFinite(targetChatId)) return;

    const cmdPreview = approval.command.length > 80 ? approval.command.slice(0, 80) + '...' : approval.command;
    const expiresIn = Math.max(0, Math.round((approval.expiresAt.getTime() - Date.now()) / 1000));
    const expiresStr = expiresIn < 60 ? `${expiresIn}s` : `${Math.floor(expiresIn / 60)}m`;

    const keyboard = new InlineKeyboard()
      .text('✅ Approve', `approve:${approval.id}`)
      .text('❌ Deny', `deny:${approval.id}`);

    bot.api.sendMessage(
      targetChatId,
      `⛔ Exec approval needed: #${approval.id}\n` +
      `Tier ${approval.tier}: ${approval.reason}\n` +
      `Command: ${cmdPreview}\n` +
      `${approval.cwd ? `CWD: ${approval.cwd}\n` : ''}` +
      `Expires in: ${expiresStr}`,
      { reply_markup: keyboard }
    ).catch((err: any) => {
      console.error('[telegram] Failed to send approval notification:', err);
    });
  });
}
