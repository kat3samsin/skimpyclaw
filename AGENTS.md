# SkimpyClaw — Agent Instructions

## Build & Test

```bash
pnpm build        # TypeScript compile (tsc)
pnpm test         # Vitest (500 tests)
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
| `src/agent.ts` | AI model runner — orchestrates prompts, provider calls, tools, and memory |
| `src/providers/index.ts` | Provider registry + unified routing for `chat` and `chatWithTools` |
| `src/providers/adapter.ts` | `ProviderAdapter` interface (`isAvailable()`, `chat()`, `chatWithTools` flow hooks) |
| `src/providers/tool-loop.ts` | `runToolLoop` shared tool execution path for all providers |
| `src/tools.ts` | Tool orchestration + MCP discovery/dispatch |
| `src/tools/*` | Tool implementations (file, bash, browser, path-utils) |
| `src/code-agents/*` | Coding agent CLI execution (types, parser, executor, registry, utils) |
| `src/exec-approval.ts` | Bash risk classification (tier 0–3) + approval registry |
| `src/telegram.ts` | Telegram bot |
| `src/channels/discord/*` | Discord bot (handlers, threads, utils, types) |

| `src/gateway.ts` | Fastify HTTP server on port 18790 |
| `src/api.ts` | Dashboard REST API under `/api/dashboard/*` |
| `src/dashboard-frontend.ts` | Dashboard route + static asset serving from `dist/dashboard/` |
| `src/cron.ts` | Cron scheduler — `agentTurn` and `script` payloads |
| `src/skills.ts` | Skills system — loads from `~/.skimpyclaw/skills/` |
| `src/usage.ts` | Cost & token usage tracking (JSONL) |
| `src/env-sanitizer.ts` | Shared env sanitization for child processes (strips secrets, extends PATH) |
| `src/model-selection.ts` | Model alias/provider resolution (single source of truth) |
| `src/cli.ts` | CLI entrypoint (start/stop/restart/status/logs/onboard/config/model/cron/tools/sandbox/uninstall) |
| `src/types.ts` | All TypeScript interfaces and types |

## Critical Rules

- **Provider routing is adapter-based** — both `chat` and `chatWithTools` route through `src/providers/index.ts`
- **Tool loops are unified** — all providers use `runToolLoop`; do not add per-provider loop logic
- **New providers implement `ProviderAdapter`** — include `isAvailable()`, `chat()`, and tool-loop adapter methods
- **MCP is Anthropic-only** — Codex/OpenAI providers don't support MCP tools
- **Pass toolConfig to runAgentTurn** — without it, the model hallucinates XML tool calls
- **Guard Codex SSE responses** — `fc.arguments` can be undefined
- **Path validation** — all file/dir operations restricted to `ToolConfig.allowedPaths`
- **Hardcode paths** — prefer simple over configurable
- **Skills directory** — `~/.skimpyclaw/skills/`, NOT `~/.claude/skills/`
- **Model selection** — always call `resolveModelSelection`, don't duplicate alias parsing
- **Sandbox CLI workflows** — use `skimpyclaw sandbox init` for runtime/image/profile bootstrap and `skimpyclaw sandbox doctor` for targeted diagnostics

## Security & Secrets

- **Never store raw secrets in config.json** — use `${ENV_VAR}` or `${KEYCHAIN:service/account}` references
- **Config file permissions** — `saveConfig()` enforces `0600`; do not weaken this
- **Env sanitization** — `sanitizeExecEnv()` in `src/env-sanitizer.ts` strips sensitive env vars from child processes. Used by both bash tool and cron scripts. Add new provider key patterns to `SENSITIVE_ENV_PATTERNS` when adding providers
- **Fetch tool** — validates URLs against an IP blocklist (RFC 1918, link-local, metadata) and blocked hostnames. Re-validates on every redirect. Do not bypass `validateTarget()`
- **Gateway auth** — `/status` and all write endpoints require Bearer token. Do not add unauthed endpoints that expose config or runtime state
- **Cron prompt paths** — `resolveMessageSource()` only reads files inside `~/.skimpyclaw/prompts/`. Do not relax this path restriction
- **Voice TTS** — uses `spawnSync` with argument arrays. Never use `execSync` with string interpolation for user-controlled text
- **Token comparison** — `validateBearerToken()` hashes both sides with SHA-256 before `timingSafeEqual`. Do not revert to direct buffer comparison

## Testing

- Tests use vitest with `vi.mock()` for module mocking
- Mock `runAgentTurn` when testing anything that calls the AI
- Mock `fs` operations when testing file-system interactions
- Use `resetForTesting()` in subagent tests to clear state between runs

## Style

- No unnecessary abstractions — keep it simple
- Inline error handling (try/catch returning error strings from tools)
- Console logging with `[module]` prefixes: `[agent]`, `[codex]`, `[subagent]`

## Reference Docs

Detailed architecture docs (read when needed, not every session):

- [Model providers, MCP, browser tool](docs/reference/providers.md)
- [Coding agents, exec approval, skills, dashboard](docs/reference/code-agents.md)
- [Config options](docs/reference/config-options.md)
- [Model aliases](docs/reference/model-aliases.md)
