# SkimpyClaw 👙🦞

Lightweight personal AI assistant (~23k LOC). Runs locally. Telegram/Discord chat, scheduled routines, a web dashboard, and a tool-enabled agent — all in one tiny service.

## Why SkimpyClaw vs OpenClaw

Both are personal AI assistants you run yourself. The difference is scope.

|                     | SkimpyClaw (~23k LOC)                   | OpenClaw (~700k LOC)                                     |
| ------------------- | --------------------------------------- | -------------------------------------------------------- |
| **Channels**        | Telegram, Discord                       | WhatsApp, Signal, iMessage, Slack, Teams, Matrix, + more |
| **Setup**           | `skimpyclaw onboard` → done             | Daemon + wizard + per-channel pairing                    |
| **Codebase**        | Read it in an afternoon                 | Full platform with extensions, packages, native UI       |
| **Model support**   | Anthropic, OpenAI, Kimi, MiniMax, Codex | Same + more                                              |
| **Release cadence** | Move fast, no stability guarantees      | Stable / beta / dev channels                             |

Use SkimpyClaw if you live in Telegram or Discord, want to read and own every line, and don't need 13 channels. Use OpenClaw if you need to support multiple channels like WhatsApp, Signal, iMessage, or Slack — or want a more polished, maintained platform.

## Features

- **Chat interface** — Telegram and Discord bots with persistent conversation history
- **Tool-enabled agent** — file read/write, bash, browser (Playwright), MCP tools via mcporter
- **Multi-modal support** — voice messages (STT/TTS), image analysis
- **Subagents** — model autonomously spawns coding/research subagents with retry + concurrency control
- **Code agents** — delegate coding tasks to Claude Code, Codex, or Kimi CLI with `code_with_agent` and `code_with_team`
- **Cron scheduler** — run agent prompts or shell scripts on a schedule
- **Web dashboard** — Preact/Vite SPA with status, cron, audit log, memory, templates, config editor, skills, approvals
- **Heartbeat** — periodic keep-alive with Telegram/Discord alerts
- **Skills** — domain-specific capabilities loaded from `~/.skimpyclaw/skills/`
- **Exec approval** — human-in-the-loop approval for sensitive bash commands (tier 2-3 risks)
- **Voice** — optional TTS/STT support (ElevenLabs, OpenAI, macOS `say`, local Whisper)
- **Observability** — optional Langfuse tracing per agent turn
- **Audit logging** — JSONL-based audit traces for all agent interactions
- **Multiple model providers** — Anthropic, OpenAI, Kimi, MiniMax, Codex (ChatGPT backend), any OpenAI-compatible API

## Architecture

```mermaid
flowchart LR
  subgraph Channels
    user["Telegram / Discord"]
    browser["Browser"]
  end

  subgraph Gateway["Fastify :18790"]
    dash["Dashboard"]
    api["REST API"]
  end

  subgraph Core
    agent["Agent Runtime"]
    subagents["Subagent Pool"]
    cron["Cron"]
    hb["Heartbeat"]
    audit["Audit Log"]
    skills["Skills System"]
    approvals["Exec Approval"]
  end

  user --> agent
  browser --> dash --> api --> agent
  cron --> agent
  hb --> agent
  agent --> subagents
  agent --> audit
  agent --> skills
  agent --> approvals
  agent --> models["Anthropic / OpenAI / Codex"]
  agent --> mcp["MCP Servers"]
  agent --> fs["~/.skimpyclaw"]
```

See [docs/architecture.md](docs/architecture.md) for runtime flow and startup sequence diagrams.

## Quick Start

**Install:**

```bash
npm install -g skimpyclaw
```

**Run onboarding:**

```bash
skimpyclaw onboard
```

Onboarding validates your Telegram token, provider auth, and creates:

- `~/.skimpyclaw/config.json`
- `~/.skimpyclaw/agents/main/*.md` (from templates)

**Start:**

```bash
skimpyclaw start
# or run as launchd daemon on macOS:
skimpyclaw start --daemon
```

**Stop/Restart daemon (macOS):**

```bash
skimpyclaw stop
skimpyclaw restart
```

**Uninstall helper:**

```bash
skimpyclaw uninstall          # removes launch agent, keeps ~/.skimpyclaw
skimpyclaw uninstall --purge  # removes launch agent and ~/.skimpyclaw
pnpm remove -g skimpyclaw     # removes global package
```

**Verify:**

```bash
curl http://127.0.0.1:18790/health
```

**Open dashboard:**

```
http://127.0.0.1:18790/dashboard
```

Bearer token is shown in startup logs.

## Tech Stack

- **Backend:** TypeScript (ESM), Fastify, Vitest
- **Frontend:** Preact, Vite, TypeScript
- **Chat:** grammy (Telegram), discord.js (Discord)
- **Scheduling:** Croner
- **Browser:** Playwright
- **AI SDKs:** Anthropic SDK, OpenAI SDK
- **Observability:** Langfuse (optional)

## Project Structure

```
src/
  index.ts              # App entrypoint with logging setup
  gateway.ts            # Fastify server + top-level routes
  agent.ts              # Prompt assembly, model routing, tool loop, memory writes
  tools.ts              # Tool registry + dispatch
  tools/                # Tool executors (bash, browser, file tools, path utils, execute context)
  providers/            # Provider routing + provider implementations (anthropic/openai/codex)
  code-agents/          # Background coding-agent runtime (executor/parser/orchestrator/registry)
  channels/             # Channel adapters/utilities (telegram/discord)
  subagent.ts           # Background task dispatch: retry, concurrency, disk registry
  file-lock.ts          # In-memory file lock for concurrent subagent writes
  audit.ts              # Append-only audit log (trace/event model, JSONL storage)
  cron.ts               # Job scheduling + execution + cron logging
  heartbeat.ts          # Periodic health/attention checks
  channels.ts           # Active channel selection + proactive routing
  telegram.ts           # Telegram bot commands and message handling
  discord.ts            # Discord bot commands and message handling
  voice.ts              # Voice input/output (TTS/STT via providers)
  digests.ts            # Daily digest generation for cron job outputs
  skills.ts             # Skill loading, eligibility checks, and prompt injection
  skills-types.ts       # TypeScript types for skills system
  exec-approval.ts      # Human-in-the-loop exec approval flow with risk tiers
  api.ts                # Dashboard REST API under /api/dashboard/*
  dashboard-frontend.ts # Dashboard static asset serving
  security.ts           # Auth, path validation, bash command blocklist, rate limiting
  config.ts             # Config loading and validation
  types.ts              # All TypeScript interfaces and types
  setup.ts              # Interactive setup wizard
  langfuse.ts           # Observability integration with cost tracking
  usage.ts              # Token usage tracking and aggregation
  service.ts            # Runtime service management
  cli.ts                # CLI command definitions
  cache.ts              # TTL cache utility
  sessions.ts           # Session persistence for chat history
  doctor/               # Health check system
    index.ts
    checks.ts
    formatters.ts
    runner.ts
    types.ts

web/dashboard/          # Preact/Vite dashboard frontend
  src/
    App.tsx
    api/client.ts
    components/
    pages/              # Overview, Cron, Audit, Memory, Config, Skills, etc.

templates/              # Default template markdown files
  SOUL.md
  IDENTITY.md
  USER.md
  TOOLS.md
  BOOT.md
  HEARTBEAT.md
  MEMORY.md
  AGENTS.md
  BOOTSTRAP.md

dist/                   # Compiled output + built dashboard assets
```

## Documentation

| Doc                                            | Contents                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)   | Component diagram, runtime flow, startup sequence, source layout |
| [docs/configuration.md](docs/configuration.md) | Full config reference, all sections with examples                |
| [docs/tools.md](docs/tools.md)                 | Built-in tools, browser tool, MCP integration, code agents       |
| [docs/subagents.md](docs/subagents.md)         | Subagent types, concurrency, file locking, flow diagram          |
| [docs/dashboard.md](docs/dashboard.md)         | Web dashboard, all HTTP endpoints + API routes                   |
| [docs/coding-agents.md](docs/coding-agents.md) | Coding-agent execution model and CLI backends                    |
| [docs/cli.md](docs/cli.md)                     | CLI commands, service management                                 |
| [docs/chat-commands.md](docs/chat-commands.md) | Telegram/Discord bot commands                                    |
| [docs/skills.md](docs/skills.md)               | Skills system, built-in skills, creating custom skills           |
| [docs/data-storage.md](docs/data-storage.md)   | File layout, audit log format, security notes                    |
| [docs/setup-guide.md](docs/setup-guide.md)     | Step-by-step installation and setup guide                        |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common issues and solutions                                  |

## Development

```bash
# Install dependencies
pnpm install

# Run in development mode (hot reload)
pnpm dev

# Build TypeScript and dashboard
pnpm build

# Run tests
pnpm test

# Run full CI gate
pnpm ci

# Run doctor checks
pnpm run doctor
```

## License

MIT
