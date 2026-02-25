import { resolve, sep } from 'path';
import { realpathSync } from 'fs';

/**
 * Resolve a path to its real location, following symlinks.
 * Falls back to path.resolve() if the path doesn't exist yet (e.g. for writes).
 */
function safeRealpath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    // Path doesn't exist yet — resolve logically (normalizes .. but can't follow symlinks)
    return resolve(filePath);
  }
}

export function isPathAllowed(filePath: string, allowedPaths: string[]): boolean {
  const resolved = safeRealpath(filePath);
  return allowedPaths.some((allowed) => {
    const allowedRoot = safeRealpath(allowed);
    return resolved === allowedRoot || resolved.startsWith(`${allowedRoot}${sep}`);
  });
}
