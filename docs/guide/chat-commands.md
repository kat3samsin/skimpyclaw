# Chat Commands

## All channels (Telegram + Discord)

| Command | Description |
|---------|-------------|
| `/start` | Greet and show help |
| `/model <alias\|provider/model\|model-id>` | Switch active model |
| `/status` | Service status — model, last message, coding agents, cron jobs |
| `/cron list` | List scheduled jobs |
| `/cron run <job-id>` | Trigger a cron job on demand |
| `/heartbeat` | Trigger an on-demand heartbeat check |
| `/silence <minutes>` | Suppress proactive messages for N minutes |
| `/focus` | Enable focus mode |
| `/tasks` | Redirect to /agents or /cron |
| `/cancel <id>` | Redirect to dashboard or /cron |
| `/new` | Clear conversation history |
| `/compact` | Summarize and compress conversation history |

## Telegram-only

| Command | Description |
|---------|-------------|
| `/memory` | List agent memory files |
| `/memory <filename>` | Read a specific memory file |

## Non-command messages

Any non-command text is treated as a chat prompt to the agent. Recent conversation history (last 5 pairs) is included automatically.
