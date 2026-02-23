import { describe, expect, it } from 'vitest';
import { normalizeCodeAgent, resolveSelectedCodeAgent } from '../code-agents/utils.js';

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

describe('resolveSelectedCodeAgent', () => {
  it('prefers requested agent when provided', () => {
    expect(resolveSelectedCodeAgent('codex5.3', 'claude')).toBe('codex');
  });

  it('falls back to configured default agent', () => {
    expect(resolveSelectedCodeAgent(undefined, 'claude-think')).toBe('claude');
  });

  it('uses claude as hard default', () => {
    expect(resolveSelectedCodeAgent(undefined, undefined)).toBe('claude');
  });

  it('auto-selects codex when model is a GPT model and no agent specified', () => {
    expect(resolveSelectedCodeAgent(undefined, 'claude', 'gpt-4.1')).toBe('codex');
    expect(resolveSelectedCodeAgent(undefined, 'claude', 'gpt-5.3-codex')).toBe('codex');
    expect(resolveSelectedCodeAgent(undefined, 'claude', 'openai/gpt-4.1')).toBe('codex');
    expect(resolveSelectedCodeAgent(undefined, 'claude', 'o3-pro')).toBe('codex');
  });

  it('auto-selects kimi when model is a kimi model and no agent specified', () => {
    expect(resolveSelectedCodeAgent(undefined, 'claude', 'kimi-for-coding')).toBe('kimi');
  });

  it('respects explicit agent even when model suggests different agent', () => {
    expect(resolveSelectedCodeAgent('claude', 'claude', 'gpt-4.1')).toBe('claude');
  });
});
