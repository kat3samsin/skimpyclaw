import { describe, expect, it } from 'vitest';
import { normalizeCodeAgent } from '../code-agents/utils.js';

describe('normalizeCodeAgent', () => {
  it('accepts strict ids', () => {
    expect(normalizeCodeAgent('claude')).toBe('claude');
    expect(normalizeCodeAgent('codex')).toBe('codex');
    expect(normalizeCodeAgent('kimi')).toBe('kimi');
  });

  it('maps legacy alias-like values', () => {
    expect(normalizeCodeAgent('claude-think')).toBe('claude');
    expect(normalizeCodeAgent('codex5.3')).toBe('codex');
    expect(normalizeCodeAgent('kimi/coding')).toBe('kimi');
  });

  it('returns null for unknown values', () => {
    expect(normalizeCodeAgent('gpt')).toBeNull();
    expect(normalizeCodeAgent(undefined)).toBeNull();
  });
});
