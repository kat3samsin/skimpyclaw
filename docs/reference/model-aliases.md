# Model Aliases

Aliases let you switch models with short names instead of full `provider/model-id` strings. Defined in `config.json` under `models.aliases`.

## Default Aliases

These are created by the setup wizard:

| Alias | Resolves To |
|-------|-------------|
| `codex5.1` | `codex/gpt-5.1-codex` |
| `codex5.2` | `codex/gpt-5.2-codex` |
| `codex5.3` | `codex/gpt-5.3-codex` |
| `codex5.5` | `codex/gpt-5.5` |
| `codex5.6` | `codex/gpt-5.6-sol` |
| `codex` | `codex/gpt-5.6-sol` |

Claude models should be configured with their exact model IDs, such as `anthropic/claude-opus-4-7`, `anthropic/claude-sonnet-4-6`, or `anthropic/claude-haiku-4-5`.

## Model Selection

Models can be specified three ways:

1. **Alias** -- `codex5.6`
2. **Full provider/model** -- `anthropic/claude-haiku-4-5`
3. **Bare model ID** -- `claude-haiku-4-5` (must contain `-` or `.`)

### Switching models

**CLI:**
```bash
skimpyclaw model anthropic/claude-sonnet-4-6
```

**Telegram/Discord:**
```
/model anthropic/claude-sonnet-4-6
```

**Dashboard API:**
```bash
curl -X POST http://localhost:18790/api/dashboard/model \
  -H 'Authorization: Bearer TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"model": "anthropic/claude-sonnet-4-6"}'
```

## Deprecated Model Migration

Old model IDs (Claude 3.x) are automatically migrated to current equivalents. No action needed.
