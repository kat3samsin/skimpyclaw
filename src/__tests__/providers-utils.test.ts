import { describe, expect, it } from 'vitest';
import {
  getProvider,
  stripProvider,
  resolveModel,
  resolveProviderRoute,
  shouldUseCodexAliasProvider,
} from '../providers/utils.js';

describe('provider utils', () => {
  it('detects provider from explicit prefix', () => {
    expect(getProvider('openai/gpt-5.3-codex')).toBe('openai');
    expect(getProvider('codex/gpt-5.3-codex')).toBe('codex');
    expect(getProvider('anthropic/claude-sonnet-4-6')).toBe('anthropic');
  });

  it('strips provider prefix when registries are omitted', () => {
    expect(stripProvider('openai/gpt-5.3-codex')).toBe('gpt-5.3-codex');
    expect(stripProvider('codex/gpt-5.3-codex')).toBe('gpt-5.3-codex');
    expect(stripProvider('anthropic/claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('resolves provider route from aliases', () => {
    const route = resolveProviderRoute('codex5.3', {
      models: {
        aliases: { 'codex5.3': 'codex/gpt-5.3-codex' },
        providers: {},
      },
    } as any);
    expect(route.resolvedModel).toBe('codex/gpt-5.3-codex');
    expect(route.provider).toBe('codex');
    expect(route.modelId).toBe('gpt-5.3-codex');
    expect(route.isCodexModel).toBe(true);
  });

  it('detects openai codex alias compatibility', () => {
    expect(shouldUseCodexAliasProvider('openai', true, true)).toBe(true);
    expect(shouldUseCodexAliasProvider('openai', true, false)).toBe(false);
    expect(shouldUseCodexAliasProvider('codex', true, true)).toBe(false);
    expect(shouldUseCodexAliasProvider('openai', false, true)).toBe(false);
  });

  it('migrates deprecated claude 3.5 sonnet model ids', () => {
    const cfg: any = { models: { aliases: {} } };
    expect(resolveModel('claude-3-5-sonnet-20241022', cfg)).toBe('claude-sonnet-4-6');
    expect(resolveModel('anthropic/claude-3-5-sonnet-20241022', cfg)).toBe('anthropic/claude-sonnet-4-6');
    // dot variant (e.g. claude-3.5-sonnet from model hallucination)
    expect(resolveModel('claude-3.5-sonnet', cfg)).toBe('claude-sonnet-4-6');
    expect(resolveModel('claude.3.5.sonnet', cfg)).toBe('claude-sonnet-4-6');
  });

  it('migrates deprecated claude 3.5 haiku model ids', () => {
    const cfg: any = { models: { aliases: {} } };
    expect(resolveModel('claude-3-5-haiku-20241022', cfg)).toBe('claude-haiku-4-5');
    expect(resolveModel('anthropic/claude-3-5-haiku-20241022', cfg)).toBe('anthropic/claude-haiku-4-5');
    expect(resolveModel('claude-3.5-haiku', cfg)).toBe('claude-haiku-4-5');
    expect(resolveModel('claude-haiku', cfg)).toBe('claude-haiku-4-5');
    expect(resolveModel('anthropic/claude-haiku', cfg)).toBe('anthropic/claude-haiku-4-5');
  });

  it('migrates deprecated claude opus 4 model ids', () => {
    const cfg: any = { models: { aliases: {} } };
    expect(resolveModel('claude-opus-4', cfg)).toBe('claude-opus-4-7');
    expect(resolveModel('anthropic/claude-opus-4', cfg)).toBe('anthropic/claude-opus-4-7');
  });

  it('normalizes provider route fields after deprecated model migration', () => {
    const cfg: any = { models: { aliases: {} } };
    const route = resolveProviderRoute('anthropic/claude-3-5-sonnet-20241022', cfg);
    expect(route.resolvedModel).toBe('anthropic/claude-sonnet-4-6');
    expect(route.provider).toBe('anthropic');
    expect(route.modelId).toBe('claude-sonnet-4-6');
    expect(route.isCodexModel).toBe(false);
  });
});
