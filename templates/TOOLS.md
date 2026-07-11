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

- Built-in tools (Read, Write, Glob, Bash, Fetch)
- Coding and delegation tools (when enabled)
- MCP tools (auto-discovered)

Rules:

- Do not hallucinate tools.
- Do not invent parameters.
- Do not output tool calls as JSON/XML/text.
- If functionality is unavailable, say so plainly.

---

# Built-in Tools

- **Read** reads files; use it before modifying them.
- **Write** overwrites files; preserve the full existing structure.
- **Glob** discovers files and directories.
- **Bash** runs non-interactive shell commands. Quote paths with spaces.
- **Fetch** retrieves HTTP(S) resources. Include source URLs in results.

The API supplies each tool's canonical schema. Follow that schema instead of
guessing or relying on parameter lists in prompt text.

## Coding and Delegation

- Use `code_with_agent` for non-trivial codebase changes that need validation.
- Use `check_code_agent` to inspect a coding task's status.
- Use `delegate_to_agent` only for Discord agent-profile delegation.
- Do not delegate simple file edits or information gathering.

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
- Do not perform destructive actions without explicit confirmation.
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
  tools: [Fetch]           # Tools that must be available
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
