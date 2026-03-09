import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadHistory,
  saveExchange,
  replaceWithSummary,
  clearHistory,
  setSessionsDir,
  clearSessionKeyCacheForTests,
  MAX_HISTORY_PAIRS,
} from '../sessions.js';

let testSessionsDir: string;

beforeEach(() => {
  clearSessionKeyCacheForTests();
  process.env.SKIMPYCLAW_HISTORY_KEY = 'test-history-key';
  testSessionsDir = join(tmpdir(), `sk-sessions-test-${Date.now()}`);
  mkdirSync(testSessionsDir, { recursive: true });
  setSessionsDir(testSessionsDir);
});

afterEach(() => {
  delete process.env.SKIMPYCLAW_HISTORY_KEY;
  if (existsSync(testSessionsDir)) {
    rmSync(testSessionsDir, { recursive: true, force: true });
  }
});

describe('loadHistory', () => {
  it('returns [] when file does not exist', async () => {
    const result = await loadHistory('telegram', '12345');
    expect(result).toEqual([]);
  });

  it('returns [] for a chatId with no session file', async () => {
    const result = await loadHistory('discord', 'dm:999999');
    expect(result).toEqual([]);
  });
});

describe('saveExchange', () => {
  it('creates the session file and writes one entry', async () => {
    await saveExchange('telegram', '111', 'hello', 'hi there');

    const filePath = join(testSessionsDir, 'telegram-111.jsonl');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    expect(content.trim().startsWith('ENCv1:')).toBe(true);

    const messages = await loadHistory('telegram', '111');
    expect(messages[0].content).toBe('hello');
    expect(messages[1].content).toBe('hi there');
  });

  it('appends multiple entries', async () => {
    await saveExchange('telegram', '222', 'msg1', 'reply1');
    await saveExchange('telegram', '222', 'msg2', 'reply2');

    const filePath = join(testSessionsDir, 'telegram-222.jsonl');
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith('ENCv1:')).toBe(true);
    expect(lines[1].startsWith('ENCv1:')).toBe(true);
  });
});

describe('loadHistory round-trip', () => {
  it('returns messages in correct ChatMessage format', async () => {
    await saveExchange('telegram', '333', 'question', 'answer');

    const messages = await loadHistory('telegram', '333');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'user', content: 'question' });
    expect(messages[1]).toEqual({ role: 'assistant', content: 'answer' });
  });

  it('returns multiple exchanges in order', async () => {
    await saveExchange('telegram', '444', 'first', 'first reply');
    await saveExchange('telegram', '444', 'second', 'second reply');

    const messages = await loadHistory('telegram', '444');
    expect(messages).toHaveLength(4);
    expect(messages[0].content).toBe('first');
    expect(messages[1].content).toBe('first reply');
    expect(messages[2].content).toBe('second');
    expect(messages[3].content).toBe('second reply');
  });

  it('respects MAX_HISTORY_PAIRS cap — returns last N pairs', async () => {
    const total = MAX_HISTORY_PAIRS + 2;
    for (let i = 0; i < total; i++) {
      await saveExchange('telegram', '555', `msg-${i}`, `reply-${i}`);
    }

    const messages = await loadHistory('telegram', '555');
    expect(messages).toHaveLength(MAX_HISTORY_PAIRS * 2);

    // Should start with exchange at index (total - MAX_HISTORY_PAIRS)
    const firstExpectedIndex = total - MAX_HISTORY_PAIRS;
    expect(messages[0].content).toBe(`msg-${firstExpectedIndex}`);
    expect(messages[messages.length - 2].content).toBe(`msg-${total - 1}`);
    expect(messages[messages.length - 1].content).toBe(`reply-${total - 1}`);
  });

  it('skips malformed lines gracefully', async () => {
    const filePath = join(testSessionsDir, 'telegram-666.jsonl');
    const { writeFileSync } = await import('fs');
    writeFileSync(
      filePath,
      '{"ts":"2026-01-01","user":"good","assistant":"ok"}\nnot-valid-json\n'
    );

    const messages = await loadHistory('telegram', '666');
    // Should only include the valid entry
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('good');
  });
});

describe('replaceWithSummary', () => {
  it('rewrites file to a single summary entry', async () => {
    await saveExchange('telegram', '777', 'hello', 'world');
    await saveExchange('telegram', '777', 'foo', 'bar');

    await replaceWithSummary('telegram', '777', 'We talked about greetings.');

    const filePath = join(testSessionsDir, 'telegram-777.jsonl');
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('ENCv1:')).toBe(true);

    const messages = await loadHistory('telegram', '777');
    expect(messages[0].content).toBe('Summary of our previous conversation:');
    expect(messages[1].content).toBe('We talked about greetings.');
  });

  it('loadHistory after replaceWithSummary returns the summary pair', async () => {
    await saveExchange('telegram', '888', 'hello', 'world');
    await replaceWithSummary('telegram', '888', 'Conversation summary here.');

    const messages = await loadHistory('telegram', '888');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      role: 'user',
      content: 'Summary of our previous conversation:',
    });
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: 'Conversation summary here.',
    });
  });

  it('creates file if it does not exist yet', async () => {
    await replaceWithSummary('telegram', '889', 'Fresh summary.');
    const messages = await loadHistory('telegram', '889');
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe('Fresh summary.');
  });
});

describe('clearHistory', () => {
  it('deletes the session file', async () => {
    await saveExchange('telegram', '999', 'hello', 'world');

    const filePath = join(testSessionsDir, 'telegram-999.jsonl');
    expect(existsSync(filePath)).toBe(true);

    await clearHistory('telegram', '999');
    expect(existsSync(filePath)).toBe(false);
  });

  it('does not throw when file does not exist', async () => {
    await expect(clearHistory('telegram', 'nonexistent-000')).resolves.not.toThrow();
  });
});

describe('platform isolation', () => {
  it('keeps telegram and discord sessions in separate files', async () => {
    await saveExchange('telegram', '100', 'telegram msg', 'telegram reply');
    await saveExchange('discord', '100', 'discord msg', 'discord reply');

    const tgMessages = await loadHistory('telegram', '100');
    const dcMessages = await loadHistory('discord', '100');

    expect(tgMessages).toHaveLength(2);
    expect(tgMessages[0].content).toBe('telegram msg');

    expect(dcMessages).toHaveLength(2);
    expect(dcMessages[0].content).toBe('discord msg');
  });
});
