# Dashboard API

Interactive and management features exposed through the dashboard API.

## Code Agents

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/dashboard/code-agents` | List active/recent code agent runs |
| `GET` | `/api/dashboard/code-agents/:id` | Get details of a specific run |
| `POST` | `/api/dashboard/code-agents/:id/cancel` | Cancel a running agent |

### Code Agent Status Object

```json
{
  "id": "abc-123",
  "status": "running",
  "task": "Fix the login bug",
  "model": "anthropic/claude-opus-4-7",
  "startedAt": "2026-02-23T10:00:00Z",
  "output": "Last 5KB of streaming output..."
}
```

Status values: `running`, `validating`, `completed`, `failed`

## Exec Approvals

Bash commands classified as Tier 2+ require explicit approval before execution.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/dashboard/approvals` | List pending and recent approval requests |
| `POST` | `/api/dashboard/approvals/:id/approve` | Approve a pending command |
| `POST` | `/api/dashboard/approvals/:id/deny` | Deny a pending command |

### Risk Tiers

| Tier | Risk | Behavior |
|------|------|----------|
| 0 | Safe | Auto-approved |
| 1 | Low | Auto-approved |
| 2 | Medium | Prompts user (sudo, chmod 777) |
| 3 | Catastrophic | Always requires approval (rm -rf, mkfs, DROP TABLE) |

## Digests

Cron job article outputs stored as digests.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/dashboard/digests` | List all digests |
| `GET` | `/api/dashboard/digests/:id` | Get digest content |
| `DELETE` | `/api/dashboard/digests/:id` | Delete a digest |
| `POST` | `/api/dashboard/digests/:digestId/articles/:articleId/read` | Mark article read/unread. Body: `{ read? }` |

## Skills

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/dashboard/skills` | List skills with eligibility and metadata |
| `GET` | `/api/dashboard/skills/:name` | Full skill details including raw SKILL.md |
| `POST` | `/api/dashboard/skills` | Create skill. Body: `{ name, content }` |
| `PUT` | `/api/dashboard/skills/:name` | Update skill. Body: `{ enabled?, content? }` |
| `DELETE` | `/api/dashboard/skills/:name` | Delete skill directory |
