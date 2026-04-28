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
- **Agents** — Multiple configured agent identities with their own prompts, models, effort, and memory
- **Cron scheduler** — Run prompts or scripts on a schedule
- **Web dashboard** — Manage everything through a beautiful web interface
- **Coding agents** — Delegate coding tasks to Claude Code, Codex, or Kimi CLI workers

## Quick Start

```bash
pnpm add -g skimpyclaw
skimpyclaw onboard
skimpyclaw start --daemon
```

## Next Steps

- Read the [Architecture](/guide/architecture) overview
- Learn about [Configuration](/guide/configuration)
- Review [Security](/guide/security) controls and hardening notes
- Follow the [Discord Update Documentation Process](/guide/discord-updates) when changing Discord behavior
- Explore available [Tools](/guide/tools)
- Configure [Agents](/guide/agents) and optional Discord profile aliases
- Set up [Cron jobs](/guide/configuration#cron) for scheduled and long-running tasks

## Getting Help

- Check the [Troubleshooting](/guide/troubleshooting) guide
- Browse the [API Reference](/api/)
- Open an issue on [GitHub](https://github.com/kat3samsin/skimpyclaw)
