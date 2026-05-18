import { describe, expect, it } from 'vitest';
import {
  buildChiefDailyReaderArtifactPath,
  getChiefDailyReaderShortcutReply,
  resolveChiefDailyReaderDateFromPrompt,
} from '../channels/discord/agent-shortcuts.js';

describe('Discord agent shortcuts', () => {
  const today = new Date(2026, 4, 18);

  it('resolves chief daily reader dates from newspaper prompts', () => {
    expect(resolveChiefDailyReaderDateFromPrompt('newspaper 05/18/2026', today)).toBe('2026-05-18');
    expect(resolveChiefDailyReaderDateFromPrompt('daily reader 2026-05-18', today)).toBe('2026-05-18');
    expect(resolveChiefDailyReaderDateFromPrompt('newspaper today', today)).toBe('2026-05-18');
    expect(resolveChiefDailyReaderDateFromPrompt('newspaper', today)).toBe('2026-05-18');
  });

  it('skips shortcut resolution for invalid dates and explicit reruns', () => {
    expect(resolveChiefDailyReaderDateFromPrompt('newspaper 02/31/2026', today)).toBeNull();
    expect(resolveChiefDailyReaderDateFromPrompt('regenerate newspaper 05/18/2026', today)).toBeNull();
    expect(resolveChiefDailyReaderDateFromPrompt('summarize my PRs', today)).toBeNull();
  });

  it('returns an existing chief daily reader artifact link instead of rerunning the agent', () => {
    const artifactPath = buildChiefDailyReaderArtifactPath('2026-05-18');
    const reply = getChiefDailyReaderShortcutReply(
      'chief',
      'newspaper 05/18/2026',
      today,
      (path) => path === artifactPath,
    );

    expect(reply).toContain(`[Chief Daily Reader HTML](${artifactPath})`);
    expect(reply).toContain('returned it instead of rerunning the agent');
  });

  it('only returns shortcut replies for chief when the artifact exists', () => {
    expect(getChiefDailyReaderShortcutReply('mayora', 'newspaper 05/18/2026', today, () => true)).toBeNull();
    expect(getChiefDailyReaderShortcutReply('chief', 'newspaper 05/18/2026', today, () => false)).toBeNull();
  });
});
