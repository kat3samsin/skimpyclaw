// Skills System: Load, filter, and format skill prompts from ~/.skimpyclaw/skills/

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import matter from 'gray-matter';
import type { SkillFrontmatter, LoadedSkill, SkillConfig, SkillContext } from './skills-types.js';
import type { ToolConfig } from './types.js';
import { TTLCache } from './cache.js';

const DEFAULT_SKILLS_DIR = join(homedir(), '.skimpyclaw', 'skills');
const DEFAULT_PRIORITY = 100;

/**
 * Check if a binary exists on PATH.
 * Returns true if found, false otherwise.
 */
function binExists(name: string): boolean {
  try {
    execSync(`which ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a skill meets its external requirements.
 * Returns { eligible: true } or { eligible: false, reason: string }.
 */
export function checkEligibility(
  skill: SkillFrontmatter,
  toolConfig?: ToolConfig
): { eligible: boolean; reason?: string } {
  const reqs = skill.requires;
  if (!reqs) return { eligible: true };

  // Check binary dependencies
  if (reqs.bins) {
    for (const bin of reqs.bins) {
      if (!binExists(bin)) {
        return { eligible: false, reason: `Missing binary: ${bin}` };
      }
    }
  }

  // Check environment variables
  if (reqs.env) {
    for (const envVar of reqs.env) {
      if (!process.env[envVar]) {
        return { eligible: false, reason: `Missing env var: ${envVar}` };
      }
    }
  }

  // Check file/directory paths
  if (reqs.paths) {
    for (const p of reqs.paths) {
      if (!existsSync(p)) {
        return { eligible: false, reason: `Missing path: ${p}` };
      }
    }
  }

  // Check tool availability against the active ToolConfig
  if (reqs.tools && reqs.tools.length > 0) {
    if (!toolConfig?.enabled) {
      return { eligible: false, reason: `Tools not enabled (needs: ${reqs.tools.join(', ')})` };
    }
    const missing: string[] = [];
    for (const tool of reqs.tools) {
      const t = tool.toLowerCase();
      if (t === 'browser') {
        if (!toolConfig.browser?.enabled) missing.push(tool);
      }
      // built-in tools are available whenever tools.enabled is true
    }
    if (missing.length > 0) {
      return { eligible: false, reason: `Tools not enabled (needs: ${missing.join(', ')})` };
    }
  }

  return { eligible: true };
}

/**
 * Parse a single SKILL.md file from a skill directory.
 * Returns a LoadedSkill or null if the file doesn't exist or is malformed.
 */
function parseSkillFile(dirPath: string, dirName: string, skillConfig?: SkillConfig, toolConfig?: ToolConfig): LoadedSkill | null {
  const skillPath = join(dirPath, 'SKILL.md');
  if (!existsSync(skillPath)) {
    return null;
  }

  try {
    const raw = readFileSync(skillPath, 'utf-8');
    const { data, content } = matter(raw);

    const frontmatter: SkillFrontmatter = {
      name: data.name || dirName,
      description: data.description || '',
      enabled: data.enabled !== false, // default true
      emoji: data.emoji,
      tags: data.tags,
      requires: data.requires,
      contexts: data.contexts,
      priority: typeof data.priority === 'number' ? data.priority : DEFAULT_PRIORITY,
    };

    // Check config-level override for this skill
    if (skillConfig?.entries?.[frontmatter.name] === false) {
      return {
        name: frontmatter.name,
        dirPath,
        frontmatter,
        body: content.trim(),
        eligible: false,
        reason: 'Disabled in config',
      };
    }

    // Check frontmatter-level enabled flag
    if (frontmatter.enabled === false) {
      return {
        name: frontmatter.name,
        dirPath,
        frontmatter,
        body: content.trim(),
        eligible: false,
        reason: 'Disabled in frontmatter',
      };
    }

    // Check external requirements
    const eligibility = checkEligibility(frontmatter, toolConfig);

    return {
      name: frontmatter.name,
      dirPath,
      frontmatter,
      body: content.trim(),
      eligible: eligibility.eligible,
      reason: eligibility.reason,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[skills] Failed to parse ${skillPath}: ${msg}`);
    return null;
  }
}

const skillsCache = new TTLCache<LoadedSkill[]>(60_000);

/**
 * Scan the skills directory and load all valid skills.
 * Returns skills sorted by priority (lower first).
 * Results are cached for 60s to avoid repeated disk I/O and `which` calls.
 */
export function loadSkills(skillConfig?: SkillConfig, toolConfig?: ToolConfig): LoadedSkill[] {
  // Master switch
  if (skillConfig?.enabled === false) {
    return [];
  }

  const cacheKey = JSON.stringify({
    dir: skillConfig?.directory,
    entries: skillConfig?.entries,
    enabled: skillConfig?.enabled,
    toolEnabled: toolConfig?.enabled,
    browserEnabled: toolConfig?.browser?.enabled,
  });

  const cached = skillsCache.get(cacheKey);
  if (cached) return cached;

  const dir = skillConfig?.directory || DEFAULT_SKILLS_DIR;
  if (!existsSync(dir)) {
    return [];
  }

  const dirEntries = readdirSync(dir);
  const skills: LoadedSkill[] = [];

  for (const entry of dirEntries) {
    const entryPath = join(dir, entry);
    // Only process directories
    try {
      if (!statSync(entryPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const skill = parseSkillFile(entryPath, entry, skillConfig, toolConfig);
    if (skill) {
      skills.push(skill);
    }
  }

  // Sort by priority (lower = first), then alphabetically by name
  skills.sort((a, b) => {
    const pa = a.frontmatter.priority ?? DEFAULT_PRIORITY;
    const pb = b.frontmatter.priority ?? DEFAULT_PRIORITY;
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });

  skillsCache.set(cacheKey, skills);
  return skills;
}

export function clearSkillsCache(): void {
  skillsCache.clear();
}

/**
 * Filter skills by context (channel, cron job ID, tags).
 * Skills with no context filters pass through (always active).
 * Skills with context filters must match at least one criterion.
 */
export function getSkillsForContext(
  skills: LoadedSkill[],
  context?: { channel?: string; cronJobId?: string; tags?: string[] }
): LoadedSkill[] {
  return skills.filter(skill => {
    // Only include eligible skills
    if (!skill.eligible) return false;

    const ctx = skill.frontmatter.contexts;
    // No context filters = always active
    if (!ctx) return true;

    const hasFilters =
      (ctx.channels && ctx.channels.length > 0) ||
      (ctx.cronJobs && ctx.cronJobs.length > 0) ||
      (ctx.tags && ctx.tags.length > 0);

    // No actual filter values = always active
    if (!hasFilters) return true;

    // Check channel match
    if (ctx.channels?.length && context?.channel) {
      if (ctx.channels.includes(context.channel)) return true;
    }

    // Check cron job match
    if (ctx.cronJobs?.length && context?.cronJobId) {
      if (ctx.cronJobs.includes(context.cronJobId)) return true;
    }

    // Check tag match (any overlap)
    if (ctx.tags?.length && context?.tags?.length) {
      if (ctx.tags.some(t => context.tags!.includes(t))) return true;
    }

    // Has filters but none matched
    return false;
  });
}

/**
 * Format eligible, context-filtered skills into a markdown prompt section.
 */
export function formatSkillsPrompt(skills: LoadedSkill[], _maxTokens?: number): string {
  if (skills.length === 0) return '';
  const sections: string[] = [];

  // Header
  const header = '## Active Skills\n';

  for (const skill of skills) {
    const emoji = skill.frontmatter.emoji ? `${skill.frontmatter.emoji} ` : '';
    const section = `### ${emoji}${skill.name}\n\n${skill.body}`;

    sections.push(section);
  }

  if (sections.length === 0) return '';

  return header + sections.join('\n\n---\n\n');
}
