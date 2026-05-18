#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { loadConfig, loadRawConfig, getConfigPath, saveConfig, resolveAllowedPaths } from './config.js';
import type { Config, ToolConfig } from './types.js';
import { startRuntime } from './service.js';
import { runSetup, renderGatewayPlist } from './setup.js';
import { runDoctor as runDoctorCommand } from './doctor/index.js';
import { getToolDefinitions, BUILTIN_TOOL_DEFINITIONS } from './tools.js';
import { formatModelSelectionError, getModelSelectionUsage, resolveModelSelection } from './model-selection.js';
import { cleanupLogs, formatCleanupSummary } from './log-cleanup.js';

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
  uninstall [--keep-data|--purge]
                          Remove launch agent and optionally purge ~/.skimpyclaw
  status                  Show daemon and gateway status
  logs [--file name]      Show logs (stdout|stderr|app), default stdout
       [--lines N]
       [--follow]
  logs cleanup [--dry-run]
                          Prune old runtime artifacts and scratch files
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
  tools list              List available tools (built-in + MCP)
  tools install <name>    Add MCP server (--command <cmd> [--args ...] or --url <url>)
  tools remove <name>     Remove MCP server
  agents                  List coding agents (active + recent)
  agents <id>             Show details for a coding agent (with live output)
  agents <id> --follow    Follow live output for an agent
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
  if (config.channels.telegram.tools) {
    return {
      ...config.channels.telegram.tools,
      allowedPaths: resolveAllowedPaths(config, config.channels.telegram.tools.allowedPaths),
    };
  }
  return {
    enabled: true,
    allowedPaths: resolveAllowedPaths(config),
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

  // Regenerate plist to point at the current binary (pnpm changes path on upgrade)
  try {
    const plistContent = renderGatewayPlist();
    const plistDir = join(homedir(), 'Library', 'LaunchAgents');
    if (!existsSync(plistDir)) mkdirSync(plistDir, { recursive: true });
    writeFileSync(LAUNCHD_PLIST, plistContent);
  } catch (err) {
    // If template is missing (e.g. corrupted install), fall back to existing plist
    if (!existsSync(LAUNCHD_PLIST)) {
      console.error(`Launchd plist not found: ${LAUNCHD_PLIST}`);
      console.error('Run `skimpyclaw onboard` first.');
      return 1;
    }
    console.warn(`Warning: could not regenerate plist (${err instanceof Error ? err.message : err}), using existing`);
  }

  const result = runLaunchctl(['load', LAUNCHD_PLIST]);
  if (!result.ok && !result.output.includes('already loaded')) {
    console.error(result.output || 'Failed to load daemon');
    return 1;
  }
  console.log(`Daemon started: ${LAUNCHD_LABEL}`);
  return 0;
}

// All launchd labels that may be running (current + legacy)
const ALL_LAUNCHD_LABELS = [LAUNCHD_LABEL, 'com.katre.skimpyclaw'];

function stopDaemon(): number {
  const launchAgentsDir = join(homedir(), 'Library', 'LaunchAgents');
  const uid = process.getuid?.();

  // 1. Unload and remove plists for all known labels
  if (launchctlAvailable()) {
    for (const label of ALL_LAUNCHD_LABELS) {
      const plist = join(launchAgentsDir, `${label}.plist`);
      if (existsSync(plist)) {
        runLaunchctl(['unload', plist]);
        rmSync(plist, { force: true });
        console.log(`Unloaded and removed: ${label}`);
      }
      // Also try bootout in case the service is loaded without a plist
      if (uid !== undefined) {
        runLaunchctl(['bootout', `gui/${uid}/${label}`]);
      }
    }
  }

  // 2. Kill anything still listening on the gateway port
  const lsofResult = spawnSync('lsof', ['-ti', `:${DEFAULT_PORT}`], { encoding: 'utf-8' });
  const pids = (lsofResult.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (pids.length > 0) {
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGTERM');
        console.log(`Killed process ${pid} on port ${DEFAULT_PORT}`);
      } catch {
        // already dead
      }
    }
  }

  console.log('Daemon stopped.');
  return 0;
}

function commandUninstall(args: string[]): number {
  const hasPurge = args.includes('--purge');
  const hasKeepData = args.includes('--keep-data');
  const unknownFlags = args.filter((arg) => arg.startsWith('--') && arg !== '--purge' && arg !== '--keep-data');

  if (unknownFlags.length > 0 || (hasPurge && hasKeepData)) {
    console.error('Usage: skimpyclaw uninstall [--keep-data|--purge]');
    return 1;
  }

  if (existsSync(LAUNCHD_PLIST) && launchctlAvailable()) {
    const stopResult = runLaunchctl(['unload', LAUNCHD_PLIST]);
    if (!stopResult.ok && !stopResult.output.includes('Could not find specified service')) {
      console.error(`Warning: failed to unload daemon: ${stopResult.output || 'unknown error'}`);
    }
  }

  if (existsSync(LAUNCHD_PLIST)) {
    rmSync(LAUNCHD_PLIST, { force: true });
    console.log(`Removed launch agent: ${LAUNCHD_PLIST}`);
  } else {
    console.log('No launch agent found.');
  }

  const dataDir = join(homedir(), '.skimpyclaw');
  if (hasPurge) {
    rmSync(dataDir, { recursive: true, force: true });
    console.log(`Purged data directory: ${dataDir}`);
  } else {
    console.log(`Kept data directory: ${dataDir}`);
  }

  console.log('To remove the global package, run: pnpm remove -g skimpyclaw');
  return 0;
}

function daemonStatus(): string {
  if (!launchctlAvailable()) {
    return 'unsupported';
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const probes: string[][] = [];
  if (uid !== undefined) {
    probes.push(['print', `gui/${uid}/${LAUNCHD_LABEL}`]);
  }
  probes.push(['list', LAUNCHD_LABEL]);
  probes.push(['print', `system/${LAUNCHD_LABEL}`]);

  for (const args of probes) {
    const result = runLaunchctl(args);
    if (result.ok) return 'loaded';
  }
  return 'not-loaded';
}

async function requestGateway(path: string, init?: RequestInit, port?: number): Promise<any> {
  const cfgPort = port ?? loadConfig().gateway.port;
  const url = `http://127.0.0.1:${cfgPort}${path}`;
  let dashboardToken = '';
  try {
    dashboardToken = String(loadConfig()?.dashboard?.token || '');
  } catch {
    // best effort
  }

  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (dashboardToken && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${dashboardToken}`);
  }

  const res = await fetch(url, {
    ...init,
    headers,
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
  let port = DEFAULT_PORT;
  let dashboardToken = '';
  try {
    const cfg = loadConfig();
    const cfgPort = Number(cfg?.gateway?.port);
    if (Number.isFinite(cfgPort) && cfgPort > 0) {
      port = cfgPort;
    }
    dashboardToken = String(cfg?.dashboard?.token || '');
  } catch {
    // Keep default when config does not exist yet.
  }

  const ds = daemonStatus();

  try {
    const health = await requestGateway('/health', undefined, port);
    const status = await requestGateway('/status', undefined, port);
    const daemonLine = ds === 'not-loaded' ? 'running (not managed by launchd)' : ds;
    console.log(`Daemon: ${daemonLine}`);
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
  if (args[0] === 'cleanup') {
    const summary = cleanupLogs({ dryRun: hasFlag(args, '--dry-run') });
    console.log(formatCleanupSummary(summary));
    if (summary.errors.length > 0) {
      console.error(summary.errors.join('\n'));
      return 1;
    }
    return 0;
  }

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
    console.log('Usage: skimpyclaw model <alias|provider/model|model-id>\n');
    console.log(`${getModelSelectionUsage()}\n`);
    if (aliases.length > 0) {
      console.log('Available aliases:');
      for (const [alias, model] of aliases) {
        console.log(`  ${alias.padEnd(16)} → ${model}`);
      }
    } else {
      console.log('No aliases configured. Pass a full model name (e.g. anthropic/claude-sonnet-4-5).');
    }
    return 1;
  }

  const selection = resolveModelSelection(requested, config);
  if (!selection.ok || !selection.resolved) {
    const errorMessage = selection.error || 'Invalid model selection';
    console.error(formatModelSelectionError(errorMessage, config));
    return 1;
  }

  const data = await requestGateway('/model', {
    method: 'POST',
    body: JSON.stringify({ model: selection.resolved }),
  }, config.gateway.port);

  console.log(`Model set to ${data.model}`);
  return 0;
}

function commandModels(): number {
  const config = loadConfig();
  const providers = Object.entries(config.models.providers || {});
  const aliases = Object.entries(config.models.aliases || {}).sort(([a], [b]) => a.localeCompare(b));
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

async function commandTools(args: string[]): Promise<number> {
  const sub = args[0];

  if (sub === 'list' || !sub) {
    const config = loadConfig();
    const toolConfig = getCliToolConfig(config);
    const tools = await getToolDefinitions(toolConfig);

    // Group tools
    const builtinNames = new Set([...BUILTIN_TOOL_DEFINITIONS.map(t => t.name), 'Fetch']);

    console.log('Built-in tools:');
    for (const t of tools.filter(t => builtinNames.has(t.name))) {
      console.log(`  ${t.name.padEnd(20)} ${(t.description || '').split('\n')[0]}`);
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

async function commandAgents(args: string[]): Promise<number> {
  const { getAllCodeAgents, getCodeAgent, restoreCodeAgentTasks } = await import('./code-agents/index.js');

  // Restore tasks from disk so we can see them
  restoreCodeAgentTasks();

  const id = args.find(a => !a.startsWith('-'));
  const follow = args.includes('--follow') || args.includes('-f');

  if (id) {
    // Show details for a specific agent
    const showAgent = () => {
      const agent = getCodeAgent(id);
      if (!agent) {
        console.error(`No coding agent found with ID "${id}".`);
        return false;
      }

      // Clear screen in follow mode
      if (follow) process.stdout.write('\x1b[2J\x1b[H');

      const elapsed = agent.durationSeconds != null
        ? agent.durationSeconds
        : Math.round((Date.now() - new Date(agent.startedAt).getTime()) / 1000);
      const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m${elapsed % 60}s`;

      console.log(`\x1b[1m${agent.id}\x1b[0m  ${agent.agent}  \x1b[33m${agent.status}\x1b[0m  (${elapsedStr})`);
      if (agent.model) console.log(`Model: ${agent.model}`);
      console.log(`Workdir: ${agent.workdir}`);
      console.log(`Task: ${agent.task.slice(0, 200)}${agent.task.length > 200 ? '...' : ''}`);

      // Show live output
      if (agent.liveOutput) {
        console.log(`\n\x1b[1mLive Output:\x1b[0m`);
        console.log(agent.liveOutput.slice(-3000));
      }

      // Show result
      if (agent.outputPreview) {
        console.log(`\n\x1b[1mResult:\x1b[0m`);
        console.log(agent.outputPreview.slice(0, 2000));
      }
      if (agent.error) {
        console.log(`\n\x1b[31mError: ${agent.error}\x1b[0m`);
      }
      if (agent.validationOutput) {
        console.log(`\n\x1b[1mValidation:\x1b[0m`);
        console.log(agent.validationOutput.slice(0, 1000));
      }

      return agent.status === 'running' || agent.status === 'validating' || agent.status === 'pending';
    };

    if (follow) {
      let stillRunning = showAgent();
      while (stillRunning) {
        await new Promise(r => setTimeout(r, 3000));
        restoreCodeAgentTasks();
        stillRunning = showAgent();
      }
      // Show final state
      showAgent();
      return 0;
    }

    showAgent();
    return 0;
  }

  // List all agents
  const all = getAllCodeAgents();
  if (all.length === 0) {
    console.log('No coding agents have run yet.');
    return 0;
  }

  // Group: active first, then recent
  const active = all.filter(a => a.status === 'running' || a.status === 'validating' || a.status === 'pending');
  const finished = all.filter(a => a.status !== 'running' && a.status !== 'validating' && a.status !== 'pending');

  if (active.length > 0) {
    console.log('\x1b[1mActive:\x1b[0m');
    for (const a of active) {
      const elapsed = Math.round((Date.now() - new Date(a.startedAt).getTime()) / 1000);
      const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m${elapsed % 60}s`;
      const taskPreview = a.task.slice(0, 80) + (a.task.length > 80 ? '...' : '');
      console.log(`  ${a.id}: \x1b[33m${a.status}\x1b[0m ${a.agent} (${elapsedStr})${taskPreview ? ` — ${taskPreview}` : ''}`);
    }
  }

  if (finished.length > 0) {
    console.log(active.length > 0 ? '\n\x1b[1mRecent:\x1b[0m' : '\x1b[1mRecent:\x1b[0m');
    for (const a of finished.slice(-15)) {
      const dur = a.durationSeconds != null
        ? (a.durationSeconds < 60 ? `${a.durationSeconds}s` : `${Math.floor(a.durationSeconds / 60)}m`)
        : '?';
      const icon = a.status === 'completed' ? '✅' : a.status === 'failed' ? '❌' : a.status === 'timeout' ? '⏰' : a.status === 'cancelled' ? '🚫' : '❓';
      const taskPreview = a.task.slice(0, 80) + (a.task.length > 80 ? '...' : '');
      console.log(`  ${icon} ${a.id}: ${a.status} ${a.agent} (${dur}) — ${taskPreview}`);
    }
  }

  return 0;
}
async function commandSandboxRemoved(): Promise<number> {
  console.error("The sandbox subsystem has been removed. Use exec-approval for command safety.");
  return 1;
}


export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...args] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    const pkgPath = join(fileURLToPath(import.meta.url), '..', '..', 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      console.log(`skimpyclaw v${pkg.version}`);
    } catch {
      console.log('skimpyclaw (version unknown)');
    }
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

    if (command === 'uninstall') {
      return commandUninstall(args);
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

    if (command === 'tools') {
      return await commandTools(args);
    }

    if (command === 'agents') {
      return await commandAgents(args);
    }

    if (command === 'sandbox') {
      return await commandSandboxRemoved();
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
