# Architecture

## Component view

```mermaid
flowchart LR
  subgraph Channels
    user["User (Telegram/Discord)"]
    browser["User (Browser)"]
  end

  subgraph Gateway["Gateway · Fastify :18790"]
    dash["Dashboard UI"]
    api["Dashboard API"]
    routes["/health /status /message /model /cron/:id/run"]
  end

  subgraph Core
    agent["Agent Runtime"]
    subagents["Subagent Pool"]
    cron["Cron Scheduler"]
    hb["Heartbeat Timer"]
    audit["Audit Log"]
  end

  subgraph Providers
    models["Anthropic / OpenAI / Codex"]
    mcp["MCP Servers (mcporter)"]
  end

  user --> agent
  browser --> dash --> api --> agent
  routes --> agent
  cron --> agent
  hb --> agent
  agent --> subagents
  agent --> audit
  agent --> models
  agent --> mcp
  agent --> fs["~/.skimpyclaw (config, logs, memory, templates)"]
```

## Runtime flow (message handling)

```mermaid
sequenceDiagram
  participant U as User
  participant C as Channel / API
  participant A as Agent Runtime
  participant M as Model API
  participant T as Tools

  U->>C: Send message
  C->>A: runAgentTurn(agentId, message, model, tools?)
  A->>A: Build system prompt from templates
  A->>A: Sanitize user input
  alt Tools enabled
    loop Tool loop
      A->>M: chatWithTools(messages)
      M-->>A: tool_use blocks
      A->>T: executeTool(name, args)
      T-->>A: tool result
    end
    M-->>A: Final text response
  else Tools disabled
    A->>M: chat(messages)
    M-->>A: Response text
  end
  A->>A: Append turn to daily memory
  A->>A: Record audit trace
  A-->>C: Final response
  C-->>U: Reply
```

## Startup sequence

```mermaid
flowchart TD
  start["src/index.ts"] --> cfg["loadConfig()"]
  cfg --> providers["initProviders() — Anthropic + OpenAI-compat clients"]
  providers --> gateway["createGateway() + listen :18790"]
  gateway --> cron["initCron() — schedule jobs"]
  cron --> channel["initActiveChannel() + startActiveChannel()"]
  channel --> hb["initHeartbeat()"]
  hb --> run["Service running"]
```

## Source layout

```text
src/
  index.ts          # App entrypoint
  gateway.ts        # Fastify server + top-level routes
  agent.ts          # Prompt assembly, model calls, tool loop, memory writes
  tools.ts          # Tool registry, MCP auto-discovery, built-in implementations
  subagent.ts       # Background task dispatch: retry, concurrency, disk registry
  file-lock.ts      # In-memory file lock for concurrent subagent writes
  audit.ts          # Append-only audit log (trace/event model, JSONL storage)
  cron.ts           # Job scheduling + execution + cron logging
  heartbeat.ts      # Periodic health/attention checks
  channels.ts       # Active channel selection + proactive routing
  telegram.ts       # Telegram commands and message handling
  discord.ts        # Discord commands and message handling
  voice.ts          # Voice input/output (TTS/STT via providers)
  digests.ts        # Daily digest generation
  skills.ts         # Skill loading and routing
  exec-approval.ts  # Human-in-the-loop exec approval flow
  api.ts            # Dashboard REST API under /api/dashboard/*
  dashboard.ts      # Dashboard frontend (inline HTML/CSS/JS)
  security.ts       # Allowlist, sanitization, rate limiting, secret redaction
  config.ts         # Config load/save + path helpers
  types.ts          # Shared TypeScript types
  setup.ts          # Interactive setup wizard
  langfuse.ts       # Observability integration
  service.ts        # Systemd service management
  cli.ts            # CLI command definitions

templates/          # Default template markdown files copied during setup
dist/               # Compiled output
```
