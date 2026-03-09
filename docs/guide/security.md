# Security

SkimpyClaw applies defense-in-depth for a locally run agent that can execute tools on your behalf.

## Config & Secrets

- **Config file permissions**: `~/.skimpyclaw/config.json` is written with `0600` (owner-only) permissions
- **Secrets in config**: Use `${ENV_VAR}` or `${KEYCHAIN:service/account}` (macOS); raw secrets should not be stored in JSON
- **Dashboard redaction**: Config API responses redact key/token-like fields

## Authentication & Access Control

- **Gateway auth**: Sensitive endpoints (`/message`, `/model`, `/reload`, `/cron/*`, `/status`) require a Bearer token
- **Token comparison**: Bearer token validation uses SHA-256 hashing with `timingSafeEqual` to reduce timing-attack risk
- **Channel allowlists**: Telegram/Discord access is restricted to configured `allowFrom` IDs

## Tool & Runtime Safety

- **Tool path restriction**: All file and directory tool operations are constrained to `ToolConfig.allowedPaths`
- **Bash safety**: Dangerous commands are blocked by a blocklist; tier 2-3 risky commands require human approval via exec-approval
- **Env sanitization**: Bash and cron child processes receive a sanitized env with API keys, tokens, and credentials stripped; `GH_TOKEN` is allowlisted
- **Cron prompt paths**: Prompt file references in cron jobs are restricted to `~/.skimpyclaw/prompts/` and path traversal is rejected
- **Voice TTS process safety**: TTS shell calls use `spawnSync` with argument arrays (no string interpolation)

## Network Controls

- **Fetch SSRF protection**: The fetch tool blocks private/reserved IPs and cloud metadata endpoints, and re-validates targets on every redirect hop
