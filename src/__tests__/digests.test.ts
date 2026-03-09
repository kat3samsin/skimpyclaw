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

import { saveDigest, getDigest, deleteDigest, getDigestsDir } from '../digests.js';

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
});
