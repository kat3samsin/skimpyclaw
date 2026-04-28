# Model Aliases

Aliases let you switch models with short names instead of full `provider/model-id` strings. Defined in `config.json` under `models.aliases`.

## Default Aliases

These are created by the setup wizard:

| Alias | Resolves To |
|-------|-------------|
| `claude-fast` | `anthropic/claude-haiku-4-5` |
| `claude-think` | `anthropic/claude-sonnet-4-6` |
| `claude-opus` | `anthropic/claude-opus-4-7` |
| `claude-opus4.6` | `anthropic/claude-opus-4-6` |
| `claude-opus-4.6` | `anthropic/claude-opus-4-6` |
| `codex5.1` | `codex/gpt-5.1-codex` |
| `codex5.2` | `codex/gpt-5.2-codex` |
| `codex5.3` | `codex/gpt-5.3-codex` |
| `codex5.5` | `codex/gpt-5.5` |
| `codex` | `codex/gpt-5.5` |
| `minimax` | `minimax/MiniMax-M2.5` |
| `kimi` | `kimi/kimi-for-coding` |

### With OpenAI provider

| Alias | Resolves To |
|-------|-------------|
| `gpt-fast` | `openai/gpt-4o-mini` |
| `gpt` | `openai/gpt-4o` |

## Model Selection

Models can be specified three ways:

1. **Alias** -- `claude-fast`
2. **Full provider/model** -- `anthropic/claude-haiku-4-5`
3. **Bare model ID** -- `claude-haiku-4-5` (must contain `-` or `.`)

### Switching models

**CLI:**
```bash
skimpyclaw model claude-think
```

**Telegram/Discord:**
```
/model claude-think
```

**Dashboard API:**
```bash
curl -X POST http://localhost:18790/api/dashboard/model \
  -H 'Authorization: Bearer TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"model": "claude-think"}'
```

## Deprecated Model Migration

Old model IDs (Claude 3.x) are automatically migrated to current equivalents. No action needed.
