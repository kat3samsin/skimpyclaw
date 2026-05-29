import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, extname, join, resolve } from 'path';
import type { Config } from './types.js';

export interface RegisteredArtifact {
  id: string;
  path: string;
  name: string;
  contentType: string;
  createdAt: number;
}

const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_REGISTERED_ARTIFACTS = 200;
const artifacts = new Map<string, RegisteredArtifact>();
let persistedArtifactsLoaded = false;

function getArtifactContentType(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8';
  if (ext === '.md') return 'text/markdown; charset=utf-8';
  if (ext === '.txt' || ext === '.log') return 'text/plain; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.aiff' || ext === '.aif') return 'audio/aiff';
  return 'application/octet-stream';
}

function pruneRegisteredArtifacts(): void {
  if (artifacts.size <= MAX_REGISTERED_ARTIFACTS) return;
  const oldest = [...artifacts.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, artifacts.size - MAX_REGISTERED_ARTIFACTS);
  for (const artifact of oldest) artifacts.delete(artifact.id);
}

function getRegistryPath(): string | null {
  if (process.env.SKIMPYCLAW_ARTIFACT_REGISTRY_PATH) {
    return resolve(process.env.SKIMPYCLAW_ARTIFACT_REGISTRY_PATH);
  }
  if (process.env.VITEST) return null;
  return join(homedir(), '.skimpyclaw', 'artifacts-registry.json');
}

function loadPersistedArtifacts(): void {
  if (persistedArtifactsLoaded) return;
  persistedArtifactsLoaded = true;

  const registryPath = getRegistryPath();
  if (!registryPath || !existsSync(registryPath)) return;

  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf-8')) as unknown;
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const artifact = item as Partial<RegisteredArtifact>;
      if (
        typeof artifact.id === 'string' &&
        typeof artifact.path === 'string' &&
        typeof artifact.name === 'string' &&
        typeof artifact.contentType === 'string' &&
        typeof artifact.createdAt === 'number'
      ) {
        artifacts.set(artifact.id, {
          id: artifact.id,
          path: resolve(artifact.path),
          name: artifact.name,
          contentType: artifact.contentType,
          createdAt: artifact.createdAt,
        });
      }
    }
    pruneRegisteredArtifacts();
  } catch {
    // Artifact links are best-effort. A corrupt registry should not block the gateway.
  }
}

function persistRegisteredArtifacts(): void {
  const registryPath = getRegistryPath();
  if (!registryPath) return;

  try {
    mkdirSync(dirname(registryPath), { recursive: true });
    const entries = [...artifacts.values()].sort((a, b) => b.createdAt - a.createdAt);
    writeFileSync(registryPath, `${JSON.stringify(entries, null, 2)}\n`);
  } catch {
    // Artifact links remain valid in memory even when persistence fails.
  }
}

export function registerLocalArtifact(path: string): RegisteredArtifact | null {
  try {
    loadPersistedArtifacts();
    const resolvedPath = resolve(path);
    const stat = statSync(resolvedPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ARTIFACT_BYTES) return null;

    const id = randomBytes(12).toString('base64url');
    const artifact: RegisteredArtifact = {
      id,
      path: resolvedPath,
      name: basename(resolvedPath),
      contentType: getArtifactContentType(resolvedPath),
      createdAt: Date.now(),
    };
    artifacts.set(id, artifact);
    pruneRegisteredArtifacts();
    persistRegisteredArtifacts();
    return artifact;
  } catch {
    return null;
  }
}

export function getRegisteredArtifact(id: string): RegisteredArtifact | null {
  loadPersistedArtifacts();
  const artifact = artifacts.get(id);
  if (!artifact) return null;

  try {
    if (!existsSync(artifact.path)) {
      artifacts.delete(id);
      persistRegisteredArtifacts();
      return null;
    }
    const stat = statSync(artifact.path);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ARTIFACT_BYTES) {
      artifacts.delete(id);
      persistRegisteredArtifacts();
      return null;
    }
    return artifact;
  } catch {
    artifacts.delete(id);
    persistRegisteredArtifacts();
    return null;
  }
}

export function readRegisteredArtifact(id: string): { artifact: RegisteredArtifact; content: Buffer } | null {
  const artifact = getRegisteredArtifact(id);
  if (!artifact) return null;
  try {
    return { artifact, content: readFileSync(artifact.path) };
  } catch {
    artifacts.delete(id);
    persistRegisteredArtifacts();
    return null;
  }
}

export function buildArtifactUrl(config: Pick<Config, 'gateway'> | null | undefined, artifact: RegisteredArtifact): string | null {
  const port = config?.gateway?.port;
  if (!port) return null;

  const configuredHost = config.gateway.publicHost?.trim() || config.gateway.host?.trim();
  const host = configuredHost && configuredHost !== '0.0.0.0' && configuredHost !== '::'
    ? configuredHost
    : '127.0.0.1';
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${urlHost}:${port}/artifacts/${artifact.id}/${encodeURIComponent(artifact.name)}`;
}

export function clearRegisteredArtifactsForTesting(): void {
  artifacts.clear();
  persistedArtifactsLoaded = false;
  const registryPath = getRegistryPath();
  if (registryPath) {
    try {
      unlinkSync(registryPath);
    } catch {
      // ignore
    }
  }
}

export function clearRegisteredArtifactMemoryForTesting(): void {
  artifacts.clear();
  persistedArtifactsLoaded = false;
}
