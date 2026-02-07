# SkimpyClaw 👙🦞

SkimpyClaw is a tiny, cheeky, mini-"me" inspired by OpenClaw.
Think: pocket-sized brain, lobster attitude, zero chill for boring workflows.

Lightweight personal AI assistant with:
- Telegram chat interface
- Local HTTP gateway + web dashboard
- Scheduled cron routines
- Periodic heartbeat checks
- Optional tool-enabled agent execution (read/write/list/bash within allowed paths)
- Conversation history controls in Telegram (`/new`, `/compact`)

## Assistant personality (SOUL)

SkimpyClaw’s default behavior (from `templates/SOUL.md`) is:
- Direct, resourceful, and proactive
- Playful and a little sassy (without being rude or dismissive)
- Not sycophantic; keeps responses concise and useful
- Works within your existing tools/workflows
- Keeps private things private and asks before external messaging

Default proactive themes include morning check-ins, stale PR nudges, meeting prep prompts, and habit reminders.

## Architecture

### Component view

```mermaid
flowchart LR
  user["User (Telegram)"] --> tg["Telegram Bot (grammy)"]
  user2["User (Browser)"] --> dash["Dashboard UI (/dashboard)"]
  dash --> api["Dashboard API (/api/dashboard/*)"]
  tg --> agent["Agent Runtime"]
  api --> agent
  gw["Gateway Server (Fastify)"] --> api
  gw --> dash
  gw --> st["/health /status /message /model /cron/:id/run"]
  cron["Cron Scheduler (croner)"] --> agent
  hb["Heartbeat Timer"] --> agent
  agent --> models["Model Providers (Anthropic/OpenAI/Codex-compatible)"]
  agent --> fs["~/.skimpyclaw (config, sessions, logs, memory, templates)"]
```

### Runtime flow (message handling)

```mermaid
sequenceDiagram
  participant U as User
  participant T as Telegram/Gateway API
  participant A as Agent Runtime
  participant M as Model API
  participant F as Local Files

  U->>T: Send message
  T->>A: runAgentTurn(agentId, message, model, tools?)
  A->>A: Build system prompt from templates
  A->>A: Sanitize user input
  alt Tools enabled
    A->>M: chatWithTools(...)
    M-->>A: tool_use blocks
    A->>F: Execute allowed tool actions
    A->>M: Return tool results
    M-->>A: Final response
  else Tools disabled
    A->>M: chat(...)
    M-->>A: Response text
  end
  A->>F: Append turn to daily memory
  A-->>T: Final response
  T-->>U: Reply
```

### Startup and background services

```mermaid
flowchart TD
  start["src/index.ts"] --> cfg["loadConfig()"]
  cfg --> providers["initProviders()"]
  providers --> gateway["createGateway() + listen 127.0.0.1:port"]
  gateway --> cron["initCron()"]
  cron --> hb["initHeartbeat()"]
  hb --> tg["initTelegram() + startTelegram()"]
  tg --> run["Service running"]
```

## Tech stack

- TypeScript (ESM)
- Fastify (HTTP server + dashboard routes)
- grammy (Telegram bot)
- Croner (scheduling)
- Anthropic SDK + OpenAI SDK (model providers)
- Vitest (tests)

## Repository layout

```text
src/
  index.ts        # app entrypoint
  setup.ts        # interactive first-time setup wizard
  gateway.ts      # Fastify server + top-level routes
  api.ts          # dashboard API routes
  dashboard.ts    # dashboard frontend HTML
  agent.ts        # prompt assembly, model calls, tool loop, memory writes
  tools.ts        # Read/Write/Glob/Bash tool implementations
  telegram.ts     # Telegram commands and message handling
  cron.ts         # job scheduling + execution + cron logging
  heartbeat.ts    # periodic health/attention checks
  security.ts     # allowlist, sanitization, rate limit, secret redaction
  config.ts       # config load/save + path helpers
  types.ts        # shared type definitions
templates/        # default template markdown files copied during setup
dist/             # compiled output
```

## Prerequisites

- Node.js 20+
- pnpm
- Telegram bot token (from @BotFather)
- Anthropic API key (or compatible auth token config)

## Quick start

1. Install dependencies:

```bash
pnpm install
```

2. Run onboarding:

```bash
pnpm run cli -- onboard
```

This creates and populates:
- `~/.skimpyclaw/config.json`
- `~/.skimpyclaw/.env`
- `~/.skimpyclaw/agents/main/*.md` (from `templates/`)
- `~/Library/LaunchAgents/com.skimpyclaw.plist`

3. Start locally:

```bash
pnpm run dev
```

4. Verify health:

```bash
curl http://127.0.0.1:18790/health
```

5. Open dashboard:

- `http://127.0.0.1:18790/dashboard`
- Use dashboard bearer token shown in startup logs (also stored in config)

## NPM scripts

- `pnpm run start` - run once
- `pnpm run dev` - run with watch mode
- `pnpm run setup` - interactive setup (legacy)
- `pnpm run onboard` - interactive onboarding via CLI
- `pnpm run cli -- <command>` - run CLI commands
- `pnpm run build` - compile TypeScript to `dist/`
- `pnpm run typecheck` - type-check only
- `pnpm run test` - run Vitest

## CLI

After build, the package exposes a `skimpyclaw` binary. During development:

```bash
pnpm run cli -- help
```

Common commands:

- `skimpyclaw onboard` - run onboarding wizard
- `skimpyclaw start` - start in foreground
- `skimpyclaw start --daemon` - load launchd daemon (macOS)
- `skimpyclaw stop` - stop launchd daemon
- `skimpyclaw status` - show daemon + gateway status
- `skimpyclaw logs --file stdout --lines 200 --follow` - tail logs
- `skimpyclaw config get gateway.port`
- `skimpyclaw config set gateway.port 18790`
- `skimpyclaw model smart`
- `skimpyclaw send "plan my day"`
- `skimpyclaw cron list`
- `skimpyclaw cron run morning`

## Configuration overview

Main config file: `~/.skimpyclaw/config.json`

Top-level sections:
- `gateway`: HTTP port and mode
- `agents`: default agent + agent definitions
- `models`: provider credentials + model aliases (`apiKey`, optional `authToken`, optional `baseURL`, optional `authPath`)
- `channels.telegram`: token, allowlist, optional `tools`, optional `dailyNotesDir`, optional `defaultAllowedPaths`
- `cron.jobs`: scheduled tasks
- `heartbeat`: interval, prompt, optional `model`, optional `tools`
- `dashboard.token`: API auth token for `/api/dashboard/*`

Environment placeholders in JSON are supported:
- `${ANTHROPIC_API_KEY}`
- `${TELEGRAM_BOT_TOKEN}`
- `${HOME}`

## HTTP endpoints

Gateway routes:
- `GET /health`
- `GET /status`
- `POST /message` (`{ message, model? }`)
- `POST /model` (`{ model }`)
- `POST /cron/:id/run`
- `POST /reload` (currently returns restart-required note)
- `GET /dashboard`

Dashboard API routes (Bearer token protected when configured):
- `GET /api/dashboard/status`
- `GET /api/dashboard/sessions`
- `GET /api/dashboard/sessions/:id`
- `GET /api/dashboard/memory/:agentId`
- `GET /api/dashboard/memory/:agentId/:filename`
- `GET /api/dashboard/cron`
- `POST /api/dashboard/cron/:id/run`
- `GET /api/dashboard/model`
- `POST /api/dashboard/model`
- `GET /api/dashboard/templates/:agentId`
- `GET /api/dashboard/templates/:agentId/:name`
- `PUT /api/dashboard/templates/:agentId/:name`
- `GET /api/dashboard/logs`
- `GET /api/dashboard/logs/:filename`
- `GET /api/dashboard/config`
- `PUT /api/dashboard/config`

## Telegram commands

- `/start`
- `/model <alias-or-model>`
- `/status`
- `/cron list`
- `/cron run <job-id>`
- `/heartbeat`
- `/silence <minutes>`
- `/morning`
- `/eod`
- `/focus`
- `/new` (clear conversation history)
- `/compact` (summarize + compress conversation history)
- `/memory` (list recent memory files)
- `/memory <filename>` (read one memory file)

Any non-command text message is treated as a chat prompt to the agent and uses recent in-memory conversation context.

## Data and logs

Under `~/.skimpyclaw`:
- `config.json` - runtime configuration
- `.env` - local secrets
- `agents/<id>/` - markdown templates and memory
- `agents/<id>/memory/YYYY-MM-DD.md` - daily conversation memory
- `sessions/*.json` - session records (dashboard-readable)
- `logs/` - app logs
- `logs/cron/<job>-YYYY-MM-DD.log` - cron execution logs

## Security notes

- Telegram access is allowlist-based (`allowFrom` IDs/usernames)
- Basic per-user message rate limiting is enabled
- User input is sanitized for common prompt-injection markers
- Dashboard config responses redact key/token-like fields
- Tool execution is constrained by `allowedPaths` and bash safety patterns

## Testing

Run:

```bash
pnpm run typecheck
pnpm run test
```

Current tests cover:
- Dashboard API behavior and auth
- Tool name mapping and tool safety/path constraints

## Known implementation caveats

- Telegram daily notes path and default tool paths are configurable in `channels.telegram`.
- Heartbeat tool paths are configurable in `heartbeat.tools`.
- Gateway binds to `127.0.0.1` by default.
- Config reload endpoint currently indicates restart is required.
