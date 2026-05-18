import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clearRegisteredArtifactsForTesting } from '../artifacts.js';
import { findMissingLocalHtmlArtifactLinks, linkLocalHtmlArtifactsForDiscord } from '../channels/discord/utils.js';

let tempRoot: string | null = null;

afterEach(() => {
  clearRegisteredArtifactsForTesting();
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

function makeArtifactRoot(): string {
  tempRoot = mkdtempSync(join(tmpdir(), 'skimpy-discord-artifacts-'));
  return tempRoot;
}

describe('linkLocalHtmlArtifactsForDiscord', () => {
  it('rewrites safe local HTML report links to gateway artifact links', () => {
    const root = makeArtifactRoot();
    const reportPath = join(root, 'chief-daily-reader', '2026-05-17.html');
    mkdirSync(join(root, 'chief-daily-reader'), { recursive: true });
    writeFileSync(reportPath, '<!doctype html><title>Chief</title>', 'utf-8');

    const result = linkLocalHtmlArtifactsForDiscord(
      `Open [Chief Daily Reader](${reportPath})`,
      { gateway: { port: 18790, host: '127.0.0.1', mode: 'local' } },
      [root],
    );

    expect(result).toMatch(/\[Chief Daily Reader\]\(http:\/\/127\.0\.0\.1:18790\/artifacts\/[^/]+\/2026-05-17\.html\)/);
  });

  it('leaves local HTML links outside allowed artifact roots unchanged', () => {
    const root = makeArtifactRoot();
    const outsidePath = join(tmpdir(), 'outside-chief-report.html');
    writeFileSync(outsidePath, '<!doctype html><title>Outside</title>', 'utf-8');

    const input = `Open [Outside](${outsidePath})`;
    const result = linkLocalHtmlArtifactsForDiscord(
      input,
      { gateway: { port: 18790, host: '127.0.0.1', mode: 'local' } },
      [root],
    );

    expect(result).toBe(input);
    rmSync(outsidePath, { force: true });
  });

  it('detects missing local HTML artifact links inside allowed roots', () => {
    const root = makeArtifactRoot();
    const missingPath = join(root, 'mayora-daily-briefing', '2026-05-18.html');

    const missing = findMissingLocalHtmlArtifactLinks(
      `Open [Mayora Daily Briefing HTML](${missingPath})`,
      [root],
    );

    expect(missing).toEqual([
      { label: 'Mayora Daily Briefing HTML', path: missingPath },
    ]);
  });

  it('ignores missing local HTML links outside allowed roots', () => {
    const root = makeArtifactRoot();
    const outsidePath = join(tmpdir(), 'missing-mayora-report.html');

    const missing = findMissingLocalHtmlArtifactLinks(
      `Open [Outside](${outsidePath})`,
      [root],
    );

    expect(missing).toEqual([]);
  });

  it('does not register symlinked HTML files that resolve outside allowed roots', () => {
    const root = makeArtifactRoot();
    const reportsDir = join(root, 'reports');
    const outsideDir = join(root, 'outside');
    mkdirSync(reportsDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const outsidePath = join(outsideDir, 'outside.html');
    const symlinkPath = join(reportsDir, 'linked.html');
    writeFileSync(outsidePath, '<!doctype html><title>Outside</title>', 'utf-8');
    symlinkSync(outsidePath, symlinkPath);

    const input = `Open [Linked](${symlinkPath})`;
    const result = linkLocalHtmlArtifactsForDiscord(
      input,
      { gateway: { port: 18790, host: '127.0.0.1', mode: 'local' } },
      [reportsDir],
    );

    expect(result).toBe(input);
  });

  it('registers the resolved target for symlinked HTML files inside allowed roots', () => {
    const root = makeArtifactRoot();
    const reportsDir = join(root, 'reports');
    const targetDir = join(reportsDir, 'daily');
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, 'target.html');
    const symlinkPath = join(reportsDir, 'linked.html');
    writeFileSync(targetPath, '<!doctype html><title>Target</title>', 'utf-8');
    symlinkSync(targetPath, symlinkPath);

    const result = linkLocalHtmlArtifactsForDiscord(
      `Open [Linked](${symlinkPath})`,
      { gateway: { port: 18790, host: '127.0.0.1', mode: 'local' } },
      [reportsDir],
    );

    expect(result).toMatch(/\[Linked\]\(http:\/\/127\.0\.0\.1:18790\/artifacts\/[^/]+\/target\.html\)/);
  });
});
