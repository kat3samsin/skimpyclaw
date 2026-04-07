import {
  Client,
  GatewayIntentBits,
  Partials,
  AttachmentBuilder,
  type Message,
  type Interaction,
} from 'discord.js';
import type { Config } from '../../types.js';
import { onApprovalEvent } from '../../exec-approval.js';
import { KNOWN_COMMANDS } from './types.js';
import { handleCommand, handleIncomingMessage, handleInteraction, sendApprovalCard } from './handlers.js';
import { splitToChunks, conversationKey } from './utils.js';
import { sendToThread, sendToThreadWithVoice } from './threads.js';

let client: Client | null = null;
let config: Config;
let silenceUntil: Date | null = null;

export async function initDiscord(cfg: Config): Promise<boolean> {
  const discord = cfg.channels.discord;
  if (!discord?.enabled || !discord.token) {
    console.log('[discord] Disabled or no token configured');
    return false;
  }

  config = cfg;
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  client.on('messageCreate', (message: Message) => {
    if (message.author.bot) return;

    void (async () => {
      const text = message.content.trim();
      const isPrefixedCommand = text.startsWith('/') || text.startsWith('!');
      const isDm = message.channel.isDMBased();

      // Route commands through handleCommand with silenceUntil access
      if (isPrefixedCommand || isDm) {
        const commandText = isPrefixedCommand ? text.slice(1).trim() : text;
        const [commandPart, ...args] = commandText.split(/\s+/);
        const command = (commandPart || '').toLowerCase();
        if (KNOWN_COMMANDS.has(command)) {
          await handleCommand(message, command, args, config, silenceUntil, (d) => { silenceUntil = d; });
          return;
        }
        if (isPrefixedCommand) {
          await message.reply(`Unknown command: /${command}\n\nType /help to see available commands.`);
          return;
        }
      }

      // Non-command messages
      await handleIncomingMessage(message, config);
    })();
  });

  client.on('interactionCreate', (interaction: Interaction) => {
    void handleInteraction(interaction);
  });

  client.once('clientReady', () => {
    console.log(`[discord] Bot started as ${client?.user?.tag ?? 'unknown'}`);
  });

  client.on('error', (error: unknown) => {
    console.error('[discord] Client error:', error);
  });

  // Subscribe to approval-created events
  onApprovalEvent('created', (event) => {
    if (!client) return;
    const { approval } = event;
    const meta = approval.channelMeta;

    if (meta?.channel && meta.channel !== 'discord') return;

    let targetChannelId: string | undefined;
    if (meta?.chatId) {
      targetChannelId = String(meta.chatId);
    }
    if (!targetChannelId) {
      targetChannelId = getDiscordDefaultTarget(cfg) ?? undefined;
    }
    if (!targetChannelId) return;

    void sendApprovalCard(client!, targetChannelId, approval).catch((err) => {
      console.error('[discord] Failed to send approval notification:', err);
    });
  });

  return true;
}

export async function startDiscord(): Promise<void> {
  if (!client || !config.channels.discord?.token) return;
  console.log('[discord] Starting bot...');
  await client.login(config.channels.discord.token);
}

export async function stopDiscord(): Promise<void> {
  if (!client) return;
  client.destroy();
  console.log('[discord] Bot stopped');
}

export function isDiscordSilenced(): boolean {
  if (!silenceUntil) return false;
  return new Date() < silenceUntil;
}

export function getDiscordDefaultTarget(cfg: Config): string | null {
  const discord = cfg.channels.discord;
  if (!discord) return null;
  if (discord.defaultChannelId?.trim()) return discord.defaultChannelId.trim();

  for (const entry of discord.allowFrom) {
    const value = String(entry).trim();
    if (value) return value;
  }
  return null;
}

async function sendChunked(target: { send: (content: string) => Promise<unknown> }, text: string): Promise<void> {
  if (!text || !text.trim()) return;
  const chunks = splitToChunks(text, 1900);
  for (const chunk of chunks) {
    await target.send(chunk);
  }
}

export async function sendDiscordProactiveMessage(target: string | number, message: string): Promise<void> {
  if (!client || isDiscordSilenced()) return;

  const targetId = String(target);
  const channel = await client.channels.fetch(targetId).catch(() => null);
  if (channel && 'send' in channel && typeof channel.send === 'function') {
    await sendChunked(channel as { send: (content: string) => Promise<unknown> }, message);
    return;
  }

  const user = await client.users.fetch(targetId).catch(() => null);
  if (user) {
    await sendChunked(user as { send: (content: string) => Promise<unknown> }, message);
  }
}

export async function sendDiscordProactiveVoice(target: string | number, buffer: Uint8Array, format: string): Promise<void> {
  if (!client || isDiscordSilenced()) return;

  const targetId = String(target);
  const attachment = new AttachmentBuilder(Buffer.from(buffer), {
    name: `voice.${format}`,
    description: 'Voice message',
  });

  const channel = await client.channels.fetch(targetId).catch(() => null);
  if (channel && 'send' in channel && typeof channel.send === 'function') {
    await (channel as { send: (opts: unknown) => Promise<unknown> }).send({ files: [attachment] });
    return;
  }

  const user = await client.users.fetch(targetId).catch(() => null);
  if (user) {
    await user.send({ files: [attachment] });
  }
}

/**
 * Send a message to a Discord thread by ID.
 * Used by code-agent notifications to route updates to task-specific threads.
 * Returns true if sent successfully, false if client unavailable or thread not found.
 */
export async function sendToDiscordThread(threadId: string, message: string): Promise<boolean> {
  if (!client) return false;
  return sendToThread(client, threadId, message);
}

/**
 * Send a message with optional voice attachment to a Discord thread by ID.
 * Used by cron jobs to route both text and voice output to the same thread.
 * Returns true if sent successfully, false if client unavailable or thread not found.
 */
export async function sendToDiscordThreadWithVoice(
  threadId: string,
  message: string,
  voiceBuffer?: Uint8Array,
  voiceFormat?: string,
): Promise<boolean> {
  if (!client) return false;
  return sendToThreadWithVoice(client, threadId, message, voiceBuffer, voiceFormat);
}
