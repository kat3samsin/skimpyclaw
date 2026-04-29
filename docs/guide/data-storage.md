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
│   ├── coding/                         # Coding agent (auto-created)
│   │   ├── IDENTITY.md
│   │   ├── TOOLS.md
│   │   └── memory/
│   ├── research/                       # Research agent (auto-created)
│   └── general/                        # General agent (auto-created)
├── sessions/
│   └── *.json                          # Session records (dashboard-readable)
│   └── *.jsonl                         # Conversation history (Telegram/Discord)
├── discord-thread-agents.json          # Discord profile aliases + thread bindings
├── skills/                             # Custom skills directory
│   └── <skill-name>/
│       └── SKILL.md                    # Skill definition
└── logs/
    ├── stdout.log                      # Application stdout
    ├── cron/
    │   └── <job>-YYYY-MM-DD.log        # Cron execution logs
    ├── audit/
    │   └── YYYY-MM-DD.jsonl            # Audit traces (one JSON line per trace)
    ├── usage/                           # Token usage tracking (JSONL)
    ├── code-agent-status.json          # Coding agent live status
    └── digests/                        # Digest storage for cron outputs
        ├── index.json                  # Digest index (id -> job/date) for direct lookup/delete
        └── <job-id>/
            └── YYYY-MM-DD-<digest-id>.json
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

## Digest format

Digests are stored in `logs/digests/<job-id>/YYYY-MM-DD-<digest-id>.json`:

```json
{
  "id": "morning-a1b2c3d4",
  "jobId": "morning",
  "jobName": "Morning Briefing",
  "createdAt": "2026-02-17T08:00:00.000Z",
  "articles": [
    {
      "id": "abc123def456",
      "title": "Article Title",
      "source": "Hacker News",
      "url": "https://example.com/article",
      "score": 123,
      "comments": 45,
      "read": false
    }
  ],
  "summary": "Raw digest content from agent"
}
```

Digest metadata is also indexed in `logs/digests/index.json` to support direct, validated lookup/deletion by digest ID.

## Discord profile format

Discord profile aliases and thread bindings are stored in `discord-thread-agents.json`:

```json
{
  "version": 2,
  "profiles": [
    {
      "alias": "reviewer",
      "agentId": "main",
      "model": "anthropic/claude-sonnet-4-6",
      "thinking": "high",
      "promptOverlay": "Focus on correctness and missing tests.",
      "createdBy": "1234567890",
      "createdAt": "2026-04-27T20:00:00.000Z",
      "updatedAt": "2026-04-27T20:05:00.000Z"
    }
  ],
  "bindings": [
    {
      "threadId": "9876543210",
      "profileAlias": "reviewer",
      "channelId": "5555555555",
      "createdBy": "1234567890",
      "createdAt": "2026-04-27T20:10:00.000Z",
      "updatedAt": "2026-04-27T20:10:00.000Z"
    }
  ]
}
```

## Security notes

- `config.json` is written with `0600` permissions (owner-only read/write)
- Secrets use `${ENV_VAR}` or `${KEYCHAIN:service/account}` references — never stored as plaintext in config
- Child processes (bash tool, cron scripts) receive a sanitized env via `sanitizeExecEnv()` — API keys, tokens, passwords, and provider-specific vars are stripped. `GH_TOKEN` is allowlisted
- The fetch tool validates all URLs against a private/reserved IP blocklist and blocked hostnames (localhost, cloud metadata endpoints). Redirect targets are re-validated on each hop
- Channel access is allowlist-based (`allowFrom` IDs/usernames)
- Basic per-user message rate limiting is enabled
- User input is sanitized for common prompt-injection markers
- Dashboard config responses redact key/token-like fields
- All gateway endpoints that expose state or accept writes (`/message`, `/model`, `/reload`, `/cron/*`, `/status`) require Bearer token auth
- Tool execution is constrained by `allowedPaths` and a bash safety blocklist
- Cron prompt file paths are restricted to `~/.skimpyclaw/prompts/` — path traversal attempts are rejected
- Bearer token validation uses SHA-256 hashing with `timingSafeEqual` to prevent timing side-channels
- Voice TTS uses `spawnSync` with argument arrays (no shell injection risk)
- Gateway binds to `127.0.0.1` by default
