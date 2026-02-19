#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { loadConfig, loadRawConfig, getConfigPath, saveConfig } from './config.js';
import type { Config, ToolConfig } from './types.js';
import { startRuntime } from './service.js';
import { runSetup } from './setup.js';
import { runDoctor as runDoctorCommand } from './doctor/index.js';
import { executeTool, getToolDefinitions, BUILTIN_TOOL_DEFINITIONS, BROWSER_TOOL_DEFINITION } from './tools.js';

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
  onboard [--dry-run]     Run onboarding wizard (or validate setup only)
  config                  Show config JSON
  config path             Show config file path
  config get <key>        Read config value by dot path
  config set <key> <val>  Set config value (JSON value or string)
  model <alias|model>     Switch current runtime model
  models                  List providers and aliases
  send <message>          Send a message to the local gateway
  cron list               List cron jobs from gateway status
  cron run <id>           Trigger cron job by id
  doctor [--json]         Run preflight checks
  browser <action> ...    Run browser tool action (open/click/type/select/hover/scroll/waitFor/evaluate/getText/screenshot/wait/close)
  browser login [url]     Open real Chrome (no automation) for manual login. Cookies persist for agent use.
  tools list              List available tools (built-in + MCP)
  tools install <name>    Add MCP server (--command <cmd> [--args ...] or --url <url>)
  tools remove <name>     Remove MCP server
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

function getCliToolConfig(config: Config): ToolConfig {
  if (config.channels.telegram.tools) return config.channels.telegram.tools;
  if (config.channels.telegram.defaultAllowedPaths?.length) {
    return {
      enabled: true,
      allowedPaths: config.channels.telegram.defaultAllowedPaths,
      maxIterations: 100,
      bashTimeout: 15000,
    };
  }
  return {
    enabled: true,
    allowedPaths: [join(homedir(), '.skimpyclaw')],
    maxIterations: 100,
    bashTimeout: 15000,
  };
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

  let dashboardToken = '';
  try {
    const cfg = loadConfig();
    dashboardToken = (cfg as any).dashboard?.token || '';
  } catch { /* ignore */ }

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
    if (dashboardToken) {
      console.log(`Dashboard: http://127.0.0.1:${port}/dashboard`);
      console.log(`Dashboard token: ${dashboardToken}`);
    }
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

  // Try gateway-prefixed names first (new plist), fall back to old names
  const fileCandidates: Record<string, string[]> = {
    stdout: ['gateway.stdout.log', 'stdout.log'],
    stderr: ['gateway.stderr.log', 'stderr.log'],
    app: ['app.log'],
  };
  const candidates = fileCandidates[fileOpt] || [fileOpt];
  const path = candidates.map((f) => join(logDir, f)).find((p) => existsSync(p));

  if (!path) {
    console.error(`Log file not found. Tried: ${candidates.map((f) => join(logDir, f)).join(', ')}`);
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
  const config = loadConfig();
  const requested = args[0];
  if (!requested) {
    const aliases = Object.entries(config.models.aliases || {});
    console.log('Usage: skimpyclaw model <alias|model>\n');
    if (aliases.length > 0) {
      console.log('Available aliases:');
      for (const [alias, model] of aliases) {
        console.log(`  ${alias.padEnd(16)} → ${model}`);
      }
    } else {
      console.log('No aliases configured. Pass a full model name (e.g. anthropic/claude-sonnet-4-6).');
    }
    return 1;
  }

  const resolved = config.models.aliases[requested] || requested;
  const data = await requestGateway('/model', {
    method: 'POST',
    body: JSON.stringify({ model: resolved }),
  }, config.gateway.port);

  console.log(`Model set to ${data.model}`);
  return 0;
}

function commandModels(): number {
  const config = loadConfig();
  const providers = Object.entries(config.models.providers || {});
  const aliases = Object.entries(config.models.aliases || {});
  const currentModel = config.agents.list[config.agents.default]?.model || 'unknown';

  console.log(`Current: ${currentModel}\n`);

  if (providers.length > 0) {
    console.log('Providers:');
    for (const [name, cfg] of providers) {
      const url = (cfg as any).baseURL || (name === 'anthropic' ? 'api.anthropic.com' : '');
      console.log(`  ${name.padEnd(16)} ${url}`);
    }
    console.log('');
  }

  if (aliases.length > 0) {
    console.log('Aliases:');
    for (const [alias, model] of aliases) {
      console.log(`  ${alias.padEnd(16)} → ${model}`);
    }
    console.log('');
  }

  console.log(`Switch: skimpyclaw model <alias|provider/model>`);
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

async function commandBrowserLogin(args: string[], config: Config): Promise<number> {
  const url = args[0] || 'about:blank';
  const toolConfig = getCliToolConfig(config);
  const profileDir = toolConfig.browser?.profileDir || join(homedir(), '.skimpyclaw', 'browser-profile');
  const executablePath = toolConfig.browser?.executablePath || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

  if (!existsSync(profileDir)) {
    mkdirSync(profileDir, { recursive: true });
  }

  console.log(`Opening Chrome for login (profile: ${profileDir})`);
  console.log('Log in manually, then close the browser window when done.');
  console.log('Cookies will persist for agent use.');

  const chromeArgs = [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ];

  const child = spawn(executablePath, chromeArgs, {
    stdio: 'ignore',
    detached: false,
  });

  return new Promise((resolve) => {
    child.on('exit', (code) => {
      console.log('Browser closed. Login session saved.');
      resolve(code ?? 0);
    });
    child.on('error', (err) => {
      console.error(`Failed to launch Chrome: ${err.message}`);
      resolve(1);
    });
  });
}

async function commandBrowser(args: string[]): Promise<number> {
  const action = args[0];
  if (!action) {
    console.error('Usage: skimpyclaw browser <open|click|type|select|hover|scroll|waitFor|evaluate|getText|screenshot|wait|close|login> ...');
    return 1;
  }

  const config = loadConfig();

  if (action.toLowerCase() === 'login') {
    return commandBrowserLogin(args.slice(1), config);
  }

  const toolConfig = getCliToolConfig(config);

  if (!toolConfig.browser?.enabled) {
    console.error('Browser tool is disabled. Enable tools.browser.enabled in config.');
    return 1;
  }

  const normalizedAction = action.toLowerCase();
  const input: Record<string, any> = { action: normalizedAction };

  if (normalizedAction === 'open') {
    input.url = args[1];
    if (!input.url) {
      console.error('Usage: skimpyclaw browser open <url>');
      return 1;
    }
  } else if (normalizedAction === 'click') {
    input.selector = args[1];
    if (!input.selector) {
      console.error('Usage: skimpyclaw browser click <selector>');
      return 1;
    }
  } else if (normalizedAction === 'type') {
    input.selector = args[1];
    input.text = args.slice(2).join(' ');
    if (!input.selector || !input.text) {
      console.error('Usage: skimpyclaw browser type <selector> <text>');
      return 1;
    }
  } else if (normalizedAction === 'waitfor') {
    input.selector = args[1];
    if (hasFlag(args, '--text')) {
      const idx = args.indexOf('--text');
      input.text = args[idx + 1];
    }
  } else if (normalizedAction === 'screenshot') {
    input.file_path = args[1];
  } else if (normalizedAction === 'wait') {
    const idx = args.indexOf('--ms');
    if (idx !== -1) input.timeMs = Number(args[idx + 1]);
  } else if (normalizedAction === 'evaluate') {
    const scriptIdx = args.indexOf('--script');
    if (scriptIdx !== -1) {
      input.script = args.slice(scriptIdx + 1).join(' ');
    } else {
      input.script = args[1];
    }
    if (!input.script) {
      console.error('Usage: skimpyclaw browser evaluate --script "document.title"');
      return 1;
    }
  } else if (normalizedAction === 'gettext') {
    input.selector = args[1]; // optional
  } else if (normalizedAction === 'scroll') {
    if (args[1] && !args[1].startsWith('--')) {
      input.selector = args[1]; // scrollIntoView target
    }
    const dirIdx = args.indexOf('--direction');
    if (dirIdx !== -1) input.direction = args[dirIdx + 1];
    const amtIdx = args.indexOf('--amount');
    if (amtIdx !== -1) input.amount = Number(args[amtIdx + 1]);
  } else if (normalizedAction === 'select') {
    input.selector = args[1];
    input.text = args[2];
    if (!input.selector || !input.text) {
      console.error('Usage: skimpyclaw browser select <selector> <value>');
      return 1;
    }
  } else if (normalizedAction === 'hover') {
    input.selector = args[1];
    if (!input.selector) {
      console.error('Usage: skimpyclaw browser hover <selector>');
      return 1;
    }
  }

  if (hasFlag(args, '--headful')) input.headless = false;
  if (hasFlag(args, '--headless')) input.headless = true;
  const browserIdx = args.indexOf('--browser');
  if (browserIdx !== -1) input.type = args[browserIdx + 1];
  const slowIdx = args.indexOf('--slowmo');
  if (slowIdx !== -1) input.slowMoMs = Number(args[slowIdx + 1]);
  const uaIdx = args.indexOf('--user-agent');
  if (uaIdx !== -1) input.userAgent = args[uaIdx + 1];
  const exeIdx = args.indexOf('--executable');
  if (exeIdx !== -1) input.executablePath = args[exeIdx + 1];
  const wIdx = args.indexOf('--width');
  const hIdx = args.indexOf('--height');
  if (wIdx !== -1 && hIdx !== -1) {
    input.viewport = { width: Number(args[wIdx + 1]), height: Number(args[hIdx + 1]) };
  }

  const result = await executeTool('Browser', input, toolConfig);
  console.log(result);
  return result.startsWith('Error') ? 1 : 0;
}

async function commandTools(args: string[]): Promise<number> {
  const sub = args[0];

  if (sub === 'list' || !sub) {
    const config = loadConfig();
    const toolConfig = getCliToolConfig(config);
    const tools = await getToolDefinitions(toolConfig);

    // Group tools
    const builtinNames = new Set(BUILTIN_TOOL_DEFINITIONS.map(t => t.name));
    const browserName = BROWSER_TOOL_DEFINITION.name;

    console.log('Built-in tools:');
    for (const t of tools.filter(t => builtinNames.has(t.name))) {
      console.log(`  ${t.name.padEnd(20)} ${(t.description || '').split('\n')[0]}`);
    }

    const browser = tools.find(t => t.name === browserName);
    if (browser) {
      console.log('\nBrowser tool:');
      console.log(`  ${browser.name.padEnd(20)} ${(browser.description || '').split('\n')[0]}`);
    } else {
      console.log('\nBrowser tool: disabled');
    }

    const mcpTools = tools.filter(t => t.name.startsWith('mcp__'));
    if (mcpTools.length > 0) {
      // Group by server
      const byServer = new Map<string, any[]>();
      for (const t of mcpTools) {
        const parts = t.name.split('__');
        const server = parts[1];
        if (!byServer.has(server)) byServer.set(server, []);
        byServer.get(server)!.push(t);
      }

      console.log('\nMCP tools:');
      for (const [server, serverTools] of byServer) {
        console.log(`  [${server}]`);
        for (const t of serverTools) {
          const toolName = t.name.split('__').slice(2).join('__');
          console.log(`    ${toolName.padEnd(30)} ${(t.description || '').split('\n')[0]}`);
        }
      }
    } else {
      console.log('\nMCP tools: none discovered');
    }

    console.log(`\nTotal: ${tools.length} tools`);
    return 0;
  }

  if (sub === 'install') {
    const name = args[1];
    if (!name) {
      console.error('Usage: skimpyclaw tools install <name> --command <cmd> [--args <json-array>] | --url <url>');
      return 1;
    }

    const mcpConfigPath = join(homedir(), '.mcporter', 'mcporter.json');
    const rawConfig = existsSync(mcpConfigPath)
      ? JSON.parse(readFileSync(mcpConfigPath, 'utf-8'))
      : {};

    const entry: Record<string, any> = {};
    const commandIdx = args.indexOf('--command');
    const urlIdx = args.indexOf('--url');
    const argsIdx = args.indexOf('--args');

    if (commandIdx !== -1 && commandIdx + 1 < args.length) {
      entry.command = args[commandIdx + 1];
      if (argsIdx !== -1 && argsIdx + 1 < args.length) {
        try {
          entry.args = JSON.parse(args[argsIdx + 1]);
        } catch {
          console.error('--args must be a valid JSON array');
          return 1;
        }
      }
    } else if (urlIdx !== -1 && urlIdx + 1 < args.length) {
      entry.url = args[urlIdx + 1];
    } else {
      console.error('Provide --command <cmd> or --url <url>');
      return 1;
    }

    if (!rawConfig.mcpServers) {
      rawConfig.mcpServers = {};
    }
    rawConfig.mcpServers[name] = entry;
    writeFileSync(mcpConfigPath, JSON.stringify(rawConfig, null, 2) + '\n');
    console.log(`Installed MCP server "${name}" in ${mcpConfigPath}`);
    return 0;
  }

  if (sub === 'remove') {
    const name = args[1];
    if (!name) {
      console.error('Usage: skimpyclaw tools remove <name>');
      return 1;
    }

    const mcpConfigPath = join(homedir(), '.mcporter', 'mcporter.json');
    if (!existsSync(mcpConfigPath)) {
      console.error(`mcporter config not found: ${mcpConfigPath}`);
      return 1;
    }
    const rawConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));

    const servers = rawConfig.mcpServers;
    if (!servers || !servers[name]) {
      console.error(`MCP server "${name}" not found in config`);
      return 1;
    }
    delete servers[name];
    writeFileSync(mcpConfigPath, JSON.stringify(rawConfig, null, 2) + '\n');
    console.log(`Removed MCP server "${name}" from ${mcpConfigPath}`);
    return 0;
  }

  console.error('Usage: skimpyclaw tools <list|install|remove>');
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

    if (command === 'onboard') {
      await runSetup({ dryRun: args.includes('--dry-run') });
      return 0;
    }

    if (command === 'config') {
      return commandConfig(args);
    }

    if (command === 'model') {
      return await commandModel(args);
    }

    if (command === 'models') {
      return commandModels();
    }

    if (command === 'send') {
      return await commandSend(args);
    }

    if (command === 'cron') {
      return await commandCron(args);
    }

    if (command === 'doctor') {
      const json = args.includes('--json');
      const result = await runDoctorCommand({ json });
      console.log(result.output);
      return result.exitCode;
    }

    if (command === 'browser') {
      return await commandBrowser(args);
    }

    if (command === 'tools') {
      return await commandTools(args);
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
