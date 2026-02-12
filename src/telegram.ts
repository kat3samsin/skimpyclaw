// Telegram bot using Grammy

import { Bot, Context, GrammyError, HttpError } from 'grammy';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import type { Config, ToolConfig, AgentRunContext } from './types.js';
import { isAllowed, isRateLimited } from './security.js';
import type { ChatMessage } from './types.js';
import { runAgentTurn } from './agent.js';
import { getCronJobs, runCronJob } from './cron.js';
import { getCurrentModel, setCurrentModel, getLastMessage } from './gateway.js';
import { runHeartbeatCheck } from './heartbeat.js';
import { initSubagentSystem, dispatchSubagent, cancelTask, getActiveTasks, getRecentTasks, getPresetDescriptions } from './subagent.js';
import type { SubagentType } from './types.js';

const LAUNCHD_LABEL = 'com.skimpyclaw.gateway';

// Command definitions — single source of truth for the / menu and /help
const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: 'help', description: 'Show available commands' },
  { command: 'model', description: 'Switch model (fast/smart/opus)' },
  { command: 'status', description: 'Show bot status' },
  { command: 'morning', description: 'Run morning routine' },
  { command: 'eod', description: 'Run EOD review' },
  { command: 'focus', description: 'Plan your day' },
  { command: 'memory', description: 'View recent memory entries' },
  { command: 'new', description: 'Clear conversation history' },
  { command: 'compact', description: 'Compress conversation history' },
  { command: 'silence', description: 'Pause proactive messages' },
  { command: 'cron', description: 'List or run scheduled jobs' },
  { command: 'agent', description: 'Run a background agent task' },
  { command: 'tasks', description: 'Show active/recent agent tasks' },
  { command: 'cancel', description: 'Cancel a running agent task' },
  { command: 'heartbeat', description: 'Trigger heartbeat check' },
  { command: 'restart', description: 'Restart the gateway' },
];

// Set of known command names for catch-all routing
const KNOWN_COMMANDS = new Set(
  BOT_COMMANDS.map(c => c.command).concat(['start'])
);

function getTodayDailyNote(cfg: Config): string | null {
  const dailyNotesDir = cfg.channels.telegram.dailyNotesDir;
  if (!dailyNotesDir) {
    return null;
  }

  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const year = now.getFullYear();
  const filename = `${month}-${day}-${year}.md`;
  const filePath = join(dailyNotesDir, filename);

  if (!existsSync(filePath)) {
    return null;
  }
  return readFileSync(filePath, 'utf-8');
}

let bot: Bot | null = null;
let silenceUntil: Date | null = null;

// Conversation history per chat — last N user/assistant message pairs
const MAX_HISTORY_PAIRS = 5;
const chatHistory = new Map<number, ChatMessage[]>();

function getHistory(chatId: number): ChatMessage[] {
  return chatHistory.get(chatId) || [];
}

function addToHistory(chatId: number, userMsg: string, assistantMsg: string): void {
  const history = getHistory(chatId);
  history.push({ role: 'user', content: userMsg });
  history.push({ role: 'assistant', content: assistantMsg });
  // Keep only last N pairs (2 messages per pair)
  while (history.length > MAX_HISTORY_PAIRS * 2) {
    history.shift();
    history.shift();
  }
  chatHistory.set(chatId, history);
}

function clearHistory(chatId: number): void {
  chatHistory.delete(chatId);
}

function getRunContext(ctx: Context): AgentRunContext {
  return {
    userId: ctx.from?.id ? String(ctx.from.id) : undefined,
    sessionId: ctx.chat?.id ? String(ctx.chat.id) : undefined,
    channel: 'telegram',
    metadata: {
      username: ctx.from?.username,
      chatId: ctx.chat?.id,
    },
  };
}

/** Keep sending "typing..." every 4s until the returned stop function is called. */
function startTypingIndicator(ctx: Context): () => void {
  const interval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);
  return () => clearInterval(interval);
}

// Default tool config for Telegram — gives the agent file/bash access
const DEFAULT_TELEGRAM_TOOLS: ToolConfig = {
  enabled: true,
  allowedPaths: [join(homedir(), '.skimpyclaw'), process.cwd()],
  maxIterations: 100,
  bashTimeout: 15000,
};

function getTelegramToolConfig(cfg: Config): ToolConfig | undefined {
  if (cfg.channels.telegram.tools) {
    return cfg.channels.telegram.tools;
  }

  if (cfg.channels.telegram.defaultAllowedPaths?.length) {
    return {
      ...DEFAULT_TELEGRAM_TOOLS,
      allowedPaths: cfg.channels.telegram.defaultAllowedPaths,
    };
  }

  return DEFAULT_TELEGRAM_TOOLS;
}

/** Build the help text from BOT_COMMANDS. */
function buildHelpText(cfg: Config): string {
  const agentConfig = cfg.agents.list[cfg.agents.default];
  const emoji = agentConfig?.identity?.emoji || '🦞';
  const name = agentConfig?.identity?.name || 'SkimpyClaw';

  const commandList = BOT_COMMANDS
    .map(c => `/${c.command} — ${c.description}`)
    .join('\n');

  return `${emoji} ${name} online.\n\nSend a message to chat, or use a command:\n\n${commandList}`;
}

/** Get recent memory files (sorted newest first). */
function getRecentMemoryFiles(count: number = 5): { name: string; path: string; date: string; size: number }[] {
  const memoryDir = join(homedir(), '.skimpyclaw', 'agents', 'main', 'memory');

  if (!existsSync(memoryDir)) {
    return [];
  }

  const files = readdirSync(memoryDir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const filePath = join(memoryDir, f);
      const stats = statSync(filePath);
      return {
        name: f,
        path: filePath,
        date: f.replace('.md', ''),
        size: stats.size,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, count);

  return files;
}

export async function initTelegram(cfg: Config): Promise<Bot | null> {
  if (!cfg.channels.telegram.enabled || !cfg.channels.telegram.token) {
    console.log('[telegram] Disabled or no token configured');
    return null;
  }

  bot = new Bot(cfg.channels.telegram.token);

  // Initialize subagent system with message delivery callback
  initSubagentSystem(async (chatId: number, message: string) => {
    if (!bot) return;
    await sendLongMessage({ reply: (text: string) => bot!.api.sendMessage(chatId, text) } as any, message);
  });

  // Register commands with Telegram for the / menu
  bot.api.setMyCommands(BOT_COMMANDS).catch((err) => {
    console.error('[telegram] Failed to set bot commands:', err);
  });

  // Middleware: allowlist check
  bot.use(async (ctx, next) => {
    const senderId = ctx.from?.id;
    const senderUsername = ctx.from?.username;

    if (!senderId || !isAllowed(cfg.channels.telegram.allowFrom, senderId, senderUsername)) {
      console.log(`[telegram] Blocked message from ${senderId} (@${senderUsername})`);
      return; // Silently ignore
    }

    // Rate limit check
    if (isRateLimited(senderId)) {
      await ctx.reply('Too many messages. Please wait a moment.');
      return;
    }

    await next();
  });

  // /start command
  bot.command('start', async (ctx) => {
    await ctx.reply(buildHelpText(cfg));
  });

  // /help command
  bot.command('help', async (ctx) => {
    await ctx.reply(buildHelpText(cfg));
  });

  // /model command
  bot.command('model', async (ctx) => {
    const modelAlias = ctx.match;
    if (!modelAlias) {
      const current = getCurrentModel();
      const aliases = Object.keys(cfg.models.aliases).join(', ');
      await ctx.reply(`Current: ${current}\nAliases: ${aliases}\n\nUsage: /model <alias>`);
      return;
    }

    const resolved = cfg.models.aliases[modelAlias];
    if (!resolved) {
      const aliases = Object.keys(cfg.models.aliases).join(', ');
      await ctx.reply(`Unknown model alias: "${modelAlias}"\n\nAvailable: ${aliases}`);
      return;
    }
    setCurrentModel(resolved);
    await ctx.reply(`Model switched to: ${modelAlias} (${resolved})`);
  });

  // /status command
  bot.command('status', async (ctx) => {
    const model = getCurrentModel();
    const last = getLastMessage();
    const jobs = getCronJobs();
    const activeTasks = getActiveTasks();
    const recentTasks = getRecentTasks(20);

    const jobList = jobs.map(j => `  - ${j.name}: ${j.nextRun?.toLocaleString() || 'unknown'}`).join('\n');

    const pendingCount = activeTasks.filter(t => t.status === 'pending').length;
    const runningCount = activeTasks.filter(t => t.status === 'running').length;
    const maxConcurrent = cfg.subagents?.maxConcurrent ?? 5;

    const recentCompleted = recentTasks.filter(t => t.status === 'completed').length;
    const recentFailed = recentTasks.filter(t => t.status === 'failed').length;
    const recentCancelled = recentTasks.filter(t => t.status === 'cancelled').length;

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

    await ctx.reply(
      `Agent: ${cfg.agents.default}\n` +
      `Model: ${model}\n` +
      `Last message: ${last?.toLocaleString() || 'never'}\n` +
      `Silence until: ${silenceUntil?.toLocaleString() || 'not silenced'}\n\n` +
      `Subagents: ${activeTasks.length}/${maxConcurrent} active (running: ${runningCount}, pending: ${pendingCount})\n` +
      `Recent (last ${recentTasks.length}): ✅ ${recentCompleted} • ❌ ${recentFailed} • 🚫 ${recentCancelled}\n` +
      `${activePreview ? `Active now:\n${activePreview}\n\n` : '\n'}` +
      `Scheduled jobs:\n${jobList || '  (none)'}`
    );
  });

  // /cron command
  bot.command('cron', async (ctx) => {
    const args = ctx.match.split(' ');
    const subcommand = args[0];

    if (subcommand === 'list' || !subcommand) {
      const jobs = getCronJobs();
      if (jobs.length === 0) {
        await ctx.reply('No scheduled jobs.');
        return;
      }

      const list = jobs.map(j => `${j.id}: ${j.name} (next: ${j.nextRun?.toLocaleString() || '?'})`).join('\n');
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
  });

  // /heartbeat command — trigger a heartbeat check on demand
  bot.command('heartbeat', async (ctx) => {
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
  });

  // /restart command — restart the gateway
  bot.command('restart', async (ctx) => {
    const isLaunchd = !!process.env.SKIMPYCLAW_LAUNCHD;
    if (isLaunchd) {
      await ctx.reply('🦞 Restarting via launchd...');
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      const target = uid !== undefined ? `gui/${uid}/${LAUNCHD_LABEL}` : LAUNCHD_LABEL;
      const res = spawnSync('launchctl', ['kickstart', '-k', target], {
        encoding: 'utf8',
        timeout: 3000,
      });
      if (res.error || res.status !== 0) {
        await ctx.reply(`Restart failed: ${res.stderr || res.error?.message || 'unknown error'}`);
      }
      // If kickstart succeeded, process is already dead — this won't run
    } else {
      await ctx.reply('🦞 Restarting (dev mode)...');
      setTimeout(() => process.exit(0), 500);
    }
  });

  // /agent command — dispatch a background agent task
  bot.command('agent', async (ctx) => {
    const raw = ctx.match.trim();
    if (!raw) {
      const presets = getPresetDescriptions();
      await ctx.reply(
        `Usage: /agent <type> [model:<alias>] <prompt>\n\nTypes:\n${presets}\n\n` +
        `Example: /agent coding list TODOs in the codebase\n` +
        `Example: /agent research model:claude-opus summarize my daily notes`
      );
      return;
    }

    // Parse: <type> [model:<alias>] <prompt>
    const parts = raw.split(/\s+/);
    const type = parts[0] as SubagentType;
    if (!['coding', 'research', 'general'].includes(type)) {
      await ctx.reply(`Unknown type: ${type}. Use: coding, research, general`);
      return;
    }

    let modelOverride: string | undefined;
    let promptStart = 1;

    if (parts[1]?.startsWith('model:')) {
      const alias = parts[1].slice(6);
      modelOverride = cfg.models.aliases[alias] || alias;
      promptStart = 2;
    }

    const prompt = parts.slice(promptStart).join(' ');
    if (!prompt) {
      await ctx.reply('Missing prompt. What should the agent do?');
      return;
    }

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    try {
      const history = getHistory(chatId);
      const task = dispatchSubagent(type, prompt, chatId, cfg, modelOverride, history);
      await ctx.reply(
        `🚀 Agent ${task.id} dispatched (${task.type}, model: ${task.model})\n` +
        `Prompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}\n\n` +
        `I'll send the result when it's done. Use /tasks to check status.`
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`Error: ${msg}`);
    }
  });

  // /tasks command — show active and recent agent tasks
  bot.command('tasks', async (ctx) => {
    const active = getActiveTasks();
    const recent = getRecentTasks(5);

    if (recent.length === 0) {
      await ctx.reply('No agent tasks yet. Use /agent to start one.');
      return;
    }

    const formatTask = (t: typeof recent[0]) => {
      const elapsed = ((t.completedAt || new Date()).getTime() - t.createdAt.getTime()) / 1000;
      const elapsedStr = elapsed < 60 ? `${Math.round(elapsed)}s` : `${Math.round(elapsed / 60)}m`;
      const status = {
        pending: '⏳ Pending',
        running: `🔄 Running (${elapsedStr})`,
        completed: `✅ Done (${elapsedStr})`,
        failed: `❌ Failed (${elapsedStr})`,
        cancelled: '🚫 Cancelled',
      }[t.status];
      const promptPreview = t.prompt.slice(0, 60) + (t.prompt.length > 60 ? '...' : '');
      return `${t.id}: ${status} [${t.type}] ${promptPreview}`;
    };

    const lines = recent.map(formatTask).join('\n');
    await ctx.reply(`Agent tasks:\n\n${lines}`);
  });

  // /cancel command — cancel a running agent task
  bot.command('cancel', async (ctx) => {
    const id = ctx.match.trim();
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
  });

  // /new command — clear conversation history
  bot.command('new', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId) clearHistory(chatId);
    await ctx.reply('Conversation cleared. Starting fresh.');
  });

  // /compact command — summarize and compress conversation history
  bot.command('compact', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const history = getHistory(chatId);
    if (history.length === 0) {
      await ctx.reply('No conversation history to compact.');
      return;
    }

    const stopTyping = startTypingIndicator(ctx);
    try {
      // Ask the agent to summarize the conversation so far
      const historyText = history.map(m => `${m.role}: ${m.content}`).join('\n');
      const summary = await runAgentTurn(
        cfg.agents.default,
        `Summarize this conversation in 2-3 sentences so you can remember the context:\n\n${historyText}`,
        cfg,
        getCurrentModel(),
        undefined,
        undefined,
        getRunContext(ctx)
      );
      // Replace history with a single summary message
      clearHistory(chatId);
      chatHistory.set(chatId, [
        { role: 'user', content: 'Summary of our previous conversation:' },
        { role: 'assistant', content: summary },
      ]);
      await ctx.reply(`Compacted ${history.length} messages into a summary.`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`Error: ${msg}`);
    } finally {
      stopTyping();
    }
  });

  // /silence command
  bot.command('silence', async (ctx) => {
    const minutes = parseInt(ctx.match) || 30;
    silenceUntil = new Date(Date.now() + minutes * 60 * 1000);
    await ctx.reply(`Proactive messages silenced until ${silenceUntil.toLocaleTimeString()}`);
  });

  // /morning command
  bot.command('morning', async (ctx) => {
    await ctx.reply('Starting morning routine via Claude Code in vault... (this takes a few minutes)');

    let cronError: string | null = null;
    try {
      await runCronJob('morning', cfg);
    } catch (error) {
      cronError = error instanceof Error ? error.message : 'Unknown error';
    }

    // Always check for the daily note — claude -p may succeed but exit non-zero
    const dailyNote = getTodayDailyNote(cfg);
    if (dailyNote) {
      await ctx.reply('Morning routine complete. Here\'s your daily note:');
      await sendLongMessage(ctx, dailyNote);
    } else if (cronError) {
      await ctx.reply(`Morning routine failed: ${cronError}\n\nCheck logs at ~/.skimpyclaw/logs/cron/`);
    } else {
      await ctx.reply('Morning routine completed but no daily note was created for today.');
    }
  });

  // /eod command
  bot.command('eod', async (ctx) => {
    const stopTyping = startTypingIndicator(ctx);
    try {
      const response = await runAgentTurn(
        cfg.agents.default,
        'run EOD review',
        cfg,
        getCurrentModel(),
        getTelegramToolConfig(cfg),
        undefined,
        getRunContext(ctx)
      );
      await sendLongMessage(ctx, response);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`Error: ${msg}`);
    } finally {
      stopTyping();
    }
  });

  // /focus command
  bot.command('focus', async (ctx) => {
    const stopTyping = startTypingIndicator(ctx);
    try {
      const response = await runAgentTurn(
        cfg.agents.default,
        'plan my day',
        cfg,
        getCurrentModel(),
        getTelegramToolConfig(cfg),
        undefined,
        getRunContext(ctx)
      );
      await sendLongMessage(ctx, response);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`Error: ${msg}`);
    } finally {
      stopTyping();
    }
  });

  // /memory command — show recent memory entries
  bot.command('memory', async (ctx) => {
    const arg = ctx.match.trim();
    const recentFiles = getRecentMemoryFiles(10);

    if (recentFiles.length === 0) {
      await ctx.reply('No memory entries found.');
      return;
    }

    // If a date was specified, show that entry
    if (arg) {
      const match = recentFiles.find(f => f.date === arg || f.name === arg || f.name === `${arg}.md`);
      if (!match) {
        await ctx.reply(`No memory entry for "${arg}".\n\nAvailable: ${recentFiles.map(f => f.date).join(', ')}`);
        return;
      }

      try {
        const content = readFileSync(match.path, 'utf-8');
        // Show first ~3500 chars to stay within Telegram limits
        const preview = content.length > 3500
          ? content.slice(0, 3500) + '\n\n... (truncated)'
          : content;
        await sendLongMessage(ctx, `📝 Memory: ${match.date}\n\n${preview}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        await ctx.reply(`Error reading memory: ${msg}`);
      }
      return;
    }

    // Default: show list of recent entries with sizes
    const formatSize = (bytes: number): string => {
      if (bytes < 1024) return `${bytes}B`;
      return `${(bytes / 1024).toFixed(1)}KB`;
    };

    const list = recentFiles
      .map(f => `  ${f.date} (${formatSize(f.size)})`)
      .join('\n');

    await ctx.reply(
      `📝 Recent memory entries:\n\n${list}\n\n` +
      `View one: /memory <date>\nExample: /memory ${recentFiles[0].date}`
    );
  });

  // Handle plain text messages (treat as /ask)
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;

    // Catch-all for unknown commands — respond instead of silently ignoring
    if (text.startsWith('/')) {
      const command = text.split(/[\s@]/)[0].slice(1).toLowerCase();
      if (!KNOWN_COMMANDS.has(command)) {
        await ctx.reply(`Unknown command: /${command}\n\nType /help to see available commands.`);
      }
      return;
    }

    const chatId = ctx.chat?.id;
    const stopTyping = startTypingIndicator(ctx);

    try {
      const history = chatId ? getHistory(chatId) : [];
      const response = await runAgentTurn(
        cfg.agents.default,
        text,
        cfg,
        getCurrentModel(),
        getTelegramToolConfig(cfg),
        history,
        getRunContext(ctx)
      );
      if (chatId) addToHistory(chatId, text, response);
      await sendLongMessage(ctx, response);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`Error: ${msg}`);
    } finally {
      stopTyping();
    }
  });

  // Error handling
  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`[telegram] Error while handling update ${ctx.update.update_id}:`);
    const e = err.error;
    if (e instanceof GrammyError) {
      console.error('[telegram] Error in request:', e.description);
    } else if (e instanceof HttpError) {
      console.error('[telegram] Could not contact Telegram:', e);
    } else {
      console.error('[telegram] Unknown error:', e);
    }
  });

  return bot;
}

// Helper to send long messages (Telegram has 4096 char limit)
async function sendLongMessage(ctx: Context, text: string): Promise<void> {
  const MAX_LENGTH = 4000;

  if (text.length <= MAX_LENGTH) {
    await ctx.reply(text);
    return;
  }

  // Split on paragraph boundaries
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of text.split('\n\n')) {
    if (current.length + paragraph.length + 2 > MAX_LENGTH) {
      if (current) chunks.push(current.trim());
      current = paragraph;
    } else {
      current += (current ? '\n\n' : '') + paragraph;
    }
  }
  if (current) chunks.push(current.trim());

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

export async function startTelegram(): Promise<void> {
  if (!bot) return;

  console.log('[telegram] Starting bot...');
  bot.start({
    onStart: (botInfo) => {
      console.log(`[telegram] Bot started as @${botInfo.username}`);
    },
  });
}

export async function stopTelegram(): Promise<void> {
  if (!bot) return;
  await bot.stop();
  console.log('[telegram] Bot stopped');
}

export function isSilenced(): boolean {
  if (!silenceUntil) return false;
  return new Date() < silenceUntil;
}

export async function sendProactiveMessage(chatId: string | number, message: string): Promise<void> {
  if (!bot || isSilenced()) return;
  const resolvedChatId = typeof chatId === 'number' ? chatId : Number(chatId);
  if (!Number.isFinite(resolvedChatId)) return;
  await bot.api.sendMessage(resolvedChatId, message);
}

export function getTelegramDefaultChatId(cfg: Config): number | null {
  const allowFrom = cfg.channels.telegram.allowFrom;
  for (const entry of allowFrom) {
    if (typeof entry === 'number') return entry;
    const num = Number(entry);
    if (!isNaN(num)) return num;
  }
  return null;
}
