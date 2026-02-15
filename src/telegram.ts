// Telegram bot using Grammy

import { Bot, Context, GrammyError, HttpError } from 'grammy';
import { run, RunnerHandle } from '@grammyjs/runner';
import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  writeFileSync,
  unlinkSync,
  mkdirSync
} from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { transcribeAudio } from './voice.js';
import { spawnSync } from 'child_process';
import type { Config, ToolConfig, AgentRunContext } from './types.js';
import { isAllowed, isRateLimited } from './security.js';
import type { ChatMessage } from './types.js';
import { runAgentTurn } from './agent.js';
import { getCronJobs, runCronJob } from './cron.js';
import { getCurrentModel, setCurrentModel, getLastMessage } from './gateway.js';
import { runHeartbeatCheck } from './heartbeat.js';
import {
  initSubagentSystem,
  cancelTask,
  getActiveTasks,
  getRecentTasks
} from './subagent.js';
import { getActiveCodeAgents, getRecentCodeAgents } from './tools.js';

const LAUNCHD_LABEL = 'com.skimpyclaw.gateway';

// Command definitions — single source of truth for the / menu and /help
const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: 'help', description: 'Show available commands' },
  { command: 'model', description: 'Switch model (fast/smart/opus)' },
  { command: 'status', description: 'Show bot status' },
  { command: 'memory', description: 'View recent memory entries' },
  { command: 'new', description: 'Clear conversation history' },
  { command: 'compact', description: 'Compress conversation history' },
  { command: 'silence', description: 'Pause proactive messages' },
  { command: 'cron', description: 'List or run scheduled jobs' },
  { command: 'tasks', description: 'Show active/recent agent tasks' },
  { command: 'cancel', description: 'Cancel a running agent task' },
  { command: 'heartbeat', description: 'Trigger heartbeat check' },
  { command: 'restart', description: 'Restart the gateway' }
];

// Set of known command names for catch-all routing
const KNOWN_COMMANDS = new Set(
  BOT_COMMANDS.map((c) => c.command).concat(['start'])
);

let bot: Bot | null = null;
let runnerHandle: RunnerHandle | null = null;
let silenceUntil: Date | null = null;

// Conversation history per chat — last N user/assistant message pairs
const MAX_HISTORY_PAIRS = 5;
const chatHistory = new Map<number, ChatMessage[]>();

function getHistory(chatId: number): ChatMessage[] {
  return chatHistory.get(chatId) || [];
}

function addToHistory(
  chatId: number,
  userMsg: string,
  assistantMsg: string
): void {
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
    trigger: 'telegram',
    metadata: {
      username: ctx.from?.username,
      chatId: ctx.chat?.id
    }
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
  bashTimeout: 15000
};

function getTelegramToolConfig(cfg: Config): ToolConfig | undefined {
  if (cfg.channels.telegram.tools) {
    return cfg.channels.telegram.tools;
  }

  if (cfg.channels.telegram.defaultAllowedPaths?.length) {
    return {
      ...DEFAULT_TELEGRAM_TOOLS,
      allowedPaths: cfg.channels.telegram.defaultAllowedPaths
    };
  }

  return DEFAULT_TELEGRAM_TOOLS;
}

/** Build the help text from BOT_COMMANDS. */
function buildHelpText(cfg: Config): string {
  const agentConfig = cfg.agents.list[cfg.agents.default];
  const emoji = agentConfig?.identity?.emoji || '🦞';
  const name = agentConfig?.identity?.name || 'SkimpyClaw';

  const commandList = BOT_COMMANDS.map(
    (c) => `/${c.command} — ${c.description}`
  ).join('\n');

  return `${emoji} ${name} online.\n\nSend a message to chat, or use a command:\n\n${commandList}`;
}

/** Get recent memory files (sorted newest first). */
function getRecentMemoryFiles(
  count: number = 5
): { name: string; path: string; date: string; size: number }[] {
  const memoryDir = join(homedir(), '.skimpyclaw', 'agents', 'main', 'memory');

  if (!existsSync(memoryDir)) {
    return [];
  }

  const files = readdirSync(memoryDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const filePath = join(memoryDir, f);
      const stats = statSync(filePath);
      return {
        name: f,
        path: filePath,
        date: f.replace('.md', ''),
        size: stats.size
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
    await sendLongMessage(
      { reply: (text: string) => bot!.api.sendMessage(chatId, text) } as any,
      message
    );
  });

  // Register commands with Telegram for the / menu
  bot.api.setMyCommands(BOT_COMMANDS).catch((err) => {
    console.error('[telegram] Failed to set bot commands:', err);
  });

  // Middleware: allowlist check
  bot.use(async (ctx, next) => {
    const senderId = ctx.from?.id;
    const senderUsername = ctx.from?.username;

    if (
      !senderId ||
      !isAllowed(cfg.channels.telegram.allowFrom, senderId, senderUsername)
    ) {
      console.log(
        `[telegram] Blocked message from ${senderId} (@${senderUsername})`
      );
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
      await ctx.reply(
        `Current: ${current}\nAliases: ${aliases}\n\nUsage: /model <alias>`
      );
      return;
    }

    const resolved = cfg.models.aliases[modelAlias];
    if (!resolved) {
      const aliases = Object.keys(cfg.models.aliases).join(', ');
      await ctx.reply(
        `Unknown model alias: "${modelAlias}"\n\nAvailable: ${aliases}`
      );
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

    const jobList = jobs
      .map((j) => `  - ${j.name}: ${j.nextRun?.toLocaleString() || 'unknown'}`)
      .join('\n');

    const pendingCount = activeTasks.filter(
      (t) => t.status === 'pending'
    ).length;
    const runningCount = activeTasks.filter(
      (t) => t.status === 'running'
    ).length;
    const maxConcurrent = cfg.subagents?.maxConcurrent ?? 5;

    const recentCompleted = recentTasks.filter(
      (t) => t.status === 'completed'
    ).length;
    const recentFailed = recentTasks.filter(
      (t) => t.status === 'failed'
    ).length;
    const recentCancelled = recentTasks.filter(
      (t) => t.status === 'cancelled'
    ).length;

    const activePreview = activeTasks
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 3)
      .map((task) => {
        const started = task.startedAt || task.createdAt;
        const elapsedSeconds = Math.max(
          0,
          Math.round((Date.now() - started.getTime()) / 1000)
        );
        const elapsed =
          elapsedSeconds < 60
            ? `${elapsedSeconds}s`
            : `${Math.round(elapsedSeconds / 60)}m`;
        const label = task.label ? ` (${task.label})` : '';
        return `  - ${task.id} [${task.type}] ${task.status}${label} • ${elapsed}`;
      })
      .join('\n');

    // Coding agents status (multi-agent)
    const caActive = getActiveCodeAgents();
    const caRecent = getRecentCodeAgents(3);
    const caAll = [...caActive, ...caRecent];
    let caLine = 'Coding Agents: idle';
    if (caAll.length > 0) {
      const runningCount = caActive.length;
      const completedCount = caRecent.filter(
        (t) => t.status === 'completed'
      ).length;
      const failedCount = caRecent.filter(
        (t) => t.status === 'failed' || t.status === 'timeout'
      ).length;
      const parts: string[] = [];
      if (runningCount) parts.push(`${runningCount} running`);
      if (completedCount) parts.push(`${completedCount} completed`);
      if (failedCount) parts.push(`${failedCount} failed`);
      caLine = `Coding Agents: ${parts.join(', ') || 'idle'}`;
      const caPreview = caAll
        .slice(0, 5)
        .map((t) => {
          const elapsed =
            t.durationSeconds != null
              ? t.durationSeconds < 60
                ? `${t.durationSeconds}s`
                : `${Math.floor(t.durationSeconds / 60)}m ${t.durationSeconds % 60}s`
              : Math.round(
                  (Date.now() - new Date(t.startedAt).getTime()) / 1000
                ) + 's';
          const taskPreview =
            t.task.length > 50 ? t.task.slice(0, 50) + '...' : t.task;
          return `  ${t.id}: ${t.status.toUpperCase()} (${t.agent}, ${elapsed}) — ${taskPreview}`;
        })
        .join('\n');
      if (caPreview) caLine += '\n' + caPreview;
    }

    await ctx.reply(
      `Agent: ${cfg.agents.default}\n` +
        `Model: ${model}\n` +
        `Last message: ${last?.toLocaleString() || 'never'}\n` +
        `Silence until: ${silenceUntil?.toLocaleString() || 'not silenced'}\n\n` +
        `${caLine}\n\n` +
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

      const list = jobs
        .map(
          (j) =>
            `${j.id}: ${j.name} (next: ${j.nextRun?.toLocaleString() || '?'})`
        )
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
      const uid =
        typeof process.getuid === 'function' ? process.getuid() : undefined;
      const target =
        uid !== undefined ? `gui/${uid}/${LAUNCHD_LABEL}` : LAUNCHD_LABEL;
      const res = spawnSync('launchctl', ['kickstart', '-k', target], {
        encoding: 'utf8',
        timeout: 3000
      });
      if (res.error || res.status !== 0) {
        await ctx.reply(
          `Restart failed: ${res.stderr || res.error?.message || 'unknown error'}`
        );
      }
      // If kickstart succeeded, process is already dead — this won't run
    } else {
      await ctx.reply('🦞 Restarting (dev mode)...');
      setTimeout(() => process.exit(0), 500);
    }
  });

  // /tasks command — show active and recent agent tasks
  bot.command('tasks', async (ctx) => {
    const active = getActiveTasks();
    const recent = getRecentTasks(5);

    if (recent.length === 0) {
      await ctx.reply(
        'No agent tasks yet. Subagents spawn automatically for complex requests.'
      );
      return;
    }

    const formatTask = (t: (typeof recent)[0]) => {
      const elapsed =
        ((t.completedAt || new Date()).getTime() - t.createdAt.getTime()) /
        1000;
      const elapsedStr =
        elapsed < 60
          ? `${Math.round(elapsed)}s`
          : `${Math.round(elapsed / 60)}m`;
      const status = {
        pending: '⏳ Pending',
        running: `🔄 Running (${elapsedStr})`,
        completed: `✅ Done (${elapsedStr})`,
        failed: `❌ Failed (${elapsedStr})`,
        cancelled: '🚫 Cancelled'
      }[t.status];
      const promptPreview =
        t.prompt.slice(0, 60) + (t.prompt.length > 60 ? '...' : '');
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
      const historyText = history
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n');
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
        { role: 'assistant', content: summary }
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
    await ctx.reply(
      `Proactive messages silenced until ${silenceUntil.toLocaleTimeString()}`
    );
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
      const match = recentFiles.find(
        (f) => f.date === arg || f.name === arg || f.name === `${arg}.md`
      );
      if (!match) {
        await ctx.reply(
          `No memory entry for "${arg}".\n\nAvailable: ${recentFiles.map((f) => f.date).join(', ')}`
        );
        return;
      }

      try {
        const content = readFileSync(match.path, 'utf-8');
        // Show first ~3500 chars to stay within Telegram limits
        const preview =
          content.length > 3500
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
      .map((f) => `  ${f.date} (${formatSize(f.size)})`)
      .join('\n');

    await ctx.reply(
      `📝 Recent memory entries:\n\n${list}\n\n` +
        `View one: /memory <date>\nExample: /memory ${recentFiles[0].date}`
    );
  });

  // Handle voice messages — transcribe and pass to agent
  bot.on('message:voice', async (ctx) => {
    const voice = ctx.message.voice;
    if (!voice) return;

    const chatId = ctx.chat?.id;
    const stopTyping = startTypingIndicator(ctx);

    try {
      // Check voice config
      if (!cfg.voice) {
        await ctx.reply(
          'Voice transcription not configured. Add a "voice" section to config.json.'
        );
        return;
      }

      // Download the voice file from Telegram
      const file = await bot!.api.getFile(voice.file_id);
      const token = cfg.channels.telegram.token;
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());

      // Save to temp file
      const ext = file.file_path?.split('.').pop() || 'oga';
      const tempDir = join(tmpdir(), 'skimpyclaw-voice');
      if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
      const tempPath = join(tempDir, `voice-${Date.now()}.${ext}`);
      writeFileSync(tempPath, buffer);

      try {
        // Transcribe
        const result = await transcribeAudio(tempPath, cfg.voice);
        const transcription = result.text.trim();
        console.log(`[telegram] Transcription result: ${transcription}`);

        if (!transcription) {
          await ctx.reply('Could not transcribe audio — no speech detected.');
          return;
        }

        const history = chatId ? getHistory(chatId) : [];
        const agentResponse = await runAgentTurn(
          cfg.agents.default,
          transcription,
          cfg,
          getCurrentModel(),
          getTelegramToolConfig(cfg),
          history,
          getRunContext(ctx)
        );
        if (chatId) addToHistory(chatId, transcription, agentResponse);

        // Single message: blockquote transcription + agent response (no reply to voice note)
        const combined = `<blockquote>🎤 ${transcription}</blockquote>\n\n${escapeHtml(agentResponse)}`;
        await sendLongMessageHtml(ctx, combined);
      } finally {
        // Clean up temp file
        try {
          unlinkSync(tempPath);
        } catch {}
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`Voice transcription error: ${msg}`);
    } finally {
      stopTyping();
    }
  });

  // Handle photo messages
  bot.on('message:photo', async (ctx) => {
    const photos = ctx.message.photo;
    if (!photos || photos.length === 0) return;

    const chatId = ctx.chat?.id;
    const stopTyping = startTypingIndicator(ctx);

    try {
      // Get the largest photo size (last element)
      const photo = photos[photos.length - 1];

      // Download the photo
      const file = await bot!.api.getFile(photo.file_id);
      const token = cfg.channels.telegram.token;
      const imageUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const imageResponse = await fetch(imageUrl);
      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      const base64Image = imageBuffer.toString('base64');

      // Determine media type from file path
      const ext = file.file_path?.split('.').pop()?.toLowerCase() || 'jpg';
      const mediaType = ext === 'png' ? 'image/png' : 'image/jpeg';

      // Get caption or use default
      const caption = ctx.message.caption || "What's in this image?";

      // Build multi-part content array
      const content: import('./types.js').ContentBlock[] = [
        {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: mediaType,
            data: base64Image
          }
        },
        {
          type: 'text' as const,
          text: caption
        }
      ];

      const history = chatId ? getHistory(chatId) : [];
      const response = await runAgentTurn(
        cfg.agents.default,
        content,
        cfg,
        getCurrentModel(),
        getTelegramToolConfig(cfg),
        history,
        getRunContext(ctx)
      );

      if (chatId) {
        addToHistory(chatId, `[Image: ${caption}]`, response);
      }

      await sendLongMessage(ctx, response);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`Error processing image: ${msg}`);
    } finally {
      stopTyping();
    }
  });

  // Handle plain text messages (treat as /ask)
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;

    // Catch-all for unknown commands — respond instead of silently ignoring
    if (text.startsWith('/')) {
      const command = text.split(/[\s@]/)[0].slice(1).toLowerCase();
      if (!KNOWN_COMMANDS.has(command)) {
        await ctx.reply(
          `Unknown command: /${command}\n\nType /help to see available commands.`
        );
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
    console.error(
      `[telegram] Error while handling update ${ctx.update.update_id}:`
    );
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

// Escape HTML entities for Telegram HTML parse mode
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Send long message with HTML parse mode (for blockquotes etc.)
async function sendLongMessageHtml(
  ctx: Context,
  html: string,
  replyToMessageId?: number
): Promise<void> {
  const MAX_LENGTH = 4000;
  const replyOpts = replyToMessageId
    ? { reply_parameters: { message_id: replyToMessageId } }
    : {};

  if (html.length <= MAX_LENGTH) {
    await ctx.reply(html, { parse_mode: 'HTML', ...replyOpts });
    return;
  }

  // For HTML we can't safely split mid-tag, so just send as chunks at paragraph boundaries
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of html.split('\n\n')) {
    if (current.length + paragraph.length + 2 > MAX_LENGTH) {
      if (current) chunks.push(current.trim());
      current = paragraph;
    } else {
      current += (current ? '\n\n' : '') + paragraph;
    }
  }
  if (current) chunks.push(current.trim());

  for (let i = 0; i < chunks.length; i++) {
    await ctx.reply(chunks[i], {
      parse_mode: 'HTML',
      ...(i === 0 ? replyOpts : {})
    });
  }
}

// Helper to send long messages (Telegram has 4096 char limit)
async function sendLongMessage(
  ctx: Context,
  text: string,
  replyToMessageId?: number
): Promise<void> {
  const MAX_LENGTH = 4000;
  const replyOpts = replyToMessageId
    ? { reply_parameters: { message_id: replyToMessageId } }
    : {};

  if (text.length <= MAX_LENGTH) {
    await ctx.reply(text, replyOpts);
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

  for (let i = 0; i < chunks.length; i++) {
    // Only reply-to on the first chunk
    await ctx.reply(chunks[i], i === 0 ? replyOpts : {});
  }
}

export async function startTelegram(): Promise<void> {
  if (!bot) return;

  console.log('[telegram] Starting bot (concurrent runner)...');
  // Use @grammyjs/runner for concurrent update processing
  // bot.start() processes updates sequentially — one at a time.
  // run(bot) processes them concurrently so cron jobs and long agent
  // turns don't block incoming messages.
  runnerHandle = run(bot);
  const botInfo = await bot.api.getMe();
  console.log(`[telegram] Bot started as @${botInfo.username}`);
}

export async function stopTelegram(): Promise<void> {
  if (runnerHandle) {
    runnerHandle.stop();
    console.log('[telegram] Bot stopped');
    runnerHandle = null;
  } else if (bot) {
    await bot.stop();
    console.log('[telegram] Bot stopped');
  }
}

export function isSilenced(): boolean {
  if (!silenceUntil) return false;
  return new Date() < silenceUntil;
}

export async function sendProactiveMessage(
  chatId: string | number,
  message: string
): Promise<void> {
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
