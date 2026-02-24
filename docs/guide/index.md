---
title: Getting Started
outline: deep
---

# Getting Started

Welcome to SkimpyClaw! This guide will help you get up and running with your personal AI assistant.

## What is SkimpyClaw?

SkimpyClaw is a lightweight (~23k LOC) personal AI assistant that runs locally on your machine. It provides:

- **Multi-channel chat** — Telegram and Discord bots with persistent conversation history
- **Tool-enabled agent** — File read/write, bash, browser (Playwright), MCP tools
- **Cron scheduler** — Run prompts or scripts on a schedule
- **Web dashboard** — Manage everything through a beautiful web interface
- **Subagents** — Autonomous task delegation with retry and concurrency control

## Quick Start

```bash
# Clone the repository
git clone https://github.com/kat3samsin/skimpyclaw.git
cd skimpyclaw

# Install dependencies
pnpm install

# Run setup wizard
pnpm run onboard

# Start the service
pnpm dev
```

## Next Steps

- Read the [Architecture](/guide/architecture) overview
- Learn about [Configuration](/guide/configuration)
- Explore available [Tools](/guide/tools)
- Set up [Subagents](/guide/subagents) for complex tasks

## Getting Help

- Check the [Troubleshooting](/guide/troubleshooting) guide
- Browse the [API Reference](/api/)
- Open an issue on [GitHub](https://github.com/kat3samsin/skimpyclaw)
