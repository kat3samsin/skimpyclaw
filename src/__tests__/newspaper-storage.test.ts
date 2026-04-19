import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Edition } from '../newspaper/types.js';

// Mock fs and config before imports
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('../config.js', () => ({
  getLogsDir: vi.fn(() => '/tmp/test-skimpyclaw/logs'),
}));

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import {
  saveEdition,
  getEdition,
  getLatestEdition,
  getTodayEdition,
  listEditions,
  updateArticleRead,
  cleanupOldEditions,
} from '../newspaper/storage.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockUnlinkSync = vi.mocked(unlinkSync);

function makeEdition(overrides: Partial<Edition> = {}): Edition {
  return {
    id: '2026-04-11-morning',
    createdAt: '2026-04-11T11:48:00.000Z',
    slot: 'morning',
    leadStoryId: 'lead1',
    articles: [
      {
        id: 'lead1',
        title: 'Lead Story',
        url: 'https://example.com/lead',
        source: 'Example',
        section: 'us',
        rank: 1,
        sourceAttribution: 'Example',
        read: false,
        sources: [{ name: 'Example', url: 'https://example.com/lead' }],
      },
      {
        id: 'art2',
        title: 'Second Story',
        url: 'https://example.com/second',
        source: 'Example',
        section: 'ai',
        rank: 2,
        sourceAttribution: 'Example',
        read: false,
        sources: [{ name: 'Example', url: 'https://example.com/second' }],
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: index doesn't exist yet
  mockExistsSync.mockReturnValue(false);
});

describe('saveEdition', () => {
  it('writes edition JSON and updates index', () => {
    const edition = makeEdition();
    mockExistsSync.mockReturnValue(false);

    saveEdition(edition);

    // Should write the edition file
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('2026-04-11-morning.json'),
      expect.any(String),
      'utf-8',
    );

    // Should write the index
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('index.json'),
      expect.any(String),
      'utf-8',
    );

    // Verify edition content
    const editionCall = mockWriteFileSync.mock.calls.find(c =>
      (c[0] as string).includes('2026-04-11-morning.json'),
    );
    expect(editionCall).toBeTruthy();
    const written = JSON.parse(editionCall![1] as string);
    expect(written.id).toBe('2026-04-11-morning');
    expect(written.articles).toHaveLength(2);
  });
});

describe('getEdition', () => {
  it('returns edition when file exists', () => {
    const edition = makeEdition();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(edition));

    const result = getEdition('2026-04-11-morning');
    expect(result).toMatchObject({ id: '2026-04-11-morning' });
  });

  it('returns null when file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    const result = getEdition('nonexistent');
    expect(result).toBeNull();
  });
});

describe('getLatestEdition', () => {
  it('returns null when index is empty', () => {
    mockExistsSync.mockReturnValue(false);
    expect(getLatestEdition()).toBeNull();
  });

  it('returns the most recent edition from index', () => {
    const edition = makeEdition();
    const index = {
      editions: [
        { id: '2026-04-11-morning', createdAt: '2026-04-11T11:48:00.000Z', slot: 'morning', articleCount: 2 },
      ],
    };

    mockExistsSync.mockImplementation((path: any) => {
      const p = path as string;
      return p.includes('index.json') || p.includes('2026-04-11-morning.json') || p.includes('editions');
    });
    mockReadFileSync.mockImplementation((path: any) => {
      const p = path as string;
      if (p.includes('index.json')) return JSON.stringify(index);
      return JSON.stringify(edition);
    });

    const result = getLatestEdition();
    expect(result?.id).toBe('2026-04-11-morning');
  });
});

describe('getTodayEdition', () => {
  it('matches today using the Chicago calendar date', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-04-20T01:00:00Z'));

      const edition = makeEdition({
        id: '2026-04-19-evening',
        createdAt: '2026-04-20T00:30:00.000Z',
        slot: 'evening',
      });
      const index = {
        editions: [
          { id: '2026-04-19-evening', createdAt: '2026-04-20T00:30:00.000Z', slot: 'evening', articleCount: 2 },
        ],
      };

      mockExistsSync.mockImplementation((path: any) => {
        const p = path as string;
        return p.includes('index.json') || p.includes('2026-04-19-evening.json') || p.includes('editions');
      });
      mockReadFileSync.mockImplementation((path: any) => {
        const p = path as string;
        if (p.includes('index.json')) return JSON.stringify(index);
        return JSON.stringify(edition);
      });

      expect(getTodayEdition()?.id).toBe('2026-04-19-evening');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('listEditions', () => {
  it('returns empty array when no editions', () => {
    mockExistsSync.mockReturnValue(false);
    expect(listEditions()).toEqual([]);
  });
});

describe('updateArticleRead', () => {
  it('returns false when edition not found', () => {
    mockExistsSync.mockReturnValue(false);
    expect(updateArticleRead('nonexistent', 'art1', true)).toBe(false);
  });
});

describe('cleanupOldEditions', () => {
  it('deletes editions older than retention period', () => {
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(); // 100 days ago
    const recentDate = new Date().toISOString();
    const index = {
      editions: [
        { id: 'recent', createdAt: recentDate, slot: 'morning', articleCount: 5 },
        { id: 'old', createdAt: oldDate, slot: 'morning', articleCount: 3 },
      ],
    };

    mockExistsSync.mockImplementation((path: any) => {
      const p = path as string;
      return p.includes('index.json') || p.includes('old.json');
    });
    mockReadFileSync.mockReturnValue(JSON.stringify(index));

    const deleted = cleanupOldEditions(90);
    expect(deleted).toBe(1);
    expect(mockUnlinkSync).toHaveBeenCalledWith(expect.stringContaining('old.json'));
  });
});
