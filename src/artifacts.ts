import { randomBytes } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { basename, extname, resolve } from 'path';
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

function getArtifactContentType(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8';
  if (ext === '.md') return 'text/markdown; charset=utf-8';
  if (ext === '.txt' || ext === '.log') return 'text/plain; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function pruneRegisteredArtifacts(): void {
  if (artifacts.size <= MAX_REGISTERED_ARTIFACTS) return;
  const oldest = [...artifacts.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, artifacts.size - MAX_REGISTERED_ARTIFACTS);
  for (const artifact of oldest) artifacts.delete(artifact.id);
}

export function registerLocalArtifact(path: string): RegisteredArtifact | null {
  try {
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
    return artifact;
  } catch {
    return null;
  }
}

export function getRegisteredArtifact(id: string): RegisteredArtifact | null {
  const artifact = artifacts.get(id);
  if (!artifact) return null;

  try {
    if (!existsSync(artifact.path)) {
      artifacts.delete(id);
      return null;
    }
    const stat = statSync(artifact.path);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ARTIFACT_BYTES) {
      artifacts.delete(id);
      return null;
    }
    return artifact;
  } catch {
    artifacts.delete(id);
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
    return null;
  }
}

export function buildArtifactUrl(config: Pick<Config, 'gateway'> | null | undefined, artifact: RegisteredArtifact): string | null {
  const port = config?.gateway?.port;
  if (!port) return null;

  const configuredHost = config.gateway.host?.trim();
  const host = configuredHost && configuredHost !== '0.0.0.0' && configuredHost !== '::'
    ? configuredHost
    : '127.0.0.1';
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${urlHost}:${port}/artifacts/${artifact.id}/${encodeURIComponent(artifact.name)}`;
}

export function clearRegisteredArtifactsForTesting(): void {
  artifacts.clear();
}
