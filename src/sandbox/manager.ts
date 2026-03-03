import { createContainer, removeContainer, isContainerRunning } from './runtime.js';
import { validateMountPaths } from './mount-security.js';
import type { ContainerOpts } from './runtime.js';
import type { SandboxConfig } from '../types.js';

export const SANDBOX_DEFAULTS: SandboxConfig = {
  enabled: false,
  image: 'skimpyclaw-sandbox',
  cpus: 2,
  memory: '2G',
  network: 'bridge',
  idleTimeoutMs: 3_600_000,
};

interface ActiveContainer {
  name: string;
  sessionId: string;
  lastUsed: number;
}

const activeContainers = new Map<string, ActiveContainer>();

export async function ensureContainer(
  sessionId: string,
  config: SandboxConfig,
  allowedPaths: string[],
): Promise<string> {
  const name = `skimpyclaw-sbx-${sessionId}`;

  const existing = activeContainers.get(sessionId);
  if (existing) {
    const running = await isContainerRunning(existing.name);
    if (running) {
      existing.lastUsed = Date.now();
      return existing.name;
    }
    // Container died — remove from map, recreate
    activeContainers.delete(sessionId);
  }

  // Process restarts clear in-memory state; adopt or clean an existing named
  // container so a duplicate-name create does not fail.
  const alreadyRunning = await isContainerRunning(name);
  if (alreadyRunning) {
    activeContainers.set(sessionId, {
      name,
      sessionId,
      lastUsed: Date.now(),
    });
    return name;
  }
  // Best effort cleanup for stopped or half-created containers with same name.
  await removeContainer(name);

  const mounts = validateMountPaths(allowedPaths);
  const uid = process.getuid?.() ?? 501;
  const gid = process.getgid?.() ?? 20;

  const merged = { ...SANDBOX_DEFAULTS, ...config };
  const opts: ContainerOpts = {
    image: merged.image!,
    cpus: merged.cpus,
    memory: merged.memory,
    network: merged.network,
    mounts: mounts.map((m) => ({
      host: m.host,
      container: m.container,
      readOnly: m.readOnly,
    })),
    env: config.env,
    user: `${uid}:${gid}`,
  };

  await createContainer(name, opts);

  activeContainers.set(sessionId, {
    name,
    sessionId,
    lastUsed: Date.now(),
  });

  return name;
}

export async function releaseContainer(sessionId: string): Promise<void> {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;
  activeContainers.delete(sessionId);
  await removeContainer(entry.name);
}

export async function pruneIdle(maxIdleMs: number): Promise<number> {
  const now = Date.now();
  let pruned = 0;

  for (const [sessionId, entry] of activeContainers) {
    if (now - entry.lastUsed > maxIdleMs) {
      activeContainers.delete(sessionId);
      await removeContainer(entry.name);
      pruned++;
    }
  }

  return pruned;
}

export async function releaseAll(): Promise<void> {
  const entries = Array.from(activeContainers.values());
  activeContainers.clear();
  for (const entry of entries) {
    await removeContainer(entry.name);
  }
}

export function resetForTesting(): void {
  activeContainers.clear();
}
