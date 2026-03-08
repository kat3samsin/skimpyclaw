// Shared utilities used across modules

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash, timingSafeEqual } from 'crypto';

/**
 * Format a Date as YYYY-MM-DD string.
 */
export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Extract an error message from an unknown caught value.
 */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read JSONL files from a dated directory (YYYY-MM-DD.jsonl), filtered by date range.
 * Returns records in reverse chronological order (newest first).
 */
export function readJsonlDir<T>(
  dir: string,
  startDate: string,
  endDate: string,
  filter?: (record: T) => boolean,
): T[] {
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .reverse(); // newest first

  const allRecords: T[] = [];

  for (const file of files) {
    const dateStr = file.replace('.jsonl', '');
    if (dateStr < startDate || dateStr > endDate) continue;

    const filePath = join(dir, file);
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const record = JSON.parse(lines[i]) as T;
          if (filter && !filter(record)) continue;
          allRecords.push(record);
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return allRecords;
}

/**
 * Timing-safe bearer token validation.
 * Returns true if the provided token matches the expected token.
 */
export function validateBearerToken(expected: string, authHeader: string | undefined): boolean {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const provided = authHeader.slice(7);
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}
