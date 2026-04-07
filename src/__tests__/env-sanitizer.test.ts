import { describe, it, expect } from 'vitest';
import { sanitizeExecEnv, sanitizeCronEnv } from '../env-sanitizer.js';

describe('sanitizeExecEnv', () => {
  it('strips sensitive env vars while preserving allowlisted values', () => {
    process.env.OPENAI_API_KEY = 'secret-openai';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'secret-claude';
    process.env.GH_TOKEN = 'allowed-gh';
    process.env.NORMAL_VAR = 'ok';

    const env = sanitizeExecEnv();

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBe('allowed-gh');
    expect(env.NORMAL_VAR).toBe('ok');

    delete process.env.OPENAI_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.NORMAL_VAR;
  });

  it('ensures common tool paths are present in PATH', () => {
    process.env.PATH = '/usr/bin:/bin';
    const env = sanitizeExecEnv();
    expect(env.PATH).toContain('/opt/homebrew/bin');
    expect(env.PATH).toContain('/usr/local/bin');
  });

  it('applies strict allowlist for cron environments', () => {
    process.env.OPENAI_API_KEY = 'secret';
    process.env.GH_TOKEN = 'allowed-gh';
    process.env.SKIMPYCLAW_MODE = 'prod';
    process.env.CUSTOM_RANDOM_VAR = 'do-not-include';
    process.env.PATH = '/usr/bin:/bin';
    process.env.HOME = '/tmp/home';

    const env = sanitizeCronEnv();

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CUSTOM_RANDOM_VAR).toBeUndefined();
    expect(env.GH_TOKEN).toBe('allowed-gh');
    expect(env.SKIMPYCLAW_MODE).toBe('prod');
    expect(env.HOME).toBe('/tmp/home');
    expect(env.PATH).toContain('/opt/homebrew/bin');

    delete process.env.OPENAI_API_KEY;
    delete process.env.GH_TOKEN;
    delete process.env.SKIMPYCLAW_MODE;
    delete process.env.CUSTOM_RANDOM_VAR;
    delete process.env.HOME;
  });
});
