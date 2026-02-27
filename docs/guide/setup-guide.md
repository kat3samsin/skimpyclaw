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

## Feature Opt-In Guide

### When to Enable Browser

- You want the agent to visit URLs, take screenshots, or scrape web pages
- Requires Chrome or Chromium installed
- Enable in config: set `tools.browser.enabled: true` in any channel's tools config

### When to Enable Voice

- You want to send/receive voice messages in Telegram
- Requires: ffmpeg (audio conversion) and whisper-cli or whisper (transcription)
- Install: `brew install ffmpeg` then [whisper.cpp](https://github.com/ggerganov/whisper.cpp)

### When to Enable MCP Tools

- You're an Automattician wanting Slack/Linear/GitHub context
- Requires mcporter configured at `~/.mcporter/mcporter.json`
- See internal docs for mcporter setup

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
