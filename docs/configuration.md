# Configuration

Main config file: `~/.skimpyclaw/config.json`

## Top-level sections

| Section | Description |
|---------|-------------|
| `gateway` | HTTP port and mode (`local` \| `remote`) |
| `agents` | Default agent + agent definitions |
| `models` | Provider credentials + model aliases |
| `channels` | Telegram, Discord, active channel selection |
| `cron.jobs` | Scheduled tasks |
| `heartbeat` | Interval, prompt, optional model + tools |
| `dashboard.token` | Bearer token for `/api/dashboard/*` |
| `subagents` | Concurrency + retry limits |
| `langfuse` | Optional observability tracing |
| `voice` | Optional TTS/STT configuration |

## Environment placeholders

JSON values support env var substitution:

```json
"${ANTHROPIC_API_KEY}"
"${TELEGRAM_BOT_TOKEN}"
"${DISCORD_BOT_TOKEN}"
"${HOME}"
"${CLAUDE_CODE_OAUTH_TOKEN}"
```

## Models

```json
"models": {
  "providers": {
    "anthropic": { "apiKey": "${ANTHROPIC_API_KEY}" },
    "openrouter": { "apiKey": "${OPENROUTER_KEY}", "baseURL": "https://openrouter.ai/api/v1" },
    "codex": { "authPath": "${HOME}/.codex/auth.json" }
  },
  "aliases": {
    "claude-fast":  "anthropic/claude-haiku-4-5-20251001",
    "claude-think": "anthropic/claude-sonnet-4-6",
    "claude-opus":  "anthropic/claude-opus-4-6",
    "codex5.3":     "codex/gpt-5.3-codex",
    "codex-spark":  "codex/gpt-5.3-codex-spark"
  }
}
```

Provider is determined by the prefix before `/` in the model string (e.g. `openrouter/google/gemini-2.0-flash`).

## Channels

```json
"channels": {
  "active": "telegram",
  "telegram": {
    "token": "${TELEGRAM_BOT_TOKEN}",
    "allowFrom": ["@username", "123456789"],
    "tools": {
      "enabled": true,
      "allowedPaths": ["${HOME}/.skimpyclaw", "${HOME}/Library/Mobile Documents/iCloud~md~obsidian"],
      "maxIterations": 20,
      "bashTimeout": 30000
    }
  },
  "discord": {
    "token": "${DISCORD_BOT_TOKEN}",
    "allowFrom": ["username#0000"],
    "defaultChannelId": "123456789"
  }
}
```

## Cron jobs

Two payload types:

**agentTurn** — runs an agent prompt:
```json
{
  "id": "morning",
  "cron": "0 8 * * *",
  "payload": {
    "type": "agentTurn",
    "agentId": "main",
    "model": "claude-think",
    "prompt": "Good morning! Here's the plan for today...",
    "tools": { "enabled": true, "allowedPaths": ["${HOME}/.skimpyclaw"] }
  }
}
```

**script** — runs a shell command:
```json
{
  "id": "backup",
  "cron": "0 2 * * *",
  "payload": {
    "type": "script",
    "command": "rsync -av ~/Documents /Volumes/Backup/",
    "cwd": "${HOME}",
    "timeoutMs": 60000
  }
}
```

## Subagents

```json
"subagents": {
  "maxConcurrent": 5,
  "maxRetries": 2
}
```

## Heartbeat

```json
"heartbeat": {
  "intervalMs": 300000,
  "prompt": "Check for anything urgent.",
  "model": "claude-fast",
  "tools": { "enabled": false }
}
```

## Langfuse (optional)

```json
"langfuse": {
  "enabled": true,
  "publicKey": "${LANGFUSE_PUBLIC_KEY}",
  "secretKey": "${LANGFUSE_SECRET_KEY}",
  "baseUrl": "https://cloud.langfuse.com",
  "environment": "local",
  "release": "dev",
  "exportMode": "batched"
}
```

Traces are created per agent turn. Tool calls appear as child observations. Token costs may be blank for OAuth/Codex unless Langfuse has model pricing configured.

## Voice (optional)

```json
"voice": {
  "enabled": true,
  "defaultProvider": "elevenlabs",
  "providers": {
    "elevenlabs": {
      "apiKey": "${ELEVENLABS_API_KEY}",
      "tts": { "voiceId": "your-voice-id" }
    }
  },
  "channels": {
    "telegram": { "acceptVoice": true, "sendVoice": false }
  }
}
```
