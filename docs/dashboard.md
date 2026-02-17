# Dashboard & HTTP API

## Web dashboard

Open `http://127.0.0.1:18790/dashboard` in a browser. The bearer token is shown in startup logs and stored in `config.dashboard.token`.

The dashboard is a single-page app (inline HTML/CSS/JS, no build step) with tabs for:
- **Status** — service health, active model, active channel
- **Cron** — job list, trigger on-demand runs
- **Audit** — trace log with trigger badges, collapsible events, pagination
- **Memory** — browse agent memory files
- **Templates** — view and edit agent template files
- **Logs** — application log viewer
- **Config** — live config viewer/editor (sensitive fields redacted)

## Gateway routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service health check |
| GET | `/status` | Runtime status |
| POST | `/message` | Send a message `{ message, model? }` |
| POST | `/model` | Switch model `{ model }` |
| POST | `/cron/:id/run` | Trigger a cron job |
| POST | `/reload` | Reload config (currently requires restart) |
| GET | `/dashboard` | Dashboard UI |

## Dashboard API routes

All routes require `Authorization: Bearer <token>`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/dashboard/status` | Service + model status |
| GET | `/api/dashboard/sessions` | Session list |
| GET | `/api/dashboard/sessions/:id` | Session detail |
| GET | `/api/dashboard/memory/:agentId` | List memory files |
| GET | `/api/dashboard/memory/:agentId/:filename` | Read memory file |
| GET | `/api/dashboard/cron` | List cron jobs |
| POST | `/api/dashboard/cron/:id/run` | Trigger cron job |
| GET | `/api/dashboard/model` | Current model |
| POST | `/api/dashboard/model` | Switch model |
| GET | `/api/dashboard/templates/:agentId` | List templates |
| GET | `/api/dashboard/templates/:agentId/:name` | Read template |
| PUT | `/api/dashboard/templates/:agentId/:name` | Update template |
| GET | `/api/dashboard/logs` | List log files |
| GET | `/api/dashboard/logs/:filename` | Read log file |
| GET | `/api/dashboard/config` | Read config (redacted) |
| PUT | `/api/dashboard/config` | Update config |
| GET | `/api/dashboard/audit` | Audit traces `?limit=&offset=&trigger=` |
| GET | `/api/dashboard/code-agent-status` | Coding agent live status |
