import { describe, expect, it } from 'vitest';
import { validateBearerToken } from '../utils.js';

describe('validateBearerToken', () => {
  it('accepts valid bearer token', () => {
    expect(validateBearerToken('abc123', 'Bearer abc123')).toBe(true);
  });

  it('rejects invalid bearer token', () => {
    expect(validateBearerToken('abc123', 'Bearer nope')).toBe(false);
  });

  it('rejects missing or malformed auth headers', () => {
    expect(validateBearerToken('abc123', undefined)).toBe(false);
    expect(validateBearerToken('abc123', 'Basic abc123')).toBe(false);
  });
});
