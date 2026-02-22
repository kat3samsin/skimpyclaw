import { resolve, sep } from 'path';

export function isPathAllowed(filePath: string, allowedPaths: string[]): boolean {
  const resolved = resolve(filePath);
  return allowedPaths.some((allowed) => {
    const allowedRoot = resolve(allowed);
    return resolved === allowedRoot || resolved.startsWith(`${allowedRoot}${sep}`);
  });
}
