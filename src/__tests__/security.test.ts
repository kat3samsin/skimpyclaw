import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../security.js';

describe('redactSecrets', () => {
  it('redacts nested secrets inside arrays and objects', () => {
    const input = {
      token: 'abc',
      nested: {
        apiKey: 'def',
      },
      providers: [
        { name: 'x', secret: 'ghi' },
        { name: 'y', password: 'jkl' },
      ],
    };

    const redacted = redactSecrets(input);
    expect(redacted.token).toBe('[REDACTED]');
    expect(redacted.nested.apiKey).toBe('[REDACTED]');
    expect(redacted.providers[0].secret).toBe('[REDACTED]');
    expect(redacted.providers[1].password).toBe('[REDACTED]');
    expect(redacted.providers[0].name).toBe('x');
  });
});
