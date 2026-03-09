import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

describe('discord documentation maintenance', () => {
  it('keeps Discord process and changelog docs present and linked from README', () => {
    const processDocPath = 'docs/guide/discord-updates.md';
    const changelogPath = 'docs/guide/changelog.md';

    expect(existsSync(resolve(repoRoot, processDocPath))).toBe(true);
    expect(existsSync(resolve(repoRoot, changelogPath))).toBe(true);

    const readme = read('README.md');
    expect(readme).toContain(`[${processDocPath}](${processDocPath})`);
    expect(readme).toContain(`[${changelogPath}](${changelogPath})`);
  });

  it('documents required Discord update recording steps', () => {
    const processDoc = read('docs/guide/discord-updates.md');
    const changelog = read('docs/guide/changelog.md');

    expect(processDoc).toContain('## Required Documentation Updates');
    expect(processDoc).toContain('docs/guide/changelog.md');
    expect(processDoc).toContain('## Validation Checklist');

    expect(changelog).toContain('## Unreleased');
    expect(changelog).toContain('Discord:');
  });
});
