import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

import type { ToolConfig } from '../types.js';
import { isPathAllowed } from './path-utils.js';

/** Expand ~ to home directory */
function expandTilde(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

export function executeReadFile(path: string, config: ToolConfig): string {
  path = expandTilde(path);
  if (!isPathAllowed(path, config.allowedPaths)) {
    return `Error: Path not allowed. Permitted: ${config.allowedPaths.join(', ')}`;
  }
  if (!existsSync(path)) {
    return `Error: File not found: ${path}`;
  }
  const content = readFileSync(path, 'utf-8');
  if (content.length > 100_000) {
    return content.slice(0, 100_000) + '\n\n[TRUNCATED - file exceeds 100KB]';
  }
  return content;
}

function executeWriteFile(path: string, content: string, config: ToolConfig): string {
  if (!isPathAllowed(path, config.allowedPaths)) {
    return `Error: Path not allowed. Permitted: ${config.allowedPaths.join(', ')}`;
  }
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, content, 'utf-8');
  return `OK`;
}

/**
 * Write with file locking when a lockTaskId is provided (concurrent context).
 * Falls back to unlocked write when no lockTaskId.
 */
export async function executeWriteFileLocked(path: string, content: string, config: ToolConfig, lockTaskId?: string): Promise<string> {
  if (!lockTaskId) {
    return executeWriteFile(path, content, config);
  }

  const { acquireLock, releaseLock } = await import('../file-lock.js');
  const acquired = await acquireLock(path, lockTaskId);
  if (!acquired) {
    return `Error: Could not acquire file lock on ${path} (timed out after 30s)`;
  }

  try {
    return executeWriteFile(path, content, config);
  } finally {
    releaseLock(path, lockTaskId);
  }
}

export function executeListDirectory(path: string, config: ToolConfig): string {
  if (!isPathAllowed(path, config.allowedPaths)) {
    return `Error: Path not allowed. Permitted: ${config.allowedPaths.join(', ')}`;
  }
  if (!existsSync(path)) {
    return `Error: Directory not found: ${path}`;
  }
  const entries = readdirSync(path, { withFileTypes: true });
  if (entries.length === 0) return '(empty directory)';

  const lines = entries.map(e => {
    const type = e.isDirectory() ? 'dir' : 'file';
    if (e.isFile()) {
      const stat = statSync(join(path, e.name));
      return `${type}\t${e.name}\t${stat.size}`;
    }
    return `${type}\t${e.name}`;
  });
  return lines.join('\n');
}
