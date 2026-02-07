// Telegram bot using Grammy

import { Bot, Context, GrammyError, HttpError } from 'grammy';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { Config, ToolConfig } from './types.js';
import { isAllowed, isRateLimited, sanitizeUserInput } from './security.js';
import { runAgentTurn } from './agent.js';
import { getCronJobs, runCronJob } from './cron.js';
import { getCurrentModel, setCurrentModel, getLastMessage } from './gateway.js';
import { runHeartbeatCheck } from './heartbeat.js';

const VAULT_DAILY_NOTES = '/Users/katre/Library/Mobile Documents/iCloud~md~obsidian/Documents/2ndBrain/2. Areas/Daily Notes';

function getTodayDailyNote(): string | null {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const year = now.getFullYear();
  const filename = `${month}-${day}-${year}.md`;
  const filePath = join(VAULT_DAILY_NOTES, filename);

  if (!existsSync(filePath)) {
    return null;
  }
  return readFileSync(filePath, 'utf-8');
}

let bot: Bot | null = null;
let config: Config;
let silenceUntil: Date | null = null;

// Default tool config for Telegram — gives the agent file/bash access
const DEFAULT_TELEGRAM_TOOLS: ToolConfig = {
  enabled: true,
  allowedPaths: [
    '/Users/katre/Library/Mobile Documents/iCloud~md~obsidian/Documents/2ndBrain',
    '/Users/katre/.skimpyclaw',
  ],
  maxIterations: 10,
  bashTimeout: 15000,
};

function getTelegramToolConfig(cfg: Config): ToolConfig | undefined {
  return cfg.channels.telegram.tools || DEFAULT_TELEGRAM_TOOLS;
}

export async function initTelegram(cfg: Config): Promise<Bot | null> {
  if (!cfg.channels.telegram.enabled || !cfg.channels.telegram.token) {
    console.log('[telegram] Disabled or no token configured');
    return null;
  }

  config = cfg;
  bot = new Bot(cfg.channels.telegram.token);

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
    const agentConfig = cfg.agents.list[cfg.agents.default];
    const emoji = agentConfig?.identity?.emoji || '🦞';
    const name = agentConfig?.identity?.name || 'SkimpyClaw';
    await ctx.reply(`${emoji} ${name} online.\n\nJust send me a message. Commands:\n/model <alias> - Switch model (fast/smart/opus)\n/status - Show status\n/morning - Morning routine\n/eod - EOD review\n/silence <mins> - Pause proactive messages`);
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

    const resolved = cfg.models.aliases[modelAlias] || modelAlias;
    setCurrentModel(resolved);
    await ctx.reply(`Model switched to: ${resolved}`);
  });

  // /status command
  bot.command('status', async (ctx) => {
    const model = getCurrentModel();
    const last = getLastMessage();
    const jobs = getCronJobs();

    const jobList = jobs.map(j => `  - ${j.name}: ${j.nextRun?.toLocaleString() || 'unknown'}`).join('\n');

    await ctx.reply(
      `Agent: ${cfg.agents.default}\n` +
      `Model: ${model}\n` +
      `Last message: ${last?.toLocaleString() || 'never'}\n` +
      `Silence until: ${silenceUntil?.toLocaleString() || 'not silenced'}\n\n` +
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
    await ctx.replyWithChatAction('typing');
    try {
      const response = await runHeartbeatCheck(cfg);
      await sendLongMessage(ctx, `🫀 ${response}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`Heartbeat error: ${msg}`);
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
    const dailyNote = getTodayDailyNote();
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
    await ctx.replyWithChatAction('typing');
    try {
      const response = await runAgentTurn(
        cfg.agents.default,
        'run EOD review',
        cfg,
        getCurrentModel(),
        getTelegramToolConfig(cfg)
      );
      await sendLongMessage(ctx, response);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`Error: ${msg}`);
    }
  });

  // /focus command
  bot.command('focus', async (ctx) => {
    await ctx.replyWithChatAction('typing');
    try {
      const response = await runAgentTurn(
        cfg.agents.default,
        'plan my day',
        cfg,
        getCurrentModel(),
        getTelegramToolConfig(cfg)
      );
      await sendLongMessage(ctx, response);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`Error: ${msg}`);
    }
  });

  // /memory command
  bot.command('memory', async (ctx) => {
    // TODO: Show recent memory entries
    await ctx.reply('Memory viewing not yet implemented.');
  });

  // Handle plain text messages (treat as /ask)
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;

    // Skip if it's a command
    if (text.startsWith('/')) return;

    await ctx.replyWithChatAction('typing');

    try {
      const response = await runAgentTurn(
        cfg.agents.default,
        text,
        cfg,
        getCurrentModel(),
        getTelegramToolConfig(cfg)
      );
      await sendLongMessage(ctx, response);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`Error: ${msg}`);
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

export async function sendProactiveMessage(chatId: number, message: string): Promise<void> {
  if (!bot || isSilenced()) return;
  await bot.api.sendMessage(chatId, message);
}
