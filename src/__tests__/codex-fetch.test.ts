import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  codexFetch,
  initCodexAuth,
  resetCodexProviderState,
  setCodexFetchRetryDelaysForTesting,
} from '../providers/codex.js';

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

function writeFakeCodexAuth(authPath: string, token: string): void {
  writeFileSync(authPath, JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: token,
      account_id: 'acct-test',
    },
  }), 'utf-8');
}

function initFakeCodexAuth(): { authPath: string; token: string } {
  const dir = mkdtempSync(join(tmpdir(), 'skimpyclaw-codex-fetch-'));
  tempDirs.push(dir);
  const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const authPath = join(dir, 'auth.json');
  writeFakeCodexAuth(authPath, token);

  initCodexAuth(authPath, 'https://codex.test/backend-api');
  return { authPath, token };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetCodexProviderState();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('codexFetch', () => {
  it('retries transient fetch failures inside a single provider call', async () => {
    initFakeCodexAuth();
    setCodexFetchRetryDelaysForTesting([0, 0]);
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: new Error('connect timeout') }))
      .mockResolvedValueOnce(new Response('data: [DONE]\n\n', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await codexFetch({ model: 'gpt-5.5' });

    expect(result).toBe('data: [DONE]\n\n');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('includes the backend URL and underlying cause when retries are exhausted', async () => {
    initFakeCodexAuth();
    setCodexFetchRetryDelaysForTesting([0]);
    const fetchMock = vi.fn()
      .mockRejectedValue(new TypeError('fetch failed', { cause: new Error('read ECONNRESET') }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(codexFetch({ model: 'gpt-5.5' })).rejects.toThrow(
      'Codex fetch failed for https://codex.test/backend-api/codex/responses: fetch failed; cause: read ECONNRESET',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries transient Codex HTTP responses', async () => {
    initFakeCodexAuth();
    setCodexFetchRetryDelaysForTesting([0]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('upstream connect error', { status: 503 }))
      .mockResolvedValueOnce(new Response('data: [DONE]\n\n', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await codexFetch({ model: 'gpt-5.5' });

    expect(result).toBe('data: [DONE]\n\n');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reloads Codex auth from disk once when the cached token is expired server-side', async () => {
    const { authPath, token: staleToken } = initFakeCodexAuth();
    const refreshedToken = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 7200 });
    writeFakeCodexAuth(authPath, refreshedToken);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'Provided authentication token is expired. Please try signing in again.', code: 'token_expired' },
        status: 401,
      }), { status: 401 }))
      .mockResolvedValueOnce(new Response('data: [DONE]\n\n', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await codexFetch({ model: 'gpt-5.5' });

    expect(result).toBe('data: [DONE]\n\n');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.headers.Authorization).toBe(`Bearer ${staleToken}`);
    expect(fetchMock.mock.calls[1][1]?.headers.Authorization).toBe(`Bearer ${refreshedToken}`);
  });
});
