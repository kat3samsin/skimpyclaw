# Skills

Skills are reusable, domain-specific capabilities stored in `~/.skimpyclaw/skills/`. Each skill is a directory with a `SKILL.md` file containing instructions, examples, and workflow patterns. The agent reads relevant skill files when handling related tasks.

## How skills work

- Skills provide specialized expertise (PDF processing, calendar sync, internal search, etc.)
- The agent automatically routes to relevant skills based on task context
- Skills are modular — add or remove them without changing core code
- No rebuild needed; skill changes take effect immediately

## Built-in skills

| Skill               | Description                                                                        |
| ------------------- | ---------------------------------------------------------------------------------- |
| `dev-team`          | Spawn a 5-person dev team (PM, coder, reviewer, tester, docs) for complex features |
| `ical-sync`         | Sync macOS Calendar events using icalBuddy                                         |
| `qmd-vault-search`  | Search Obsidian vault for notes, context, or references                            |
| `test-image-studio` | Test Image Studio asset loading on WordPress using Playwright                      |

## Creating a skill

1. Create a directory: `~/.skimpyclaw/skills/my-skill/`
2. Add `SKILL.md` with YAML frontmatter and content:

```markdown
---
name: my-skill
description: What this skill does
triggers: ['keyword1', 'keyword2']
priority: 100
---

# My Skill

Instructions and workflow patterns here.
```

```
~/.skimpyclaw/skills/
├── my-skill/
│   └── SKILL.md          # Main instructions (required)
```

Skills can also be configured in `config.json` under `skills.entries`.
