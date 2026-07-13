# Dashboard & HTTP API

## Web dashboard

Open `http://127.0.0.1:18790/dashboard` in a browser. The bearer token is shown
once during setup and is normally stored in macOS Keychain through the
`config.dashboard.token` reference. Routine status and startup logs do not print it.

The dashboard is a framework SPA (Preact/Vite) served from built assets in `dist/dashboard/`.
If the build output is missing, `/dashboard` returns a `503` with build instructions.

Current pages include:

- **Overview** — service stats, active model, coding agent status, recent activity
- **Cron** — job list, trigger on-demand runs
- **Audit** — trace log with trigger badges, collapsible events, pagination
- **Memory** — browse agent memory files
- **Templates** — view and edit agent template files
- **Logs** — application log viewer
- **Config** — live config viewer/editor (sensitive fields redacted)
- **Skills** — browse, enable/disable, and edit skills
- **Digests** — browse cron job digest outputs
- **Approvals** — pending and recent exec approval requests
- **Messages** — chat interface for agent interaction
- **Health** — doctor checks and system health status

## Gateway routes

| Method | Path            | Description                                |
| ------ | --------------- | ------------------------------------------ |
| GET    | `/health`       | Service health check                       |
| GET    | `/status`       | Runtime status                             |
| POST   | `/message`      | Send a message `{ message, model? }`       |
| POST   | `/model`        | Switch model `{ model }` (alias/provider/model/model-id) |
| POST   | `/cron/:id/run` | Trigger a cron job                         |
| POST   | `/reload`       | Placeholder response (restart required)    |
| GET    | `/dashboard`    | Dashboard UI                               |

## Dashboard API routes

All routes require `Authorization: Bearer <token>`.

### Status & Health

| Method | Path                                       | Description                             |
| ------ | ------------------------------------------ | --------------------------------------- |
| GET    | `/api/dashboard/status`                    | Service + model + coding agent status   |
| GET    | `/api/dashboard/health`                    | Doctor checks + feature toggles         |
| GET    | `/api/dashboard/doctor`                    | Full doctor report                      |

### Conversations

| Method | Path                                       | Description                             |
| ------ | ------------------------------------------ | --------------------------------------- |
| GET    | `/api/dashboard/conversations`             | Chat conversations list                 |
| GET    | `/api/dashboard/conversations/:id`         | Conversation messages                   |

### Memory

| Method | Path                                       | Description                             |
| ------ | ------------------------------------------ | --------------------------------------- |
| GET    | `/api/dashboard/memory/:agentId`           | List memory files                       |
| GET    | `/api/dashboard/memory/:agentId/:filename` | Read memory file                        |

### Cron

| Method | Path                                       | Description                             |
| ------ | ------------------------------------------ | --------------------------------------- |
| GET    | `/api/dashboard/cron`                      | List cron jobs                          |
| GET    | `/api/dashboard/cron/prompt-file?path=`    | Read cron prompt file                   |
| POST   | `/api/dashboard/cron/:id/run`              | Trigger cron job                        |

### Model

| Method | Path                                       | Description                             |
| ------ | ------------------------------------------ | --------------------------------------- |
| GET    | `/api/dashboard/model`                     | Current model + aliases                 |
| POST   | `/api/dashboard/model`                     | Switch model (returns resolved model)   |

### Templates

| Method | Path                                       | Description                             |
| ------ | ------------------------------------------ | --------------------------------------- |
| GET    | `/api/dashboard/templates/:agentId`        | List templates                          |
| GET    | `/api/dashboard/templates/:agentId/:name`  | Read template                           |
| PUT    | `/api/dashboard/templates/:agentId/:name`  | Update template                         |

### Logs

| Method | Path                                       | Description                             |
| ------ | ------------------------------------------ | --------------------------------------- |
| GET    | `/api/dashboard/logs`                      | List log files                          |
| GET    | `/api/dashboard/logs/:filename?tail=N`     | Read log file (optional tail lines)     |

### Config

| Method | Path                                       | Description                             |
| ------ | ------------------------------------------ | --------------------------------------- |
| GET    | `/api/dashboard/config`                    | Read config (redacted)                  |
| PUT    | `/api/dashboard/config`                    | Update config                           |
| POST   | `/api/dashboard/restart`                   | Restart service                         |
| POST   | `/api/dashboard/reload`                    | Reload config (live reload)             |

### Audit

| Method | Path                                       | Description                             |
| ------ | ------------------------------------------ | --------------------------------------- |
| GET    | `/api/dashboard/audit?limit=&offset=&trigger=` | Audit traces                        |

### Usage

| Method | Path                                       | Description                             |
| ------ | ------------------------------------------ | --------------------------------------- |
| GET    | `/api/dashboard/usage`                     | Usage summary                           |
| GET    | `/api/dashboard/usage/records`             | Usage records                           |

### Code Agents

| Method | Path                                       | Description                             |
| ------ | ------------------------------------------ | --------------------------------------- |
| GET    | `/api/dashboard/code-agents`               | List code agents                        |
| GET    | `/api/dashboard/code-agents/:id`           | Code agent detail                       |
| POST   | `/api/dashboard/code-agents/:id/cancel`    | Cancel code agent                       |

### Exec Approvals

| Method | Path                                       | Description                             |
| ------ | ------------------------------------------ | --------------------------------------- |
| GET    | `/api/dashboard/approvals`                 | List pending + recent approvals         |
| POST   | `/api/dashboard/approvals/:id/approve`     | Approve request                         |
| POST   | `/api/dashboard/approvals/:id/deny`        | Deny request                            |

### Digests

| Method | Path                                       | Description                             |
| ------ | ------------------------------------------ | --------------------------------------- |
| GET    | `/api/dashboard/digests`                   | List digests                            |
| GET    | `/api/dashboard/digests/:id`               | Get digest detail                       |
| DELETE | `/api/dashboard/digests/:id`               | Delete digest                           |
| POST   | `/api/dashboard/digests/:digestId/articles/:articleId/read` | Mark article read/unread |

### Skills

| Method | Path                                       | Description                             |
| ------ | ------------------------------------------ | --------------------------------------- |
| GET    | `/api/dashboard/skills`                    | List skills                             |
| GET    | `/api/dashboard/skills/:name`              | Get skill detail                        |
| POST   | `/api/dashboard/skills`                    | Create skill                            |
| PUT    | `/api/dashboard/skills/:name`              | Update skill (enable/disable/edit)      |
| DELETE | `/api/dashboard/skills/:name`              | Delete skill                            |

### Messages

| Method | Path                                       | Description                             |
| ------ | ------------------------------------------ | --------------------------------------- |
| POST   | `/api/dashboard/messages/send`             | Send message to active channel          |
| POST   | `/api/dashboard/messages/agent`            | Run agent turn (get response)           |
