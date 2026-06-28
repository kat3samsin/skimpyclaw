import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testState = vi.hoisted(() => ({
  logsDir: '',
}));

vi.mock('../config.js', () => ({
  getLogsDir: () => testState.logsDir,
}));

import { saveDigest, getDigest, deleteDigest, getDigestsDir, parseAndSaveDigest } from '../digests.js';

describe('digests index path resolution', () => {
  beforeEach(() => {
    testState.logsDir = fs.mkdtempSync(join(tmpdir(), 'skimpyclaw-digests-'));
  });

  afterEach(() => {
    fs.rmSync(testState.logsDir, { recursive: true, force: true });
  });

  it('resolves get/delete by indexed path without scanning directories', () => {
    const digest = {
      id: 'tech-digest-deadbeef',
      jobId: 'tech-digest',
      jobName: 'Tech Digest',
      createdAt: '2026-03-08T09:00:00.000Z',
      articles: [{ id: 'a1', title: 'Story', source: 'Web', url: 'https://example.com' }],
    };

    saveDigest(digest);
    const indexPath = join(getDigestsDir(), 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    expect(index[digest.id]).toEqual({ jobId: digest.jobId, date: '2026-03-08' });

    const loaded = getDigest(digest.id);
    expect(loaded?.id).toBe(digest.id);

    const deleted = deleteDigest(digest.id);
    expect(deleted).toBe(true);
    expect(getDigest(digest.id)).toBeNull();
  });

  it('rejects invalid digest ids and stale index entries safely', () => {
    expect(getDigest('../etc/passwd')).toBeNull();
    expect(deleteDigest('../etc/passwd')).toBe(false);

    const indexPath = join(getDigestsDir(), 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify({
      'tech-digest-deadbeef': { jobId: '../escape', date: '2026-03-08' },
    }), 'utf-8');

    expect(getDigest('tech-digest-deadbeef')).toBeNull();
    expect(deleteDigest('tech-digest-deadbeef')).toBe(false);
  });

  it('does not use markdown section headers as article titles', () => {
    const digest = parseAndSaveDigest(
      'news-digest',
      'News Digest',
      [
        '## World Headlines',
        'https://example.com/world-one',
        'https://example.com/world-two',
      ].join('\n'),
    );

    expect(digest.articles).toHaveLength(2);
    expect(digest.articles.map(a => a.title)).toEqual(['world one', 'world two']);
  });

  it('extracts titles from markdown links in digest output', () => {
    const digest = parseAndSaveDigest(
      'news-digest',
      'News Digest',
      [
        '# News Digest',
        '',
        '## US Headlines',
        '1. [Direct article title](https://example.com/news/direct-article) *(Example News)*',
      ].join('\n'),
    );

    expect(digest.articles).toHaveLength(1);
    expect(digest.articles[0]?.title).toBe('Direct article title');
    expect(digest.articles[0]?.url).toBe('https://example.com/news/direct-article');
  });

  it('ignores source error diagnostics when digest sources are unavailable', () => {
    const digest = parseAndSaveDigest(
      'ph-digest',
      'Reddit PH Evening Digest',
      [
        '🇵🇭 r/Philippines',
        '',
        'UNAVAILABLE (RuntimeError)',
        '',
        '💬 r/ChikaPH',
        '',
        'UNAVAILABLE (RuntimeError)',
        '',
        '🎤 r/bini_ph',
        '',
        'UNAVAILABLE (RuntimeError)',
        '',
        'Source errors:',
        '- r/Philippines: RSS RuntimeError: HTTPError: 403 Client Error: Blocked for url: https://www.reddit.com/r/Philippines/top.rss?t=day; HTTPError: 429 Client Error: Too Many Requests for url: https://old.reddit.com/r/Philippines/top/.rss?t=day',
        '- r/ChikaPH: RSS RuntimeError: HTTPError: 429 Client Error: Too Many Requests for url: https://www.reddit.com/r/ChikaPH/top.rss?t=day; JSON RuntimeError: HTTPError: HTTP Error 403: Blocked',
        '',
        '[ph_digest] UNAVAILABLE: no Reddit PH posts retrieved; all sources failed',
      ].join('\n'),
    );

    expect(digest.articles).toHaveLength(0);
  });

  it('preserves real article URLs before source error diagnostics', () => {
    const digest = parseAndSaveDigest(
      'ph-digest',
      'Reddit PH Evening Digest',
      [
        '🇵🇭 r/Philippines',
        '',
        '1. [Real PH story](https://example.com/real-ph-story)',
        '',
        'Source errors:',
        '- r/ChikaPH: HTTPError: 429 Client Error for url: https://www.reddit.com/r/ChikaPH/top.rss?t=day',
      ].join('\n'),
    );

    expect(digest.articles).toHaveLength(1);
    expect(digest.articles[0]?.title).toBe('Real PH story');
    expect(digest.articles[0]?.url).toBe('https://example.com/real-ph-story');
  });

});
