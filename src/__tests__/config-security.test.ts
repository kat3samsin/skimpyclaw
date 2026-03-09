import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ mtime: new Date(), size: 0 })),
}));

const mockDotenvConfig = vi.hoisted(() => vi.fn());
const mockSecureStore = vi.hoisted(() => ({
  getSecureValue: vi.fn(),
  setSecureValue: vi.fn(),
  requireSecureStore: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: mockFs.existsSync,
  readFileSync: mockFs.readFileSync,
  writeFileSync: mockFs.writeFileSync,
  chmodSync: mockFs.chmodSync,
  mkdirSync: mockFs.mkdirSync,
  readdirSync: mockFs.readdirSync,
  statSync: mockFs.statSync,
}));

vi.mock('dotenv', () => ({
  default: {
    config: mockDotenvConfig,
  },
}));

vi.mock('../secure-store.js', () => ({
  getSecureValue: mockSecureStore.getSecureValue,
  setSecureValue: mockSecureStore.setSecureValue,
  requireSecureStore: mockSecureStore.requireSecureStore,
}));

vi.mock('os', () => ({
  homedir: () => '/mock-home',
}));

describe('config security hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('{}');
    mockSecureStore.getSecureValue.mockReturnValue('resolved-secret');
  });

  it('enforces mode 0600 when saving config', async () => {
    const { saveConfig } = await import('../config.js');
    saveConfig({ gateway: { port: 18790 } } as any);

    expect(mockFs.mkdirSync).toHaveBeenCalledWith('/mock-home/.skimpyclaw', { recursive: true });
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      '/mock-home/.skimpyclaw/config.json',
      expect.any(String),
      { encoding: 'utf-8', mode: 0o600 },
    );
    expect(mockFs.chmodSync).toHaveBeenCalledWith('/mock-home/.skimpyclaw/config.json', 0o600);
  });

  it('migrates plaintext secrets to keychain references when saving config', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const { saveConfig } = await import('../config.js');
      saveConfig({
        gateway: { port: 18790 },
        channels: { telegram: { token: 'tg-plain-secret' } },
        models: { providers: { openai: { apiKey: 'sk-plain-secret' } } },
      } as any);

      expect(mockSecureStore.requireSecureStore).toHaveBeenCalled();
      expect(mockSecureStore.setSecureValue).toHaveBeenCalledWith(
        'skimpyclaw-config',
        'channels.telegram.token',
        'tg-plain-secret',
      );
      expect(mockSecureStore.setSecureValue).toHaveBeenCalledWith(
        'skimpyclaw-config',
        'models.providers.openai.apiKey',
        'sk-plain-secret',
      );

      const written = mockFs.writeFileSync.mock.calls[0][1] as string;
      expect(written).toContain('${KEYCHAIN:skimpyclaw-config/channels.telegram.token}');
      expect(written).toContain('${KEYCHAIN:skimpyclaw-config/models.providers.openai.apiKey}');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('enforces mode 0600 when generating dashboard token', async () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ gateway: { port: 18790 } }));
    const { ensureDashboardToken } = await import('../config.js');

    const cfg: any = { gateway: { port: 18790 } };
    const token = ensureDashboardToken(cfg);
    expect(typeof token).toBe('string');
    expect(cfg.dashboard.token).toBe(token);
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      '/mock-home/.skimpyclaw/config.json',
      expect.any(String),
      { encoding: 'utf-8', mode: 0o600 },
    );
    expect(mockFs.chmodSync).toHaveBeenCalledWith('/mock-home/.skimpyclaw/config.json', 0o600);
  });

  it('resolves ${KEYCHAIN:service/account} references', async () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      models: { providers: { openai: { apiKey: '${KEYCHAIN:skimpy/service-account}' } } },
    }));

    const { loadConfig } = await import('../config.js');
    const cfg: any = loadConfig();

    expect(cfg.models.providers.openai.apiKey).toBe('resolved-secret');
    expect(mockSecureStore.getSecureValue).toHaveBeenCalledWith('skimpy', 'service-account');
  });

  it('migrates legacy plaintext secrets on load for backward compatibility', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      channels: { telegram: { token: 'legacy-token' } },
      models: { providers: { openai: { apiKey: 'legacy-api-key' } } },
    }));

    try {
      const { loadConfig } = await import('../config.js');
      const cfg: any = loadConfig();
      expect(cfg.channels.telegram.token).toBe('resolved-secret');
      expect(cfg.models.providers.openai.apiKey).toBe('resolved-secret');
      expect(mockSecureStore.setSecureValue).toHaveBeenCalledTimes(2);
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('throws a clear error when secure store is unavailable during migration', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockSecureStore.requireSecureStore.mockImplementation(() => {
      throw new Error('[secure-store] Secret storage requires macOS Keychain, but it is unavailable');
    });

    try {
      const { saveConfig } = await import('../config.js');
      expect(() => saveConfig({ channels: { telegram: { token: 'tg-secret' } } } as any)).toThrow(
        'requires macOS Keychain',
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });
});
