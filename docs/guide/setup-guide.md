# SkimpyClaw Setup Guide

Step-by-step guide for getting SkimpyClaw running on macOS. Works for both humans and Agents.

## Prerequisites

- **Node.js 18+** — `node --version`
- **pnpm** — `pnpm --version` (install: `npm install -g pnpm`)
- **Telegram bot token** — create one via [@BotFather](https://t.me/BotFather)
- **At least one AI provider** — Anthropic API key, OpenAI key, or Claude Code OAuth
- **Your Telegram user ID** — get it from [@userinfobot](https://t.me/userinfobot) (it's a number)

## Installation

```bash
pnpm add -g skimpyclaw
skimpyclaw onboard
skimpyclaw start --daemon
```

## Setup Wizard Walkthrough

The `skimpyclaw onboard` command walks you through:

### Required

1. **Telegram Bot Token** — paste the token from BotFather
2. **Your Telegram ID** — must be numeric (send `/start` to @userinfobot)
3. **Model Providers** — pick at least one (Anthropic, OpenAI, Codex, MiniMax)
4. **Agent Name** — what the bot calls itself (default: "Claw")
5. **Your Name** — what the bot calls you

### Optional Features

6. **Allowed paths** — `~/.skimpyclaw` is always included; add extra project paths only if needed.
7. **Browser tool** — requires Chrome/Chromium. Default: No. Enable if you need web scraping.
8. **Voice/TTS** — requires ffmpeg and whisper-cli. Default: No. Enable for voice messages.
9. **MCP tools** — requires mcporter at `~/.mcporter/`. Default: No. Enable for Automattic internal integrations.
10. **Starter packs** — optional starter cron jobs (HN + weather) and starter skills (code-review + daily-notes).

### Post-Setup

The wizard automatically runs doctor checks after writing config. Green = good, yellow = warnings to fix later.

## What Gets Created

```
~/.skimpyclaw/
├── config.json         # Main config (env var references, not secrets)
├── .env                # Secrets (API keys, tokens)
├── agents/main/        # Agent personality templates
│   ├── SOUL.md
│   ├── IDENTITY.md
│   ├── USER.md
│   ├── TOOLS.md
│   └── HEARTBEAT.md
├── logs/               # Runtime logs
├── sessions/           # Chat session storage
└── cron/               # Cron job output logs

~/Library/LaunchAgents/com.skimpyclaw.gateway.plist  # macOS daemon
```

## Starting the Service

```bash
# Option 1: Development mode (with hot reload)
pnpm dev

# Option 2: As a macOS daemon
skimpyclaw start --daemon

# Check it's running
curl http://localhost:18790/health
```

## Optional Features

All optional features are disabled by default. Enable them during `skimpyclaw onboard` or manually in config.

---

### Browser Tool (Playwright)

**What it does:** Lets the agent open URLs, click elements, fill forms, take screenshots, and scrape web content.

**Prerequisites:**

| Dependency | Install | Required? |
|------------|---------|-----------|
| Playwright | `pnpm add playwright` (in project) or `npx playwright install` | Yes |
| Chromium | `npx playwright install chromium` | Yes (or Chrome/Firefox) |
| Chrome (alternative) | Install from google.com/chrome | Optional — use instead of Chromium |
| Firefox (alternative) | Install from mozilla.org | Optional — set `browser.type: "firefox"` |

**Setup:**

```bash
# Install Playwright + Chromium
npx playwright install chromium
```

**Enable in config** (`~/.skimpyclaw/config.json`):

Add `browser` to any channel's `tools` block:

```json
"tools": {
  "enabled": true,
  "browser": {
    "enabled": true,
    "type": "chromium",
    "headless": true
  }
}
```

Or use a specific browser binary:

```json
"browser": {
  "enabled": true,
  "executablePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
}
```

**Verify:** `skimpyclaw doctor` checks for Playwright and a browser binary.

---

### Voice (STT / TTS)

**What it does:** Transcribes incoming voice messages (STT) and optionally generates voice replies (TTS).

#### STT (Speech-to-Text)

You need **one** of these — local whisper is preferred (free, fast):

| Option | Install | Notes |
|--------|---------|-------|
| whisper.cpp (recommended) | `brew install whisper-cpp` | Fast C++ implementation, ~1-3s per clip |
| Python whisper | `pip install openai-whisper` | Slower fallback |
| OpenAI Whisper API | Configure `voice.providers.openai` in config | Costs money, no local install needed |

whisper.cpp also needs a model file:

```bash
# Models are installed to /opt/homebrew/share/whisper-cpp/
# whisper-cpp ships with ggml-base.bin by default
# For better accuracy, download the small model:
curl -L -o /opt/homebrew/share/whisper-cpp/ggml-small.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
```

#### TTS (Text-to-Speech)

| Option | Install | Notes |
|--------|---------|-------|
| macOS `say` (free) | Built-in on macOS | Requires ffmpeg for format conversion |
| OpenAI TTS | Configure `voice.providers.openai.tts` | Higher quality, costs money |
| ElevenLabs | Configure `voice.providers.elevenlabs` | Requires API key + voice ID |

#### Shared Dependency

| Dependency | Install | Why |
|------------|---------|-----|
| ffmpeg | `brew install ffmpeg` | Converts audio formats (Telegram sends .oga, whisper needs .wav; macOS TTS outputs .aiff) |

**Enable in config:**

```json
"voice": {
  "enabled": true,
  "providers": {
    "macos": {
      "tts": { "voice": "Zoe" }
    }
  }
}
```

With API fallback:

```json
"voice": {
  "enabled": true,
  "defaultProvider": "openai",
  "providers": {
    "macos": { "tts": { "voice": "Zoe" } },
    "openai": {
      "apiKey": "${OPENAI_API_KEY}",
      "stt": { "model": "whisper-1" },
      "tts": { "model": "tts-1", "voice": "nova" }
    }
  }
}
```

**Verify:** `skimpyclaw doctor` checks for ffmpeg and whisper availability.

---

### Sandbox (Containerized Bash)

**What it does:** Runs Bash tool commands inside a container instead of on the host. Isolates agent-executed commands from your system.

**Prerequisites:**

| Dependency | Install | Notes |
|------------|---------|-------|
| Apple Containers | macOS 26+ (built-in) | Preferred on macOS — lightweight, fast |
| Docker (alternative) | `brew install docker` or Docker Desktop | Works on any OS |

**Setup:**

```bash
# 1. Ensure container runtime is running
container system start          # Apple Containers
# or
docker info                     # Docker

# 2. Initialize sandbox (builds image + updates config)
skimpyclaw sandbox init

# Options:
skimpyclaw sandbox init --runtime docker    # Force Docker
skimpyclaw sandbox init --profile dev       # Include build tools (gcc, make)
skimpyclaw sandbox init --profile full      # Include pip3, sqlite3, etc.
```

**Profiles:**

| Profile | Includes |
|---------|----------|
| `minimal` (default) | bash, curl, git, gh, jq, python3, ripgrep, pnpm |
| `dev` | minimal + gcc, g++, make |
| `full` | dev + pip3, sqlite3, unzip, less |

**What `sandbox init` does:**

1. Detects container runtime (Apple Containers or Docker)
2. Builds the sandbox image from the bundled Dockerfile
3. Runs smoke tests (CLI tools, network, hostname)
4. Updates `~/.skimpyclaw/config.json` with `sandbox.enabled: true`

**Management commands:**

```bash
skimpyclaw sandbox status       # List active sandbox containers
skimpyclaw sandbox prune        # Remove orphaned containers
skimpyclaw sandbox doctor       # Run targeted sandbox diagnostics
```

**Verify:** `skimpyclaw doctor` checks runtime availability and image existence.

---

### MCP Tools (mcporter)

**What it does:** Auto-discovers and exposes tools from [MCP](https://modelcontextprotocol.io/) servers. SkimpyClaw uses [mcporter](https://github.com/nicobrinkkemper/mcporter) as the MCP client.

**Prerequisites:**

| Dependency | Install | Notes |
|------------|---------|-------|
| mcporter | `pnpm add -g mcporter` | MCP server manager |
| MCP server(s) | Varies per server | Each server has its own install |

**Setup:**

```bash
# 1. Install mcporter
pnpm add -g mcporter

# 2. Add an MCP server (two ways)

# Via skimpyclaw CLI:
skimpyclaw tools install my-server --command npx --args '["@example/mcp-server"]'
skimpyclaw tools install my-sse-server --url http://localhost:3001/sse

# Or edit ~/.mcporter/mcporter.json directly:
```

```json
{
  "mcpServers": {
    "my-tools": {
      "command": "npx",
      "args": ["@example/mcp-server"]
    },
    "my-sse-server": {
      "url": "http://localhost:3001/sse"
    }
  }
}
```

**How it works at runtime:**

1. On first tool request, SkimpyClaw reads `~/.mcporter/mcporter.json`
2. Discovers all tools from each configured server
3. Maps tools as `mcp__{server}__{tool}` (e.g. `mcp__my-tools__search`)
4. Cached for the process lifetime — restart after adding/removing servers

**Management:**

```bash
skimpyclaw tools list           # Show all tools (built-in + MCP)
skimpyclaw tools remove my-server
```

**Note:** MCP tools only work with the Anthropic provider. Codex/OpenAI providers don't support MCP.

**Verify:** `skimpyclaw doctor` checks for mcporter config when MCP references are detected.

## Post-Setup Verification

```bash
# Run all checks
skimpyclaw doctor

# Or check via dashboard
open http://localhost:18790/dashboard
# Navigate to Health tab
```

## Dry Run

To preview what the wizard will create without writing anything:

```bash
skimpyclaw onboard -- --dry-run
```

## Updating Config

Edit `~/.skimpyclaw/config.json` directly, then restart the service:

```bash
# If running as daemon
skimpyclaw restart

# If running with pnpm dev, just save — tsx watch will restart
```

Agent prompt changes (files in `~/.skimpyclaw/agents/main/`) take effect immediately without restart.
