# SkimpyClaw — Agent Instructions

## Build & Test

```bash
pnpm build        # TypeScript compile (tsc)
pnpm test         # Vitest (423 tests)
pnpm build && pnpm test  # Always run both after changes
pnpm dev          # Hot reload dev server (tsx watch)
```

Always run `pnpm build && pnpm test` after making changes. Do not submit work with failing tests.

## Project Structure

- TypeScript, ES modules (`"type": "module"`, use `.js` extensions in imports)
- Vitest for testing, test files in `src/__tests__/`
- Package manager: pnpm
- Runtime config: `~/.skimpyclaw/config.json`
- Agent prompt templates: `~/.skimpyclaw/agents/<name>/` (IDENTITY.md, TOOLS.md)
- Skills: `~/.skimpyclaw/skills/<name>/SKILL.md`

## Source Layout

| File | Purpose |
|------|---------|
| `src/agent.ts` | AI model runner — Anthropic (`chatWithTools`) + Codex (`codexChat`) + OpenAI-compatible |
| `src/tools.ts` | Tool orchestration + code-agent runtime + MCP discovery/dispatch; delegates file/bash/browser to `src/tools/*` |
| `src/tools/definitions.ts` | Claude/OpenAI tool name mapping + built-in tool definitions (`Read/Write/Glob/Bash/Browser`) + agent tool schemas |
| `src/tools/file-tools.ts` | File tool executors (`read_file`, `write_file` with lock support, `list_directory`) |
| `src/tools/bash-tool.ts` | Bash executor + exec-approval gate integration |
| `src/tools/browser-tool.ts` | Browser tool runtime (Playwright lifecycle, actions, cleanup hooks) |
| `src/tools/path-utils.ts` | Shared path allowlist validation helper |
| `src/tools/execute-context.ts` | Shared `ExecuteToolContext` type used by agent/provider tool execution |
| `src/exec-approval.ts` | Risk classification (tier 0–3) + pending approval registry for Bash commands |
| `src/telegram.ts` | Telegram bot — commands, conversation history, typing indicator |
| `src/discord.ts` | Discord bot — commands and message handling |
| `src/subagent.ts` | Background task dispatch — retry, concurrency control, disk registry |
| `src/file-lock.ts` | In-memory file lock manager for concurrent subagent writes |
| `src/gateway.ts` | Fastify HTTP server on port 18790, registers all routes |
| `src/api.ts` | Dashboard REST API under `/api/dashboard/*` |
| `src/dashboard-frontend.ts` | Framework dashboard route + static asset serving from `dist/dashboard/` |
| `src/cron.ts` | Cron scheduler — `agentTurn` and `script` payload types |
| `src/heartbeat.ts` | Periodic keep-alive with Telegram alerts |
| `src/skills.ts` | Skills system — loads from `~/.skimpyclaw/skills/`, injects into system prompt |
| `src/skills-types.ts` | TypeScript types for skills (SkillFrontmatter, LoadedSkill, SkillConfig, SkillContext) |
| `src/voice.ts` | Voice transcription — local Whisper CLI (C++/Python) with API fallback |
| `src/digests.ts` | Digest storage and management for cron job article outputs |
| `src/usage.ts` | Cost & token usage tracking — JSONL storage, aggregation, summary |
| `src/types.ts` | All TypeScript interfaces and types |
| `src/security.ts` | Auth, path validation, bash command blocklist, rate limiting |
| `src/config.ts` | Config loading and validation |
| `src/channels.ts` | Active channel selection + proactive routing |
| `src/langfuse.ts` | Observability — Langfuse tracing per agent turn |
| `src/service.ts` | Systemd service management |
| `src/setup.ts` | Interactive setup wizard |
| `src/cli.ts` | CLI command definitions |
| `src/model-selection.ts` | Shared model-selection contract for API/CLI/chat commands (alias/provider-model/bare-id + errors) |

## Model Provider Architecture

Three provider paths in `agent.ts`:

1. **Anthropic** — `chatWithTools()` — standard Anthropic SDK with tool_use
2. **Codex** — `codexChat()` — raw fetch to `chatgpt.com/backend-api/codex/responses` (NOT api.openai.com, NOT OpenAI SDK)
3. **OpenAI-compatible** — `chat()` via OpenAI SDK — includes OpenAI, Kimi, MiniMax, openrouter, groq, etc.

Both Anthropic and Codex share `ExecuteToolContext` for spawn_subagent and file locking. New tools must be wired into BOTH paths.

Provider determined by model prefix: `anthropic/claude-opus-4-6`, `openai/gpt-5.3-codex`

### Model Selection Contract

`src/model-selection.ts` is the single source of truth for model input parsing:

- Accepted inputs:
  - configured alias (e.g. `claude-think`)
  - full provider/model (e.g. `anthropic/claude-sonnet-4-5`)
  - bare model ID with `-` or `.` (e.g. `claude-sonnet-4-5`)
- Deprecated model IDs are migrated via provider utils (e.g. Claude 3.5 -> Claude 4.5 aliases).
- Standardized errors:
  - unknown alias: `Unknown model alias: "<value>"`
  - malformed value: `Invalid model selection: "<value>". Use alias, provider/model, or model-id.`
- All entry points must use this contract:
  - `POST /api/dashboard/model`
  - `skimpyclaw model ...`
  - `/model` in Telegram/Discord handlers
  - Dashboard `Model` page client-side validation mirrors the same rules.

## Coding Agent Execution

`code_with_agent` and `code_with_team` run external CLIs via `buildCodeAgentArgs()` in `src/code-agents/utils.ts`.

- Claude worker command:
  - `claude -p --verbose --output-format stream-json --dangerously-skip-permissions ... <task>`
- Codex worker command:
  - `codex exec --full-auto --json --color never ... <task>`
- Kimi worker command:
  - `kimi --yolo -p <task> ...`

Execution flow:

- Tool schemas: `src/tools/definitions.ts` (`code_with_agent`, `code_with_team`)
- Orchestration: `src/code-agents/index.ts`
- Command construction: `src/code-agents/utils.ts`

Normal tool calling (`Read/Write/Bash/Browser`) is separate from coding-agent CLI execution.

## Exec Approval

`src/exec-approval.ts` classifies Bash commands before execution:
- **Tier 0** — safe, auto-approved
- **Tier 1** — low risk, auto-approved
- **Tier 2** — medium risk (sudo, chmod 777), prompts user
- **Tier 3** — catastrophic/irreversible (rm -rf, mkfs, dd, DROP TABLE), always requires approval

Pending approvals are held in an EventEmitter registry. The active channel sends the request; user replies inline to approve or deny.

## Skills System

Skills are loaded from `~/.skimpyclaw/skills/<name>/SKILL.md`. Each `SKILL.md` has YAML frontmatter:

```markdown
---
name: my-skill
description: What this skill does
triggers: ["keyword1", "keyword2"]
priority: 100
---
```

`src/skills.ts` scans the directory, loads valid skills, and injects relevant ones into the system prompt based on triggers and token budget (`maxPromptTokens`, default 4000 chars ≈ 1000 tokens).

## Dashboard Architecture

The dashboard is framework-only (Preact/Vite).

| Concern | Location |
|---------|---------|
| Frontend source | `web/dashboard/` |
| Built assets | `dist/dashboard/` |
| Route | `GET /dashboard` via `registerDashboard()` in `src/dashboard-frontend.ts` |
| Backend API | `src/api.ts` — all endpoints under `/api/dashboard/*` |
| Auth | Bearer token from `config.dashboard.token` |

If `dist/dashboard/index.html` is missing, `GET /dashboard` returns `503` with a build hint.

### Dashboard Tests

- `src/__tests__/dashboard.test.ts` — framework route contract tests
- `src/__tests__/dashboard-mode.test.ts` — framework static serving and safety checks
- `src/__tests__/api.test.ts` — backend API contract tests

## Critical Rules

- **Guard Codex SSE responses** — `fc.arguments` can be undefined. Always use `(fc.arguments || JSON.stringify(args))`.
- **Pass toolConfig to runAgentTurn** — without it, the model hallucinates XML tool calls.
- **New tools go in both paths** — Anthropic `chatWithTools` AND Codex `codexChat` in agent.ts.
- **code_with_team agent selection** — team workers support `claude`, `codex`, or `kimi`; default comes from `subagents.defaultCodeAgent`.
- **Path validation** — all file/dir operations restricted to `ToolConfig.allowedPaths`.
- **Hardcode paths** — prefer simple over configurable.
- **Dashboard is framework-only** — route serves built frontend from `dist/dashboard/` via `src/dashboard-frontend.ts`.
- **Codex auth** — uses `~/.codex/auth.json` with ChatGPT backend headers (`chatgpt-account-id`, `OpenAI-Beta`, `originator: codex_cli_rs`).
- **Skills directory** — `~/.skimpyclaw/skills/`, NOT `~/.claude/skills/`.
- **Model selection contract** — do not duplicate alias parsing; always call `resolveModelSelection`.

## Testing

- Tests use vitest with `vi.mock()` for module mocking
- Mock `runAgentTurn` when testing anything that calls the AI
- Mock `fs` operations when testing file-system interactions
- Use `resetForTesting()` in subagent tests to clear state between runs

## Style

- No unnecessary abstractions — keep it simple
- Inline error handling (try/catch returning error strings from tools)
- Console logging with `[module]` prefixes: `[agent]`, `[codex]`, `[codex:tools]`, `[subagent]`

## Workflow

- After any major change (new feature, architectural change, new module), update both `CLAUDE.md` and `AGENTS.md` to reflect the current state — file counts, tool lists, architecture table, conventions, and gotchas.
