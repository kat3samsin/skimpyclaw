import { describe, expect, it } from 'vitest';
import {
  stripAnsi,
  chunkForDiscord,
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
