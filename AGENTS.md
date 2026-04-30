# SkimpyClaw — Agent Instructions

## Build & Test

```bash
pnpm build        # TypeScript compile (tsc)
pnpm test         # Vitest
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
- Discord agent profiles: `~/.skimpyclaw/discord-thread-agents.json`
- Coding-agent logs/state: `~/.skimpyclaw/logs/code-agents/`
- Isolated coding worktrees: `~/.skimpyclaw/worktrees/`

## Source Layout

| File | Purpose |
|------|---------|
| `src/agent.ts` | AI model runner — orchestrates prompts, provider calls, tools, and memory |
| `src/providers/index.ts` | Provider registry + unified routing for `chat` and `chatWithTools` |
| `src/providers/adapter.ts` | `ProviderAdapter` interface (`isAvailable()`, `chat()`, `chatWithTools` flow hooks) |
| `src/providers/adapters/*` | Anthropic and Codex adapter implementations |
| `src/providers/tool-loop.ts` | `runToolLoop` shared tool execution path for all providers |
| `src/tools.ts` | Tool orchestration + MCP discovery/dispatch |
| `src/tools/*` | Tool implementations (file, bash, fetch, delegation, path-utils) |
| `src/code-agents/*` | Coding agent CLI execution, parser, registry, stream formatting, interactive sessions, worktrees |
| `src/exec-approval.ts` | Bash risk classification (tier 0–3) + approval registry |
| `src/telegram.ts` | Telegram bot |
| `src/channels/discord/*` | Discord bot (handlers, threads, agent profiles, delegation, attachments, utils, types) |
| `src/gateway.ts` | Fastify HTTP server on port 18790 |
| `src/api.ts` | Dashboard REST API under `/api/dashboard/*` |
| `src/dashboard-frontend.ts` | Dashboard route + static asset serving from `dist/dashboard/` |
| `src/cron.ts` | Cron scheduler — `agentTurn` and `script` payloads |
| `src/skills.ts` | Skills system — loads from `~/.skimpyclaw/skills/` |
| `src/usage.ts` | Cost & token usage tracking (JSONL) |
| `src/env-sanitizer.ts` | Shared env sanitization for child processes (strips secrets, extends PATH) |
| `src/model-selection.ts` | Model alias/provider resolution (single source of truth) |
| `src/cli.ts` | CLI entrypoint (start/stop/restart/status/logs/onboard/config/model/cron/tools/uninstall) |
| `src/types.ts` | All TypeScript interfaces and types |

## Critical Rules

- **Provider routing is adapter-based** — both `chat` and `chatWithTools` route through `src/providers/index.ts`
- **Core providers are Anthropic and Codex** — Codex-compatible providers are registered from config entries whose `authToken` is `codex`
- **Tool loops are unified** — all providers use `runToolLoop`; do not add per-provider loop logic
- **New providers implement `ProviderAdapter`** — include `isAvailable()`, `chat()`, and tool-loop adapter methods
- **MCP works with Anthropic and Codex** — keep MCP discovery/dispatch centralized in `src/tools.ts`
- **Pass toolConfig to runAgentTurn** — without it, the model hallucinates XML tool calls
- **Guard Codex SSE responses** — `fc.arguments` can be undefined
- **Path validation** — all file/dir operations restricted to `ToolConfig.allowedPaths`
- **Hardcode paths** — prefer simple over configurable
- **Skills directory** — `~/.skimpyclaw/skills/`, NOT `~/.claude/skills/`
- **Model selection** — always call `resolveModelSelection`, don't duplicate alias parsing
- **Thinking levels** — use `ThinkingLevel` (`none`, `low`, `medium`, `high`, `xhigh`) for main agents, coding agents, and Discord profiles
- **Coding agents** — `code_with_agent` is the only coding-agent launch tool; `check_code_agent` reads task status
- **Coding worktrees** — review/rebase/diff tasks default to isolated git worktrees in auto mode. Preserve dirty worktrees or changed HEADs during cleanup
- **Interactive coding** — `interactive: true` is Discord-only and resumes through `src/code-agents/interactive-resume.ts`
- **Agent delegation** — `delegate_to_agent` is Discord-only, creates a new thread, and is capped by delegation depth
- **Discord agent profiles** — `/agent` manages reusable profiles. Profiles are separate from thread bindings; `@alias <task>` invokes a profile
- **No removed systems** — do not reintroduce sandbox/container isolation, `code_with_team`, Work/review-loop, newspaper, or browser/web_search tools

## Security & Secrets

- **Never store raw secrets in config.json** — use `${ENV_VAR}` or `${KEYCHAIN:service/account}` references
- **Config file permissions** — `saveConfig()` enforces `0600`; do not weaken this
- **Env sanitization** — `sanitizeExecEnv()` in `src/env-sanitizer.ts` strips sensitive env vars from child processes. Used by both bash tool and cron scripts. Add new provider key patterns to `SENSITIVE_ENV_PATTERNS` when adding providers
- **Fetch tool** — validates URLs against an IP blocklist (RFC 1918, link-local, metadata) and blocked hostnames. Re-validates on every redirect. Do not bypass `validateTarget()`
- **Bash execution** — commands go through exec approval and path validation. Keep risk-tier checks in `src/exec-approval.ts`
- **Gateway auth** — `/status` and all write endpoints require Bearer token. Do not add unauthed endpoints that expose config or runtime state
- **Cron prompt paths** — `resolveMessageSource()` only reads files inside `~/.skimpyclaw/prompts/`. Do not relax this path restriction
- **Voice TTS** — uses `spawnSync` with argument arrays. Never use `execSync` with string interpolation for user-controlled text
- **Token comparison** — `validateBearerToken()` hashes both sides with SHA-256 before `timingSafeEqual`. Do not revert to direct buffer comparison

## Testing

- Tests use vitest with `vi.mock()` for module mocking
- Mock `runAgentTurn` when testing anything that calls the AI
- Mock `fs` operations when testing file-system interactions
- Use the module-specific test reset helpers (`resetForTesting()`, `_setThreadAgentStorePathForTesting()`, etc.) to clear persisted state between runs
- Add focused tests when changing provider routing, tool-loop behavior, Discord profile/delegation behavior, worktree cleanup, config security, or command approval

## Style

- No unnecessary abstractions — keep it simple
- Inline error handling (try/catch returning error strings from tools)
- Console logging with `[module]` prefixes: `[agent]`, `[codex]`, `[discord-thread-agents]`, etc.

## Reference Docs

Detailed architecture docs (read when needed, not every session):

- [Model providers, MCP, and fetch tool](docs/reference/providers.md)
- [Coding agents, exec approval, skills, dashboard](docs/reference/code-agents.md)
- [Config options](docs/reference/config-options.md)
- [Model aliases](docs/reference/model-aliases.md)
