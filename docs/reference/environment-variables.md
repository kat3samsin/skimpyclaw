# Environment Variables

Secrets are stored in `~/.skimpyclaw/.env` and loaded at startup. Config values can reference them with `${VAR_NAME}` syntax.

## Required

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather |

## Provider Auth

At least one provider must be configured:

| Variable | Description |
|----------|-------------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Anthropic OAuth token (from `claude setup-token`) |
| `ANTHROPIC_API_KEY` | Anthropic API key (alternative to OAuth) |

::: tip
Codex uses `~/.codex/auth.json` directly -- no env var needed.
:::

## Optional

| Variable | Description |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `OPENAI_API_KEY` | Optional OpenAI voice STT/TTS provider key |
| `LANGFUSE_PUBLIC_KEY` | Langfuse observability public key |
| `LANGFUSE_SECRET_KEY` | Langfuse observability secret key |
| `LANGFUSE_BASEURL` | Langfuse server URL |

## Runtime Variables

These are set by the system, not by the user:

| Variable | Description |
|----------|-------------|
| `CLAUDECODE` | Set by Claude Code -- must be stripped from child processes |
| `HOME` | Used in config path expansion (`${HOME}`) |
