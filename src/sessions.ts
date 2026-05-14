// Persistent conversation history — encrypted JSONL per chat
// Storage: ~/.skimpyclaw/sessions/{platform}-{chatId}.jsonl

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
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { getSecureValue, setSecureValue } from './secure-store.js';
import { redactSecretText } from './security.js';
import type { ChatMessage } from './types.js';

let SESSIONS_DIR = join(homedir(), '.skimpyclaw', 'sessions');
export const MAX_HISTORY_PAIRS = 5;
export const MAX_SESSION_TEXT_CHARS = 50_000;

const ENCRYPTED_PREFIX = 'ENCv1:';
const SESSION_KEY_SERVICE = 'skimpyclaw-history';
const SESSION_KEY_ACCOUNT = 'session-key-v1';
const SESSION_KEY_ENV = 'SKIMPYCLAW_HISTORY_KEY';
let sessionKeyCache: Buffer | null = null;
let warnedUnavailable = false;

/** Reset session key cache between tests to prevent cross-test leakage. */
export function clearSessionKeyCacheForTests(): void {
  sessionKeyCache = null;
  warnedUnavailable = false;
}

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

function truncateSessionText(value: string): string {
  const redacted = redactSecretText(value);
  if (redacted.length <= MAX_SESSION_TEXT_CHARS) return redacted;
  return `${redacted.slice(0, MAX_SESSION_TEXT_CHARS)}\n[truncated ${redacted.length - MAX_SESSION_TEXT_CHARS} chars]`;
}

function sessionPath(platform: string, chatId: string | number): string {
  return join(SESSIONS_DIR, `${platform}-${chatId}.jsonl`);
}

function ensureDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function deriveKeyFromEnv(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  const base64 = Buffer.from(trimmed, 'base64');
  if (base64.length === 32) {
    return base64;
  }

  return createHash('sha256').update(trimmed).digest();
}

function getSessionKey(): Buffer {
  if (sessionKeyCache) {
    return sessionKeyCache;
  }

  const envKey = process.env[SESSION_KEY_ENV];
  if (envKey) {
    sessionKeyCache = deriveKeyFromEnv(envKey);
    return sessionKeyCache;
  }

  if (process.platform !== 'darwin') {
    throw new Error(
      `[sessions] Encrypted history requires macOS Keychain or ${SESSION_KEY_ENV} on non-macOS environments.`,
    );
  }

  const existing = getSecureValue(SESSION_KEY_SERVICE, SESSION_KEY_ACCOUNT);
  if (existing) {
    sessionKeyCache = deriveKeyFromEnv(existing);
    return sessionKeyCache;
  }

  const generated = randomBytes(32).toString('base64');
  setSecureValue(SESSION_KEY_SERVICE, SESSION_KEY_ACCOUNT, generated);
  sessionKeyCache = Buffer.from(generated, 'base64');
  return sessionKeyCache;
}

function encryptEntry(entry: SessionEntry): string {
  const key = getSessionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(entry), 'utf-8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, ciphertext]).toString('base64');
  return `${ENCRYPTED_PREFIX}${payload}`;
}

function decryptEntry(line: string): SessionEntry {
  const key = getSessionKey();
  const payload = Buffer.from(line.slice(ENCRYPTED_PREFIX.length), 'base64');
  if (payload.length < 29) {
    throw new Error('Encrypted session entry payload is invalid');
  }

  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
  return JSON.parse(plaintext) as SessionEntry;
}

function parseLine(line: string): { entry: SessionEntry | null; wasPlaintext: boolean } {
  if (!line) return { entry: null, wasPlaintext: false };

  try {
    if (line.startsWith(ENCRYPTED_PREFIX)) {
      return { entry: decryptEntry(line), wasPlaintext: false };
    }
    return { entry: JSON.parse(line) as SessionEntry, wasPlaintext: true };
  } catch {
    return { entry: null, wasPlaintext: false };
  }
}

function canEncrypt(): boolean {
  try {
    getSessionKey();
    return true;
  } catch (err) {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.error('[sessions] Encryption unavailable:', err instanceof Error ? err.message : String(err));
    }
    return false;
  }
}

function migratePlaintextFile(filePath: string, entries: SessionEntry[]): void {
  if (!entries.length || !canEncrypt()) return;

  try {
    const encryptedLines = entries.map(entry => encryptEntry(entry));
    writeFileSync(filePath, encryptedLines.join('\n') + '\n', 'utf-8');
    console.log(`[sessions] Migrated plaintext history to encrypted format: ${filePath}`);
  } catch (err) {
    console.error('[sessions] Failed to migrate session file:', err);
  }
}

function appendEncryptedEntry(filePath: string, entry: SessionEntry): void {
  if (!canEncrypt()) {
    throw new Error('Encrypted session storage is unavailable. Configure macOS Keychain access or SKIMPYCLAW_HISTORY_KEY.');
  }

  appendFileSync(filePath, encryptEntry(entry) + '\n', 'utf-8');
}

export function readSessionEntriesFromFile(filePath: string): SessionEntry[] {
  if (!existsSync(filePath)) return [];

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const entries: SessionEntry[] = [];
    let foundPlaintext = false;

    for (const line of lines) {
      const parsed = parseLine(line);
      if (parsed.entry) {
        entries.push(parsed.entry);
        if (parsed.wasPlaintext) foundPlaintext = true;
      }
    }

    if (foundPlaintext) {
      migratePlaintextFile(filePath, entries);
    }

    return entries;
  } catch {
    return [];
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
    const entries = readSessionEntriesFromFile(filePath);

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
      user: truncateSessionText(userMsg),
      assistant: truncateSessionText(assistantMsg),
    };
    appendEncryptedEntry(filePath, entry);
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
      user: truncateSessionText(message),
      proactive: true,
    };
    appendEncryptedEntry(filePath, entry);
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
      assistant: truncateSessionText(summary),
      summary: true,
    };

    if (!canEncrypt()) {
      throw new Error('Encrypted session storage is unavailable. Configure macOS Keychain access or SKIMPYCLAW_HISTORY_KEY.');
    }

    writeFileSync(filePath, encryptEntry(entry) + '\n', 'utf-8');
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
