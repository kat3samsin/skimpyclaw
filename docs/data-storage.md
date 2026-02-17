# Data & Storage

All runtime data lives under `~/.skimpyclaw/`.

```text
~/.skimpyclaw/
├── config.json                         # Runtime configuration
├── .env                                # Local secrets
├── agents/
│   ├── main/                           # Main agent templates + memory
│   │   ├── IDENTITY.md
│   │   ├── SOUL.md
│   │   ├── TOOLS.md
│   │   ├── USER.md
│   │   ├── HEARTBEAT.md
│   │   └── memory/
│   │       └── YYYY-MM-DD.md           # Daily conversation memory
│   ├── coding/                         # Coding subagent (auto-created)
│   │   ├── IDENTITY.md
│   │   ├── TOOLS.md
│   │   └── memory/
│   ├── research/                       # Research subagent (auto-created)
│   └── general/                        # General subagent (auto-created)
├── sessions/
│   └── *.json                          # Session records (dashboard-readable)
├── browser-profile/                    # Persistent browser profile
└── logs/
    ├── stdout.log                      # Application stdout
    ├── cron/
    │   └── <job>-YYYY-MM-DD.log        # Cron execution logs
    ├── audit/
    │   └── YYYY-MM-DD.jsonl            # Audit traces (one JSON line per trace)
    ├── subagent-runs.jsonl             # Subagent task lifecycle events
    └── code-agent-status.json          # Coding agent live status
```

## Audit log format

Each line in `logs/audit/YYYY-MM-DD.jsonl` is a completed trace:

```json
{
  "id": "trace-abc123",
  "trigger": "telegram",
  "status": "success",
  "startedAt": "2026-02-17T08:00:00.000Z",
  "endedAt": "2026-02-17T08:00:05.123Z",
  "events": [
    { "type": "tool_call", "summary": "Read ~/.skimpyclaw/agents/main/TOOLS.md", "durationMs": 12 },
    { "type": "model_call", "summary": "anthropic/claude-sonnet-4-6", "durationMs": 3200 }
  ]
}
```

## Security notes

- Channel access is allowlist-based (`allowFrom` IDs/usernames)
- Basic per-user message rate limiting is enabled
- User input is sanitized for common prompt-injection markers
- Dashboard config responses redact key/token-like fields
- Tool execution is constrained by `allowedPaths` and a bash safety blocklist
- Gateway binds to `127.0.0.1` by default
