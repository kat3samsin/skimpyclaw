import { describe, expect, it } from 'vitest';
import {
  formatAliases,
  formatModelSelectionError,
  getModelSelectionUsage,
  listModelAliases,
  resolveModelSelection,
} from '../model-selection.js';

function mockConfig(): any {
  return {
    models: {
      aliases: {
        codex5: 'codex/gpt-5.3-codex',
      },
    },
  };
}

describe('model-selection', () => {
  it('lists aliases sorted', () => {
    expect(listModelAliases(mockConfig())).toEqual(['codex5']);
  });

  it('formats aliases', () => {
    expect(formatAliases(mockConfig())).toBe('codex5');
  });

  it('returns model selection usage string', () => {
    expect(getModelSelectionUsage()).toBe('Use alias, provider/model, or model-id.');
  });

  it('resolves alias values', () => {
    const resolved = resolveModelSelection('codex5', mockConfig());
    expect(resolved.ok).toBe(true);
    expect(resolved.aliasUsed).toBe('codex5');
    expect(resolved.resolved).toBe('codex/gpt-5.3-codex');
  });

  it('accepts full model spec', () => {
    const resolved = resolveModelSelection('anthropic/claude-sonnet-4-5', mockConfig());
    expect(resolved.ok).toBe(true);
    expect(resolved.aliasUsed).toBeUndefined();
    expect(resolved.resolved).toBe('anthropic/claude-sonnet-4-5');
  });

  it('accepts bare model id', () => {
    const resolved = resolveModelSelection('claude-haiku-4-20250414', mockConfig());
    expect(resolved.ok).toBe(true);
    expect(resolved.aliasUsed).toBeUndefined();
    expect(resolved.resolved).toBe('claude-haiku-4-20250414');
  });

  it('migrates deprecated model ids through shared resolver', () => {
    const resolved = resolveModelSelection('claude-3-5-sonnet-20241022', mockConfig());
    expect(resolved.ok).toBe(true);
    expect(resolved.resolved).toBe('claude-sonnet-4-6');
  });

  it('rejects unknown values with consistent error', () => {
    const resolved = resolveModelSelection('claude_think', mockConfig());
    expect(resolved.ok).toBe(false);
    expect(resolved.error).toBe('Unknown model alias: "claude_think"');
  });

  it('rejects malformed provider/model input', () => {
    const resolved = resolveModelSelection('anthropic/', mockConfig());
    expect(resolved.ok).toBe(false);
    expect(resolved.error).toBe('Invalid model selection: "anthropic/". Use alias, provider/model, or model-id.');
  });

  it('formats model selection errors with aliases and usage', () => {
    const text = formatModelSelectionError('Unknown model alias: "x"', mockConfig());
    expect(text).toContain('Unknown model alias: "x"');
    expect(text).toContain('Available aliases: codex5');
    expect(text).toContain('Use alias, provider/model, or model-id.');
  });
});
