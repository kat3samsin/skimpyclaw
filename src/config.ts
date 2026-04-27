// Config loader with environment variable expansion

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, chmodSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join, basename } from 'path';
import dotenv from 'dotenv';
import type { Config } from './types.js';
import { getSecureValue, setSecureValue, requireSecureStore } from './secure-store.js';

const CONFIG_PATH = join(homedir(), '.skimpyclaw', 'config.json');
const CONFIG_DIR = join(homedir(), '.skimpyclaw');
const ENV_PATH = join(homedir(), '.skimpyclaw', '.env');
const CONFIG_SECRET_SERVICE = 'skimpyclaw-config';
let envLoaded = false;
const keychainCache = new Map<string, string>();
const SECRET_KEY_PATTERN = /(api.?key|token|secret|password|auth.?token|private.?key)/i;
let warnedSecureStoreUnavailable = false;

function ensureEnvLoaded(): void {
  if (envLoaded) return;
  dotenv.config({ path: ENV_PATH });
  envLoaded = true;
}

function resolveKeychainReference(raw: string): string {
  const [service, ...accountParts] = raw.split('/');
  const account = accountParts.join('/');
  if (!service || !account) {
    throw new Error(`[config] Invalid keychain reference: ${raw} (expected service/account)`);
  }

  const cacheKey = `${service}/${account}`;
  const cached = keychainCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const value = getSecureValue(service, account);
  if (value === null) {
    throw new Error(
      `[config] Keychain secret not found for ${cacheKey}. Re-run setup or add it with: security add-generic-password -U -s ${service} -a ${account} -w '<secret>'`,
    );
  }

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

function isSecureReference(value: string): boolean {
  return value.startsWith('${') && value.endsWith('}');
}

function shouldSecureField(path: string[]): boolean {
  const key = path[path.length - 1] || '';
  return SECRET_KEY_PATTERN.test(key);
}

function sanitizeKeychainAccount(path: string[]): string {
  return path.join('.').replace(/[^\w.-]/g, '_');
}

function migratePlaintextSecrets(obj: unknown, path: string[] = []): { value: unknown; migrated: number } {
  if (Array.isArray(obj)) {
    let migrated = 0;
    const mapped = obj.map((item, index) => {
      const result = migratePlaintextSecrets(item, [...path, String(index)]);
      migrated += result.migrated;
      return result.value;
    });
    return { value: mapped, migrated };
  }

  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    let migrated = 0;
    for (const [key, value] of Object.entries(obj)) {
      const migratedValue = migratePlaintextSecrets(value, [...path, key]);
      result[key] = migratedValue.value;
      migrated += migratedValue.migrated;
    }
    return { value: result, migrated };
  }

  if (typeof obj !== 'string') {
    return { value: obj, migrated: 0 };
  }

  if (!shouldSecureField(path)) {
    return { value: obj, migrated: 0 };
  }

  const trimmed = obj.trim();
  if (!trimmed || trimmed === '[REDACTED]' || isSecureReference(trimmed)) {
    return { value: obj, migrated: 0 };
  }

  if (process.platform !== 'darwin') {
    if (!warnedSecureStoreUnavailable) {
      warnedSecureStoreUnavailable = true;
      console.warn('[config] Secure secret migration requires macOS Keychain. Plaintext values are preserved on this platform.');
    }
    return { value: obj, migrated: 0 };
  }

  requireSecureStore('Config secret migration');
  const account = sanitizeKeychainAccount(path);
  setSecureValue(CONFIG_SECRET_SERVICE, account, obj);
  return {
    value: `\${KEYCHAIN:${CONFIG_SECRET_SERVICE}/${account}}`,
    migrated: 1,
  };
}

function writeConfigFile(rawConfig: unknown): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(rawConfig, null, 2), { encoding: 'utf-8', mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
}

function loadAndMaybeMigrateRawConfig(): Record<string, any> {
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  const migrated = migratePlaintextSecrets(parsed);
  if (migrated.migrated > 0) {
    writeConfigFile(migrated.value);
    console.log(`[config] Migrated ${migrated.migrated} plaintext secret(s) to macOS Keychain`);
  }
  return migrated.value as Record<string, any>;
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

  const parsed = loadAndMaybeMigrateRawConfig();
  return expandEnvVars(parsed) as Config;
}

export function loadRawConfig(): Record<string, any> {
  ensureEnvLoaded();
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Config not found: ${CONFIG_PATH}\nRun 'pnpm run setup' to create one.`);
  }

  return loadAndMaybeMigrateRawConfig();
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
  const migrated = migratePlaintextSecrets(config);
  writeConfigFile(migrated.value);
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

  // Read raw config to preserve env var references, then add the token.
  // loadRawConfig() already runs migratePlaintextSecrets(), so no need to run it again.
  const raw = loadRawConfig();
  raw.dashboard = raw.dashboard || {};
  raw.dashboard.token = token;
  writeConfigFile(raw);

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
 * Resolve allowed paths for a given context. Named project paths are always
 * appended so channel-level tool overrides cannot accidentally hide them.
 */
export function resolveAllowedPaths(config: Config, overridePaths?: string[]): string[] {
  const basePaths = overridePaths?.length
    ? overridePaths
    : config.allowedPaths?.length
      ? config.allowedPaths
      : [join(homedir(), '.skimpyclaw')];
  const projectPaths = Object.values(config.projects || {});
  return [...new Set([...basePaths, ...projectPaths])];
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
