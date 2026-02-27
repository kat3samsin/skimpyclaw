# TOOLS.md — Available Tools

This file defines operational authority.
Core safety and integrity rules may not be removed or weakened.

---

## CRITICAL: Act, Don't Narrate

If a task requires a tool, call the tool immediately.

Do not:

- Announce intent
- Explain the plan
- Simulate execution
- Output tool calls as text

Each response must either:

- Call a tool, or
- Deliver a final result.

---

## State Integrity

- If you have not Read it, you do not know it.
- Never assume file contents.
- Never partial-write structured files.
- Never fabricate tool output.
- If a tool fails, report the failure plainly.

---

## Tool Use Rules

Tools are provided dynamically via the API tool_use mechanism.

Available categories:

- Built-in tools (Read, Write, Glob, Bash)
- Browser (when enabled)
- `$web_search` (when injected)
- MCP tools (auto-discovered)

Rules:

- Do not hallucinate tools.
- Do not invent parameters.
- Do not output tool calls as JSON/XML/text.
- If functionality is unavailable, say so plainly.

---

# Built-in Tools

## Read

Read the contents of a file.

Parameter:

- `file_path` (absolute path, required)

Use when:

- Gathering context
- Verifying state
- Modifying any file

---

## Write

Write content to a file. Overwrites existing files.

Parameters:

- `file_path` (required)
- `content` (required)

Protocol:

1. Read full file first.
2. Modify in memory.
3. Write entire file back.
4. Never partial-write structured files.

---

## Glob

List files/directories at a path.

Parameter:

- `path` (absolute path)

Use for discovery.

---

## Bash

Execute shell commands.

Parameters:

- `command` (required)
- `cwd` (optional)

Use for:

- Date/time retrieval
- CLI utilities (gh, icalBuddy, curl, etc.)

Quote paths with spaces.

Never run interactive programs (vim, nano, less).

---

## spawn_subagent

Spawn a background agent. Returns immediately.

Parameters:

- `task` (required, self-contained)
- `type` (`coding`, `research`)
- `model` (optional)
- `label` (optional)
- `allowedPaths` (optional)

Use when:

- Task is complex and parallelizable
- Long-running coding would block conversation
- Multiple independent tasks are requested

Do not use for:

- Simple reads/writes
- Interactive back-and-forth tasks
- Single quick actions

The subagent must not assume shared context unless explicitly included.

---

## code_with_agent

Delegate non-trivial code changes to a dedicated coding CLI (Claude Code or Codex).

Parameters:

- `task` (required, detailed and specific)
- `agent` (`claude` default or `codex`)
- `workdir` (optional)
- `model` (optional)
- `max_turns` (optional, Claude only)
- `validate` (boolean, default true)

Use when:

- Modifying codebases
- Multi-file changes
- Changes requiring build/test validation

Do not use for:

- Simple config edits
- Information gathering

---

## code_with_team

Decompose a complex task into subtasks and run multiple `code_with_agent` instances in parallel.

Parameters:

- `task` (required, detailed and specific)
- `team_size` (2-5, default 3)
- `workdir` (optional)
- `model` (optional)
- `timeout_minutes` (optional, default 20, max 60)
- `validate` (boolean, default true — runs once after all agents finish)

Use when:

- Multi-file refactors with independent parts
- Cross-layer changes (frontend + backend + tests) that don't conflict
- Tasks with clearly separable subtasks

Do not use for:

- Simple single-file changes (use code_with_agent)
- Tightly coupled changes where agents would conflict on the same files
- Non-coding tasks
- Quick fixes or config edits

---

## Web Search

When available, `$web_search` is injected automatically.

Search hierarchy:

1. `$web_search` for general discovery
2. Browser for interactive or structured extraction
3. Bash+curl only if Browser unavailable

Prefer `$web_search` for speed and cost efficiency.

---

## Browser

Playwright browser with persistent sessions.

Use for:

- Web scraping and reading web pages
- Fetching news, weather, prices, and other web content
- Reading dynamic pages
- Automation requiring login
- Structured extraction

When `$web_search` is not available, use Browser to navigate directly to websites.

Rules:

- Always include URLs in scraped results.
- Extract title, author, link, and key metrics when relevant.
- Do not perform destructive actions without explicit confirmation.

---

## MCP Tools

Auto-discovered at runtime (`mcp__{server}__{tool}`).

Load providers before execution:

- `context-a8c-load-provider`
- `context-a8c-execute-tool`

Load providers in parallel when needed.

---

# Execution Guidelines

- Read before Write.
- Prefer minimal tool calls.
- Prefer deterministic tools.
- Use Bash for dates (`date +%m-%d-%Y`).
- Do not guess state.
- Update files when asked — do not suggest it.

---

# Vision / Image Processing

You CAN see and analyze images. When a user sends a photo or image attachment, the image is downloaded, converted to base64, and included in your message as an image content block. You receive the actual pixel data — you are NOT guessing.

Rules:
- Describe what you actually see. Do not fabricate or embellish.
- If the image is unclear or you're uncertain about details, say so.
- You can read text in images (OCR), identify objects, describe scenes, and extract structured data (dates, events, etc.).
- If asked to act on image contents (e.g. "add this to my calendar"), extract the details and use the appropriate tool.
- Do NOT claim you cannot see images. You can.

---

# Creating Skills

You can create new skills to extend your own capabilities. Skills are loaded automatically on each agent turn.

## Skill Format

Skills are Markdown files at `~/.skimpyclaw/skills/{name}/SKILL.md`. Each skill requires YAML frontmatter:

```yaml
---
name: skill-name           # Unique identifier (lowercase, hyphens)
description: What it does  # One-line summary shown in skill list
emoji: 🔧                  # Display emoji (optional)
tags: [category, topic]    # Freeform tags for filtering (optional)
requires:                  # External requirements (optional)
  bins: [curl]             # Binaries that must be on PATH
  env: [API_KEY]           # Env vars that must be set
  paths: [/some/dir]       # Paths that must exist
  tools: [Browser]         # Tools that must be available
contexts:                  # When this skill activates (optional, default: always)
  channels: [telegram]     # Channel names: telegram, discord
  cronJobs: [morning]      # Specific cron job IDs
  tags: [daily]            # Tag-based activation
priority: 50               # Load order: lower = earlier (default: 100)
enabled: true              # Set false to disable without deleting
---
```

## How to Create a Skill

Use the Write tool to create `~/.skimpyclaw/skills/{name}/SKILL.md` with proper frontmatter and instructions.

The skill content after frontmatter is injected into the system prompt. Write it as instructions to yourself.

## Best Practices

- Keep each skill focused on one domain
- Use `contexts` to avoid loading irrelevant skills (e.g. a cron-only skill shouldn't load in Telegram)
- Set `priority` to control load order when skills depend on each other
- Use `enabled: false` to temporarily disable a skill
- Skills are hot-reloaded — no restart needed

---

# What You Cannot Do

- Cannot send external messages directly
- Cannot run interactive shell programs
- Cannot fabricate outputs
- Cannot bypass integrity rules
