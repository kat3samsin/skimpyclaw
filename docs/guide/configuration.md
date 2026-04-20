# Configuration

Main config file: `~/.skimpyclaw/config.json`

## Top-Level Sections

| Section | Description |
|---------|-------------|
| `gateway` | HTTP port, host, and mode (`local` \| `remote`) |
| `agents` | Default agent + agent definitions with identity and model |
| `models` | Provider credentials + model aliases + prompt caching |
| `channels` | Telegram, Discord, active channel selection |
| `cron.jobs` | Scheduled tasks (agentTurn or script) |
| `heartbeat` | Interval, prompt, optional model + tools |
| `dashboard` | Token for `/api/dashboard/*` auth |
| `codeAgents` | Concurrency and default code agent |
| `langfuse` | Optional observability tracing |
| `voice` | Optional TTS/STT configuration |
| `skills` | Skills system configuration |
| `projects` | Named project paths for code agents |

## Environment Placeholders

JSON values support env var substitution:

```json
"${ANTHROPIC_API_KEY}"
"${TELEGRAM_BOT_TOKEN}"
"${DISCORD_BOT_TOKEN}"
"${HOME}"
"${CLAUDE_CODE_OAUTH_TOKEN}"
```

macOS Keychain references are also supported in string values:

```json
"${KEYCHAIN:service/account}"
```

When the app writes `~/.skimpyclaw/config.json`, it enforces restrictive `0600` file permissions.

## Gateway

```json
"gateway": {
  "port": 18790,
  "host": "127.0.0.1",
  "mode": "local"
}
```

## Agents

```json
"agents": {
  "default": "main",
  "list": {
    "main": {
      "identity": {
        "name": "SkimpyClaw",
        "emoji": "👙🦞"
      },
      "model": "claude-fast",
      "thinking": "medium"
    }
  }
}
```

Thinking levels: `none`, `low`, `medium`, `high` (enables extended thinking for supported models).

## Models

```json
"models": {
  "providers": {
    "anthropic": { "apiKey": "${ANTHROPIC_API_KEY}" },
    "openrouter": { 
      "apiKey": "${OPENROUTER_KEY}", 
      "baseURL": "https://openrouter.ai/api/v1" 
    },
    "codex": { 
      "authToken": "codex",
      "authPath": "${HOME}/.codex/auth.json"
    },
    "kimi": {
      "apiKey": "${KIMI_API_KEY}",
      "baseURL": "https://api.kimi.com/v1"
    }
  },
  "aliases": {
    "claude-fast": "anthropic/claude-haiku-4-5",
    "claude-think": "anthropic/claude-sonnet-4-5",
    "claude-opus": "anthropic/claude-opus-4",
    "codex5.3": "codex/gpt-5.3-codex"
  },
  "promptCaching": true
}
```

Provider is determined by the prefix before `/` in the model string (e.g., `openrouter/google/gemini-2.0-flash`).

### Provider-Specific Notes

- **Anthropic**: Supports both API key and OAuth (Claude Code) authentication
- **Codex**: Uses ChatGPT backend via `~/.codex/auth.json` (created by `codex` CLI)
- **Kimi**: Requires `User-Agent` header with version string (handled automatically)

## Channels

### Telegram

```json
"channels": {
  "active": "telegram",
  "telegram": {
    "enabled": true,
    "token": "${TELEGRAM_BOT_TOKEN}",
    "allowFrom": ["@username", "123456789"],
    "tools": {
      "enabled": true,
      "allowedPaths": ["${HOME}/.skimpyclaw", "${HOME}/Projects"],
      "maxIterations": 100,
      "bashTimeout": 30000,
      "browser": {
        "enabled": true,
        "type": "chromium",
        "headless": true,
        "profileDir": "${HOME}/.skimpyclaw/browser-profile"
      },
      "execApproval": {
        "enabled": true,
        "ttlMs": 300000,
        "requireForTiers": [2, 3]
      }
    },
    "dailyNotesDir": "${HOME}/Notes/Daily"
  }
}
```

### Discord

```json
"discord": {
  "enabled": true,
  "token": "${DISCORD_BOT_TOKEN}",
  "allowFrom": ["username", "123456789"],
  "defaultChannelId": "123456789",
  "threadedReplies": true,
  "tools": {
    "enabled": true,
    "allowedPaths": ["${HOME}/.skimpyclaw"]
  }
}
```

## Cron Jobs

Two payload types: `agentTurn` and `script`.

### Agent Turn

```json
{
  "id": "morning",
  "name": "Morning Briefing",
  "schedule": {
    "kind": "cron",
    "expr": "0 8 * * *",
    "tz": "America/New_York"
  },
  "payload": {
    "kind": "agentTurn",
    "message": "Good morning! What's on the agenda today?",
    "sendAsVoice": false,
    "discordThreadId": "123456789012345678"
  },
  "model": "claude-think"
}
```

If `payload.discordThreadId` is set, cron notifications route to that Discord thread first. If the thread ID is invalid or delivery fails, notifications fall back to the active channel target.

### Script

```json
{
  "id": "backup",
  "name": "Daily Backup",
  "schedule": {
    "kind": "cron", 
    "expr": "0 2 * * *",
    "tz": "UTC"
  },
  "payload": {
    "kind": "script",
    "script": "rsync -av ~/Documents /Volumes/Backup/",
    "cwd": "${HOME}",
    "timeoutMs": 600000
  }
}
```

### Message from File

The `message` field can reference a markdown file:

```json
{
  "payload": {
    "kind": "agentTurn",
    "message": "morning-brief.md"
  }
}
```

Prompt files must live inside `~/.skimpyclaw/prompts/`. Paths outside this directory are rejected as a security measure. Bare filenames (e.g. `morning-brief.md`) are resolved relative to the prompts directory.

## Code Agents

```json
"codeAgents": {
  "maxConcurrent": 5,
  "defaultAgent": "claude"
}
```

- `maxConcurrent`: Maximum parallel coding agent tasks (default: 5)
- `defaultAgent`: Default CLI for `code_with_agent` (`claude`, `codex`, or `kimi`)

## Heartbeat

```json
"heartbeat": {
  "intervalMs": 3600000,
  "prompt": "Check for anything urgent. If nothing needs attention, respond with 'HEARTBEAT_OK'.",
  "model": "claude-fast",
  "tools": {
    "enabled": false
  }
}
```

## Dashboard

```json
"dashboard": {
  "token": "auto-generated-uuid",
  "frontend": "framework"
}
```

The token is auto-generated on first startup if not present.

## Langfuse (Optional)

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

## Voice (Optional)

```json
"voice": {
  "enabled": true,
  "defaultProvider": "elevenlabs",
  "providers": {
    "elevenlabs": {
      "apiKey": "${ELEVENLABS_API_KEY}",
      "tts": {
        "voiceId": "your-voice-id",
        "model": "eleven_multilingual_v2"
      }
    },
    "openai": {
      "apiKey": "${OPENAI_API_KEY}",
      "tts": {
        "model": "tts-1",
        "voice": "nova"
      },
      "stt": {
        "model": "whisper-1"
      }
    },
    "macos": {
      "tts": {
        "voice": "Zoe"
      }
    }
  },
  "channels": {
    "telegram": {
      "acceptVoice": true,
      "sendVoice": true
    },
    "discord": {
      "acceptVoice": true,
      "sendVoice": true
    }
  }
}
```

### Voice Providers

- **ElevenLabs**: High-quality voices, requires `voiceId`
- **OpenAI**: `tts-1`/`tts-1-hd` models, supports multiple voices
- **macOS**: Uses `say` command + ffmpeg (local, free)

### Transcription Priority

1. Local whisper.cpp (`whisper-cli`) — fastest, free
2. Local Python whisper (`whisper`) — free
3. Configured API provider — fallback

## Skills

```json
"skills": {
  "enabled": true,
  "directory": "${HOME}/.skimpyclaw/skills",
  "entries": {
    "my-skill": true,
    "another-skill": false
  },
  "maxPromptTokens": 4000
}
```

- `enabled`: Master switch for skills system
- `directory`: Path to skills directory
- `entries`: Per-skill enable/disable overrides
- `maxPromptTokens`: Budget for injected skills content

## Projects

Named project paths for use with `code_with_agent`:

```json
"projects": {
  "skimpyclaw": "${HOME}/Sites/skimpyclaw",
  "my-app": "${HOME}/Projects/my-app"
}
```

Projects are automatically added to tool `allowedPaths` and can be referenced by name in `code_with_agent` calls.

## Complete Example

```json
{
  "gateway": {
    "port": 18790,
    "host": "127.0.0.1",
    "mode": "local"
  },
  "agents": {
    "default": "main",
    "list": {
      "main": {
        "identity": {
          "name": "SkimpyClaw",
          "emoji": "👙🦞"
        },
        "model": "claude-fast"
      }
    }
  },
  "models": {
    "providers": {
      "anthropic": {
        "apiKey": "${ANTHROPIC_API_KEY}"
      }
    },
    "aliases": {
      "claude-fast": "anthropic/claude-sonnet-4-5",
      "claude-opus": "anthropic/claude-opus-4"
    },
    "promptCaching": true
  },
  "channels": {
    "active": "telegram",
    "telegram": {
      "enabled": true,
      "token": "${TELEGRAM_BOT_TOKEN}",
      "allowFrom": ["@yourusername"],
      "tools": {
        "enabled": true,
        "allowedPaths": ["${HOME}/.skimpyclaw"]
      }
    }
  },
  "cron": {
    "jobs": []
  },
  "heartbeat": {
    "intervalMs": 3600000,
    "prompt": "Check for anything urgent."
  }
}
```
