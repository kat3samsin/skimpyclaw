/**
 * Discord thread management for coding agent task updates.
 *
 * Creates threads from triggering messages and routes status updates
 * to those threads instead of the main channel.
 */

import { ChannelType, type Client, type Message, type ThreadChannel } from 'discord.js';
import { splitToChunks } from './utils.js';

// taskId → threadId mapping (in-memory, resets on restart)
const taskThreads = new Map<string, string>();

// Regex to detect "Started coding agent ca-N" or "Started coding team ca-N"
const STARTED_AGENT_RE = /Started coding (?:agent|team) (ca-\d+)/;

/**
 * Detect if a response contains a coding agent start message.
 * Returns the task ID if found, null otherwise.
 */
export function detectCodeAgentStart(response: string): string | null {
  const match = response.match(STARTED_AGENT_RE);
  return match ? match[1] : null;
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
    if (message.channel.isDMBased()) return null;
    if (!('threads' in message.channel)) return null;

    const threadName = `${taskId}: ${taskPreview.slice(0, 90)}`;
    const thread = await message.startThread({
      name: threadName,
      autoArchiveDuration: 1440, // 24 hours
    });

    taskThreads.set(taskId, thread.id);
    console.log(`[discord] Created thread ${thread.id} for task ${taskId}`);
    return thread.id;
  } catch (err) {
    console.error(`[discord] Failed to create thread for ${taskId}:`, err);
    return null;
  }
}

/**
 * Register an existing thread for a task (e.g. restored from disk).
 */
export function registerTaskThread(taskId: string, threadId: string): void {
  taskThreads.set(taskId, threadId);
}

/**
 * Get the thread ID for a task, if one exists.
 */
export function getTaskThreadId(taskId: string): string | undefined {
  return taskThreads.get(taskId);
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
    const thread = await client.channels.fetch(threadId).catch(() => null);
    if (!thread) {
      console.warn(`[discord] Channel/thread ${threadId} not found`);
      return false;
    }

    // Accept threads and text-based channels (GuildText, PublicThread, PrivateThread)
    if (!('send' in thread) || typeof (thread as any).send !== 'function') {
      console.warn(`[discord] Channel ${threadId} is not sendable (type=${thread.type})`);
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
    const thread = await client.channels.fetch(threadId).catch(() => null);
    if (!thread) {
      console.warn(`[discord] Channel/thread ${threadId} not found`);
      return false;
    }

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

/**
 * Clean up thread mapping for a task (e.g. after completion).
 * We keep the mapping around for a while since late notifications may arrive.
 */
export function clearTaskThread(taskId: string): void {
  // Delay cleanup by 5 minutes to catch late notifications
  setTimeout(() => {
    taskThreads.delete(taskId);
  }, 5 * 60 * 1000);
}

/** Export for testing. */
export function _getTaskThreadsMap(): Map<string, string> {
  return taskThreads;
}
