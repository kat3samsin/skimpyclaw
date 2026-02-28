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
| `src/agent.ts` | AI model runner — Anthropic + Codex + OpenAI-compatible |
| `src/tools.ts` | Tool orchestration + MCP discovery/dispatch |
| `src/tools/*` | Tool implementations (file, bash, browser, path-utils) |
| `src/code-agents/*` | Coding agent CLI execution (types, parser, executor, registry, utils) |
| `src/exec-approval.ts` | Bash risk classification (tier 0–3) + approval registry |
| `src/telegram.ts` | Telegram bot |
| `src/discord.ts` | Discord bot |

| `src/gateway.ts` | Fastify HTTP server on port 18790 |
| `src/api.ts` | Dashboard REST API under `/api/dashboard/*` |
| `src/dashboard-frontend.ts` | Dashboard route + static asset serving from `dist/dashboard/` |
| `src/cron.ts` | Cron scheduler — `agentTurn` and `script` payloads |
| `src/skills.ts` | Skills system — loads from `~/.skimpyclaw/skills/` |
| `src/usage.ts` | Cost & token usage tracking (JSONL) |
| `src/model-selection.ts` | Model alias/provider resolution (single source of truth) |
| `src/cli.ts` | CLI entrypoint (start/stop/restart/status/logs/onboard/config/model/cron/tools/sandbox/uninstall) |
| `src/types.ts` | All TypeScript interfaces and types |

## Critical Rules

- **New tools go in both paths** — Anthropic `chatWithTools` AND Codex `codexChat` in agent.ts
- **MCP is Anthropic-only** — Codex/OpenAI providers don't support MCP tools
- **Pass toolConfig to runAgentTurn** — without it, the model hallucinates XML tool calls
- **Guard Codex SSE responses** — `fc.arguments` can be undefined
- **Path validation** — all file/dir operations restricted to `ToolConfig.allowedPaths`
- **Hardcode paths** — prefer simple over configurable
- **Skills directory** — `~/.skimpyclaw/skills/`, NOT `~/.claude/skills/`
- **Model selection** — always call `resolveModelSelection`, don't duplicate alias parsing
- **Sandbox CLI workflows** — use `skimpyclaw sandbox init` for runtime/image/profile bootstrap and `skimpyclaw sandbox doctor` for targeted diagnostics

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
