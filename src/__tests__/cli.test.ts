import { describe, it, expect } from 'vitest';
import { parseConfigValue, setDeepValue, getDeepValue } from '../cli.js';

describe('parseConfigValue', () => {
  it('parses JSON primitives and objects', () => {
    expect(parseConfigValue('true')).toBe(true);
    expect(parseConfigValue('18790')).toBe(18790);
    expect(parseConfigValue('{"enabled":true}')).toEqual({ enabled: true });
  });

  it('falls back to raw string for non-JSON values', () => {
    expect(parseConfigValue('anthropic/claude-sonnet-4-20250514')).toBe('anthropic/claude-sonnet-4-20250514');
  });
});

describe('setDeepValue/getDeepValue', () => {
  it('sets nested values by dot path', () => {
    const obj: Record<string, unknown> = {
      gateway: { port: 18790 },
    };

    setDeepValue(obj, 'gateway.port', 20000);
    setDeepValue(obj, 'channels.telegram.enabled', true);

    expect(getDeepValue(obj, 'gateway.port')).toBe(20000);
    expect(getDeepValue(obj, 'channels.telegram.enabled')).toBe(true);
  });

  it('returns undefined for unknown paths', () => {
    const obj: Record<string, unknown> = { a: { b: 1 } };
    expect(getDeepValue(obj, 'a.c')).toBeUndefined();
  });

  it('throws for invalid key path', () => {
    const obj: Record<string, unknown> = {};

    expect(() => setDeepValue(obj, '', 1)).toThrowError('Invalid key path');
    expect(() => getDeepValue(obj, '')).toThrowError('Invalid key path');
  });
});
