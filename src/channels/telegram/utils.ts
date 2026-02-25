// Telegram Utilities

import type { Context } from 'grammy';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Config, ChatMessage, ToolConfig, AgentRunContext } from '../../types.js';
import type { SkillConfig } from '../../skills-types.js';
import { state, MAX_HISTORY_PAIRS, BOT_COMMANDS, type MemoryFileInfo } from './types.js';
import * as sessions from '../../sessions.js';

/** Keep sending "typing..." every 4s until the returned stop function is called. */
export function startTypingIndicator(ctx: Context): () => void {
  const maxDurationMs = 90_000;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    clearTimeout(watchdog);
  };

  // Send one action immediately, then keep alive every 4s while work is in progress.
  void ctx.replyWithChatAction('typing').catch(() => {});
  const interval = setInterval(() => {
    if (stopped) return;
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);
  const watchdog = setTimeout(() => {
    console.warn('[telegram] Typing indicator watchdog reached; auto-stopping.');
    stop();
  }, maxDurationMs);
  return stop;
}

/** Build the help text from BOT_COMMANDS. */
export function buildHelpText(cfg: Config): string {
  const agentConfig = cfg.agents.list[cfg.agents.default];
  const emoji = agentConfig?.identity?.emoji || '🦞';
  const name = agentConfig?.identity?.name || 'SkimpyClaw';

  const commandList = BOT_COMMANDS.map(
    (c) => `/${c.command} — ${c.description}`
  ).join('\n');

  return `${emoji} ${name} online.\n\nSend a message to chat, or use a command:\n\n${commandList}`;
}

/** Get recent memory files (sorted newest first). */
export function getRecentMemoryFiles(count: number = 5): MemoryFileInfo[] {
  const memoryDir = join(homedir(), '.skimpyclaw', 'agents', 'main', 'memory', 'logs');

  if (!existsSync(memoryDir)) {
    return [];
  }

  return readdirSync(memoryDir)
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
}

/** Conversation history per chat — last N user/assistant message pairs */
export async function getHistory(chatId: number): Promise<ChatMessage[]> {
  // Lazy-load from disk on first access this session
  if (!state.loadedFromDisk.has(chatId)) {
    state.loadedFromDisk.add(chatId);
    const diskHistory = await sessions.loadHistory('telegram', chatId).catch(() => []);
    if (diskHistory.length > 0 && !state.chatHistory.has(chatId)) {
      state.chatHistory.set(chatId, diskHistory);
    }
  }
  return state.chatHistory.get(chatId) || [];
}

export async function addToHistory(
  chatId: number,
  userMsg: string,
  assistantMsg: string
): Promise<void> {
  const history = await getHistory(chatId);
  history.push({ role: 'user', content: userMsg });
  history.push({ role: 'assistant', content: assistantMsg });
  // Keep only last N pairs (2 messages per pair)
  while (history.length > MAX_HISTORY_PAIRS * 2) {
    history.shift();
    history.shift();
  }
  state.chatHistory.set(chatId, history);
  // Persist to disk (fire-and-forget)
  sessions.saveExchange('telegram', chatId, userMsg, assistantMsg).catch(() => {});
}

export async function clearHistory(chatId: number): Promise<void> {
  state.chatHistory.delete(chatId);
  state.loadedFromDisk.delete(chatId);
  await sessions.clearHistory('telegram', chatId).catch(() => {});
}

export function getRunContext(ctx: Context): AgentRunContext {
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

// Default tool config for Telegram — gives the agent file/bash access
export function getDefaultTelegramToolConfig(cfg: Config): ToolConfig | undefined {
  if (cfg.channels.telegram.tools) {
    return cfg.channels.telegram.tools;
  }

  if (cfg.channels.telegram.defaultAllowedPaths?.length) {
    return {
      enabled: true,
      allowedPaths: cfg.channels.telegram.defaultAllowedPaths,
      maxIterations: 100,
      bashTimeout: 15000,
    };
  }

  return {
    enabled: true,
    allowedPaths: [join(homedir(), '.skimpyclaw')],
    maxIterations: 30,
    bashTimeout: 15000,
  };
}

/** Get Telegram default chat ID from config */
export function getTelegramDefaultChatId(cfg: Config): number | null {
  const allowFrom = cfg.channels.telegram.allowFrom;
  if (!allowFrom || allowFrom.length === 0) return null;

  // Prefer the first numeric ID anywhere in allowFrom. Usernames (e.g. "@name")
  // are not valid proactive chat targets.
  for (const entry of allowFrom) {
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
    if (typeof entry === 'string' && /^\d+$/.test(entry)) {
      const parsed = Number(entry);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/** Send a long message by splitting it into chunks */
export async function sendLongMessage(ctx: Context, text: string): Promise<void> {
  const MAX_LENGTH = 4000;
  
  if (text.length <= MAX_LENGTH) {
    await ctx.reply(text);
    return;
  }

  // Split into chunks at newline boundaries when possible
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_LENGTH) {
    let chunk = remaining.slice(0, MAX_LENGTH);
    const lastNewline = chunk.lastIndexOf('\n');
    
    if (lastNewline > MAX_LENGTH * 0.8) {
      // Split at newline if it's in the last 20%
      chunk = chunk.slice(0, lastNewline);
    }
    
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  
  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

/** Send a long message with HTML formatting */
export async function sendLongMessageHtml(ctx: Context, html: string): Promise<void> {
  const MAX_LENGTH = 3500;
  
  if (html.length <= MAX_LENGTH) {
    await ctx.reply(html, { parse_mode: 'HTML' });
    return;
  }

  // Split into chunks
  const chunks: string[] = [];
  let remaining = html;

  while (remaining.length > MAX_LENGTH) {
    let chunk = remaining.slice(0, MAX_LENGTH);
    const lastNewline = chunk.lastIndexOf('\n');
    
    if (lastNewline > MAX_LENGTH * 0.8) {
      chunk = chunk.slice(0, lastNewline);
    }
    
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  
  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk, { parse_mode: 'HTML' });
  }
}

/** Escape HTML special characters */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Convert markdown to Telegram HTML */
export function markdownToTelegramHtml(md: string): string {
  const lines = md.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeLines: string[] = [];

  for (const line of lines) {
    // Code block toggle
    if (line.trimStart().startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.trimStart().slice(3).trim();
        codeLines = [];
        continue;
      } else {
        // Close code block
        inCodeBlock = false;
        const code = escapeHtml(codeLines.join('\n'));
        if (codeBlockLang) {
          result.push(`<pre><code class="language-${escapeHtml(codeBlockLang)}">${code}</code></pre>`);
        } else {
          result.push(`<pre>${code}</pre>`);
        }
        continue;
      }
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Inline code
    let processed = line.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    processed = processed.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

    // Italic
    processed = processed.replace(/\*([^*]+)\*/g, '<i>$1</i>');

    // Strikethrough
    processed = processed.replace(/~~([^~]+)~~/g, '<s>$1</s>');

    // Links [text](url)
    processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    result.push(processed);
  }

  // Handle unclosed code block
  if (inCodeBlock && codeLines.length > 0) {
    const code = escapeHtml(codeLines.join('\n'));
    if (codeBlockLang) {
      result.push(`<pre><code class="language-${escapeHtml(codeBlockLang)}">${code}</code></pre>`);
    } else {
      result.push(`<pre>${code}</pre>`);
    }
  }

  return result.join('\n');
}
