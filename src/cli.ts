#!/usr/bin/env node

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { loadConfig, loadRawConfig, getConfigPath, saveConfig } from './config.js';
import type { Config } from './types.js';
import { startRuntime } from './service.js';
import { runSetup } from './setup.js';

const APP_NAME = 'skimpyclaw';
const DEFAULT_PORT = 18790;
const LAUNCHD_LABEL = 'com.skimpyclaw.gateway';
const LAUNCHD_PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);

function printHelp(): void {
  console.log(`Usage: ${APP_NAME} <command> [options]

Commands:
  start [--daemon]        Start service (foreground by default)
  stop                    Stop launchd daemon (macOS)
  restart                 Restart launchd daemon (macOS)
  status                  Show daemon and gateway status
  logs [--file name]      Show logs (stdout|stderr|app), default stdout
       [--lines N]
       [--follow]
  onboard [--dry-run]     Run interactive onboarding wizard
  setup                   Alias for onboard (supports --dry-run)
  config                  Show config JSON
  config path             Show config file path
  config get <key>        Read config value by dot path
  config set <key> <val>  Set config value (JSON value or string)
  model <alias|model>     Switch current runtime model
  send <message>          Send a message to the local gateway
  cron list               List cron jobs from gateway status
  cron run <id>           Trigger cron job by id
  help                    Show this help
`);
}

export function parseConfigValue(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

export function setDeepValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.').filter(Boolean);
  if (keys.length === 0) {
    throw new Error('Invalid key path');
  }

  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const next = current[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

export function getDeepValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split('.').filter(Boolean);
  if (keys.length === 0) {
    throw new Error('Invalid key path');
  }

  let current: unknown = obj;
  for (const key of keys) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function parseOption(args: string[], longFlag: string, fallback: string): string {
  const idx = args.indexOf(longFlag);
  if (idx === -1 || idx + 1 >= args.length) {
    return fallback;
  }
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function launchctlAvailable(): boolean {
  return process.platform === 'darwin' && spawnSync('which', ['launchctl'], { encoding: 'utf-8' }).status === 0;
}

function runLaunchctl(args: string[]): { ok: boolean; output: string } {
  const result = spawnSync('launchctl', args, { encoding: 'utf-8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  return { ok: result.status === 0, output };
}

function startDaemon(): number {
  if (!launchctlAvailable()) {
    console.error('Daemon control is only supported on macOS with launchctl.');
    return 1;
  }
  if (!existsSync(LAUNCHD_PLIST)) {
    console.error(`Launchd plist not found: ${LAUNCHD_PLIST}`);
    console.error('Run `skimpyclaw onboard` first.');
    return 1;
  }

  const result = runLaunchctl(['load', LAUNCHD_PLIST]);
  if (!result.ok && !result.output.includes('already loaded')) {
    console.error(result.output || 'Failed to load daemon');
    return 1;
  }
  console.log(`Daemon started: ${LAUNCHD_LABEL}`);
  return 0;
}

function stopDaemon(): number {
  if (!launchctlAvailable()) {
    console.error('Daemon control is only supported on macOS with launchctl.');
    return 1;
  }
  if (!existsSync(LAUNCHD_PLIST)) {
    console.error(`Launchd plist not found: ${LAUNCHD_PLIST}`);
    return 1;
  }

  const result = runLaunchctl(['unload', LAUNCHD_PLIST]);
  if (!result.ok && !result.output.includes('Could not find specified service')) {
    console.error(result.output || 'Failed to unload daemon');
    return 1;
  }

  console.log(`Daemon stopped: ${LAUNCHD_LABEL}`);
  return 0;
}

function daemonStatus(): string {
  if (!launchctlAvailable()) {
    return 'unsupported';
  }

  const result = runLaunchctl(['list', LAUNCHD_LABEL]);
  return result.ok ? 'loaded' : 'not-loaded';
}

async function requestGateway(path: string, init?: RequestInit, port?: number): Promise<any> {
  const cfgPort = port ?? loadConfig().gateway.port;
  const url = `http://127.0.0.1:${cfgPort}${path}`;

  const res = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
    signal: AbortSignal.timeout(5000),
  });

  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return body;
}

async function runForeground(): Promise<number> {
  console.log('👙🦞 SkimpyClaw starting...');
  const config = loadConfig();
  console.log('[config] Loaded');

  const runtime = await startRuntime(config);
  console.log(`[gateway] Listening on http://127.0.0.1:${config.gateway.port}`);
  console.log('👙🦞 SkimpyClaw running');

  await new Promise<void>((resolve) => {
    const shutdown = async (signal: string) => {
      console.log(`\n[shutdown] Received ${signal}`);
      await runtime.stop();
      console.log('👙🦞 SkimpyClaw stopped');
      resolve();
    };

    process.once('SIGINT', () => {
      void shutdown('SIGINT');
    });
    process.once('SIGTERM', () => {
      void shutdown('SIGTERM');
    });
  });

  return 0;
}

async function commandStatus(): Promise<number> {
  const ds = daemonStatus();

  let port = DEFAULT_PORT;
  try {
    port = loadConfig().gateway.port;
  } catch {
    // Keep default when config does not exist yet.
  }

  try {
    const health = await requestGateway('/health', undefined, port);
    const status = await requestGateway('/status', undefined, port);
    console.log(`Daemon: ${ds}`);
    console.log(`Gateway: running (http://127.0.0.1:${port})`);
    console.log(`Uptime: ${Math.round((health.uptime || 0) / 1000)}s`);
    console.log(`Agent: ${status.agent}`);
    console.log(`Model: ${status.model}`);
    console.log(`Last message: ${status.lastMessage || 'never'}`);
    console.log(`Cron jobs: ${Array.isArray(status.cronJobs) ? status.cronJobs.length : 0}`);
    return 0;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(`Daemon: ${ds}`);
    console.log(`Gateway: not reachable (http://127.0.0.1:${port})`);
    console.log(`Error: ${msg}`);
    return 1;
  }
}

function commandLogs(args: string[]): number {
  const logDir = join(homedir(), '.skimpyclaw', 'logs');
  const fileOpt = parseOption(args, '--file', 'stdout');
  const linesOpt = parseOption(args, '--lines', '200');
  const follow = hasFlag(args, '--follow');

  const fileMap: Record<string, string> = {
    stdout: 'stdout.log',
    stderr: 'stderr.log',
    app: 'app.log',
  };
  const filename = fileMap[fileOpt] || fileOpt;
  const path = join(logDir, filename);

  if (!existsSync(path)) {
    console.error(`Log file not found: ${path}`);
    return 1;
  }

  const lines = Number.parseInt(linesOpt, 10);
  const tailArgs = ['-n', Number.isNaN(lines) ? '200' : String(lines)];
  if (follow) {
    const child = spawn('tail', [...tailArgs, '-f', path], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    return 0;
  }

  const result = spawnSync('tail', [...tailArgs, path], { encoding: 'utf-8' });
  if (result.status !== 0) {
    console.error(result.stderr || 'Failed to read logs');
    return 1;
  }
  process.stdout.write(result.stdout);
  return 0;
}

function commandConfig(args: string[]): number {
  const sub = args[0];

  if (!sub) {
    const raw = loadRawConfig();
    console.log(JSON.stringify(raw, null, 2));
    return 0;
  }

  if (sub === 'path') {
    console.log(getConfigPath());
    return 0;
  }

  if (sub === 'get') {
    const key = args[1];
    if (!key) {
      console.error('Usage: skimpyclaw config get <key>');
      return 1;
    }
    const raw = loadRawConfig() as Record<string, unknown>;
    const value = getDeepValue(raw, key);
    if (value === undefined) {
      console.error(`Key not found: ${key}`);
      return 1;
    }
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return 0;
  }

  if (sub === 'set') {
    const key = args[1];
    const valueInput = args.slice(2).join(' ');
    if (!key || !valueInput) {
      console.error('Usage: skimpyclaw config set <key> <value>');
      return 1;
    }

    const raw = loadRawConfig() as Record<string, unknown>;
    const value = parseConfigValue(valueInput);
    setDeepValue(raw, key, value);
    saveConfig(raw as unknown as Config);
    console.log(`Updated ${key}`);
    return 0;
  }

  console.error('Usage: skimpyclaw config [path|get|set]');
  return 1;
}

async function commandModel(args: string[]): Promise<number> {
  const requested = args[0];
  if (!requested) {
    console.error('Usage: skimpyclaw model <alias|model>');
    return 1;
  }

  const config = loadConfig();
  const resolved = config.models.aliases[requested] || requested;
  const data = await requestGateway('/model', {
    method: 'POST',
    body: JSON.stringify({ model: resolved }),
  }, config.gateway.port);

  console.log(`Model set to ${data.model}`);
  return 0;
}

async function commandSend(args: string[]): Promise<number> {
  const message = args.join(' ').trim();
  if (!message) {
    console.error('Usage: skimpyclaw send <message>');
    return 1;
  }

  const config = loadConfig();
  const data = await requestGateway('/message', {
    method: 'POST',
    body: JSON.stringify({ message }),
  }, config.gateway.port);

  console.log(data.response || '');
  return 0;
}

async function commandCron(args: string[]): Promise<number> {
  const sub = args[0];
  const config = loadConfig();

  if (sub === 'list' || !sub) {
    const status = await requestGateway('/status', undefined, config.gateway.port);
    const jobs = Array.isArray(status.cronJobs) ? status.cronJobs : [];

    if (jobs.length === 0) {
      console.log('No cron jobs configured.');
      return 0;
    }

    for (const job of jobs) {
      console.log(`${job.id}\t${job.name}\t${job.nextRun || 'unknown'}`);
    }
    return 0;
  }

  if (sub === 'run') {
    const id = args[1];
    if (!id) {
      console.error('Usage: skimpyclaw cron run <id>');
      return 1;
    }

    const data = await requestGateway(`/cron/${id}/run`, { method: 'POST' }, config.gateway.port);
    console.log(`${data.status}: ${data.id}`);
    return 0;
  }

  console.error('Usage: skimpyclaw cron <list|run>');
  return 1;
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...args] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }

  try {
    if (command === 'start') {
      if (args.includes('--daemon')) {
        return startDaemon();
      }
      return await runForeground();
    }

    if (command === 'stop') {
      return stopDaemon();
    }

    if (command === 'restart') {
      const stopCode = stopDaemon();
      if (stopCode !== 0) {
        return stopCode;
      }
      return startDaemon();
    }

    if (command === 'status') {
      return await commandStatus();
    }

    if (command === 'logs') {
      return commandLogs(args);
    }

    if (command === 'onboard' || command === 'setup') {
      const dryRun = args.includes('--dry-run');
      await runSetup({ dryRun });
      return 0;
    }

    if (command === 'config') {
      return commandConfig(args);
    }

    if (command === 'model') {
      return await commandModel(args);
    }

    if (command === 'send') {
      return await commandSend(args);
    }

    if (command === 'cron') {
      return await commandCron(args);
    }

    console.error(`Unknown command: ${command}`);
    printHelp();
    return 1;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(msg);
    return 1;
  }
}

const isDirectExecution = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  runCli().then((code) => {
    process.exit(code);
  });
}
