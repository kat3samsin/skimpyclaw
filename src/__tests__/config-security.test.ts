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

const mockSpawnSync = vi.hoisted(() => vi.fn());
const mockDotenvConfig = vi.hoisted(() => vi.fn());

vi.mock('fs', () => ({
  existsSync: mockFs.existsSync,
  readFileSync: mockFs.readFileSync,
  writeFileSync: mockFs.writeFileSync,
  chmodSync: mockFs.chmodSync,
  mkdirSync: mockFs.mkdirSync,
  readdirSync: mockFs.readdirSync,
  statSync: mockFs.statSync,
}));

vi.mock('child_process', () => ({
  spawnSync: mockSpawnSync,
}));

vi.mock('dotenv', () => ({
  default: {
    config: mockDotenvConfig,
  },
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

  it('resolves ${KEYCHAIN:service/account} references on darwin', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        models: { providers: { openai: { apiKey: '${KEYCHAIN:skimpy/service-account}' } } },
      }));
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: 'resolved-secret\n',
        stderr: '',
      });

      const { loadConfig } = await import('../config.js');
      const cfg: any = loadConfig();

      expect(cfg.models.providers.openai.apiKey).toBe('resolved-secret');
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'security',
        ['find-generic-password', '-s', 'skimpy', '-a', 'service-account', '-w'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });
});
