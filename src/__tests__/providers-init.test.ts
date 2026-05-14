import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initProviders,
  addResponsesApiProvider,
  isResponsesApiProvider,
  isCodexAvailable,
  setUsingOAuth,
  isUsingOAuth,
} from '../providers/index.js';

const tempDirs: string[] = [];

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value))
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function fakeJwt(payload: Record<string, unknown>): string {
  return `${base64UrlJson({ alg: 'none' })}.${base64UrlJson(payload)}.signature`;
}

function writeCodexAuthFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skimpyclaw-providers-init-'));
  tempDirs.push(dir);
  const path = join(dir, 'auth.json');
  writeFileSync(path, JSON.stringify({
    tokens: {
      access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      account_id: 'acct-from-file',
    },
  }), 'utf-8');
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function baseConfig(providers: Record<string, any>): any {
  return {
    gateway: { port: 18790, mode: 'local' },
    agents: { default: 'main', list: { main: { identity: { name: 'bot', emoji: 'x' }, model: 'anthropic/claude-sonnet-4-6' } } },
    models: { providers, aliases: {} },
    channels: { telegram: { enabled: false, token: '', allowFrom: [] }, discord: { enabled: false, token: '', allowFrom: [] } },
    cron: { jobs: [] },
    heartbeat: { intervalMs: 60000, prompt: 'heartbeat' },
  };
}

describe('providers init reset behavior', () => {
  it('clears stale codex provider registrations on re-init', async () => {
    addResponsesApiProvider('openai');
    expect(isResponsesApiProvider('openai')).toBe(true);

    await initProviders(baseConfig({}));
    expect(isResponsesApiProvider('openai')).toBe(false);
  });

  it('initializes legacy codex authPath-only provider config', async () => {
    await initProviders(baseConfig({
      codex: { authPath: writeCodexAuthFile() },
    }));

    expect(isResponsesApiProvider('codex')).toBe(true);
    expect(isCodexAvailable()).toBe(true);
  });

  it('resets oauth flag on re-init', async () => {
    setUsingOAuth(true);
    expect(isUsingOAuth()).toBe(true);

    await initProviders(baseConfig({}));
    expect(isUsingOAuth()).toBe(false);
  });
});
