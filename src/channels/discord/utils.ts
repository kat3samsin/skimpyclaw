import { join } from 'path';
import { homedir } from 'os';
import type { Message } from 'discord.js';
import type { AgentRunContext, ChatMessage, Config, ToolConfig } from '../../types.js';
import { resolveAllowedPaths } from '../../config.js';
import * as sessions from '../../sessions.js';
import { BOT_COMMANDS, MAX_HISTORY_PAIRS } from './types.js';

// ── State ───────────────────────────────────────────────────────────

const chatHistory = new Map<string, ChatMessage[]>();
const loadedFromDisk = new Set<string>();

// ── History ─────────────────────────────────────────────────────────

export async function getHistory(key: string): Promise<ChatMessage[]> {
  if (!loadedFromDisk.has(key)) {
    loadedFromDisk.add(key);
    const diskHistory = await sessions.loadHistory('discord', key).catch(() => []);
    if (diskHistory.length > 0 && !chatHistory.has(key)) {
      chatHistory.set(key, diskHistory);
    }
  }
  return chatHistory.get(key) || [];
}

export async function addToHistory(key: string, userMsg: string, assistantMsg: string): Promise<void> {
  const history = await getHistory(key);
  history.push({ role: 'user', content: userMsg });
  history.push({ role: 'assistant', content: assistantMsg });
  while (history.length > MAX_HISTORY_PAIRS * 2) {
    history.shift();
    history.shift();
  }
  chatHistory.set(key, history);
  sessions.saveExchange('discord', key, userMsg, assistantMsg).catch(() => {});
}

export async function clearHistory(key: string): Promise<void> {
  chatHistory.delete(key);
  loadedFromDisk.delete(key);
  await sessions.clearHistory('discord', key).catch(() => {});
}

/** Replace history with a compact summary (used by /compact). */
export function replaceHistory(key: string, summary: string): void {
  chatHistory.set(key, [
    { role: 'user', content: 'Summary of our previous conversation:' },
    { role: 'assistant', content: summary },
  ]);
  loadedFromDisk.add(key);
}

// ── Tool config ─────────────────────────────────────────────────────

export function getDiscordToolConfig(cfg: Config): ToolConfig {
  const discord = cfg.channels.discord;
  if (discord?.tools) {
    return {
      ...discord.tools,
      allowedPaths: discord.tools.allowedPaths?.length
        ? discord.tools.allowedPaths
        : resolveAllowedPaths(cfg),
    };
  }

  return {
    enabled: true,
    allowedPaths: resolveAllowedPaths(cfg),
    maxIterations: 100,
    bashTimeout: 15000,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

export function conversationKey(message: Message): string {
  if (message.channel.isDMBased()) {
    return `dm:${message.author.id}`;
  }
  return `channel:${message.channelId}`;
}

export function getDiscordRunContext(message: Message): AgentRunContext {
  const isDm = message.channel.isDMBased();
  const isThread = !isDm && message.channel.isThread();
  return {
    userId: message.author.id,
    sessionId: message.channel.id,
    channel: 'discord',
    trigger: 'discord',
    metadata: {
      username: message.author.username,
      isDm,
      // When message originates from a thread, pass thread context so
      // spawned coding agents can route notifications back to the thread
      ...(isThread ? {
        discordThreadId: message.channel.id,
        discordChannelId: message.channel.parentId ?? message.channelId,
      } : {}),
    },
  };
}

export function buildHelpText(cfg: Config): string {
  const agentConfig = cfg.agents.list[cfg.agents.default];
  const emoji = agentConfig?.identity?.emoji || '🦞';
  const name = agentConfig?.identity?.name || 'SkimpyClaw';
  const commandList = BOT_COMMANDS.map(c => `/${c.command} - ${c.description}`).join('\n');
  return `${emoji} ${name} online.\n\nSend a message to chat, or use a command:\n\n${commandList}`;
}

export function splitToChunks(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let current = '';

  for (const paragraph of text.split('\n\n')) {
    if (current.length + paragraph.length + 2 > maxLength) {
      if (current) chunks.push(current.trim());
      if (paragraph.length > maxLength) {
        const lines = paragraph.split('\n');
        let lineBuf = '';
        for (const line of lines) {
          if (lineBuf.length + line.length + 1 > maxLength) {
            if (lineBuf) chunks.push(lineBuf.trim());
            if (line.length > maxLength) {
              for (let i = 0; i < line.length; i += maxLength) {
                chunks.push(line.slice(i, i + maxLength));
              }
              lineBuf = '';
            } else {
              lineBuf = line;
            }
          } else {
            lineBuf += (lineBuf ? '\n' : '') + line;
          }
        }
        current = lineBuf;
      } else {
        current = paragraph;
      }
    } else {
      current += (current ? '\n\n' : '') + paragraph;
    }
  }
  if (current) chunks.push(current.trim());

  return chunks.filter(c => c.length > 0);
}

/**
 * Reply to a message, falling back to channel.send() if reply fails
 * (e.g. Discord rejects replies to system/voice messages).
 */
export async function safeReply(message: Message, content: string | { files: unknown[]; content?: string }): Promise<void> {
  try {
    await message.reply(content as string);
  } catch {
    // Fallback: send to the channel without a reply reference
    const channel = message.channel as { send?: (c: unknown) => Promise<unknown> };
    if (typeof channel.send === 'function') {
      await channel.send(content);
    }
  }
}

export async function sendLongText(message: Message, text: string): Promise<void> {
  if (!text || text.trim().length === 0) {
    await safeReply(message, '(No response generated.)');
    return;
  }
  const chunks = splitToChunks(text, 1900);
  for (const chunk of chunks) {
    await safeReply(message, chunk);
  }
}

export function startTypingIndicator(message: Message): () => void {
  const maxDurationMs = 90_000;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    clearTimeout(watchdog);
  };

  const channel = message.channel as { sendTyping?: () => Promise<unknown> };
  if (typeof channel.sendTyping === 'function') {
    void channel.sendTyping().catch(() => {});
  }

  const interval = setInterval(() => {
    if (stopped) return;
    if (typeof channel.sendTyping === 'function') {
      void channel.sendTyping().catch(() => {});
    }
  }, 4000);
  const watchdog = setTimeout(() => {
    console.warn('[discord] Typing indicator watchdog reached; auto-stopping.');
    stop();
  }, maxDurationMs);
  return stop;
}
