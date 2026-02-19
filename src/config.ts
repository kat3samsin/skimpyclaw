// Config loader with environment variable expansion

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join, basename } from 'path';
import dotenv from 'dotenv';
import type { Config } from './types.js';

const CONFIG_PATH = join(homedir(), '.skimpyclaw', 'config.json');
const ENV_PATH = join(homedir(), '.skimpyclaw', '.env');
let envLoaded = false;

function ensureEnvLoaded(): void {
  if (envLoaded) return;
  dotenv.config({ path: ENV_PATH });
  envLoaded = true;
}

function expandEnvVars(obj: any): any {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{(\w+)\}/g, (_, key) => {
      if (process.env[key] === undefined) {
        console.warn(`[config] env var \${${key}} is not set`);
      }
      return process.env[key] || '';
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(expandEnvVars);
  }
  if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandEnvVars(value);
    }
    return result;
  }
  return obj;
}

export function loadConfig(): Config {
  ensureEnvLoaded();
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Config not found: ${CONFIG_PATH}\nRun 'pnpm run setup' to create one.`);
  }

  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  return expandEnvVars(parsed) as Config;
}

export function loadRawConfig(): Record<string, any> {
  ensureEnvLoaded();
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Config not found: ${CONFIG_PATH}\nRun 'pnpm run setup' to create one.`);
  }

  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  return JSON.parse(raw);
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function getAgentDir(agentId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
    throw new Error('Invalid agent ID');
  }
  return join(homedir(), '.skimpyclaw', 'agents', agentId);
}

export function getLogsDir(): string {
  return join(homedir(), '.skimpyclaw', 'logs');
}

export function getSessionsDir(): string {
  return join(homedir(), '.skimpyclaw', 'sessions');
}

export function saveConfig(config: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Ensures the config has a dashboard token. If not, generates one and saves it.
 * Returns the token.
 */
export function ensureDashboardToken(config: Config): string {
  if (config.dashboard?.token) {
    return config.dashboard.token;
  }

  const token = randomUUID();

  // Read raw config to preserve env var references, then add the token
  const raw = loadRawConfig();
  raw.dashboard = raw.dashboard || {};
  raw.dashboard.token = token;
  writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2), 'utf-8');

  // Update the in-memory config too
  if (!config.dashboard) {
    (config as any).dashboard = {};
  }
  config.dashboard!.token = token;

  return token;
}

export function listMemoryFiles(agentId: string): { name: string; date: string; size: number }[] {
  const memoryDir = join(getAgentDir(agentId), 'memory', 'logs');
  if (!existsSync(memoryDir)) {
    return [];
  }

  const files = readdirSync(memoryDir).filter(f => f.endsWith('.md'));
  return files.map(name => {
    const filePath = join(memoryDir, name);
    const stat = statSync(filePath);
    return {
      name,
      date: stat.mtime.toISOString(),
      size: stat.size,
    };
  }).sort((a, b) => b.date.localeCompare(a.date));
}

export function readMemoryFile(agentId: string, filename: string): string {
  // Validate agentId is a safe identifier
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
    throw new Error('Invalid agent ID');
  }
  // Validate no path traversal
  if (filename.includes('..') || filename !== basename(filename)) {
    throw new Error('Invalid filename');
  }

  const filePath = join(getAgentDir(agentId), 'memory', 'logs', filename);
  if (!existsSync(filePath)) {
    throw new Error('File not found');
  }

  return readFileSync(filePath, 'utf-8');
}
