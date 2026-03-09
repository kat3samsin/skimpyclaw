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
    if (!thread || thread.type !== ChannelType.PublicThread) {
      console.warn(`[discord] Thread ${threadId} not found or not a public thread`);
      return false;
    }

    const chunks = splitToChunks(text, 1900);
    for (const chunk of chunks) {
      await (thread as ThreadChannel).send(chunk);
    }
    return true;
  } catch (err) {
    console.error(`[discord] Failed to send to thread ${threadId}:`, err);
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
