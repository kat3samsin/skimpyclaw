import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TTLCache } from '../cache.js';

describe('TTLCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns undefined for missing keys', () => {
    const cache = new TTLCache<string>(1000);
    expect(cache.get('nope')).toBeUndefined();
  });

  it('stores and retrieves values', () => {
    const cache = new TTLCache<number>(1000);
    cache.set('a', 42);
    expect(cache.get('a')).toBe(42);
  });

  it('stores different values under different keys', () => {
    const cache = new TTLCache<string>(1000);
    cache.set('x', 'hello');
    cache.set('y', 'world');
    expect(cache.get('x')).toBe('hello');
    expect(cache.get('y')).toBe('world');
  });

  it('expires entries after TTL', () => {
    const cache = new TTLCache<string>(500);
    cache.set('k', 'val');
    expect(cache.get('k')).toBe('val');

    vi.advanceTimersByTime(499);
    expect(cache.get('k')).toBe('val');

    vi.advanceTimersByTime(2);
    expect(cache.get('k')).toBeUndefined();
  });

  it('clear() removes all entries', () => {
    const cache = new TTLCache<number>(60_000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('returns same reference on cache hit (object values)', () => {
    const cache = new TTLCache<Record<string, string>>(60_000);
    const obj = { foo: 'bar' };
    cache.set('ref', obj);
    expect(cache.get('ref')).toBe(obj); // same reference
  });

  it('overwrites existing key with new value and TTL', () => {
    const cache = new TTLCache<string>(1000);
    cache.set('k', 'first');
    vi.advanceTimersByTime(800);
    cache.set('k', 'second'); // resets TTL
    vi.advanceTimersByTime(800); // 1600ms from start, but only 800ms from second set
    expect(cache.get('k')).toBe('second');
  });

  it('uses default TTL of 60s', () => {
    const cache = new TTLCache<string>();
    cache.set('k', 'val');
    vi.advanceTimersByTime(59_999);
    expect(cache.get('k')).toBe('val');
    vi.advanceTimersByTime(2);
    expect(cache.get('k')).toBeUndefined();
  });
});
