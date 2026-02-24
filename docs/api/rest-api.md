# REST API Reference

All endpoints are served by the Fastify gateway on port `18790`. Dashboard endpoints require Bearer token auth.

## Status & Configuration

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/dashboard/status` | Uptime, model, agent, active channel, cron jobs, subagent stats |
| `GET` | `/api/dashboard/config` | Current config (secrets redacted) |
| `PUT` | `/api/dashboard/config` | Save new config. Body: `{ config }` |
| `POST` | `/api/dashboard/restart` | Graceful process restart |
| `POST` | `/api/dashboard/reload` | Hot-reload config, providers, cron, heartbeat, channels |
| `GET` | `/api/dashboard/health` | Health with feature toggles and env var status |
| `GET` | `/api/dashboard/doctor` | Run diagnostic checks |

## Model Management

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/dashboard/model` | Current model, aliases, per-agent assignments |
| `POST` | `/api/dashboard/model` | Set model. Body: `{ model }` -- validated via `resolveModelSelection` |

## Sessions & Conversations

| Method | Path | Params | Description |
|--------|------|--------|-------------|
| `GET` | `/api/dashboard/sessions` | | List all conversation sessions |
| `GET` | `/api/dashboard/sessions/:id` | | Get full session (JSON) |
| `GET` | `/api/dashboard/conversations` | `channel?` | List telegram/discord conversations |
| `GET` | `/api/dashboard/conversations/:id` | `limit?`, `offset?` | Paginated messages (JSONL) |

## Messages

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/dashboard/messages/send` | Send to active channel. Body: `{ message }` |
| `POST` | `/api/dashboard/messages/agent` | Run through agent. Body: `{ message, model? }` |

## Cron Jobs

| Method | Path | Params | Description |
|--------|------|--------|-------------|
| `GET` | `/api/dashboard/cron` | | List all cron jobs |
| `GET` | `/api/dashboard/cron/prompt-file` | `path` (required) | Read prompt file content |
| `POST` | `/api/dashboard/cron/:id/run` | | Trigger job immediately |

## Memory & Templates

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/dashboard/memory/:agentId` | List memory files |
| `GET` | `/api/dashboard/memory/:agentId/:filename` | Read memory file (`curated` = MEMORY.md) |
| `GET` | `/api/dashboard/templates/:agentId` | List template files with existence status |
| `GET` | `/api/dashboard/templates/:agentId/:name` | Read template content |
| `PUT` | `/api/dashboard/templates/:agentId/:name` | Update template. Body: `{ content }` |

## Logs

| Method | Path | Params | Description |
|--------|------|--------|-------------|
| `GET` | `/api/dashboard/logs` | | List all log files recursively |
| `GET` | `/api/dashboard/logs/:filename` | `tail?` | Read log file, optional last N lines |

## Audit

| Method | Path | Params | Description |
|--------|------|--------|-------------|
| `GET` | `/api/dashboard/audit` | `limit?`, `offset?`, `trigger?` | Paginated audit traces (max 200) |

## Usage Tracking

| Method | Path | Params | Description |
|--------|------|--------|-------------|
| `GET` | `/api/dashboard/usage` | | Usage summary (costs, tokens) |
| `GET` | `/api/dashboard/usage/records` | `limit?`, `offset?`, `model?` | Paginated records (max 200) |

## TODOs

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/dashboard/todos` | Parse TODO.md items with completion stats |
| `PUT` | `/api/dashboard/todos/:id` | Toggle todo completion. Body: `{ completed? }` |
