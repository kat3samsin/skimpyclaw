import { basename, dirname, resolve, sep } from 'path';
import { lstatSync, realpathSync } from 'fs';

/**
 * Resolve a path for a containment check, following symlinks in the nearest
 * existing ancestor when the final path does not exist yet (e.g. for writes).
 */
function resolveForContainment(filePath: string): string | null {
  let current = resolve(filePath);
  const missingSegments: string[] = [];

  while (true) {
    try {
      return resolve(realpathSync(current), ...missingSegments.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;

      try {
        // An entry that exists but cannot be resolved is a dangling symlink.
        // Appending it lexically would allow writes to follow its outside target.
        lstatSync(current);
        return null;
      } catch (lstatError) {
        const lstatCode = (lstatError as NodeJS.ErrnoException).code;
        if (lstatCode !== 'ENOENT' && lstatCode !== 'ENOTDIR') return null;
        // The current segment is genuinely missing; inspect its parent.
      }

      const parent = dirname(current);
      if (parent === current) return null;
      missingSegments.push(basename(current));
      current = parent;
    }
  }
}

export function isPathAllowed(filePath: string, allowedPaths: string[]): boolean {
  const resolved = resolveForContainment(filePath);
  if (!resolved) return false;

  return allowedPaths.some((allowed) => {
    const allowedRoot = resolveForContainment(allowed);
    if (!allowedRoot) return false;
    return resolved === allowedRoot || resolved.startsWith(`${allowedRoot}${sep}`);
  });
}
