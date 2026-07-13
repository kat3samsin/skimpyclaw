# API Overview

SkimpyClaw exposes two groups of HTTP endpoints on port `18790`:

| Group | Prefix | Auth | Purpose |
|-------|--------|------|---------|
| **Gateway** | `/` | Mixed | Public health/artifact routes; bearer-authenticated status and write routes |
| **Dashboard** | `/api/dashboard/*` | Bearer token | Full management API |

## Authentication

All `/api/dashboard/*` routes require a Bearer token in the `Authorization` header:

```
Authorization: Bearer <token>
```

The token is generated during setup when missing and stored through
`~/.skimpyclaw/config.json` under `dashboard.token`, normally as a macOS
Keychain reference.

## Gateway Routes

These are lightweight operational endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Returns `{ status: 'ok', uptime }` |
| `GET` | `/status` | Full status: model, agent, cron jobs, last message |
| `POST` | `/message` | Send message to agent. Body: `{ message, model? }` |
| `POST` | `/model` | Switch model. Body: `{ model }` |
| `POST` | `/cron/:id/run` | Trigger a cron job by ID |
| `POST` | `/reload` | Placeholder (requires full restart) |

## Dashboard API Categories

The dashboard API has **40+ endpoints** organized by domain:

- [REST API](./rest-api.md) -- full endpoint reference
- [Dashboard API](./dashboard-api.md) -- interactive features (approvals, agents, digests)

## Quick Examples

### Check health

```bash
curl http://localhost:18790/health
```

### Send a message

```bash
curl -X POST http://localhost:18790/message \
  -H 'Content-Type: application/json' \
  -d '{"message": "What time is it?"}'
```

### Get dashboard status

```bash
curl http://localhost:18790/api/dashboard/status \
  -H 'Authorization: Bearer YOUR_TOKEN'
```
