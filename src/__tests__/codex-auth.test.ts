import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { loadCodexAuth, resolveCodexAuthPath } from '../providers/codex.js';

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

function writeAuthFile(raw: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'skimpyclaw-codex-auth-'));
  tempDirs.push(dir);
  const path = join(dir, 'auth.json');
  writeFileSync(path, JSON.stringify(raw), 'utf-8');
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Codex auth loading', () => {
  it('uses ~/.codex/auth.json as the default auth path', () => {
    expect(resolveCodexAuthPath()).toBe(join(homedir(), '.codex', 'auth.json'));
    expect(resolveCodexAuthPath('~/.codex/auth.json')).toBe(join(homedir(), '.codex', 'auth.json'));
  });

  it('reads the current Codex CLI account id field from tokens.account_id', () => {
    const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const path = writeAuthFile({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: token,
        account_id: 'acct-from-file',
      },
    });

    expect(loadCodexAuth(path)).toEqual({
      accessToken: token,
      accountId: 'acct-from-file',
    });
  });

  it('falls back to the ChatGPT account id embedded in the access token', () => {
    const token = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-from-jwt',
      },
    });
    const path = writeAuthFile({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: token,
      },
    });

    expect(loadCodexAuth(path)).toEqual({
      accessToken: token,
      accountId: 'acct-from-jwt',
    });
  });
});
