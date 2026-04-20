import { describe, expect, it } from 'vitest';
import {
  stripAnsi,
  chunkForDiscord,
  parseCodexJsonl,
  formatCodexOutput,
} from '../code-agents/stream-formatter.js';

describe('stripAnsi', () => {
  it('removes color codes', () => {
    const input = '\x1B[31mred text\x1B[0m plain';
    expect(stripAnsi(input)).toBe('red text plain');
  });

  it('removes cursor moves', () => {
    const input = 'a\x1B[2Kb';
    expect(stripAnsi(input)).toBe('ab');
  });

  it('passes through plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });
});

describe('chunkForDiscord', () => {
  it('returns empty array for empty input', () => {
    expect(chunkForDiscord('')).toEqual([]);
  });

  it('returns single chunk for short input', () => {
    expect(chunkForDiscord('short text')).toEqual(['short text']);
  });

  it('splits on paragraph boundaries when possible', () => {
    const p1 = 'a'.repeat(1000);
    const p2 = 'b'.repeat(1000);
    const input = p1 + '\n\n' + p2;
    const chunks = chunkForDiscord(input, 1900);
    // Both paragraphs fit in 1900 together (1000 + 2 + 1000 = 2002 > 1900)
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(p1);
    expect(chunks[1]).toBe(p2);
  });

  it('packs multiple small paragraphs together', () => {
    const input = 'one\n\ntwo\n\nthree';
    expect(chunkForDiscord(input, 1900)).toEqual(['one\n\ntwo\n\nthree']);
  });

  it('hard-splits a paragraph that is larger than max', () => {
    const huge = 'x'.repeat(5000);
    const chunks = chunkForDiscord(huge, 1900);
    expect(chunks).toHaveLength(Math.ceil(5000 / 1900));
    expect(chunks.every(c => c.length <= 1900)).toBe(true);
    expect(chunks.join('')).toBe(huge);
  });

  it('strips ANSI before chunking', () => {
    const input = '\x1B[31mred\x1B[0m and more';
    expect(chunkForDiscord(input)).toEqual(['red and more']);
  });

  it('trims trailing whitespace but preserves internal', () => {
    expect(chunkForDiscord('hello\n\n  \n')).toEqual(['hello']);
  });
});

describe('parseCodexJsonl', () => {
  it('captures thread_id from thread.started', () => {
    const input = JSON.stringify({ type: 'thread.started', thread_id: 'abc-123' });
    const r = parseCodexJsonl(input);
    expect(r.threadId).toBe('abc-123');
    expect(r.messages).toEqual([]);
  });

  it('extracts agent_message text', () => {
    const input = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hi there' } }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');
    const r = parseCodexJsonl(input);
    expect(r.threadId).toBe('t1');
    expect(r.messages).toEqual(['hi there']);
  });

  it('condenses command_execution as tool-call line', () => {
    const input = JSON.stringify({
      type: 'item.completed',
      item: { type: 'command_execution', command: 'ls -la', status: 'completed' },
    });
    const r = parseCodexJsonl(input);
    expect(r.messages[0]).toContain('✓');
    expect(r.messages[0]).toContain('ls -la');
  });

  it('condenses file_change with paths', () => {
    const input = JSON.stringify({
      type: 'item.completed',
      item: { type: 'file_change', changes: [{ path: 'src/foo.ts' }, { path: 'src/bar.ts' }] },
    });
    const r = parseCodexJsonl(input);
    expect(r.messages[0]).toContain('src/foo.ts');
    expect(r.messages[0]).toContain('src/bar.ts');
  });

  it('ignores turn.started/completed', () => {
    const input = [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');
    const r = parseCodexJsonl(input);
    expect(r.messages).toEqual([]);
  });

  it('tolerates invalid JSON lines', () => {
    const input = [
      'not json',
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }),
      '{"broken":',
    ].join('\n');
    const r = parseCodexJsonl(input);
    expect(r.messages).toEqual(['hi']);
  });
});

describe('formatCodexOutput', () => {
  it('chunks each message independently', () => {
    const short = 'hi';
    const long = 'y'.repeat(5000);
    const chunks = formatCodexOutput([short, long]);
    expect(chunks[0]).toBe('hi');
    expect(chunks.slice(1).every(c => c.length <= 1900)).toBe(true);
  });
});
