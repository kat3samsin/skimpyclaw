import { loadConfig } from '../config.js';
import type { Config } from '../types.js';
import {
  checkNodeVersion,
  checkPackageManagerAvailable,
  checkTypeScriptCompile,
  checkConfigExistsAndValidJson,
  checkRequiredEnvVars,
  checkEnvVarPatterns,
  checkAllowedPathsWritable,
  checkProviderAuth,
  checkTelegramToken,
  checkDiscordToken,
  checkBrowserBinaryIfEnabled,
  checkPlaywrightIfBrowserEnabled,
  checkVoiceDependencies,
  checkMcpConfig,
  checkGatewayHostBindable,
  checkSkimpyclawDirWritable,
  checkPortAvailability,
  checkSandboxAvailable,
} from './checks.js';
import type { DoctorCheckResult, DoctorRunResult, DoctorReport } from './types.js';

export function computeExitCode(report: Pick<DoctorReport, 'checks'>): 0 | 1 | 2 {
  if (report.checks.some((check) => !check.ok && check.fatal)) {
    return 2;
  }

  if (report.checks.some((check) => !check.ok)) {
    return 1;
  }

  return 0;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runSafe(
  name: string,
  category: DoctorCheckResult['category'],
  fn: () => Promise<DoctorCheckResult>,
): Promise<DoctorCheckResult> {
  try {
    const result = await fn();
    return {
      ...result,
      name: result.name || name,
      category: result.category || category,
    };
  } catch (error) {
    return {
      name,
      category,
      ok: false,
      detail: asErrorMessage(error),
      remedy: 'Fix the underlying error and rerun skimpyclaw doctor.',
    };
  }
}

function buildReport(startedAt: string, checks: DoctorCheckResult[]): DoctorReport {
  const finishedAt = new Date().toISOString();
  const temp: DoctorReport = {
    ok: checks.every((check) => check.ok),
    exitCode: 0,
    startedAt,
    finishedAt,
    checks,
  };

  const exitCode = computeExitCode(temp);
  temp.ok = exitCode === 0;
  temp.exitCode = exitCode;
  return temp;
}

function providerEntries(config: Config): Array<[string, NonNullable<Config['models']['providers'][string]>]> {
  const entries: Array<[string, NonNullable<Config['models']['providers'][string]>]> = [];
  for (const [name, provider] of Object.entries(config.models.providers || {})) {
    if (!provider) continue;
    entries.push([name, provider]);
  }
  return entries;
}

export async function runDoctor(): Promise<DoctorRunResult> {
  const startedAt = new Date().toISOString();
  const checks: DoctorCheckResult[] = [];

  checks.push(await runSafe('node_version', 'environment', () => checkNodeVersion()));
  checks.push(await runSafe('package_manager_available', 'environment', () => checkPackageManagerAvailable()));
  checks.push(await runSafe('typescript_compile', 'environment', () => checkTypeScriptCompile()));

  const configJson = await runSafe('config_json_valid', 'configuration', () => checkConfigExistsAndValidJson());
  checks.push(configJson);

  if (!configJson.ok && configJson.fatal) {
    const report = buildReport(startedAt, checks);
    return { report, exitCode: report.exitCode };
  }

  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    checks.push({
      name: 'config_load',
      category: 'configuration',
      ok: false,
      detail: asErrorMessage(error),
      remedy: 'Fix config or environment values and rerun skimpyclaw doctor.',
      fatal: true,
    });

    const report = buildReport(startedAt, checks);
    return { report, exitCode: report.exitCode };
  }

  checks.push(await runSafe('required_env_vars', 'configuration', () => checkRequiredEnvVars(config)));
  checks.push(await runSafe('env_var_patterns', 'configuration', () => checkEnvVarPatterns(config)));
  checks.push(await runSafe('allowed_paths_writable', 'configuration', () => checkAllowedPathsWritable(config)));

  const hasFatalConfigFailure = checks.some((check) => check.category === 'configuration' && !check.ok && check.fatal);
  if (!hasFatalConfigFailure) {
    for (const [providerName, providerCfg] of providerEntries(config)) {
      checks.push(await runSafe(`provider_${providerName}_auth`, 'provider_auth', () => checkProviderAuth(providerName, providerCfg)));
    }

    if (config.channels.telegram?.enabled) {
      checks.push(await runSafe('telegram_token_valid', 'channels', () => checkTelegramToken(config.channels.telegram.token)));
    }

    const discord = config.channels.discord;
    if (discord?.enabled) {
      checks.push(await runSafe('discord_token_valid', 'channels', () => checkDiscordToken(discord.token)));
    }
  }

  checks.push(await runSafe('browser_binary_available', 'runtime', () => checkBrowserBinaryIfEnabled(config)));
  checks.push(await runSafe('playwright_installed', 'runtime', () => checkPlaywrightIfBrowserEnabled(config)));
  checks.push(await runSafe('voice_dependencies', 'runtime', () => checkVoiceDependencies(config)));
  checks.push(await runSafe('mcp_config', 'runtime', () => checkMcpConfig(config)));
  checks.push(await runSafe('gateway_host_bindable', 'runtime', () => checkGatewayHostBindable(config.gateway.host ?? '127.0.0.1')));
  checks.push(await runSafe('skimpyclaw_dirs_writable', 'runtime', () => checkSkimpyclawDirWritable()));
  checks.push(await runSafe('gateway_port_available', 'runtime', () => checkPortAvailability(config.gateway.port)));
  checks.push(await runSafe('sandbox_available', 'runtime', () => checkSandboxAvailable(config)));

  const report = buildReport(startedAt, checks);
  return { report, exitCode: report.exitCode };
}
