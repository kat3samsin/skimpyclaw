// Edition storage — JSON files on disk

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { getLogsDir } from '../config.js';
import type { Edition, EditionListItem, EditionIndex, EditionIndexEntry, Section } from './types.js';
import { getChicagoDateString } from './time.js';

const NEWSPAPER_DIR = 'newspaper';
const EDITIONS_DIR = 'editions';
const INDEX_FILE = 'index.json';

export function getNewspaperDir(): string {
  const dir = join(getLogsDir(), NEWSPAPER_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getEditionsDir(): string {
  const dir = join(getNewspaperDir(), EDITIONS_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getIndexPath(): string {
  return join(getNewspaperDir(), INDEX_FILE);
}

function loadIndex(): EditionIndex {
  const indexPath = getIndexPath();
  if (!existsSync(indexPath)) return { editions: [] };
  try {
    return JSON.parse(readFileSync(indexPath, 'utf-8')) as EditionIndex;
  } catch {
    return { editions: [] };
  }
}

function saveIndex(index: EditionIndex): void {
  writeFileSync(getIndexPath(), JSON.stringify(index, null, 2), 'utf-8');
}

function editionFilePath(id: string): string {
  // Validate ID to prevent path traversal
  if (id.includes('/') || id.includes('\\') || id.includes('..') || id.includes('\0')) {
    throw new Error(`Invalid edition ID: ${id}`);
  }
  return join(getEditionsDir(), `${id}.json`);
}

/**
 * Save an edition to disk and update the index.
 */
export function saveEdition(edition: Edition): void {
  const filePath = editionFilePath(edition.id);
  writeFileSync(filePath, JSON.stringify(edition, null, 2), 'utf-8');

  // Update index
  const index = loadIndex();
  const existing = index.editions.findIndex(e => e.id === edition.id);
  const entry: EditionIndexEntry = {
    id: edition.id,
    createdAt: edition.createdAt,
    slot: edition.slot,
    articleCount: edition.articles.length,
  };

  if (existing >= 0) {
    index.editions[existing] = entry;
  } else {
    index.editions.push(entry);
  }

  // Sort by createdAt desc
  index.editions.sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  saveIndex(index);
}

/**
 * Load an edition by ID.
 */
export function getEdition(id: string): Edition | null {
  try {
    const filePath = editionFilePath(id);
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Edition;
  } catch {
    return null;
  }
}

/**
 * Get the latest edition (most recent by creation time).
 */
export function getLatestEdition(): Edition | null {
  const index = loadIndex();
  if (index.editions.length === 0) return null;
  return getEdition(index.editions[0].id);
}

/**
 * Get today's edition for a specific slot.
 */
export function getTodayEdition(slot?: 'morning' | 'evening'): Edition | null {
  const today = getChicagoDateString(new Date());
  const index = loadIndex();

  for (const entry of index.editions) {
    if (entry.id.startsWith(today)) {
      if (!slot || entry.slot === slot) {
        return getEdition(entry.id);
      }
    }
  }

  // Fallback: return the latest edition
  return getLatestEdition();
}

/**
 * List editions for the archive view.
 */
export function listEditions(limit: number = 30, offset: number = 0): EditionListItem[] {
  const index = loadIndex();
  const slice = index.editions.slice(offset, offset + limit);

  return slice.map(entry => {
    const edition = getEdition(entry.id);
    const sections = edition
      ? [...new Set(edition.articles.map(a => a.section))] as Section[]
      : [];
    const leadArticle = edition?.articles.find(a => a.id === edition.leadStoryId);

    return {
      id: entry.id,
      createdAt: entry.createdAt,
      slot: entry.slot,
      articleCount: entry.articleCount,
      sections,
      leadStoryTitle: leadArticle?.title,
    };
  });
}

/**
 * Update article read status within an edition.
 */
export function updateArticleRead(editionId: string, articleId: string, read: boolean): boolean {
  const edition = getEdition(editionId);
  if (!edition) return false;

  const article = edition.articles.find(a => a.id === articleId);
  if (!article) return false;

  article.read = read;
  saveEdition(edition);
  return true;
}

/**
 * Delete editions older than retentionDays.
 */
export function cleanupOldEditions(retentionDays: number = 90): number {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const index = loadIndex();
  let deleted = 0;

  const kept: EditionIndexEntry[] = [];
  for (const entry of index.editions) {
    if (new Date(entry.createdAt) < cutoff) {
      try {
        const filePath = editionFilePath(entry.id);
        if (existsSync(filePath)) unlinkSync(filePath);
        deleted++;
      } catch { /* ignore */ }
    } else {
      kept.push(entry);
    }
  }

  if (deleted > 0) {
    index.editions = kept;
    saveIndex(index);
  }

  return deleted;
}
