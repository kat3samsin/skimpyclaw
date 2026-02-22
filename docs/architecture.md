# Architecture

## Component View

```mermaid
flowchart LR
  subgraph Channels
    user["User (Telegram/Discord)"]
    browser["User (Browser)"]
  end

  subgraph Gateway["Gateway · Fastify :18790"]
    dash["Dashboard UI (Preact/Vite)"]
    api["Dashboard API"]
    routes["/health /status /message /model /cron/:id/run"]
  end

  subgraph Core
    agent["Agent Runtime"]
    subagents["Subagent Pool"]
    codeagents["Code Agents (Claude/Codex/Kimi)"]
    cron["Cron Scheduler"]
    hb["Heartbeat Timer"]
    audit["Audit Log"]
    skills["Skills System"]
    approvals["Exec Approval"]
  end

  subgraph Providers
    models["Anthropic / OpenAI / Codex / Kimi / MiniMax"]
    mcp["MCP Servers (mcporter)"]
  end

  user --> agent
  browser --> dash --> api --> agent
  routes --> agent
  cron --> agent
  hb --> agent
  agent --> subagents
  agent --> codeagents
  agent --> audit
  agent --> skills
  agent --> approvals
  agent --> models
  agent --> mcp
  agent --> fs["~/.skimpyclaw (config, logs, memory, templates)"]
```

## Runtime Flow (Message Handling)

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
  A->>A: Load relevant skills
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

## Startup Sequence

```mermaid
flowchart TD
  start["src/index.ts"] --> cfg["loadConfig()"]
  cfg --> env["Load .env file"]
  env --> providers["initProviders() — Anthropic + OpenAI-compat + Codex clients"]
  providers --> gateway["createGateway() + listen :18790"]
  gateway --> cron["initCron() — schedule jobs"]
  cron --> channel["initActiveChannel() + startActiveChannel()"]
  channel --> hb["initHeartbeat()"]
  hb --> run["Service running"]
```

## Source Layout

```text
src/
  index.ts              # App entrypoint with file logging setup
  gateway.ts            # Fastify server + top-level routes
  agent.ts              # Prompt assembly, model calls, tool loop, memory writes, Langfuse tracing
  tools.ts              # Tool registry, MCP auto-discovery, code agents (code_with_agent, code_with_team)
  subagent.ts           # Background task dispatch: retry, concurrency, disk registry
  file-lock.ts          # In-memory file lock for concurrent subagent writes
  audit.ts              # Append-only audit log (trace/event model, JSONL storage)
  cron.ts               # Job scheduling + execution + cron logging
  heartbeat.ts          # Periodic health/attention checks
  channels.ts           # Active channel selection + proactive routing
  telegram.ts           # Telegram bot commands and message handling ( Grammy )
  discord.ts            # Discord bot commands and message handling ( discord.js )
  voice.ts              # Voice input/output (TTS/STT via multiple providers)
  digests.ts            # Daily digest generation for cron job article outputs
  skills.ts             # Skill loading, eligibility checks, and prompt injection
  skills-types.ts       # TypeScript types for skills system
  exec-approval.ts      # Human-in-the-loop exec approval flow with risk tiers
  api.ts                # Dashboard REST API under /api/dashboard/*
  dashboard-frontend.ts # Dashboard static asset serving (Preact/Vite build)
  security.ts           # Auth, path validation, bash command blocklist, rate limiting
  config.ts             # Config loading with env var expansion
  types.ts              # All TypeScript interfaces and types
  setup.ts              # Interactive setup wizard
  langfuse.ts           # Observability integration with cost tracking
  usage.ts              # Token usage tracking and aggregation
  service.ts            # Runtime service management
  cli.ts                # CLI command definitions
  cache.ts              # TTL cache utility
  sessions.ts           # Session persistence for chat history
  doctor/               # Health check system
    index.ts            # Doctor entry point
    checks.ts           # Individual health checks
    formatters.ts       # Output formatting (text/JSON)
    runner.ts           # Check orchestration
    types.ts            # Doctor type definitions

templates/              # Default template markdown files copied during setup
  SOUL.md               # Core agent personality and principles
  IDENTITY.md           # Agent name, emoji, persona
  USER.md               # User context and preferences
  TOOLS.md              # Tool usage instructions
  BOOT.md               # Startup behavior
  HEARTBEAT.md          # Heartbeat check instructions
  MEMORY.md             # Memory management guidelines
  AGENTS.md             # Multi-agent coordination
  BOOTSTRAP.md          # Bootstrap instructions

dist/                   # Compiled output + built dashboard assets
```

## Model Provider Architecture

Three provider paths in `agent.ts`:

1. **Anthropic** — `chatWithTools()` — standard Anthropic SDK with tool_use
2. **Codex** — `codexChat()` — raw fetch to `chatgpt.com/backend-api/codex/responses` (ChatGPT backend)
3. **OpenAI-compatible** — `chat()` via OpenAI SDK — includes OpenAI, Kimi, MiniMax, openrouter, groq, etc.

Both Anthropic and Codex share `ExecuteToolContext` for spawn_subagent and file locking.

## Skills System Flow

```mermaid
sequenceDiagram
  participant A as Agent Runtime
  participant S as Skills System
  participant F as SKILL.md Files
  
  A->>S: loadSkills(skillConfig, toolConfig)
  S->>F: Scan ~/.skimpyclaw/skills/*/
  F-->>S: Parse YAML frontmatter + markdown body
  S->>S: Check eligibility (bins, env, paths, tools)
  S->>S: Filter by context (channel, cron job, tags)
  S->>S: Sort by priority
  S-->>A: Return eligible skills
  A->>S: formatSkillsPrompt(skills, maxTokens)
  S-->>A: Formatted markdown section
  A->>A: Inject into system prompt
```

## Code Agent Flow

```mermaid
sequenceDiagram
  participant U as User
  participant A as Agent
  participant T as Tools
  participant C as Code Agent
  
  U->>A: Request with code task
  A->>T: executeTool('code_with_agent', args)
  T->>C: Spawn Claude/Codex/Kimi CLI
  C->>C: Execute coding task
  C->>C: Run pnpm build && pnpm test (if validate=true)
  C-->>T: Return results
  T-->>A: Tool result
  A-->>U: Final response
```

## Exec Approval Flow

```mermaid
sequenceDiagram
  participant T as Tool Executor
  participant E as Exec Approval
  participant U as User (Telegram/Discord)
  
  T->>E: classifyCommandRisk(command)
  E-->>T: RiskClassification {tier, reason}
  alt Tier 2-3 (requires approval)
    T->>E: createApprovalRequest(...)
    E->>U: Send approval request with buttons
    U->>E: Approve/Deny
    E-->>T: Approval status
    alt Approved
      T->>T: Execute command
    else Denied
      T-->>T: Return denial error
    end
  else Tier 0-1 (auto-approved)
    T->>T: Execute command immediately
  end
```
