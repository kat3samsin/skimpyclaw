# SkimpyClaw TODO

## Planned Features

### CLI Tool (`skimpyclaw` command)
- `skimpyclaw start` - Start the daemon
- `skimpyclaw stop` - Stop the daemon
- `skimpyclaw restart` - Restart
- `skimpyclaw status` - Show running status
- `skimpyclaw logs` - Tail logs
- `skimpyclaw setup` - Interactive onboarding wizard
- `skimpyclaw config` - Edit/view configuration
- `skimpyclaw config set <key> <value>` - Set config values
- `skimpyclaw model <alias>` - Switch model from CLI
- `skimpyclaw send <message>` - Send a message to the agent
- `skimpyclaw cron list` - List scheduled jobs
- `skimpyclaw cron run <id>` - Trigger a job

### Web Dashboard
- Local web UI at `http://localhost:18790/dashboard`
- Real-time status (uptime, model, last message)
- Conversation history viewer
- Memory browser (daily logs + curated MEMORY.md)
- Cron job management (view, trigger, edit schedules)
- Model switching UI
- Agent template editor (SOUL.md, USER.md, etc.)
- Logs viewer with filtering
- Config editor with validation

## Done
- [x] Gateway HTTP server
- [x] Telegram bot with allowlist
- [x] OAuth token auth (Claude Code impersonation)
- [x] Model switching via Telegram
- [x] Cron scheduler
- [x] Agent templates (SOUL, IDENTITY, USER, etc.)
- [x] Memory persistence (daily logs)
- [x] launchd daemon plist
- [x] Setup wizard (`pnpm run setup`)
