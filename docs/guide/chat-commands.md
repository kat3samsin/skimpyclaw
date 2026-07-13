# Chat Commands

## All channels (Telegram + Discord)

| Command | Description |
|---------|-------------|
| `/start` or `/help` | Greet and show help |
| `/model <alias\|provider/model\|model-id>` | Switch active model |
| `/status` | Service status — model, last message, coding agents, cron jobs |
| `/cron list` | List scheduled jobs |
| `/cron run <job-id>` | Trigger a cron job on demand |
| `/heartbeat` | Trigger an on-demand heartbeat check |
| `/silence <minutes>` | Suppress proactive messages for N minutes (default: 30) |
| `/focus` | Enable focus mode |
| `/approvals` | List pending exec approval requests |
| `/approve <id>` | Approve a pending exec request |
| `/deny <id>` | Deny a pending exec request |
| `/tasks` | Redirect to /agents or /cron |
| `/cancel <id>` | Redirect to dashboard or /cron |
| `/clear` | Clear conversation history |
| `/compact` | Summarize and compress conversation history |

## Telegram-only

| Command | Description |
|---------|-------------|
| `/memory` | List agent memory files |
| `/memory <filename>` | Read a specific memory file |

## Discord-specific behavior

- **Reasoning effort** — `/effort <none|low|medium|high|xhigh>` or `/think <...>` changes the current Discord effort override.
- **Reusable agent profiles** — `/agent` manages Discord aliases such as `@reviewer`; `@alias <message>` invokes a profile directly. See [Agents](/guide/agents).
- **Interactive approval cards** — When exec approval is needed, Discord sends a message with Approve/Deny buttons (Telegram uses inline keyboards).
- **Threaded replies** — Coding agent tasks and Discord agent-profile invocations can create threads from the triggering message. Coding-agent status updates and completion notifications route to the thread. Disable coding-agent thread creation with `threadedReplies: false` in Discord config.
- **Cron delivery** — Cron notifications use `payload.discordThreadId` or the explicit Discord `defaultChannelId`. Missing, invalid, or failed destinations do not fall back to a user DM.
- **Message chunking** — Long responses are split at paragraph/line boundaries into chunks of 1900 characters (Discord's limit is 2000).
- **Image and voice support** — Image attachments are analyzed via the model's vision capability. Voice messages are transcribed (Whisper) and optionally replied to with TTS audio.

Maintainers: for Discord posting/workflow changes, follow [Discord Update Documentation Process](/guide/discord-updates).

## Non-command messages

Any non-command text is treated as a chat prompt to the agent. Recent conversation history (last 5 pairs) is included automatically.
