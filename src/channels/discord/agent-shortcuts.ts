import { existsSync } from 'fs';
import { homedir } from 'node:os';
import { join } from 'path';

const CHIEF_DAILY_READER_DIR = join(homedir(), '.skimpyclaw', 'reports', 'chief-daily-reader');

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeDateParts(year: number, month: number, day: number): string | null {
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return null;
  }
  return formatLocalDate(date);
}

export function resolveChiefDailyReaderDateFromPrompt(prompt: string, now = new Date()): string | null {
  const text = prompt.trim();
  if (!/\b(newspaper|daily reader|reader)\b/i.test(text)) return null;
  if (/\b(regenerate|refresh|rebuild|force|re[- ]?run)\b/i.test(text)) return null;

  const iso = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    return normalizeDateParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  const slashed = text.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (slashed) {
    return normalizeDateParts(Number(slashed[3]), Number(slashed[1]), Number(slashed[2]));
  }

  if (/\btoday\b/i.test(text) || !/\d/.test(text)) {
    return formatLocalDate(now);
  }

  return null;
}

export function buildChiefDailyReaderArtifactPath(date: string): string {
  return join(CHIEF_DAILY_READER_DIR, `${date}.html`);
}

export function getChiefDailyReaderShortcutReply(
  alias: string,
  prompt: string,
  now = new Date(),
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (alias !== 'chief') return null;
  const date = resolveChiefDailyReaderDateFromPrompt(prompt, now);
  if (!date) return null;

  const artifactPath = buildChiefDailyReaderArtifactPath(date);
  if (!exists(artifactPath)) return null;

  return [
    `[Chief Daily Reader HTML](${artifactPath})`,
    '',
    `Found the existing ${date} newspaper, so I returned it instead of rerunning the agent. Say \`regenerate\` if you want a fresh run.`,
  ].join('\n');
}
