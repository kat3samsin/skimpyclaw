import { randomBytes } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, extname, join, resolve } from 'path';
import type { Config } from './types.js';
import { isPathAllowed } from './tools/path-utils.js';

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
const artifactRoots = new Map<string, string[]>();
let persistedArtifactsLoaded = false;

function getManagedArtifactRoots(): string[] {
  const root = join(homedir(), '.skimpyclaw');
  return [
    join(root, 'reports'),
    join(root, 'reviews'),
    join(root, 'logs', 'newspaper'),
  ];
}

function removeRegisteredArtifact(id: string): void {
  artifacts.delete(id);
  artifactRoots.delete(id);
}

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
  for (const artifact of oldest) removeRegisteredArtifact(artifact.id);
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
    const managedRoots = getManagedArtifactRoots();
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const artifact = item as Partial<RegisteredArtifact>;
      if (
        typeof artifact.id === 'string' &&
        typeof artifact.path === 'string' &&
        typeof artifact.createdAt === 'number'
      ) {
        try {
          const canonicalPath = realpathSync(resolve(artifact.path));
          if (!isPathAllowed(canonicalPath, managedRoots)) continue;
          artifacts.set(artifact.id, {
            id: artifact.id,
            path: canonicalPath,
            name: basename(canonicalPath),
            contentType: getArtifactContentType(canonicalPath),
            createdAt: artifact.createdAt,
          });
          artifactRoots.set(artifact.id, managedRoots);
        } catch {
          // Stale or unresolvable entries are ignored.
        }
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
    writeFileSync(registryPath, `${JSON.stringify(entries, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    chmodSync(registryPath, 0o600);
  } catch {
    // Artifact links remain valid in memory even when persistence fails.
  }
}

export function registerLocalArtifact(path: string, allowedRoots = getManagedArtifactRoots()): RegisteredArtifact | null {
  try {
    loadPersistedArtifacts();
    const resolvedPath = realpathSync(resolve(path));
    if (!isPathAllowed(resolvedPath, allowedRoots)) return null;
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
    artifactRoots.set(id, allowedRoots);
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
    const canonicalPath = realpathSync(artifact.path);
    const allowedRoots = artifactRoots.get(id) ?? getManagedArtifactRoots();
    if (!isPathAllowed(canonicalPath, allowedRoots)) throw new Error('Artifact path is outside managed roots');
    const stat = statSync(canonicalPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ARTIFACT_BYTES) {
      throw new Error('Artifact is not a readable file');
    }
    artifact.path = canonicalPath;
    artifact.name = basename(canonicalPath);
    artifact.contentType = getArtifactContentType(canonicalPath);
    return artifact;
  } catch {
    removeRegisteredArtifact(id);
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
    removeRegisteredArtifact(id);
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
  artifactRoots.clear();
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
  artifactRoots.clear();
  persistedArtifactsLoaded = false;
}
