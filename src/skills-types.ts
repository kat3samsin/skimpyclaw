// Skills System Type Definitions

/** YAML frontmatter fields in a SKILL.md file */
export interface SkillFrontmatter {
  /** Unique skill name (defaults to directory name) */
  name: string;
  /** Short description shown in skill listing */
  description: string;
  /** Whether the skill is active (default: true) */
  enabled?: boolean;
  /** Emoji identifier for the skill */
  emoji?: string;
  /** Freeform tags for filtering */
  tags?: string[];
  /** External requirements that must be met for eligibility */
  requires?: SkillRequirements;
  /** Context filters — when this skill should activate */
  contexts?: SkillContext;
  /** Sort priority — lower numbers appear first (default: 100) */
  priority?: number;
}

/** External requirements for a skill to be eligible */
export interface SkillRequirements {
  /** Binary names that must be on PATH (checked via `which`) */
  bins?: string[];
  /** Environment variables that must be set */
  env?: string[];
  /** Tool names that must be available in the current ToolConfig */
  tools?: string[];
  /** File/directory paths that must exist */
  paths?: string[];
}

/** Context filters for when a skill should be injected */
export interface SkillContext {
  /** Channel names where this skill applies (e.g. "telegram", "discord") */
  channels?: string[];
  /** Cron job IDs where this skill applies */
  cronJobs?: string[];
  /** Tag-based filters — skill activates when any tag matches */
  tags?: string[];
}

/** A fully loaded skill after parsing and eligibility check */
export interface LoadedSkill {
  /** Skill name (from frontmatter or directory name) */
  name: string;
  /** Absolute path to the skill directory */
  dirPath: string;
  /** Parsed frontmatter */
  frontmatter: SkillFrontmatter;
  /** Markdown body (after frontmatter) */
  body: string;
  /** Whether the skill passed eligibility checks */
  eligible: boolean;
  /** Reason for ineligibility (undefined if eligible) */
  reason?: string;
}

/** Config section for the skills system */
export interface SkillConfig {
  /** Master switch for the skills system (default: true) */
  enabled?: boolean;
  /** Skills directory path (default: ~/.skimpyclaw/skills/) */
  directory?: string;
  /** Override per-skill enabled state: { skillName: boolean } */
  entries?: Record<string, boolean>;
  /** Max approximate tokens for injected skills prompt (default: 4000) */
  maxPromptTokens?: number;
  /**
   * Dynamic loading: only include skill names and descriptions in the system prompt.
   * Full skill content is loaded on-demand via the Read tool.
   * Default: true (progressive disclosure)
   */
  dynamicLoading?: boolean;
}
