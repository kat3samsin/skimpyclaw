# Config Options

Configuration lives at `~/.skimpyclaw/config.json`. All fields are optional unless noted.

Environment variable interpolation is supported via `${ENV_VAR}` syntax in string values (e.g. `"${HOME}/.skimpyclaw"`).
On macOS, generic-password keychain references are also supported via `${KEYCHAIN:service/account}`.
`~/.skimpyclaw/config.json` is written with `0600` permissions.

---

## `gateway`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `port` | number | `18790` | HTTP server port |
| `host` | string | `127.0.0.1` | Bind address |
| `mode` | string | `local` | Deployment mode: `local` or `remote` |

## `agents`

| Field | Type | Description |
|-------|------|-------------|
| `default` | string | Default agent name (usually `main`) |
| `list` | object | Map of agent name → agent config |

### Agent config

| Field | Type | Description |
|-------|------|-------------|
| `identity.name` | string | Display name |
| `identity.emoji` | string | Agent emoji |
| `model` | string | Default model (e.g. `anthropic/claude-opus-4`) |
| `thinking` | string | Thinking level: `none`, `low`, `medium`, `high` |

## `models`

### `models.providers`

Each provider key maps to its auth config:

```json
{
  "anthropic": { "authToken": "${CLAUDE_CODE_OAUTH_TOKEN}" },
  "openai": { "apiKey": "${OPENAI_API_KEY}", "baseURL": "https://api.openai.com/v1" },
  "codex": { "authToken": "codex", "authPath": "${HOME}/.codex/auth.json", "baseURL": "https://chatgpt.com/backend-api" },
  "minimax": { "apiKey": "${MINIMAX_API_KEY}", "baseURL": "https://api.minimax.io/v1" }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `apiKey` | string | API key for the provider |
| `authToken` | string | OAuth/auth token (Anthropic, Codex) |
| `baseURL` | string | Custom API base URL |
| `authPath` | string | Path to auth JSON file (Codex) |

### `models.aliases`

Map of shorthand names to full `provider/model-id`. See [Model Aliases](./model-aliases.md).

### `models.promptCaching`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `promptCaching` | boolean | `true` | Enable Anthropic prompt caching |

## `channels`

| Field | Type | Description |
|-------|------|-------------|
| `active` | string | Active channel preference: `telegram` or `discord`. If unset, picks first enabled channel |

### `channels.telegram`

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable Telegram channel |
| `token` | string | Bot token (use `${ENV_VAR}` syntax) |
| `allowFrom` | array | Allowed user IDs (string or number) |
| `tools` | ToolConfig | Tool access config for this channel |
| `defaultAllowedPaths` | string[] | Filesystem paths the agent can access |
| `dailyNotesDir` | string | Directory for daily notes feature |

### `channels.discord`

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable Discord channel |
| `token` | string | Bot token (use `${ENV_VAR}` syntax) |
| `allowFrom` | array | Allowed user IDs (string or number) |
| `tools` | ToolConfig | Tool access config for this channel |
| `defaultAllowedPaths` | string[] | Filesystem paths the agent can access |
| `defaultChannelId` | string | Default channel for proactive messages (cron results, coding agent notifications) |
| `threadedReplies` | boolean | Route coding agent status updates to Discord threads (default: `true`) |

## `cron`

| Field | Type | Description |
|-------|------|-------------|
| `jobs` | array | List of cron job definitions |

### Cron job

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique job ID |
| `name` | string | Human-readable job name |
| `model` | string | Model override for this job |
| `schedule` | CronSchedule | Schedule config (see below) |
| `payload` | CronPayload | What to run (see below) |

### CronSchedule

| Field | Type | Description |
|-------|------|-------------|
| `kind` | string | `cron` or `interval` |
| `expr` | string | Cron expression (e.g. `0 8 * * *`) — for `kind: cron` |
| `ms` | number | Interval in milliseconds — for `kind: interval` |
| `tz` | string | IANA timezone (e.g. `America/Chicago`). Falls back to system timezone if invalid |

### CronPayload

| Field | Type | Description |
|-------|------|-------------|
| `kind` | string | `agentTurn`, `script`, or `http` |
| `message` | string | Agent prompt or path to prompt file (for `agentTurn`) |
| `script` | string | Shell command (for `script`) |
| `url` | string | URL to call (for `http`) |
| `cwd` | string | Working directory (for `script`) |
| `timeoutMs` | number | Timeout in milliseconds |
| `tools` | ToolConfig | Tool access config (for `agentTurn`) |
| `sendAsVoice` | boolean | Send result as voice message |
| `discordThreadId` | string | Discord thread ID to send cron notifications to; falls back to active channel if invalid/unavailable |

## `heartbeat`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `intervalMs` | number | `3600000` | Check interval (1 hour) |
| `prompt` | string | | Heartbeat prompt |
| `model` | string | | Model override for heartbeat |
| `tools` | ToolConfig | | Tool access for heartbeat agent |

## `dashboard`

| Field | Type | Description |
|-------|------|-------------|
| `token` | string | Bearer auth token (auto-generated by setup) |
| `frontend` | string | Frontend mode: `framework` |

## `codeAgents`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxConcurrent` | number | `5` | Max parallel coding agents |
| `defaultAgent` | string | `claude` | Default CLI: `claude`, `codex`, or `kimi` |
| `timeoutMinutes` | number | `30` | Timeout for `code_with_agent` (max: 60) |
| `maxTurns` | number | `50` | Max tool-use turns per agent |
| `skipPlaywright` | boolean | `false` | Skip Playwright MCP for coding agents |
| `validationCommands` | object | | Per-project validation commands. Keys match project names from `projects` config. Values are shell commands run in the project dir. Overrides auto-detected build+test |

> **Note:** `code_with_agent` requires an external coding CLI on your PATH. See [Coding Agent Execution](./code-agents.md).

## `langfuse`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable Langfuse observability |
| `publicKey` | string | | Langfuse public key |
| `secretKey` | string | | Langfuse secret key |
| `baseUrl` | string | | Langfuse server URL |
| `environment` | string | | Environment tag |
| `release` | string | | Release tag |
| `exportMode` | string | `batched` | `immediate` or `batched` |

## `voice`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Master switch for voice features |
| `defaultProvider` | string | | Default voice provider name |
| `providers` | object | | Map of provider name → VoiceProviderConfig |
| `channels` | object | | Map of channel name → VoiceChannelConfig |

### VoiceProviderConfig

| Field | Type | Description |
|-------|------|-------------|
| `apiKey` | string | Provider API key |
| `baseURL` | string | Custom API base URL |
| `tts.model` | string | TTS model name |
| `tts.voice` | string | Voice name |
| `tts.speed` | number | Playback speed |
| `tts.voiceId` | string | Voice ID (ElevenLabs) |
| `stt.model` | string | STT model name |

### VoiceChannelConfig

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable voice for this channel |
| `acceptVoice` | boolean | Accept incoming voice messages |
| `sendVoice` | boolean | Send responses as voice |

## `skills`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch for the skills system |
| `directory` | string | `~/.skimpyclaw/skills/` | Skills directory path |
| `entries` | object | | Override per-skill enabled state: `{ skillName: boolean }` |
| `maxPromptTokens` | number | `4000` | Max approximate tokens for injected skills prompt |
| `dynamicLoading` | boolean | `true` | Progressive disclosure — only inject names/descriptions, load full content on-demand |

## `projects`

Named project paths. Keys are short names (e.g. `"skimpyclaw"`), values are absolute paths. Project paths are automatically added to tool `allowedPaths` and available to `code_with_agent` by name.

```json
{
  "skimpyclaw": "/Users/you/Sites/skimpyclaw",
  "my-app": "/Users/you/Projects/my-app"
}
```

## `sandbox`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable sandboxed execution |
| `runtime` | string | auto-detect | Container runtime: `container` or `docker` |
| `image` | string | `skimpyclaw-sandbox` | Container image name |
| `cpus` | number | `2` | CPU limit |
| `memory` | string | `2G` | Memory limit |
| `network` | string | `none` | Network mode |
| `idleTimeoutMs` | number | `3600000` | Idle timeout before container stops (1 hour) |

---

## `ToolConfig`

Used by cron jobs, heartbeat, and channel defaults:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | | Enable tool use |
| `allowedPaths` | string[] | | Filesystem paths the agent can access |
| `maxIterations` | number | `20` | Max tool-use loop iterations |
| `bashTimeout` | number | `30000` | Bash command timeout (ms) |
| `maxTurnTokens` | number | `200000` | Max tokens per agent turn |
| `toolProfile` | string | `full` | Tool set to expose: `minimal`, `coding`, or `full` |

### `contextManagement`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable automatic context compaction |
| `maxContextTokens` | number | `100000` | Token threshold before compaction triggers |
| `compactionModel` | string | `anthropic/claude-haiku-4-5` | Model used for LLM summarization when compacting |

### `browser`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable Playwright browser tool |
| `type` | string | `chromium` | Browser type: `chromium`, `firefox`, `webkit` |
| `headless` | boolean | `true` | Run headless |
| `allowFile` | boolean | | Allow `file://` URLs |
| `slowMoMs` | number | | Slow-motion delay (ms) |
| `userAgent` | string | | Custom user agent |
| `viewport` | object | | `{ width, height }` |
| `profileDir` | string | | Persistent browser profile directory |
| `executablePath` | string | | Path to browser executable |

### `execApproval`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable bash exec approval |
| `ttlMs` | number | `300000` | Approval TTL (5 min) |
| `requireForTiers` | number[] | `[2, 3]` | Risk tiers that require approval |
