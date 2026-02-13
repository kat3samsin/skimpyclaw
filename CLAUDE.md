# SkimpyClaw

Personal AI assistant with Telegram integration, Fastify HTTP gateway, cron scheduler, web dashboard, and heartbeat keep-alive.

## Quick Start

```bash
pnpm dev          # Start with hot reload (tsx watch)
pnpm build        # TypeScript compile
pnpm test         # Run vitest (159 tests)
pnpm build && pnpm test  # Always run both after changes
```

## Architecture

```
src/
├── index.ts        # Entry point
├── gateway.ts      # Fastify HTTP server (port 18790), registers routes
├── agent.ts        # AI model runner (Anthropic + Codex + OpenAI-compatible)
├── tools.ts        # Tool definitions + executor (Read, Write, Glob, Bash, Browser, spawn_subagent, MCP)
├── telegram.ts     # Telegram bot with conversation history, commands
├── subagent.ts     # Background task dispatch with retry, concurrency, disk registry
├── file-lock.ts    # In-memory file lock manager for concurrent writes
├── api.ts          # Dashboard REST API under /api/dashboard/*
├── dashboard.ts    # Single-page dashboard (inline HTML/CSS/JS)
├── cron.ts         # Cron scheduler (agentTurn + script payloads)
├── heartbeat.ts    # Periodic keep-alive with Telegram alerts
├── types.ts        # All TypeScript types/interfaces
├── config.ts       # Config loading from ~/.skimpyclaw/config.json
├── security.ts     # Auth, path validation, bash safety, rate limiting
├── channels.ts     # Active channel management
├── cli.ts          # CLI commands (onboard, doctor, etc.)
├── langfuse.ts     # Observability integration
├── service.ts      # Systemd service management
├── setup.ts        # Interactive setup wizard
└── discord.ts      # Discord integration (minimal)
```

## Key Patterns

### Model Providers
- **Anthropic**: OAuth token or API key. Uses `chatWithTools()` for tool loop.
- **Codex (OpenAI)**: ChatGPT backend via `codexChat()`. Raw fetch, NOT OpenAI SDK.
- **OpenAI-compatible**: Any provider with API key + baseURL (openrouter, groq, etc.)
- Provider determined by model prefix: `openai/gpt-5.3-codex`, `anthropic/claude-opus-4-6`
- Both Anthropic and Codex paths support full tool use including `spawn_subagent`

### Tool System
- Tools defined in `src/tools.ts`, executed via `executeTool()`
- `ExecuteToolContext` threads chatId, config, history, and lockTaskId through all providers
- `spawn_subagent` available when chatId + fullConfig present (Telegram conversations)
- Path validation: all file ops restricted to `ToolConfig.allowedPaths`
- MCP tools auto-discovered from mcporter at runtime

### Subagent System
- Model calls `spawn_subagent` autonomously — no special commands
- Types: `coding` (→ claude-opus), `research` (→ claude-think), `general` (→ current model)
- Retry on failure (default 2), configurable concurrency (default 5)
- Disk registry at `~/.skimpyclaw/logs/subagent-runs.jsonl`
- File locking via `src/file-lock.ts` for concurrent writes

### Config
- Runtime config: `~/.skimpyclaw/config.json`
- Agent prompts: `~/.skimpyclaw/agents/<agent-name>/` (IDENTITY.md, TOOLS.md, etc.)
- Prompt changes don't need rebuild, config changes need restart

## Conventions

- **TypeScript with ES modules** (`"type": "module"`, `.js` extensions in imports)
- **Vitest** for testing, files in `src/__tests__/`
- **No frameworks** for dashboard — inline HTML/CSS/JS, no build step
- **Hardcode paths** — prefer simple over configurable
- **Bearer token auth** on all dashboard routes
- Always run `pnpm build && pnpm test` after changes
- Guard against undefined in Codex SSE responses (`fc.arguments` can be undefined)

## Common Gotchas

- If `toolConfig` not passed to `runAgentTurn`, model hallucinates XML tool calls
- Codex uses ChatGPT backend (`chatgpt.com/backend-api/codex/responses`), NOT `api.openai.com`
- Codex content types differ: user=`input_text`, assistant=`output_text`
- Claude CLI `-p` mode returns empty stdout when vault has TTS output style
- New tools must be wired into BOTH Anthropic and Codex paths in `agent.ts`

## Workflow

- After any major change (new feature, architectural change, new module), update `CLAUDE.md` and `AGENTS.md` to reflect the current state — file counts, tool lists, architecture diagram, conventions, and gotchas.
