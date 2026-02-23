import { beforeEach, describe, expect, it, vi } from 'vitest';

const CONFIG_PATH = '/tmp/skimpyclaw-test-config.json';
const {
  mockLoadConfig,
  mockLoadRawConfig,
  mockSaveConfig,
  mockRunSetup,
  mockRunDoctor,
} = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockLoadRawConfig: vi.fn(),
  mockSaveConfig: vi.fn(),
  mockRunSetup: vi.fn(),
  mockRunDoctor: vi.fn(),
}));

vi.mock('../config.js', () => ({
  loadConfig: mockLoadConfig,
  loadRawConfig: mockLoadRawConfig,
  getConfigPath: () => CONFIG_PATH,
  saveConfig: mockSaveConfig,
}));

vi.mock('../setup.js', () => ({
  runSetup: mockRunSetup,
}));

vi.mock('../service.js', () => ({
  startRuntime: vi.fn(),
}));

vi.mock('../doctor/index.js', () => ({
  runDoctor: mockRunDoctor,
}));

import { parseConfigValue, setDeepValue, getDeepValue, runCli } from '../cli.js';

function mockJsonResponse(body: unknown, ok: boolean = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Internal Server Error',
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

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

describe('runCli', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockLoadConfig.mockReset();
    mockLoadRawConfig.mockReset();
    mockSaveConfig.mockReset();
    mockRunSetup.mockReset();
    mockRunDoctor.mockReset();

    mockLoadConfig.mockReturnValue({
      gateway: { port: 18790 },
      models: { aliases: { fast: 'anthropic/claude-3-5-haiku-20241022' } },
    });
    mockLoadRawConfig.mockReturnValue({
      gateway: { port: 18790 },
      channels: { telegram: { enabled: false } },
    });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn());
  });

  it('prints help when no command is provided', async () => {
    const code = await runCli([]);
    expect(code).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Usage: skimpyclaw'));
  });

  it('runs onboarding command', async () => {
    const code = await runCli(['onboard']);
    expect(code).toBe(0);
    expect(mockRunSetup).toHaveBeenCalledTimes(1);
    expect(mockRunSetup).toHaveBeenCalledWith({ dryRun: false });
  });

  it('passes dry-run flag to onboarding command', async () => {
    const code = await runCli(['onboard', '--dry-run']);
    expect(code).toBe(0);
    expect(mockRunSetup).toHaveBeenCalledTimes(1);
    expect(mockRunSetup).toHaveBeenCalledWith({ dryRun: true });
  });

  it('supports config path/get/set operations', async () => {
    const pathCode = await runCli(['config', 'path']);
    expect(pathCode).toBe(0);
    expect(console.log).toHaveBeenCalledWith(CONFIG_PATH);

    const getCode = await runCli(['config', 'get', 'gateway.port']);
    expect(getCode).toBe(0);
    expect(console.log).toHaveBeenCalledWith('18790');

    const setCode = await runCli(['config', 'set', 'gateway.port', '20000']);
    expect(setCode).toBe(0);
    expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({
      gateway: { port: 20000 },
    }));
  });

  it('lists all models with aliases', async () => {
    mockLoadConfig.mockReturnValue({
      gateway: { port: 18790 },
      models: {
        providers: {
          anthropic: { apiKey: 'test' },
          codex: { authPath: '~/.codex/auth.json' },
        },
        aliases: {
          'claude-fast': 'anthropic/claude-haiku-4-5',
          'codex5.1': 'codex/gpt-5.1-codex',
          'codex5.3': 'codex/gpt-5.3-codex',
        },
      },
      agents: { default: 'main', list: { main: { model: 'anthropic/claude-opus-4' } } },
    });

    const code = await runCli(['models']);
    expect(code).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('codex5.1'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('codex/gpt-5.1-codex'));
  });

  it('sets model through gateway request using alias resolution', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(mockJsonResponse({ model: 'anthropic/claude-haiku-4-5' }));

    const code = await runCli(['model', 'fast']);
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18790/model',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'anthropic/claude-haiku-4-5' }),
      })
    );
  });

  it('resolves codex5.1 alias when setting model', async () => {
    mockLoadConfig.mockReturnValue({
      gateway: { port: 18790 },
      models: { aliases: { 'codex5.1': 'codex/gpt-5.1-codex' } },
    });

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(mockJsonResponse({ model: 'codex/gpt-5.1-codex' }));

    const code = await runCli(['model', 'codex5.1']);
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18790/model',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'codex/gpt-5.1-codex' }),
      })
    );
  });

  it('rejects unknown model aliases that are not model ids', async () => {
    const fetchMock = vi.mocked(fetch);
    const code = await runCli(['model', 'fast_alias']);
    expect(code).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Unknown model alias: "fast_alias"'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Available aliases:'));
  });

  it('rejects malformed model selections', async () => {
    const fetchMock = vi.mocked(fetch);
    const code = await runCli(['model', 'anthropic/']);
    expect(code).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid model selection: "anthropic/". Use alias, provider/model, or model-id.')
    );
  });

  it('sends a message through gateway request', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(mockJsonResponse({ response: 'ok' }));

    const code = await runCli(['send', 'hello', 'world']);
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18790/message',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ message: 'hello world' }),
      })
    );
  });

  it('lists and runs cron jobs', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(mockJsonResponse({
        cronJobs: [{ id: 'morning', name: 'Morning', nextRun: '2026-02-08T14:00:00Z' }],
      }))
      .mockResolvedValueOnce(mockJsonResponse({ status: 'triggered', id: 'morning' }));

    const listCode = await runCli(['cron', 'list']);
    expect(listCode).toBe(0);
    expect(console.log).toHaveBeenCalledWith('morning\tMorning\t2026-02-08T14:00:00Z');

    const runCode = await runCli(['cron', 'run', 'morning']);
    expect(runCode).toBe(0);
    expect(console.log).toHaveBeenCalledWith('triggered: morning');
  });

  it('routes doctor command in human mode and preserves exit code', async () => {
    mockRunDoctor.mockResolvedValue({ output: 'doctor ok', exitCode: 0 });

    const code = await runCli(['doctor']);

    expect(mockRunDoctor).toHaveBeenCalledWith({ json: false });
    expect(console.log).toHaveBeenCalledWith('doctor ok');
    expect(code).toBe(0);
  });

  it('routes doctor command in JSON mode and preserves non-zero exit code', async () => {
    mockRunDoctor.mockResolvedValue({ output: '{"ok":false}', exitCode: 1 });

    const code = await runCli(['doctor', '--json']);

    expect(mockRunDoctor).toHaveBeenCalledWith({ json: true });
    expect(console.log).toHaveBeenCalledWith('{"ok":false}');
    expect(code).toBe(1);
  });

  it('returns non-zero when doctor command throws', async () => {
    mockRunDoctor.mockRejectedValue(new Error('doctor exploded'));

    const code = await runCli(['doctor']);

    expect(code).toBe(1);
    expect(console.error).toHaveBeenCalledWith('doctor exploded');
  });

  it('returns non-zero for unknown command', async () => {
    const code = await runCli(['wat']);
    expect(code).toBe(1);
    expect(console.error).toHaveBeenCalledWith('Unknown command: wat');
  });

  it('returns non-zero when gateway request fails', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(mockJsonResponse({ error: 'boom' }, false));

    const code = await runCli(['send', 'hello']);
    expect(code).toBe(1);
    expect(console.error).toHaveBeenCalledWith('boom');
  });
});
