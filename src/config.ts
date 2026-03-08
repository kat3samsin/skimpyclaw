// Config loader with environment variable expansion

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, chmodSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join, basename } from 'path';
import { spawnSync } from 'child_process';
import dotenv from 'dotenv';
import type { Config } from './types.js';

const CONFIG_PATH = join(homedir(), '.skimpyclaw', 'config.json');
const CONFIG_DIR = join(homedir(), '.skimpyclaw');
const ENV_PATH = join(homedir(), '.skimpyclaw', '.env');
let envLoaded = false;
const keychainCache = new Map<string, string>();

function ensureEnvLoaded(): void {
  if (envLoaded) return;
  dotenv.config({ path: ENV_PATH });
  envLoaded = true;
}

function resolveKeychainReference(raw: string): string {
  const [service, account] = raw.split('/');
  if (!service || !account) {
    console.warn(`[config] invalid keychain reference: ${raw} (expected service/account)`);
    return '';
  }

  if (process.platform !== 'darwin') {
    console.warn(`[config] keychain reference is only supported on macOS: ${raw}`);
    return '';
  }

  const cacheKey = `${service}/${account}`;
  const cached = keychainCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const result = spawnSync(
    'security',
    ['find-generic-password', '-s', service, '-a', account, '-w'],
    { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    console.warn(`[config] failed to resolve keychain secret ${cacheKey}: ${detail || 'not found'}`);
    return '';
  }

  const value = (result.stdout || '').trim();
  keychainCache.set(cacheKey, value);
  return value;
}

function expandStringReferences(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, token: string) => {
    if (token.startsWith('KEYCHAIN:')) {
      return resolveKeychainReference(token.slice('KEYCHAIN:'.length));
    }
    if (process.env[token] === undefined) {
      console.warn(`[config] env var \${${token}} is not set`);
    }
    return process.env[token] || '';
  });
}

function expandEnvVars(obj: any): any {
  if (typeof obj === 'string') {
    return expandStringReferences(obj);
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

export function isValidAgentId(agentId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(agentId);
}

export function getAgentDir(agentId: string): string {
  if (!isValidAgentId(agentId)) {
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
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
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
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2), { encoding: 'utf-8', mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);

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

/**
 * Resolve allowed paths for a given context. Priority:
 * 1. Explicit toolConfig.allowedPaths (if provided)
 * 2. Config top-level allowedPaths
 * 3. Fallback: ~/.skimpyclaw only
 */
export function resolveAllowedPaths(config: Config, overridePaths?: string[]): string[] {
  if (overridePaths?.length) return overridePaths;
  if (config.allowedPaths?.length) return config.allowedPaths;
  return [join(homedir(), '.skimpyclaw')];
}

export function readMemoryFile(agentId: string, filename: string): string {
  if (!isValidAgentId(agentId)) {
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
