import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { loadSkills, getSkillsForContext, formatSkillsPrompt, checkEligibility, clearSkillsCache } from '../skills.js';
import type { LoadedSkill } from '../skills-types.js';

// Create a temp skills directory for each test
let skillsDir: string;

beforeEach(() => {
  clearSkillsCache();
  skillsDir = join(tmpdir(), `skimpyclaw-skills-test-${Date.now()}-${randomUUID()}`);
  mkdirSync(skillsDir, { recursive: true });
});

afterEach(() => {
  clearSkillsCache();
  rmSync(skillsDir, { recursive: true, force: true });
});

function writeSkill(name: string, content: string): void {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content);
}

describe('loadSkills', () => {
  it('loads skills from directory with YAML frontmatter', () => {
    writeSkill('greeting', `---
name: greeting
description: Greet the user
emoji: "👋"
priority: 10
---
Say hello warmly.`);

    const skills = loadSkills({ directory: skillsDir });
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('greeting');
    expect(skills[0].frontmatter.description).toBe('Greet the user');
    expect(skills[0].frontmatter.emoji).toBe('👋');
    expect(skills[0].frontmatter.priority).toBe(10);
    expect(skills[0].body).toBe('Say hello warmly.');
    expect(skills[0].eligible).toBe(true);
  });

  it('uses directory name as fallback skill name', () => {
    writeSkill('my-tool', `---
description: A tool skill
---
Does things.`);

    const skills = loadSkills({ directory: skillsDir });
    expect(skills[0].name).toBe('my-tool');
  });

  it('sorts by priority (lower first), then alphabetically', () => {
    writeSkill('beta', `---
name: beta
description: B
priority: 20
---
B`);
    writeSkill('alpha', `---
name: alpha
description: A
priority: 10
---
A`);
    writeSkill('gamma', `---
name: gamma
description: G
priority: 10
---
G`);

    const skills = loadSkills({ directory: skillsDir });
    expect(skills.map(s => s.name)).toEqual(['alpha', 'gamma', 'beta']);
  });

  it('defaults priority to 100', () => {
    writeSkill('no-priority', `---
name: no-priority
description: No priority set
---
Body`);

    const skills = loadSkills({ directory: skillsDir });
    expect(skills[0].frontmatter.priority).toBe(100);
  });

  it('returns empty array if directory does not exist', () => {
    const skills = loadSkills({ directory: '/tmp/nonexistent-skills-dir-12345' });
    expect(skills).toEqual([]);
  });

  it('returns empty array when skills system is disabled', () => {
    writeSkill('test', `---
name: test
description: Test
---
Body`);

    const skills = loadSkills({ enabled: false, directory: skillsDir });
    expect(skills).toEqual([]);
  });

  it('marks skill as ineligible when disabled in frontmatter', () => {
    writeSkill('disabled', `---
name: disabled
description: Disabled skill
enabled: false
---
Body`);

    const skills = loadSkills({ directory: skillsDir });
    expect(skills).toHaveLength(1);
    expect(skills[0].eligible).toBe(false);
    expect(skills[0].reason).toBe('Disabled in frontmatter');
  });

  it('marks skill as ineligible when disabled in config entries', () => {
    writeSkill('overridden', `---
name: overridden
description: Config-disabled
---
Body`);

    const skills = loadSkills({
      directory: skillsDir,
      entries: { overridden: false },
    });
    expect(skills).toHaveLength(1);
    expect(skills[0].eligible).toBe(false);
    expect(skills[0].reason).toBe('Disabled in config');
  });

  it('skips non-directory entries', () => {
    writeSkill('real-skill', `---
name: real-skill
description: Real
---
Body`);
    // Write a file (not a directory) at the same level
    writeFileSync(join(skillsDir, 'not-a-dir.txt'), 'just a file');

    const skills = loadSkills({ directory: skillsDir });
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('real-skill');
  });

  it('skips directories without SKILL.md', () => {
    mkdirSync(join(skillsDir, 'empty-dir'), { recursive: true });
    writeSkill('has-skill', `---
name: has-skill
description: Has it
---
Body`);

    const skills = loadSkills({ directory: skillsDir });
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('has-skill');
  });
});

describe('checkEligibility', () => {
  it('returns eligible when no requirements', () => {
    const result = checkEligibility({ name: 'test', description: 'test' });
    expect(result.eligible).toBe(true);
  });

  it('checks binary existence', () => {
    // 'node' should exist on any dev machine
    const result = checkEligibility({
      name: 'test',
      description: 'test',
      requires: { bins: ['node'] },
    });
    expect(result.eligible).toBe(true);
  });

  it('fails on missing binary', () => {
    const result = checkEligibility({
      name: 'test',
      description: 'test',
      requires: { bins: ['nonexistent-binary-xyz-12345'] },
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('Missing binary');
  });

  it('checks environment variables', () => {
    process.env.SKILL_TEST_VAR = 'set';
    const result = checkEligibility({
      name: 'test',
      description: 'test',
      requires: { env: ['SKILL_TEST_VAR'] },
    });
    expect(result.eligible).toBe(true);
    delete process.env.SKILL_TEST_VAR;
  });

  it('fails on missing env var', () => {
    delete process.env.TOTALLY_MISSING_VAR_XYZ;
    const result = checkEligibility({
      name: 'test',
      description: 'test',
      requires: { env: ['TOTALLY_MISSING_VAR_XYZ'] },
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('Missing env var');
  });

  it('checks path existence', () => {
    const result = checkEligibility({
      name: 'test',
      description: 'test',
      requires: { paths: ['/tmp'] },
    });
    expect(result.eligible).toBe(true);
  });

  it('fails on missing path', () => {
    const result = checkEligibility({
      name: 'test',
      description: 'test',
      requires: { paths: ['/nonexistent/path/xyz12345'] },
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('Missing path');
  });

  it('fails on tools requirement when tools not enabled', () => {
    const result = checkEligibility(
      { name: 'test', description: 'test', requires: { tools: ['Browser'] } },
      { enabled: false, allowedPaths: [] }
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('Tools not enabled');
  });

  it('fails on browser tool requirement when browser not enabled', () => {
    const result = checkEligibility(
      { name: 'test', description: 'test', requires: { tools: ['Browser'] } },
      { enabled: true, allowedPaths: ['/tmp'] }
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('Browser');
  });

  it('passes on browser tool requirement when browser enabled', () => {
    const result = checkEligibility(
      { name: 'test', description: 'test', requires: { tools: ['Browser'] } },
      { enabled: true, allowedPaths: ['/tmp'], browser: { enabled: true } }
    );
    expect(result.eligible).toBe(true);
  });

  it('passes on code_with_agent requirement when tools enabled', () => {
    const result = checkEligibility(
      { name: 'test', description: 'test', requires: { tools: ['code_with_agent'] } },
      { enabled: true, allowedPaths: ['/tmp'] }
    );
    expect(result.eligible).toBe(true);
  });
});

describe('getSkillsForContext', () => {
  function makeSkill(name: string, contexts?: LoadedSkill['frontmatter']['contexts'], eligible = true): LoadedSkill {
    return {
      name,
      dirPath: `/fake/${name}`,
      frontmatter: { name, description: name, contexts, priority: 100 },
      body: `${name} body`,
      eligible,
    };
  }

  it('includes skills with no context filters', () => {
    const skills = [makeSkill('global')];
    const result = getSkillsForContext(skills, { channel: 'telegram' });
    expect(result).toHaveLength(1);
  });

  it('excludes ineligible skills', () => {
    const skills = [makeSkill('broken', undefined, false)];
    const result = getSkillsForContext(skills);
    expect(result).toHaveLength(0);
  });

  it('filters by channel', () => {
    const skills = [
      makeSkill('telegram-only', { channels: ['telegram'] }),
      makeSkill('discord-only', { channels: ['discord'] }),
    ];
    const result = getSkillsForContext(skills, { channel: 'telegram' });
    expect(result.map(s => s.name)).toEqual(['telegram-only']);
  });

  it('filters by cron job ID', () => {
    const skills = [
      makeSkill('morning', { cronJobs: ['morning-routine'] }),
      makeSkill('evening', { cronJobs: ['evening-digest'] }),
    ];
    const result = getSkillsForContext(skills, { cronJobId: 'morning-routine' });
    expect(result.map(s => s.name)).toEqual(['morning']);
  });

  it('filters by tags', () => {
    const skills = [
      makeSkill('code', { tags: ['coding', 'dev'] }),
      makeSkill('writing', { tags: ['writing', 'creative'] }),
    ];
    const result = getSkillsForContext(skills, { tags: ['coding'] });
    expect(result.map(s => s.name)).toEqual(['code']);
  });

  it('includes skill when any context criterion matches', () => {
    const skills = [
      makeSkill('multi', { channels: ['discord'], tags: ['coding'] }),
    ];
    // Matches on tags even though channel doesn't match
    const result = getSkillsForContext(skills, { channel: 'telegram', tags: ['coding'] });
    expect(result).toHaveLength(1);
  });

  it('excludes skills when context has filters but nothing matches', () => {
    const skills = [
      makeSkill('specific', { channels: ['discord'], tags: ['writing'] }),
    ];
    const result = getSkillsForContext(skills, { channel: 'telegram', tags: ['coding'] });
    expect(result).toHaveLength(0);
  });

  it('includes skills with empty context object', () => {
    const skills = [makeSkill('empty-ctx', {})];
    const result = getSkillsForContext(skills, { channel: 'telegram' });
    expect(result).toHaveLength(1);
  });
});

describe('formatSkillsPrompt', () => {
  function makeSkill(name: string, body: string, emoji?: string): LoadedSkill {
    return {
      name,
      dirPath: `/fake/${name}`,
      frontmatter: { name, description: name, emoji, priority: 100 },
      body,
      eligible: true,
    };
  }

  it('returns empty string for no skills', () => {
    expect(formatSkillsPrompt([])).toBe('');
  });

  describe('dynamic loading (default)', () => {
    it('formats skill catalog with names, descriptions, and paths', () => {
      const result = formatSkillsPrompt([makeSkill('greet', 'Say hello.')]);
      expect(result).toContain('## Skills');
      expect(result).toContain('read the SKILL.md file');
      expect(result).toContain('greet');
      expect(result).toContain('`/fake/greet/SKILL.md`');
    });

    it('includes emoji in catalog', () => {
      const result = formatSkillsPrompt([makeSkill('greet', 'Say hello.', '👋')]);
      expect(result).toContain('👋 greet');
    });

    it('does not include skill body', () => {
      const result = formatSkillsPrompt([makeSkill('greet', 'Say hello.')]);
      expect(result).not.toContain('Say hello.');
    });

    it('lists multiple skills', () => {
      const result = formatSkillsPrompt([
        makeSkill('a', 'A body'),
        makeSkill('b', 'B body'),
      ]);
      expect(result).toContain('| a |');
      expect(result).toContain('| b |');
    });
  });

  describe('inline loading (dynamicLoading=false)', () => {
    it('formats single skill with header and body', () => {
      const result = formatSkillsPrompt([makeSkill('greet', 'Say hello.')], undefined, false);
      expect(result).toContain('## Active Skills');
      expect(result).toContain('### greet');
      expect(result).toContain('Say hello.');
    });

    it('includes emoji in header when present', () => {
      const result = formatSkillsPrompt([makeSkill('greet', 'Say hello.', '👋')], undefined, false);
      expect(result).toContain('### 👋 greet');
    });

    it('separates multiple skills with dividers', () => {
      const result = formatSkillsPrompt([
        makeSkill('a', 'A body'),
        makeSkill('b', 'B body'),
      ], undefined, false);
      expect(result).toContain('---');
      expect(result).toContain('### a');
      expect(result).toContain('### b');
    });

    it('does not skip skills based on prompt budget argument', () => {
      const result = formatSkillsPrompt([
        makeSkill('small', 'tiny'),
        makeSkill('big', 'x'.repeat(50000)),
      ], 100, false);
      expect(result).toContain('### small');
      expect(result).toContain('### big');
    });
  });
});
