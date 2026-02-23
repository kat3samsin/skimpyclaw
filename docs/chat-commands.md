# Chat Commands

## All channels (Telegram + Discord)

| Command | Description |
|---------|-------------|
| `/start` | Greet and show help |
| `/model <alias\|provider/model\|model-id>` | Switch active model |
| `/status` | Service status + subagent stats (active, running, pending, recent completed/failed) |
| `/cron list` | List scheduled jobs |
| `/cron run <job-id>` | Trigger a cron job on demand |
| `/heartbeat` | Trigger an on-demand heartbeat check |
| `/silence <minutes>` | Suppress proactive messages for N minutes |
| `/focus` | Enable focus mode |
| `/tasks` | List recent subagent tasks |
| `/cancel <id>` | Cancel a running subagent task |
| `/new` | Clear conversation history |
| `/compact` | Summarize and compress conversation history |

## Telegram-only

| Command | Description |
|---------|-------------|
| `/memory` | List agent memory files |
| `/memory <filename>` | Read a specific memory file |

## Non-command messages

Any non-command text is treated as a chat prompt to the agent. Recent conversation history (last 5 pairs) is included automatically.
