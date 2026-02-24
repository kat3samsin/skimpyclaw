# Model Provider Architecture

Three provider paths in `agent.ts`:

1. **Anthropic** — `chatWithTools()` — standard Anthropic SDK with tool_use
2. **Codex** — `codexChat()` — raw fetch to `chatgpt.com/backend-api/codex/responses` (NOT api.openai.com, NOT OpenAI SDK)
3. **OpenAI-compatible** — `chat()` via OpenAI SDK — includes OpenAI, Kimi, MiniMax, openrouter, groq, etc.

Both Anthropic and Codex share `ExecuteToolContext` for spawn_subagent and file locking. New tools must be wired into BOTH paths.

Provider determined by model prefix: `anthropic/claude-opus-4-6`, `openai/gpt-5.3-codex`

## MCP Support

MCP tools (via mcporter) are **only available on the Anthropic path**. Codex and OpenAI-compatible providers do not support MCP tools. mcporter spawns MCP servers as child processes and communicates over stdio JSON-RPC. Config at `~/.mcporter/mcporter.json`.

## Browser Tool

Two separate Playwright implementations:

| Context | Implementation | How it works |
|---------|---------------|--------------|
| Main agent | `src/tools/browser-tool.ts` | Direct Playwright API, in-process, not MCP |
| Coding agent (Claude CLI) | `@playwright/mcp` | MCP server passed via `--mcp-config` |

Both share the same persistent browser profile at `~/.skimpyclaw/browser-profile` (cookies, sessions).

## Model Selection Contract

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

## Codex Auth

Uses `~/.codex/auth.json` with ChatGPT backend headers (`chatgpt-account-id`, `OpenAI-Beta`, `originator: codex_cli_rs`).
