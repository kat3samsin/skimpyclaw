import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockLoadConfig,
  mockCheckNodeVersion,
  mockCheckPackageManagerAvailable,
  mockCheckTypeScriptCompile,
  mockCheckConfigExistsAndValidJson,
  mockCheckRequiredEnvVars,
  mockCheckEnvVarPatterns,
  mockCheckAllowedPathsWritable,
  mockCheckProviderAuth,
  mockCheckTelegramToken,
  mockCheckDiscordToken,
  mockCheckBrowserBinaryIfEnabled,
  mockCheckVoiceDependencies,
  mockCheckMcpConfig,
  mockCheckGatewayHostBindable,
  mockCheckSkimpyclawDirWritable,
  mockCheckPortAvailability,
  mockCheckSandboxAvailable,
} = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockCheckNodeVersion: vi.fn(),
  mockCheckPackageManagerAvailable: vi.fn(),
  mockCheckTypeScriptCompile: vi.fn(),
  mockCheckConfigExistsAndValidJson: vi.fn(),
  mockCheckRequiredEnvVars: vi.fn(),
  mockCheckEnvVarPatterns: vi.fn(),
  mockCheckAllowedPathsWritable: vi.fn(),
  mockCheckProviderAuth: vi.fn(),
  mockCheckTelegramToken: vi.fn(),
  mockCheckDiscordToken: vi.fn(),
  mockCheckBrowserBinaryIfEnabled: vi.fn(),
  mockCheckVoiceDependencies: vi.fn(),
  mockCheckMcpConfig: vi.fn(),
  mockCheckGatewayHostBindable: vi.fn(),
  mockCheckSkimpyclawDirWritable: vi.fn(),
  mockCheckPortAvailability: vi.fn(),
  mockCheckSandboxAvailable: vi.fn(),
}));

vi.mock('../config.js', () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock('../doctor/checks.js', () => ({
  checkNodeVersion: mockCheckNodeVersion,
  checkPackageManagerAvailable: mockCheckPackageManagerAvailable,
  checkTypeScriptCompile: mockCheckTypeScriptCompile,
  checkConfigExistsAndValidJson: mockCheckConfigExistsAndValidJson,
  checkRequiredEnvVars: mockCheckRequiredEnvVars,
  checkEnvVarPatterns: mockCheckEnvVarPatterns,
  checkAllowedPathsWritable: mockCheckAllowedPathsWritable,
  checkProviderAuth: mockCheckProviderAuth,
  checkTelegramToken: mockCheckTelegramToken,
  checkDiscordToken: mockCheckDiscordToken,
  checkBrowserBinaryIfEnabled: mockCheckBrowserBinaryIfEnabled,
  checkVoiceDependencies: mockCheckVoiceDependencies,
  checkMcpConfig: mockCheckMcpConfig,
  checkGatewayHostBindable: mockCheckGatewayHostBindable,
  checkSkimpyclawDirWritable: mockCheckSkimpyclawDirWritable,
  checkPortAvailability: mockCheckPortAvailability,
  checkSandboxAvailable: mockCheckSandboxAvailable,
}));

import { computeExitCode, runDoctor } from '../doctor/runner.js';

function okCheck(name: string, category: string, detail: string = 'ok') {
  return { name, category, ok: true, detail };
}

describe('doctor runner', () => {
  beforeEach(() => {
    const config = {
      gateway: { port: 18790 },
      models: {
        providers: {
          openai: { apiKey: '${OPENAI_API_KEY}' },
        },
      },
      channels: {
        telegram: { enabled: true, token: '${TELEGRAM_BOT_TOKEN}', allowFrom: [] },
        discord: { enabled: false, token: '', allowFrom: [] },
      },
      agents: { default: 'main', list: {} },
      cron: { jobs: [] },
      heartbeat: { intervalMs: 60000, prompt: 'ping' },
    };

    mockLoadConfig.mockReset();
    mockLoadConfig.mockReturnValue(config);

    mockCheckNodeVersion.mockReset();
    mockCheckPackageManagerAvailable.mockReset();
    mockCheckTypeScriptCompile.mockReset();
    mockCheckConfigExistsAndValidJson.mockReset();
    mockCheckRequiredEnvVars.mockReset();
    mockCheckEnvVarPatterns.mockReset();
    mockCheckAllowedPathsWritable.mockReset();
    mockCheckProviderAuth.mockReset();
    mockCheckTelegramToken.mockReset();
    mockCheckDiscordToken.mockReset();
    mockCheckBrowserBinaryIfEnabled.mockReset();
    mockCheckVoiceDependencies.mockReset();
    mockCheckMcpConfig.mockReset();
    mockCheckGatewayHostBindable.mockReset();
    mockCheckSkimpyclawDirWritable.mockReset();
    mockCheckPortAvailability.mockReset();
    mockCheckSandboxAvailable.mockReset();

    mockCheckNodeVersion.mockResolvedValue(okCheck('node_version', 'environment', 'v20.11.0'));
    mockCheckPackageManagerAvailable.mockResolvedValue(okCheck('package_manager_available', 'environment', 'pnpm'));
    mockCheckTypeScriptCompile.mockResolvedValue(okCheck('typescript_compile', 'environment'));
    mockCheckConfigExistsAndValidJson.mockResolvedValue(okCheck('config_json_valid', 'configuration'));
    mockCheckRequiredEnvVars.mockResolvedValue(okCheck('required_env_vars', 'configuration'));
    mockCheckEnvVarPatterns.mockResolvedValue(okCheck('env_var_patterns', 'configuration'));
    mockCheckAllowedPathsWritable.mockResolvedValue(okCheck('allowed_paths_writable', 'configuration'));
    mockCheckProviderAuth.mockResolvedValue(okCheck('provider_openai_auth', 'provider_auth'));
    mockCheckTelegramToken.mockResolvedValue(okCheck('telegram_token_valid', 'channels'));
    mockCheckDiscordToken.mockResolvedValue(okCheck('discord_token_valid', 'channels'));
    mockCheckBrowserBinaryIfEnabled.mockResolvedValue(okCheck('browser_binary_available', 'runtime'));
    mockCheckVoiceDependencies.mockResolvedValue(okCheck('voice_dependencies', 'runtime', 'Voice disabled'));
    mockCheckMcpConfig.mockResolvedValue(okCheck('mcp_config', 'runtime', 'MCP tools not configured'));
    mockCheckGatewayHostBindable.mockResolvedValue(okCheck('gateway_host_bindable', 'runtime', '127.0.0.1 (always available)'));
    mockCheckSkimpyclawDirWritable.mockResolvedValue(okCheck('skimpyclaw_dirs_writable', 'runtime'));
    mockCheckPortAvailability.mockResolvedValue(okCheck('gateway_port_available', 'runtime'));
    mockCheckSandboxAvailable.mockResolvedValue(okCheck('sandbox_available', 'runtime', 'Sandbox disabled'));
  });

  it('computes exit code 0 when all checks pass', () => {
    const code = computeExitCode({ checks: [okCheck('node_version', 'environment')] } as any);
    expect(code).toBe(0);
  });

  it('computes exit code 1 when any non-fatal check fails', () => {
    const code = computeExitCode({
      checks: [
        okCheck('node_version', 'environment'),
        { name: 'provider_openai_auth', category: 'provider_auth', ok: false, detail: '401' },
      ],
    } as any);
    expect(code).toBe(1);
  });

  it('computes exit code 2 when fatal config check fails', () => {
    const code = computeExitCode({
      checks: [
        { name: 'config_json_valid', category: 'configuration', ok: false, detail: 'invalid json', fatal: true },
      ],
    } as any);
    expect(code).toBe(2);
  });

  it('runs checks and returns aggregated report with timestamps', async () => {
    const { report, exitCode } = await runDoctor();

    expect(exitCode).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);
    expect(new Date(report.startedAt).toString()).not.toBe('Invalid Date');
    expect(new Date(report.finishedAt).toString()).not.toBe('Invalid Date');
  });

  it('skips provider and channel checks when integrations are disabled', async () => {
    mockLoadConfig.mockReturnValue({
      gateway: { port: 18790 },
      models: { providers: {} },
      channels: {
        telegram: { enabled: false, token: '', allowFrom: [] },
        discord: { enabled: false, token: '', allowFrom: [] },
      },
      agents: { default: 'main', list: {} },
      cron: { jobs: [] },
      heartbeat: { intervalMs: 60000, prompt: 'ping' },
    });

    const { report } = await runDoctor();

    expect(report.ok).toBe(true);
    expect(mockCheckProviderAuth).not.toHaveBeenCalled();
    expect(mockCheckTelegramToken).not.toHaveBeenCalled();
    expect(mockCheckDiscordToken).not.toHaveBeenCalled();
  });

  it('returns config-error exit code and skips dependent checks when config is fatally invalid', async () => {
    mockCheckConfigExistsAndValidJson.mockResolvedValue({
      name: 'config_json_valid',
      category: 'configuration',
      ok: false,
      fatal: true,
      detail: 'Unexpected token } in JSON at position 10',
      remedy: 'Fix config JSON',
    });

    const { report, exitCode } = await runDoctor();

    expect(exitCode).toBe(2);
    expect(report.ok).toBe(false);
    expect(mockCheckRequiredEnvVars).not.toHaveBeenCalled();
    expect(mockCheckEnvVarPatterns).not.toHaveBeenCalled();
    expect(mockCheckAllowedPathsWritable).not.toHaveBeenCalled();
    expect(mockCheckProviderAuth).not.toHaveBeenCalled();
    expect(mockCheckTelegramToken).not.toHaveBeenCalled();
    expect(mockCheckDiscordToken).not.toHaveBeenCalled();
  });

  it('captures thrown check errors as failed check results instead of crashing', async () => {
    mockCheckTypeScriptCompile.mockRejectedValue(new Error('tsc not found'));

    const { report, exitCode } = await runDoctor();

    expect(exitCode).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'typescript_compile',
          ok: false,
          detail: expect.stringContaining('tsc not found'),
        }),
      ])
    );
  });

  it('runs voice, mcp, and gateway host checks', async () => {
    await runDoctor();

    expect(mockCheckVoiceDependencies).toHaveBeenCalled();
    expect(mockCheckMcpConfig).toHaveBeenCalled();
    expect(mockCheckGatewayHostBindable).toHaveBeenCalled();
  });

  it('passes gateway host from config to host bindable check', async () => {
    mockLoadConfig.mockReturnValue({
      gateway: { port: 18790, host: '10.0.0.1' },
      models: { providers: {} },
      channels: {
        telegram: { enabled: false, token: '', allowFrom: [] },
        discord: { enabled: false, token: '', allowFrom: [] },
      },
      agents: { default: 'main', list: {} },
      cron: { jobs: [] },
      heartbeat: { intervalMs: 60000, prompt: 'ping' },
    });

    await runDoctor();

    expect(mockCheckGatewayHostBindable).toHaveBeenCalledWith('10.0.0.1');
  });

  it('defaults gateway host to 127.0.0.1 when not set', async () => {
    await runDoctor();

    expect(mockCheckGatewayHostBindable).toHaveBeenCalledWith('127.0.0.1');
  });
});
