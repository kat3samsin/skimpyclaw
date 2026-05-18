import { accessSync, constants, existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import net from 'net';
import type { Config } from '../types.js';
import type { DoctorCheckResult } from './types.js';
import { getConfigPath } from '../config.js';

function ok(name: string, category: DoctorCheckResult['category'], detail: string): DoctorCheckResult {
  return { name, category, ok: true, detail };
}

function fail(
  name: string,
  category: DoctorCheckResult['category'],
  detail: string,
  remedy?: string,
  fatal: boolean = false,
): DoctorCheckResult {
  return { name, category, ok: false, detail, remedy, fatal };
}

export async function checkNodeVersion(): Promise<DoctorCheckResult> {
  const name = 'node_version';
  const category = 'environment';
  const version = process.versions.node;
  const major = Number.parseInt(version.split('.')[0], 10);

  if (Number.isNaN(major)) {
    return fail(name, category, `Unable to parse Node.js version: ${version}`, 'Install Node.js 18 or newer.');
  }

  if (major < 18) {
    return fail(name, category, `Node.js ${version} detected`, 'Upgrade to Node.js 18 or newer.');
  }

  return ok(name, category, `v${version}`);
}

export async function checkPackageManagerAvailable(): Promise<DoctorCheckResult> {
  const name = 'package_manager_available';
  const category = 'environment';

  const pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf-8' });
  if (pnpm.status === 0) {
    return ok(name, category, `pnpm ${pnpm.stdout.trim()}`);
  }

  const npm = spawnSync('npm', ['--version'], { encoding: 'utf-8' });
  if (npm.status === 0) {
    return ok(name, category, `npm ${npm.stdout.trim()}`);
  }

  return fail(name, category, 'Neither pnpm nor npm is available', 'Install pnpm (preferred) or npm and ensure it is on PATH.');
}

export async function checkTypeScriptCompile(): Promise<DoctorCheckResult> {
  const name = 'typescript_compile';
  const category = 'environment';

  const run = spawnSync('pnpm', ['exec', 'tsc', '--noEmit', '--pretty', 'false'], {
    encoding: 'utf-8',
    cwd: process.cwd(),
  });

  if (run.status === 0) {
    return ok(name, category, 'tsc --noEmit passed');
  }

  const detail = (run.stderr || run.stdout || 'TypeScript compile check failed').trim().split('\n')[0];
  return fail(name, category, detail, 'Run "pnpm exec tsc --noEmit" locally and fix TypeScript errors.');
}

export async function checkConfigExistsAndValidJson(): Promise<DoctorCheckResult> {
  const name = 'config_json_valid';
  const category = 'configuration';
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return fail(
      name,
      category,
      `Config file not found: ${configPath}`,
      'Run "skimpyclaw onboard" to create ~/.skimpyclaw/config.json.',
      true,
    );
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    JSON.parse(raw);
    return ok(name, category, configPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(
      name,
      category,
      detail,
      'Fix ~/.skimpyclaw/config.json to valid JSON and rerun doctor.',
      true,
    );
  }
}

export async function checkRequiredEnvVars(config: Config): Promise<DoctorCheckResult> {
  const name = 'required_env_vars';
  const category = 'configuration';

  const missing: string[] = [];

  if (config.channels.telegram?.enabled && !config.channels.telegram.token?.trim()) {
    missing.push('TELEGRAM_BOT_TOKEN');
  }

  if (config.channels.discord?.enabled && !config.channels.discord.token?.trim()) {
    missing.push('DISCORD_BOT_TOKEN');
  }

  for (const [providerName, providerCfg] of Object.entries(config.models.providers || {})) {
    if (!providerCfg) continue;
    const key = providerCfg.apiKey || providerCfg.authToken;
    if (!key?.trim()) {
      missing.push(`${providerName.toUpperCase()}_API_KEY`);
    }
  }

  if (missing.length > 0) {
    return fail(name, category, `Missing values: ${missing.join(', ')}`, 'Set missing variables in ~/.skimpyclaw/.env and rerun doctor.');
  }

  return ok(name, category, 'All required env-backed values are present');
}

export async function checkEnvVarPatterns(config: Config): Promise<DoctorCheckResult> {
  const name = 'env_var_patterns';
  const category = 'configuration';

  const issues: string[] = [];

  const telegramToken = config.channels.telegram?.token || '';
  if (config.channels.telegram?.enabled && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(telegramToken)) {
    issues.push('TELEGRAM_BOT_TOKEN format looks invalid');
  }

  for (const [providerName, providerCfg] of Object.entries(config.models.providers || {})) {
    const key = providerCfg?.apiKey || providerCfg?.authToken || '';
    if (!key) continue;
    if (/anthropic/i.test(providerName) && !key.startsWith('sk-')) {
      issues.push(`${providerName} key should usually start with "sk-"`);
    }
  }

  if (issues.length > 0) {
    return fail(name, category, issues.join('; '), 'Verify API key/token formats in ~/.skimpyclaw/.env.');
  }

  return ok(name, category, 'Env value patterns look valid');
}

export async function checkAllowedPathsWritable(config: Config): Promise<DoctorCheckResult> {
  const name = 'allowed_paths_writable';
  const category = 'configuration';

  const paths = new Set<string>();

  for (const channel of [config.channels.telegram, config.channels.discord]) {
    if (!channel) continue;

    if (channel.tools?.allowedPaths) {
      channel.tools.allowedPaths.forEach((p) => paths.add(String(p)));
    }

    if (channel.defaultAllowedPaths) {
      channel.defaultAllowedPaths.forEach((p) => paths.add(String(p)));
    }
  }

  const failures: string[] = [];
  for (const path of paths) {
    try {
      accessSync(path, constants.W_OK);
    } catch {
      failures.push(path);
    }
  }

  if (failures.length > 0) {
    return fail(name, category, `Unwritable paths: ${failures.join(', ')}`, 'Fix filesystem permissions for tool allowlist paths.');
  }

  return ok(name, category, `${paths.size} paths writable`);
}

export async function checkProviderAuth(providerName: string, providerConfig: NonNullable<Config['models']['providers'][string]>): Promise<DoctorCheckResult> {
  const name = `provider_${providerName}_auth`;
  const category = 'provider_auth';

  const token = providerConfig.apiKey || providerConfig.authToken || '';
  if (!token) {
    return fail(name, category, 'Missing provider token', `Set ${providerName.toUpperCase()}_API_KEY in ~/.skimpyclaw/.env.`);
  }

  const normalized = providerName.toLowerCase();

  try {
    if (normalized === 'anthropic') {
      // OAuth tokens can't be validated via API (they use Claude Code's internal refresh flow)
      if (providerConfig.authToken) {
        return ok(name, category, 'OAuth token configured (refresh handled at runtime)');
      }

      const res = await fetch(`${providerConfig.baseURL || 'https://api.anthropic.com'}/v1/models`, {
        headers: {
          'x-api-key': token,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(7000),
      });

      if (!res.ok) {
        return fail(name, category, `${res.status} ${res.statusText}`, `Check ANTHROPIC_API_KEY and provider base URL.`);
      }

      return ok(name, category, `${res.status} ${res.statusText}`);
    }

    return ok(name, category, 'Skipped network auth check (unsupported provider type)');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(name, category, detail, `Check ${providerName.toUpperCase()}_API_KEY and network connectivity.`);
  }
}

export async function checkTelegramToken(token: string): Promise<DoctorCheckResult> {
  const name = 'telegram_token_valid';
  const category = 'channels';

  if (!token?.trim()) {
    return fail(name, category, 'Missing Telegram token', 'Set TELEGRAM_BOT_TOKEN in ~/.skimpyclaw/.env.');
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(7000),
    });
    const body = await res.json() as { ok?: boolean; description?: string; result?: { username?: string } };

    if (!res.ok || !body.ok) {
      const detail = body.description || `${res.status} ${res.statusText}`;
      return fail(name, category, detail, 'Check TELEGRAM_BOT_TOKEN in ~/.skimpyclaw/.env.');
    }

    return ok(name, category, `Connected as @${body.result?.username || 'unknown'}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(name, category, detail, 'Check network and TELEGRAM_BOT_TOKEN.');
  }
}

export async function checkDiscordToken(token: string): Promise<DoctorCheckResult> {
  const name = 'discord_token_valid';
  const category = 'channels';

  if (!token?.trim()) {
    return fail(name, category, 'Missing Discord token', 'Set DISCORD_BOT_TOKEN in ~/.skimpyclaw/.env.');
  }

  try {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(7000),
    });

    if (!res.ok) {
      return fail(name, category, `${res.status} ${res.statusText}`, 'Check DISCORD_BOT_TOKEN in ~/.skimpyclaw/.env.');
    }

    const body = await res.json() as { username?: string };
    return ok(name, category, `Connected as ${body.username || 'unknown'}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(name, category, detail, 'Check network and DISCORD_BOT_TOKEN.');
  }
}

export async function checkVoiceDependencies(config: Config): Promise<DoctorCheckResult> {
  const name = 'voice_dependencies';
  const category = 'runtime';

  if (!config.voice?.enabled) {
    return ok(name, category, 'Voice disabled');
  }

  const issues: string[] = [];

  const ffmpeg = spawnSync('which', ['ffmpeg'], { encoding: 'utf-8' });
  if (ffmpeg.status !== 0) {
    issues.push('ffmpeg not found');
  }

  // Check for STT: local whisper OR API provider
  const whisperCli = spawnSync('which', ['whisper-cli'], { encoding: 'utf-8' });
  const whisperPy = spawnSync('which', ['whisper'], { encoding: 'utf-8' });
  const hasLocalWhisper = whisperCli.status === 0 || whisperPy.status === 0;

  // Check if any API STT provider is configured
  const hasApiStt = Object.values(config.voice?.providers || {}).some(
    (p) => p && typeof p === 'object' && 'stt' in p,
  );

  if (!hasLocalWhisper && !hasApiStt) {
    issues.push('No STT available — install whisper-cli (brew install whisper-cpp) or configure an API STT provider (e.g. openai.stt)');
  }

  if (issues.length > 0) {
    return fail(name, category, issues.join('; '), 'Install ffmpeg, and either whisper-cli (brew install whisper-cpp) or add openai.stt to voice providers.');
  }

  const sttMethod = hasLocalWhisper ? (whisperCli.status === 0 ? 'whisper-cli' : 'whisper') : 'API STT';
  return ok(name, category, `ffmpeg and ${sttMethod} available`);
}

export async function checkMcpConfig(_config: Config): Promise<DoctorCheckResult> {
  const name = 'mcp_config';
  const category = 'runtime';

  // Check if any tool definitions reference MCP
  const rawConfigPath = join(homedir(), '.skimpyclaw', 'config.json');
  let hasMcpRef = false;
  try {
    const raw = readFileSync(rawConfigPath, 'utf-8');
    hasMcpRef = raw.includes('mcp__') || raw.includes('mcporter');
  } catch {
    // Config not readable — other checks handle that
  }

  if (!hasMcpRef) {
    return ok(name, category, 'MCP tools not configured');
  }

  const mcporterConfig = join(homedir(), '.mcporter', 'mcporter.json');
  if (!existsSync(mcporterConfig)) {
    return fail(name, category, `mcporter config not found at ${mcporterConfig}`, 'Run mcporter setup or create ~/.mcporter/mcporter.json.');
  }

  return ok(name, category, mcporterConfig);
}

export async function checkGatewayHostBindable(host: string): Promise<DoctorCheckResult> {
  const name = 'gateway_host_bindable';
  const category = 'runtime';

  if (host === '127.0.0.1' || host === '0.0.0.0' || host === 'localhost' || host === '::') {
    return ok(name, category, `${host} (always available)`);
  }

  // Try to bind briefly to verify the IP exists on a local interface
  const canBind = await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(0, host, () => {
      server.close(() => resolve(true));
    });
  });

  if (!canBind) {
    return fail(name, category, `Cannot bind to ${host}`, `Verify ${host} exists on a local network interface or set gateway.host to 127.0.0.1.`);
  }

  return ok(name, category, `${host} bindable`);
}

export async function checkSkimpyclawDirWritable(): Promise<DoctorCheckResult> {
  const name = 'skimpyclaw_dirs_writable';
  const category = 'runtime';
  const base = join(homedir(), '.skimpyclaw');

  if (!existsSync(base)) {
    return fail(name, category, `Directory not found: ${base}`, 'Run "skimpyclaw onboard" to initialize ~/.skimpyclaw.', true);
  }

  try {
    accessSync(base, constants.W_OK);
    return ok(name, category, base);
  } catch {
    return fail(name, category, `Directory not writable: ${base}`, 'Fix permissions for ~/.skimpyclaw.');
  }
}

export async function checkPortAvailability(port: number): Promise<DoctorCheckResult> {
  const name = 'gateway_port_available';
  const category = 'runtime';

  const canListen = await new Promise<boolean>((resolve) => {
    const server = net.createServer();

    server.once('error', () => {
      resolve(false);
    });

    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });

  if (!canListen) {
    // Check if SkimpyClaw itself is using the port
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        return ok(name, category, `Gateway already running on port ${port}`);
      }
    } catch { /* not our gateway */ }
    return fail(name, category, `Port ${port} already in use by another process`, `Free port ${port} or set a different gateway.port in config.`);
  }

  return ok(name, category, `Port ${port} is available`);
}
