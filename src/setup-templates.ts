// Template and skill content for onboarding (extracted from setup.ts)

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.skimpyclaw');

export const REQUIRED_TEMPLATE_DEFAULTS: Record<string, string> = {
  'SOUL.md': '# SOUL\n\nBe direct, resourceful, and helpful. Keep it concise.\n',
  'IDENTITY.md': '# IDENTITY\n\nName: Claw\nEmoji: 👙🦞\n',
  'USER.md': '# USER\n\nName: User\n',
  'HEARTBEAT.md': '# HEARTBEAT\n\nIf nothing needs attention, reply HEARTBEAT_OK.\n',
};

export const STARTER_SKILL_TEMPLATES: Record<string, string> = {
  'daily-notes': `---
name: daily-notes
description: Keep daily notes organized under the configured daily notes directory.
triggers: ["daily note", "standup", "plan day", "journal"]
priority: 90
---

When writing daily notes:
1. Use today's date in the file name if missing.
2. Include sections: Priorities, Schedule, Notes, Follow-ups.
3. Keep entries concise and actionable.
4. Avoid creating files outside the configured daily notes directory.
`,
  'weather': `---
name: weather
description: Fetch and format weather data for daily briefings and quick checks.
triggers: ["weather", "forecast", "temperature", "rain"]
priority: 45
---

When asked about weather or generating a daily briefing:
1. Use web search to find current weather for the user's location.
2. Format as: conditions, high/low temps, precipitation chance.
3. Keep it to 2-3 sentences max.
4. Include any weather alerts if present.
5. For daily briefings: mention if rain is expected (affects outdoor plans).
`,
  'web-search': `---
name: web-search
description: Search the web using Fetch against DuckDuckGo HTML results.
triggers: ["search", "look up", "google", "find online", "web search"]
priority: 50
---

When asked to search the web:
1. Use Fetch on https://html.duckduckgo.com/html/?q=<URL-encoded query>
2. Read the returned text for relevant result links and snippets.
3. If a specific result looks promising, Fetch that URL and extract the relevant content.
4. Summarize findings concisely — include source URLs.

Do NOT fabricate results. If the search returns nothing useful, say so.
`,
  'duckduckgo-html-search': `---
name: duckduckgo-html-search
description: Search the web via DuckDuckGo HTML results using Fetch
emoji: 🦆
tags: [search, web, fetch]
priority: 45
enabled: true
---

# DuckDuckGo HTML Search Skill

Use this skill when the user asks for web search, source gathering, or lightweight browsing.

## Priority rule
DuckDuckGo HTML via Fetch is the default search path.
- Prefer DuckDuckGo first.

## Default workflow
1. Build query URL: \\\`https://duckduckgo.com/html/?q=<urlencoded query>\\\`
2. Fetch the URL.
3. Extract result titles, URLs, and snippets from the returned HTML/text when possible.
5. Return only actually extracted items (never pad count).

## Extraction requirements
For each result, capture when available:
- title
- url
- snippet

If a field is missing, set it to \\\`UNAVAILABLE\\\`.

## Integrity rules
- Never fabricate results.
- If the page blocks, fails, or no results render, return \\\`UNAVAILABLE\\\` and state why.
- Never mix real and invented entries.
- Include source URLs in output.

## Output format (concise)
- Query used
- Result count actually extracted
- Bulleted results with title + URL + snippet
- Notes section for failures/limits

## Safe defaults
- Default top results target: 5 (or user-specified)
- If user asks for deep research, gather multiple queries but keep each query's extraction explicit and separated.
`,
};

export interface SetupStarters {
  cronTechNews: boolean;
  cronWeather: boolean;
  timezone: string;
  weatherLocation: string;
  skillDailyNotes: boolean;
  skillWeather: boolean;
  skillWebSearch: boolean;
}

export function ensureCoreTemplates(agentDir: string): string[] {
  const created: string[] = [];
  for (const [file, content] of Object.entries(REQUIRED_TEMPLATE_DEFAULTS)) {
    const dst = join(agentDir, file);
    if (!existsSync(dst)) {
      writeFileSync(dst, content, 'utf-8');
      created.push(file);
    }
  }
  return created;
}

export function ensureStarterSkills(starters: SetupStarters): string[] {
  const created: string[] = [];
  const skillsDir = join(CONFIG_DIR, 'skills');
  mkdirSync(skillsDir, { recursive: true });

  const requested: string[] = [];
  if (starters.skillDailyNotes) requested.push('daily-notes');
  if (starters.skillWeather) requested.push('weather');
  if (starters.skillWebSearch) requested.push('web-search');

  for (const skillName of requested) {
    const dir = join(skillsDir, skillName);
    const skillPath = join(dir, 'SKILL.md');
    if (!existsSync(skillPath)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(skillPath, STARTER_SKILL_TEMPLATES[skillName], 'utf-8');
      created.push(skillName);
    }
  }

  return created;
}

export function buildStarterCronJobs(starters: SetupStarters): Array<Record<string, unknown>> {
  const jobs: Array<Record<string, unknown>> = [];

  jobs.push({
    id: 'memory-trim',
    name: 'Memory Trim',
    model: 'anthropic/claude-haiku-4-5',
    schedule: {
      kind: 'cron',
      expr: '0 0,12 * * *',
      tz: starters.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    payload: {
      kind: 'agentTurn',
      message: '~/.skimpyclaw/prompts/memory-trim.md',
      tools: {
        enabled: true,
        allowedPaths: [`${homedir()}/.skimpyclaw`],
        maxIterations: 30,
        bashTimeout: 10000,
        toolProfile: 'minimal',
      },
    },
  });

  if (starters.cronTechNews) {
    jobs.push({
      id: 'tech-digest',
      name: 'Tech News',
      schedule: {
        kind: 'cron',
        expr: '0 8 * * *',
        tz: starters.timezone,
      },
      payload: {
        kind: 'agentTurn',
        message: 'Use Fetch to read https://news.ycombinator.com and fetch today\'s top 10 stories. Reply with title, URL, and 1-line summary for each item.',
        tools: {
          enabled: true,
          allowedPaths: [`${homedir()}/.skimpyclaw`],
          maxIterations: 30,
          bashTimeout: 30000,
        },
      },
    });
  }

  if (starters.cronWeather) {
    jobs.push({
      id: 'weather',
      name: 'Weather',
      schedule: {
        kind: 'cron',
        expr: '0 7 * * *',
        tz: starters.timezone,
      },
      payload: {
        kind: 'agentTurn',
        message: `Use Fetch to check current weather and today's forecast for ${starters.weatherLocation}. Keep it concise: current temp/conditions, highs/lows, precipitation chance, and 1 recommendation.`,
        tools: {
          enabled: true,
          allowedPaths: [`${homedir()}/.skimpyclaw`],
          maxIterations: 30,
          bashTimeout: 30000,
        },
      },
    });
  }
  return jobs;
}
