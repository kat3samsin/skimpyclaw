import { describe, expect, it } from 'vitest';
import { getProvider, stripProvider } from '../providers/utils.js';

describe('provider utils', () => {
  it('detects provider from explicit prefix', () => {
    expect(getProvider('openai/gpt-5.3-codex')).toBe('openai');
    expect(getProvider('codex/gpt-5.3-codex')).toBe('codex');
    expect(getProvider('anthropic/claude-sonnet-4-5')).toBe('anthropic');
  });

  it('strips provider prefix when registries are omitted', () => {
    expect(stripProvider('openai/gpt-5.3-codex')).toBe('gpt-5.3-codex');
    expect(stripProvider('codex/gpt-5.3-codex')).toBe('gpt-5.3-codex');
    expect(stripProvider('anthropic/claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
  });
});
