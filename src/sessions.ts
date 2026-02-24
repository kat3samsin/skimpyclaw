// Persistent conversation history — append-only JSONL per chat
// Storage: ~/.skimpyclaw/sessions/{platform}-{chatId}.jsonl
// Each line: {"ts":"...","user":"...","assistant":"..."}

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ChatMessage } from './types.js';

let SESSIONS_DIR = join(homedir(), '.skimpyclaw', 'sessions');
export const MAX_HISTORY_PAIRS = 5;

/** Override sessions directory. Used in tests. */
export function setSessionsDir(dir: string): void {
  SESSIONS_DIR = dir;
}

export interface SessionEntry {
  ts: string;
  user?: string;
  assistant?: string;
  summary?: true;
  proactive?: true;
}

function sessionPath(platform: string, chatId: string | number): string {
  return join(SESSIONS_DIR, `${platform}-${chatId}.jsonl`);
}

function ensureDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

/**
 * Load last MAX_HISTORY_PAIRS exchanges from disk.
 * Returns [] if file doesn't exist.
 */
export async function loadHistory(
  platform: string,
  chatId: string | number
): Promise<ChatMessage[]> {
  const filePath = sessionPath(platform, chatId);
  if (!existsSync(filePath)) return [];

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    // Parse all valid lines
    const entries: SessionEntry[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as SessionEntry;
        entries.push(entry);
      } catch {
        // Skip malformed lines
      }
    }

    // Take last MAX_HISTORY_PAIRS entries
    const usable = entries.filter((entry) => {
      if (entry.summary) return typeof entry.assistant === 'string';
      return typeof entry.user === 'string' && typeof entry.assistant === 'string';
    });
    const recent = usable.slice(-MAX_HISTORY_PAIRS);

    // Convert to ChatMessage pairs
    const messages: ChatMessage[] = [];
    for (const entry of recent) {
      if (entry.summary) {
        const assistantContent = entry.assistant || '';
        messages.push({ role: 'user', content: 'Summary of our previous conversation:' });
        messages.push({ role: 'assistant', content: assistantContent });
      } else {
        const userContent = entry.user || '';
        const assistantContent = entry.assistant || '';
        messages.push({ role: 'user', content: userContent });
        messages.push({ role: 'assistant', content: assistantContent });
      }
    }
    return messages;
  } catch {
    return [];
  }
}

/**
 * Append one exchange to the session file.
 * Fire-and-forget safe — errors are logged and swallowed.
 */
export async function saveExchange(
  platform: string,
  chatId: string | number,
  userMsg: string,
  assistantMsg: string
): Promise<void> {
  try {
    ensureDir();
    const filePath = sessionPath(platform, chatId);
    const entry: SessionEntry = {
      ts: new Date().toISOString(),
      user: userMsg,
      assistant: assistantMsg,
    };
    appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    console.error('[sessions] Failed to save exchange:', err);
  }
}

/**
 * Append one proactive outbound message to the session file.
 * This is used by dashboard "messages/send" for audit visibility.
 */
export async function saveProactiveMessage(
  platform: string,
  chatId: string | number,
  message: string
): Promise<void> {
  try {
    ensureDir();
    const filePath = sessionPath(platform, chatId);
    const entry: SessionEntry = {
      ts: new Date().toISOString(),
      user: message,
      proactive: true,
    };
    appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    console.error('[sessions] Failed to save proactive message:', err);
  }
}

/**
 * Rewrite the session file with a single summary entry.
 * Used by /compact.
 */
export async function replaceWithSummary(
  platform: string,
  chatId: string | number,
  summary: string
): Promise<void> {
  try {
    ensureDir();
    const filePath = sessionPath(platform, chatId);
    const entry: SessionEntry = {
      ts: new Date().toISOString(),
      user: 'Summary of our previous conversation:',
      assistant: summary,
      summary: true,
    };
    writeFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    console.error('[sessions] Failed to replace with summary:', err);
  }
}

/**
 * Delete the session file. Used by /clear.
 */
export async function clearHistory(
  platform: string,
  chatId: string | number
): Promise<void> {
  try {
    const filePath = sessionPath(platform, chatId);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch (err) {
    console.error('[sessions] Failed to clear history:', err);
  }
}
