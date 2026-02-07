# SkimpyClaw Dashboard - Implementation Plan

## Architecture

Single inline HTML page served from Fastify. No build step, no separate framework. Dashboard HTML lives in `src/dashboard.ts` as a template literal, served via `GET /dashboard`. All data flows through `/api/*` endpoints on the same Fastify server (port 18790). Frontend uses vanilla JS with `fetch()` for API calls.

---

## File Structure

### New Files
- `src/dashboard.ts` - Dashboard HTML/CSS/JS as exported template literal + dashboard route registration
- `src/api.ts` - All `/api/*` route definitions (keeps gateway.ts clean)

### Modified Files
- `src/gateway.ts` - Import and register dashboard routes + API routes
- `src/agent.ts` - Export `TEMPLATE_FILES` constant (currently private), add `getAgentTemplateContent(agentId, templateName)` and `saveAgentTemplate(agentId, templateName, content)` helpers
- `src/config.ts` - Add `saveConfig(config)` for config editor, add `listMemoryFiles(agentId)` and `readMemoryFile(agentId, filename)` helpers
- `src/cron.ts` - Export `scheduledJobs` map or add `getCronJobDetails()` returning full job definitions including schedule/payload

---

## API Endpoints

All endpoints prefixed with `/api/dashboard`.

### Status
| Method | Path | Description | Response |
|--------|------|-------------|----------|
| GET | `/api/dashboard/status` | Full system status | `{ uptime, model, agent, lastMessage, cronJobs[] }` |

Uses existing `/status` logic. May just proxy to it or share the handler.

### Sessions / Conversation History
| Method | Path | Description | Response |
|--------|------|-------------|----------|
| GET | `/api/dashboard/sessions` | List sessions | `{ sessions: [{ id, agentId, model, createdAt, updatedAt, turnCount }] }` |
| GET | `/api/dashboard/sessions/:id` | Get session detail | `{ session: Session }` |

Implementation: Read JSON files from `~/.skimpyclaw/sessions/`.

### Memory
| Method | Path | Description | Response |
|--------|------|-------------|----------|
| GET | `/api/dashboard/memory/:agentId` | List memory files | `{ files: [{ name, date, size }] }` |
| GET | `/api/dashboard/memory/:agentId/:filename` | Read memory file | `{ content: string }` |
| GET | `/api/dashboard/memory/:agentId/curated` | Read MEMORY.md | `{ content: string }` |

Implementation: Read from `~/.skimpyclaw/agents/{agentId}/memory/` and `~/.skimpyclaw/agents/{agentId}/MEMORY.md`.

### Cron Jobs
| Method | Path | Description | Response |
|--------|------|-------------|----------|
| GET | `/api/dashboard/cron` | List all cron jobs with details | `{ jobs: CronJob[] }` (includes schedule, payload, nextRun) |
| POST | `/api/dashboard/cron/:id/run` | Trigger a cron job | `{ status: 'triggered', id }` |

Implementation: Wraps existing `getCronJobs()` and `runCronJob()`. Gets full job defs from config.

### Model
| Method | Path | Description | Response |
|--------|------|-------------|----------|
| GET | `/api/dashboard/model` | Get current model + aliases | `{ current, aliases, agents }` |
| POST | `/api/dashboard/model` | Switch model | `{ model: string }` |

Implementation: Wraps existing `/model` route. Adds alias listing from config.

### Agent Templates
| Method | Path | Description | Response |
|--------|------|-------------|----------|
| GET | `/api/dashboard/templates/:agentId` | List templates | `{ templates: [{ name, exists, size }] }` |
| GET | `/api/dashboard/templates/:agentId/:name` | Read template content | `{ name, content }` |
| PUT | `/api/dashboard/templates/:agentId/:name` | Save template | `{ saved: true }` |

Implementation: Uses `TEMPLATE_FILES` list, reads/writes from `~/.skimpyclaw/agents/{agentId}/`.

### Logs
| Method | Path | Description | Response |
|--------|------|-------------|----------|
| GET | `/api/dashboard/logs` | List log files | `{ files: [{ name, size, modified }] }` |
| GET | `/api/dashboard/logs/:filename` | Read log content (supports `?tail=100`) | `{ content: string, lines: number }` |

Implementation: Read from `~/.skimpyclaw/logs/`.

### Config
| Method | Path | Description | Response |
|--------|------|-------------|----------|
| GET | `/api/dashboard/config` | Get config (secrets redacted) | `{ config: Config }` (redacted) |
| PUT | `/api/dashboard/config` | Save config (validates first) | `{ saved: true }` or `{ error: string }` |

Implementation: Uses `loadConfig()`, `redactSecrets()`, and new `saveConfig()`. Validation: parse JSON, type-check required fields, reject if secrets section is missing/malformed.

---

## Frontend Layout

Single-page app with tab navigation. No router needed - just show/hide sections.

```
+----------------------------------------------------------+
| SkimpyClaw Dashboard                    [status indicator] |
+----------------------------------------------------------+
| Status | History | Memory | Cron | Model | Templates | Logs | Config |
+----------------------------------------------------------+
|                                                          |
|  [Active tab content area]                               |
|                                                          |
+----------------------------------------------------------+
```

### Tab: Status (default)
- Uptime counter (auto-refreshing every 5s)
- Current model display
- Active agent name + emoji
- Last message timestamp
- Quick-glance cron job status cards

### Tab: History
- List of sessions in sidebar (sorted by date, newest first)
- Selected session shows turns in chat-bubble style
- Each turn shows role, content, timestamp

### Tab: Memory
- Agent selector dropdown (if multiple agents)
- File list (daily logs sorted by date desc)
- File content viewer (markdown rendered as plain text with headers)
- Separate section for curated MEMORY.md

### Tab: Cron
- Card per job: name, schedule expression, next run time
- "Run Now" button per job
- Status indicator (success/error of last run)

### Tab: Model
- Current model displayed prominently
- Dropdown/input to switch models
- List of configured aliases
- Per-agent model display

### Tab: Templates
- Agent selector dropdown
- Template file list (SOUL.md, IDENTITY.md, etc.)
- Textarea editor with save button
- Unsaved changes indicator

### Tab: Logs
- File list with sizes and dates
- Log content viewer with monospace font
- Tail-mode toggle (show last N lines)
- Auto-refresh option

### Tab: Config
- JSON editor (textarea with monospace font)
- Secrets shown as `[REDACTED]` (read-only for secret fields)
- Validate button (checks JSON parse + structure)
- Save button (with confirmation dialog)
- Warning: "Restart required for changes to take effect"

---

## CSS Approach

Inline `<style>` block. Dark theme (matches terminal aesthetic). CSS variables for theming:

```css
:root {
  --bg: #1a1a2e;
  --surface: #16213e;
  --text: #e0e0e0;
  --accent: #0f3460;
  --highlight: #e94560;
  --success: #4ecca3;
  --mono: 'SF Mono', 'Fira Code', monospace;
}
```

Responsive: works at 1024px+ (not optimized for mobile - this is a local dev tool).

---

## Integration Points

| Dashboard Feature | Existing Code | How |
|---|---|---|
| Status display | `gateway.ts` getLastMessage(), getCurrentModel() | Direct function calls in API handler |
| Conversation history | `config.ts` getSessionsDir() | Read session JSON files from disk |
| Memory browser | `agent.ts` getMemoryDir() | Read .md files from memory dir |
| Cron management | `cron.ts` getCronJobs(), runCronJob() | Direct function calls |
| Model switching | `gateway.ts` setCurrentModel() | Direct function call |
| Template editing | `agent.ts` loadAgentTemplates() | Extend with write capability |
| Log viewing | `config.ts` getLogsDir() | Read files from logs dir |
| Config editing | `config.ts` loadConfig(), getConfigPath() | Read/write config.json |
| Secret redaction | `security.ts` redactSecrets() | Apply to config before sending |

---

## Implementation Order

1. **API endpoints** (`src/api.ts`) - All `/api/dashboard/*` routes. Test with curl.
2. **Dashboard HTML** (`src/dashboard.ts`) - Static HTML/CSS/JS template literal.
3. **Gateway integration** (`src/gateway.ts`) - Register dashboard + API routes.
4. **Helper functions** - New exports in `agent.ts`, `config.ts`, `cron.ts` as needed.
5. **Testing** - Unit tests for API endpoints, manual Playwright testing for UI.

---

## Security Considerations

- Dashboard is local-only (localhost:18790). No auth needed for v1.
- Config editor must redact secrets on read, and preserve existing secrets on write (don't let `[REDACTED]` overwrite real values).
- Template editor should validate that filenames are in the allowed `TEMPLATE_FILES` list (no path traversal).
- Log file reader should validate filenames contain no `..` segments.
- Rate limiting is not needed for dashboard (local tool, single user).
