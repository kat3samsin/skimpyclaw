import { realpathSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import { homedir } from 'os';

const BLOCKED_PATTERNS = [
  '.ssh',
  '.gnupg',
  '.gpg',
  '.aws',
  '.azure',
  '.gcloud',
  'credentials',
  '.env',
  '.npmrc',
  '.pypirc',
  '.docker/config.json',
  '.kube',
];

export interface MountSpec {
  host: string;
  container: string;
  readOnly: boolean;
}

export function isBlockedPath(resolvedPath: string): boolean {
  const segments = resolvedPath.split('/');
  for (const segment of segments) {
    if (BLOCKED_PATTERNS.includes(segment)) {
      return true;
    }
  }
  // Also check for compound patterns like .docker/config.json
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.includes('/') && resolvedPath.includes(pattern)) {
      return true;
    }
  }
  return false;
}

export function validateMountPaths(allowedPaths: string[]): MountSpec[] {
  const home = homedir();
  const mounts: MountSpec[] = [];
  const usedBaseNames = new Map<string, number>();

  for (const rawPath of allowedPaths) {
    const expanded = rawPath.startsWith('~')
      ? resolve(home, rawPath.slice(2))
      : resolve(rawPath);

    let resolved: string;
    try {
      if (!existsSync(expanded)) {
        continue; // Skip missing paths
      }
      resolved = realpathSync(expanded);
    } catch {
      continue; // Skip paths that can't be resolved
    }

    if (isBlockedPath(resolved)) {
      throw new Error(`Blocked path: ${resolved} matches security exclusion pattern`);
    }

    let base = basename(resolved);
    const count = usedBaseNames.get(base) ?? 0;
    usedBaseNames.set(base, count + 1);
    if (count > 0) {
      base = `${base}_${count}`;
    }

    mounts.push({
      host: resolved,
      container: `/workspace/${base}`,
      readOnly: false,
    });
  }

  // Always add ~/.skimpyclaw at /workspace/config
  const skimpyclawDir = resolve(home, '.skimpyclaw');
  if (existsSync(skimpyclawDir)) {
    const resolved = realpathSync(skimpyclawDir);
    // Only add if not already included
    if (!mounts.some((m) => m.host === resolved)) {
      mounts.push({
        host: resolved,
        container: '/workspace/config',
        readOnly: false,
      });
    }
  }

  return mounts;
}

/**
 * Translate a host path to its container equivalent using mount specs.
 * Returns the original path if no mount matches (will likely fail inside container).
 */
export function translatePath(hostPath: string, mounts: MountSpec[]): string {
  // Expand ~ to home directory (~ is a shell feature, not handled by resolve())
  const expanded = hostPath.startsWith('~/')
    ? homedir() + hostPath.slice(1)
    : hostPath;
  const candidates = getPathCandidates(expanded);

  // Sort by host path length descending so we match the most specific mount first
  const sorted = [...mounts].sort((a, b) => b.host.length - a.host.length);
  for (const candidate of candidates) {
    for (const mount of sorted) {
      if (candidate === mount.host || candidate.startsWith(mount.host + '/')) {
        const relative = candidate.slice(mount.host.length);
        return mount.container + relative;
      }
    }
  }
  return hostPath;
}

function getPathCandidates(hostPath: string): string[] {
  const set = new Set<string>();
  const resolved = resolve(hostPath);
  set.add(resolved);

  try {
    set.add(realpathSync(resolved));
  } catch {
    // Path may not exist yet (e.g. write targets); keep resolved form.
  }

  for (const p of Array.from(set)) {
    if (p.startsWith('/Users/')) {
      set.add(`/System/Volumes/Data${p}`);
    } else if (p.startsWith('/System/Volumes/Data/Users/')) {
      set.add(p.replace('/System/Volumes/Data', ''));
    }
  }

  return Array.from(set);
}
