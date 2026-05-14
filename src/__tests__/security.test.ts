import { describe, it, expect } from 'vitest';
import { redactSecrets, redactSecretText } from '../security.js';

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

describe('redactSecretText', () => {
  it('redacts common token-shaped secrets in persisted text', () => {
    const githubToken = `ghp_${'a'.repeat(36)}`;
    const openAiToken = `sk-${'b'.repeat(24)}`;
    const slackToken = `xox${'b'}-123-abc`;
    const text = [
      `github token ${githubToken}`,
      `openai token ${openAiToken}`,
      `slack token ${slackToken}`,
    ].join('\n');

    const redacted = redactSecretText(text);

    expect(redacted).not.toContain(githubToken);
    expect(redacted).not.toContain(openAiToken);
    expect(redacted).not.toContain(slackToken);
    expect(redacted.match(/\[REDACTED_SECRET\]/g)).toHaveLength(3);
  });
});
