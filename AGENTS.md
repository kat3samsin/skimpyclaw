# SkimpyClaw — Agent Instructions

## Build & Test

```bash
pnpm build        # TypeScript compile (tsc)
pnpm test         # Vitest (159 tests)
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

## Source Layout

| File | Purpose |
|------|---------|
| `src/agent.ts` | AI model runner — Anthropic (`chatWithTools`) + Codex (`codexChat`) + OpenAI-compatible |
| `src/tools.ts` | Tool definitions + executor. 8 tools: Read, Write, Glob, Bash, Browser, spawn_subagent, MCP |
| `src/telegram.ts` | Telegram bot — commands, conversation history, typing indicator |
| `src/subagent.ts` | Background task dispatch — retry, concurrency control, disk registry |
| `src/file-lock.ts` | In-memory file lock manager for concurrent subagent writes |
| `src/gateway.ts` | Fastify HTTP server on port 18790, registers all routes |
| `src/api.ts` | Dashboard REST API under `/api/dashboard/*` |
| `src/dashboard.ts` | Single-page dashboard (inline HTML/CSS/JS, no build step) |
| `src/cron.ts` | Cron scheduler — `agentTurn` and `script` payload types |
| `src/types.ts` | All TypeScript interfaces and types |
| `src/security.ts` | Auth, path validation, bash command blocklist, rate limiting |
| `src/config.ts` | Config loading and validation |
| `src/heartbeat.ts` | Periodic keep-alive with Telegram alerts |

## Model Provider Architecture

Three provider paths in `agent.ts`:

1. **Anthropic** — `chatWithTools()` — standard Anthropic SDK with tool_use
2. **Codex** — `codexChat()` — raw fetch to `chatgpt.com/backend-api/codex/responses` (NOT api.openai.com, NOT OpenAI SDK)
3. **OpenAI-compatible** — `chat()` via OpenAI SDK — no tool support

Both Anthropic and Codex share `ExecuteToolContext` for spawn_subagent and file locking. New tools must be wired into BOTH paths.

Provider determined by model prefix: `anthropic/claude-opus-4-6`, `openai/gpt-5.3-codex`

## Critical Rules

- **Guard Codex SSE responses** — `fc.arguments` can be undefined. Always use `(fc.arguments || JSON.stringify(args))`.
- **Pass toolConfig to runAgentTurn** — without it, the model hallucinates XML tool calls.
- **New tools go in both paths** — Anthropic `chatWithTools` AND Codex `codexChat` in agent.ts.
- **Path validation** — all file/dir operations restricted to `ToolConfig.allowedPaths`.
- **Hardcode paths** — prefer simple over configurable.
- **Dashboard is inline** — no framework, no build step. HTML/CSS/JS in a single string in `dashboard.ts`.
- **Codex auth** — uses `~/.codex/auth.json` with ChatGPT backend headers (`chatgpt-account-id`, `OpenAI-Beta`, `originator: codex_cli_rs`).

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
