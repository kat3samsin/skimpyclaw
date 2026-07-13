/**
 * Discord thread management for coding agent task updates.
 *
 * Creates threads from triggering messages and routes status updates
 * to those threads instead of the main channel.
 */

import type { Client, Message } from 'discord.js';
import { splitToChunks } from './utils.js';

export interface DiscordTextAttachment {
  name: string;
  content: string;
  description?: string;
}

/**
 * Create a thread from the user's message for a coding agent task.
 * Returns the thread ID, or null if thread creation fails.
 */
export async function createTaskThread(
  message: Message,
  taskId: string,
  taskPreview: string,
): Promise<string | null> {
  try {
    // Only text channels in guilds support threads
    if (message.channel.isDMBased()) {
      console.warn(`[discord] Skipping thread for ${taskId}: DM channel does not support threads`);
      return null;
    }
    if (!('threads' in message.channel)) {
      console.warn(`[discord] Skipping thread for ${taskId}: channel type ${message.channel.type} does not support threads`);
      return null;
    }

    const threadName = `${taskId}: ${taskPreview.slice(0, 90)}`;
    const thread = await message.startThread({
      name: threadName,
      autoArchiveDuration: 1440, // 24 hours
    });

    console.log(`[discord] Created thread ${thread.id} for task ${taskId}`);
    return thread.id;
  } catch (err) {
    console.error(`[discord] Failed to create thread for ${taskId}:`, err);
    return null;
  }
}

/**
 * Build a user-facing Discord URL for a thread, suitable for posting as a clickable link.
 * Returns undefined if we can't construct one (e.g. missing guild context).
 */
export function buildThreadUrl(guildId: string | null | undefined, threadId: string): string | undefined {
  if (!guildId) return undefined;
  return `https://discord.com/channels/${guildId}/${threadId}`;
}

async function fetchDiscordChannel(client: Client, channelId: string) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      console.warn(`[discord] Channel/thread ${channelId} not found`);
    }
    return channel;
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? (err as { code?: unknown }).code
      : undefined;
    if (code === 10003) {
      console.warn(`[discord] Channel/thread ${channelId} not found`);
    } else {
      console.error(`[discord] Failed to fetch channel/thread ${channelId}:`, err);
    }
    return null;
  }
}

/**
 * Send a message to a Discord thread. Handles chunking for long messages.
 * Returns true if sent successfully.
 */
export async function sendToThread(
  client: Client,
  threadId: string,
  text: string,
): Promise<boolean> {
  try {
    const thread = await fetchDiscordChannel(client, threadId);
    if (!thread) return false;

    // Accept threads and text-based channels (GuildText, PublicThread, PrivateThread)
    if (!('send' in thread) || typeof (thread as any).send !== 'function') {
      console.warn(`[discord] Channel ${threadId} is not sendable (type=${thread.type})`);
      return false;
    }

    if (!text || !text.trim()) {
      console.warn(`[discord] Skipping send to thread ${threadId}: message content is empty`);
      return false;
    }
    const chunks = splitToChunks(text, 1900);
    for (const chunk of chunks) {
      await (thread as any).send(chunk);
    }
    return true;
  } catch (err) {
    console.error(`[discord] Failed to send to thread ${threadId}:`, err);
    return false;
  }
}

/**
 * Send text plus one or more UTF-8 attachments to a Discord thread.
 * Keeps the visible message compact while preserving full reports.
 */
export async function sendToThreadWithAttachments(
  client: Client,
  threadId: string,
  text: string,
  attachments: DiscordTextAttachment[] = [],
): Promise<boolean> {
  try {
    const thread = await fetchDiscordChannel(client, threadId);
    if (!thread) return false;

    if (!('send' in thread) || typeof (thread as any).send !== 'function') {
      console.warn(`[discord] Channel ${threadId} is not sendable (type=${thread.type})`);
      return false;
    }

    const chunks = splitToChunks(text || '(No summary generated.)', 1900);
    const { AttachmentBuilder } = await import('discord.js');
    const files = attachments
      .filter(file => file.content.trim())
      .map(file => new AttachmentBuilder(Buffer.from(file.content, 'utf-8'), {
        name: file.name,
        description: file.description,
      }));

    await (thread as any).send({ content: chunks[0], files });
    for (let i = 1; i < chunks.length; i++) {
      await (thread as any).send(chunks[i]);
    }
    return true;
  } catch (err) {
    console.error(`[discord] Failed to send attachments to thread ${threadId}:`, err);
    return false;
  }
}

/**
 * Send a message with optional voice attachment to a Discord thread.
 * Handles chunking for long text messages.
 * Returns true if sent successfully.
 */
export async function sendToThreadWithVoice(
  client: Client,
  threadId: string,
  text: string,
  voiceBuffer?: Uint8Array,
  voiceFormat?: string,
): Promise<boolean> {
  try {
    const thread = await fetchDiscordChannel(client, threadId);
    if (!thread) return false;

    if (!('send' in thread) || typeof (thread as any).send !== 'function') {
      console.warn(`[discord] Channel ${threadId} is not sendable (type=${thread.type})`);
      return false;
    }

    // Import AttachmentBuilder dynamically to avoid circular deps
    const { AttachmentBuilder } = await import('discord.js');

    const chunks = splitToChunks(text, 1900);

    // Send voice with first chunk if provided
    if (voiceBuffer && voiceFormat) {
      const attachment = new AttachmentBuilder(Buffer.from(voiceBuffer), {
        name: `voice.${voiceFormat}`,
        description: 'Voice message',
      });
      await (thread as any).send({ content: chunks[0], files: [attachment] });
      // Send remaining chunks as text-only
      for (let i = 1; i < chunks.length; i++) {
        await (thread as any).send(chunks[i]);
      }
    } else {
      // No voice - send all chunks as text
      for (const chunk of chunks) {
        await (thread as any).send(chunk);
      }
    }

    return true;
  } catch (err) {
    console.error(`[discord] Failed to send to thread ${threadId} with voice:`, err);
    return false;
  }
}
