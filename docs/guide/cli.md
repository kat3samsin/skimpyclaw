# CLI Reference

After install, `skimpyclaw` is available globally. During development use `pnpm run cli -- <command>`.

## Service management

```bash
skimpyclaw onboard          # Interactive setup wizard
skimpyclaw start            # Start in foreground
skimpyclaw start --daemon   # Start macOS launchd daemon
skimpyclaw stop             # Stop macOS launchd daemon
skimpyclaw restart          # Restart macOS launchd daemon
skimpyclaw status           # Show service + gateway status
skimpyclaw logs --file stdout --lines 200 --follow
skimpyclaw logs cleanup --dry-run # Preview log retention cleanup
skimpyclaw logs cleanup     # Prune old runtime artifacts and scratch files
skimpyclaw uninstall        # Remove launch agent, keep ~/.skimpyclaw data
skimpyclaw uninstall --purge # Remove launch agent and ~/.skimpyclaw data
```

For local development with hot reload, use `pnpm dev`.

## Config

```bash
skimpyclaw config get gateway.port
skimpyclaw config set gateway.port 18790
```

## Model

```bash
skimpyclaw model <alias|provider/model|model-id>
skimpyclaw model smart
skimpyclaw model anthropic/claude-sonnet-4-6
skimpyclaw model claude-sonnet-4-6
```

## Messaging

```bash
skimpyclaw send "plan my day"
```

## Cron

```bash
skimpyclaw cron list
skimpyclaw cron run morning
```

## Tools

```bash
skimpyclaw tools list
skimpyclaw tools install my-server --command npx --args '["@some/mcp-server"]'
skimpyclaw tools install my-server --url http://localhost:3001/sse
skimpyclaw tools remove my-server
```

## npm scripts

```bash
pnpm run start        # run once
pnpm run dev          # run with watch mode
pnpm run build        # compile TypeScript to dist/
pnpm run typecheck    # type-check only
pnpm run test         # run Vitest
pnpm run ci           # full CI gate (lint + typecheck + test)
```
