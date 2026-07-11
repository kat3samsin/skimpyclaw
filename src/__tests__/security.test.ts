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

  it('redacts common credentials in commands and plain text', () => {
    const privateKeyMarker = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const secrets = [
      'plain-env-token',
      '123e4567-e89b-12d3-a456-426614174000',
      'plain-password',
      'plain-result-secret',
      'private-key-material',
    ];
    const text = [
      `INTERNAL_TOKEN=${secrets[0]}`,
      `Authorization: Bearer ${secrets[1]}`,
      `tool --password ${secrets[2]}`,
      `password: ${secrets[3]}`,
      `${privateKeyMarker}\n${secrets[4]}`,
    ].join('\n');

    const redacted = redactSecretText(text);

    for (const secret of secrets) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted.match(/\[REDACTED_SECRET\]/g)).toHaveLength(5);
  });
});
