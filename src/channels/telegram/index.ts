// Telegram bot using Grammy

import { Bot, Context, GrammyError, HttpError, InputFile } from 'grammy';
import { run, RunnerHandle } from '@grammyjs/runner';
import type { Config, ChatMessage } from '../../types.js';
import { isAllowed, isRateLimited } from '../../security.js';
import { runAgentTurn } from '../../agent.js';

import { getCurrentModel } from '../../gateway.js';
import { getApproval, approveRequest, denyRequest } from '../../exec-approval.js';
import { loadSkills } from '../../skills.js';
import { transcribeAudio, synthesizeSpeech } from '../../voice.js';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { spawnSync } from 'child_process';

import { state, BOT_COMMANDS, LAUNCHD_LABEL } from './types.js';
import {
  getHistory,
  addToHistory,
  clearHistory,
  getRunContext,
  getDefaultTelegramToolConfig,
  getRecentMemoryFiles,
  startTypingIndicator,
  sendLongMessage,
  sendLongMessageHtml,
  escapeHtml,
  markdownToTelegramHtml,
  buildHelpText,
  getTelegramDefaultChatId,
} from './utils.js';

import { commandHandlers, subscribeToApprovalEvents } from './handlers.js';

// Re-export for backward compatibility
export { state, BOT_COMMANDS, LAUNCHD_LABEL } from './types.js';
export {
  getHistory,
  addToHistory,
  clearHistory,
  getRunContext,
  getDefaultTelegramToolConfig,
  buildHelpText,
  getTelegramDefaultChatId,
  startTypingIndicator,
  sendLongMessage,
  sendLongMessageHtml,
  escapeHtml,
  markdownToTelegramHtml,
} from './utils.js';
export { commandHandlers, subscribeToApprovalEvents } from './handlers.js';

let activeBot: Bot | null = null;
let runnerHandle: RunnerHandle | null = null;

export function getBot(): Bot | null {
  return activeBot;
}

export function setSilenceUntil(date: Date | null): void {
  state.silenceUntil = date;
}

export function getSilenceUntil(): Date | null {
  return state.silenceUntil;
}

export async function startTelegram(): Promise<void> {
  if (!activeBot) return;
  console.log('[telegram] Starting bot (concurrent runner)...');
  const botInfo = await activeBot.api.getMe();
  console.log(`[telegram] Bot started as @${botInfo.username}`);
}

export async function stopTelegram(): Promise<void> {
  if (runnerHandle) {
    await runnerHandle.stop();
    runnerHandle = null;
  }
  activeBot = null;
  console.log('[telegram] Bot stopped');
}

export function isSilenced(): boolean {
  if (!state.silenceUntil) return false;
  return new Date() < state.silenceUntil;
}

export async function sendProactiveMessage(
  chatId: string | number,
  message: string
): Promise<void> {
  if (!activeBot || isSilenced()) return;
  const resolvedChatId = typeof chatId === 'number' ? chatId : Number(chatId);
  if (!Number.isFinite(resolvedChatId)) return;

  const html = markdownToTelegramHtml(message);
  const MAX_LENGTH = 4000;

  if (html.length <= MAX_LENGTH) {
    await activeBot.api.sendMessage(resolvedChatId, html, { parse_mode: 'HTML' });
    return;
  }

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

  for (const chunk of chunks) {
    await activeBot.api.sendMessage(resolvedChatId, chunk, { parse_mode: 'HTML' });
  }
}

export async function sendProactiveVoice(
  chatId: string | number,
  buffer: Buffer,
  format: string
): Promise<void> {
  if (!activeBot || isSilenced()) return;
  const resolvedChatId = typeof chatId === 'number' ? chatId : Number(chatId);
  if (!Number.isFinite(resolvedChatId)) return;

  await activeBot.api.sendVoice(resolvedChatId, new InputFile(buffer, `voice.${format}`));
}

export async function initTelegram(cfg: Config): Promise<Bot | null> {
  if (!cfg.channels.telegram.enabled || !cfg.channels.telegram.token) {
    console.log('[telegram] Disabled or no token configured');
    return null;
  }

  const bot = new Bot(cfg.channels.telegram.token);
  activeBot = bot;

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
      return;
    }

    if (isRateLimited(senderId)) {
      await ctx.reply('Too many messages. Please wait a moment.');
      return;
    }

    await next();
  });

  // Command handlers
  bot.command('start', (ctx) => commandHandlers.start(ctx, cfg));
  bot.command('help', (ctx) => commandHandlers.help(ctx, cfg));
  bot.command('model', (ctx) => commandHandlers.model(ctx, cfg));
  bot.command('status', (ctx) => commandHandlers.status(ctx, cfg));
  bot.command('cron', (ctx) => commandHandlers.cron(ctx, cfg));
  bot.command('heartbeat', (ctx) => commandHandlers.heartbeat(ctx, cfg));
  bot.command('restart', (ctx) => commandHandlers.restart(ctx, cfg));
  bot.command('tasks', (ctx) => commandHandlers.tasks(ctx, cfg));
  bot.command('cancel', (ctx) => commandHandlers.cancel(ctx, cfg));
  bot.command('skills', (ctx) => commandHandlers.skills(ctx, cfg));
  bot.command('skill', (ctx) => commandHandlers.skill(ctx, cfg));
  bot.command('approvals', (ctx) => commandHandlers.approvals(ctx, cfg));
  bot.command('approve', (ctx) => commandHandlers.approve(ctx, cfg));
  bot.command('deny', (ctx) => commandHandlers.deny(ctx, cfg));
  bot.command('clear', (ctx) => commandHandlers.clear(ctx, cfg));
  bot.command('compact', (ctx) => commandHandlers.compact(ctx, cfg));
  bot.command('silence', (ctx) => commandHandlers.silence(ctx, cfg));
  bot.command('memory', (ctx) => commandHandlers.memory(ctx, cfg));

  // Inline button callback handler for approval buttons
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data) return;

    const [action, id] = data.split(':');
    if (!id || (action !== 'approve' && action !== 'deny')) {
      await ctx.answerCallbackQuery({ text: 'Unknown action' });
      return;
    }

    const by = ctx.from?.username || ctx.from?.id?.toString() || 'telegram';
    let success: boolean;
    let statusText: string;

    if (action === 'approve') {
      success = approveRequest(id, by);
      statusText = success ? `✅ Approved by @${by}` : 'Failed — not pending';
    } else {
      success = denyRequest(id, by);
      statusText = success ? `❌ Denied by @${by}` : 'Failed — not pending';
    }

    await ctx.answerCallbackQuery({ text: statusText });

    try {
      const approval = getApproval(id);
      if (approval) {
        const cmdPreview = approval.command.length > 80 ? approval.command.slice(0, 80) + '...' : approval.command;
        await ctx.editMessageText(
          `${statusText}\n\n` +
          `Approval #${id}\n` +
          `Tier ${approval.tier}: ${approval.reason}\n` +
          `Command: ${cmdPreview}`
        );
      }
    } catch {
      // Message may already be edited or deleted
    }
  });

  // Subscribe to approval events for proactive notifications
  subscribeToApprovalEvents(bot, cfg);

  // Handle voice messages
  bot.on('message:voice', async (ctx) => {
    const voice = ctx.message.voice;
    if (!voice) return;

    const chatId = ctx.chat?.id;
    const stopTyping = startTypingIndicator(ctx);

    try {
      if (!cfg.voice) {
        await ctx.reply('Voice transcription not configured. Add a "voice" section to config.json.');
        return;
      }

      const file = await bot.api.getFile(voice.file_id);
      const token = cfg.channels.telegram.token;
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());

      const ext = file.file_path?.split('.').pop() || 'oga';
      const tempDir = join(tmpdir(), 'skimpyclaw-voice');
      if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
      const tempPath = join(tempDir, `voice-${Date.now()}.${ext}`);
      writeFileSync(tempPath, buffer);

      try {
        const result = await transcribeAudio(tempPath, cfg.voice);
        const transcription = result.text.trim();
        console.log(`[telegram] Transcription result: ${transcription}`);

        if (!transcription) {
          await ctx.reply('Could not transcribe audio — no speech detected.');
          return;
        }

        const history = chatId ? await getHistory(chatId) : [];
        const agentResponse = await runAgentTurn(
          cfg.agents.default,
          transcription,
          cfg,
          getCurrentModel(),
          getDefaultTelegramToolConfig(cfg),
          history,
          getRunContext(ctx)
        );
        if (chatId) await addToHistory(chatId, transcription, agentResponse);

        if (cfg.voice?.channels?.['telegram']?.sendVoice) {
          try {
            const speech = await synthesizeSpeech(agentResponse, cfg.voice);
            await ctx.replyWithVoice(new InputFile(speech.buffer, `reply.${speech.format}`));
          } catch (err) {
            console.error('[telegram] TTS synthesis failed:', err);
          }
        }

        const combined = `<blockquote>🎤 ${transcription}</blockquote>\n\n${escapeHtml(agentResponse)}`;
        await sendLongMessageHtml(ctx, combined);
      } finally {
        try { unlinkSync(tempPath); } catch { /* best effort */ }
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
      const photo = photos[photos.length - 1];
      const file = await bot.api.getFile(photo.file_id);
      const token = cfg.channels.telegram.token;
      const imageUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const imageResponse = await fetch(imageUrl);
      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      const base64Image = imageBuffer.toString('base64');

      const ext = file.file_path?.split('.').pop()?.toLowerCase() || 'jpg';
      const mediaType = ext === 'png' ? 'image/png' : 'image/jpeg';

      const caption = ctx.message.caption || 'What do you see in this image?';
      const history = chatId ? await getHistory(chatId) : [];

      const userContent = [
        { type: 'text' as const, text: caption },
        {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: mediaType, data: base64Image }
        }
      ];

      const agentResponse = await runAgentTurn(
        cfg.agents.default,
        userContent,
        cfg,
        getCurrentModel(),
        getDefaultTelegramToolConfig(cfg),
        history,
        getRunContext(ctx)
      );

      if (chatId) await addToHistory(chatId, caption, agentResponse);

      const captionText = caption ? `🖼️ ${caption}\n\n` : '';
      await sendLongMessage(ctx, `${captionText}${agentResponse}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`Image processing error: ${msg}`);
    } finally {
      stopTyping();
    }
  });

  // Handle regular text messages
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    const chatId = ctx.chat?.id;
    if (!text || !chatId) return;

    // Skip if this looks like a command we didn't catch
    if (text.startsWith('/') && text.length > 1) {
      const cmdName = text.slice(1).split(/\s|@/)[0].toLowerCase();
      if (!['start', 'help', ...BOT_COMMANDS.map(c => c.command)].includes(cmdName)) {
        return;
      }
    }

    const stopTyping = startTypingIndicator(ctx);
    try {
      const history = await getHistory(chatId);
      const response = await runAgentTurn(
        cfg.agents.default,
        text,
        cfg,
        getCurrentModel(),
        getDefaultTelegramToolConfig(cfg),
        history,
        getRunContext(ctx)
      );
      await addToHistory(chatId, text, response);
      await sendLongMessage(ctx, response);
    } catch (error) {
      console.error('[telegram] Error:', error);
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
      console.error('[telegram] Grammy error:', e.description);
    } else if (e instanceof HttpError) {
      console.error('[telegram] HTTP error:', e);
    } else {
      console.error('[telegram] Unknown error:', e);
    }
  });

  runnerHandle = run(bot);
  console.log('[telegram] Bot started');
  return bot;
}
