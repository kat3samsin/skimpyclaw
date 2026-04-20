# Troubleshooting

Top 10 first-run issues and how to fix them.

## 1. Gateway Not Reachable

**Symptom:** `curl http://localhost:18790/health` times out or refuses connection.

**Causes:**

- Service isn't running — check `launchctl list | grep skimpyclaw`
- Wrong host/port — check `gateway.host` and `gateway.port` in `~/.skimpyclaw/config.json`
- Port already in use — run `lsof -i :18790` to see what's using it

**Fix:**

```bash
# Check if it's running
launchctl list | grep skimpyclaw

# Check logs
tail -100 /tmp/com.skimpyclaw.gateway.log

# If port conflict, change gateway.port in config.json and restart
```

## 2. Telegram Token Invalid

**Symptom:** Bot doesn't respond, doctor shows `telegram_token_valid: FAIL`.

**Causes:**

- Token typo in `~/.skimpyclaw/.env`
- Token revoked in BotFather
- `TELEGRAM_BOT_TOKEN` env var not set

**Fix:**

```bash
# Test token directly
curl https://api.telegram.org/bot<YOUR_TOKEN>/getMe

# If invalid, get a new one from @BotFather and update .env
echo "TELEGRAM_BOT_TOKEN=new-token-here" >> ~/.skimpyclaw/.env
```

## 3. No API Provider Working

**Symptom:** Agent returns errors, doctor shows `provider_*_auth: FAIL`.

**Causes:**

- API key not set in `~/.skimpyclaw/.env`
- API key expired or invalid
- Config references `${VAR}` but env var is empty (check startup logs for warnings)

**Fix:**

```bash
# Check which vars are missing (look for "[config] env var ${...} is not set")
pnpm dev 2>&1 | head -20

# Verify your key works
curl -H "x-api-key: $ANTHROPIC_API_KEY" https://api.anthropic.com/v1/models

# Update .env with correct key
```

## 4. Browser Tool Broken

**Symptom:** Browser tool errors with "browser not found" or similar.

**Causes:**

- Chrome/Chromium not installed
- `browser.enabled` is true but no browser binary available
- Wrong `executablePath` in config

**Fix:**

```bash
# Check if Chrome exists
ls '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

# If not installed
brew install --cask google-chrome

# Or disable browser if you don't need it
# Set tools.browser.enabled: false in config
```

## 5. Voice Not Working

**Symptom:** Voice messages ignored, transcription fails.

**Causes:**

- Voice not enabled in config (`voice.enabled: false` or missing)
- ffmpeg not installed
- whisper-cli/whisper not installed

**Fix:**

```bash
# Install dependencies
brew install ffmpeg

# For whisper (C++ version, faster)
brew install whisper-cpp
# Or Python version
pip install openai-whisper

# Enable in config: add voice section or re-run onboard
```

## 6. Daemon Won't Start

**Symptom:** `launchctl load` succeeds but service isn't running.

**Causes:**

- Node.js path wrong in plist
- pnpm not in PATH for launchd
- Build not compiled

**Fix:**

```bash
# Check launchd status
launchctl list | grep skimpyclaw

# Check stderr log
cat /tmp/com.skimpyclaw.gateway.err

# Common fix: rebuild
cd /path/to/skimpyclaw && pnpm build

# Regenerate plist with correct paths
pnpm run onboard
```

## 7. Empty Agent Response

**Symptom:** Agent responds with empty string or XML-looking garbage.

**Causes:**

- `toolConfig` not passed to `runAgentTurn` — model hallucinates XML tool calls
- Model quota exceeded
- Invalid model name

**Fix:**

- Ensure any code calling `runAgentTurn` passes a `ToolConfig` object
- Check model name in config matches a valid provider model
- Verify API quota: check provider dashboard

## 8. MCP Tools Not Loading

**Symptom:** MCP tools missing from tool list, errors about mcporter.

**Causes:**

- mcporter not configured at `~/.mcporter/mcporter.json`
- mcporter server not running
- MCP tools not enabled in config

**Fix:**

```bash
# Check mcporter config exists
cat ~/.mcporter/mcporter.json

# Verify mcporter can start
~/.mcporter/my-custom-mcp.sh

# If not set up, see internal mcporter docs
```

## 9. Cron Job Fails

**Symptom:** Scheduled jobs don't run or produce errors.

**Causes:**

- Invalid cron expression
- Model provider down
- Tool paths not accessible

**Fix:**

```bash
# Check cron logs
ls ~/.skimpyclaw/logs/cron/

# Manually trigger a job to see the error
curl -X POST http://localhost:18790/cron/<job-id>/run

# Or use dashboard → Cron tab → Run button
```

## 10. Dashboard 401 Unauthorized

**Symptom:** Dashboard loads but API calls return 401.

**Causes:**

- Dashboard token not entered in the UI prompt
- Token doesn't match config

**Fix:**

```bash
# Find your dashboard token
grep -o '"token":"[^"]*"' ~/.skimpyclaw/config.json

# Or check startup logs for "[dashboard] Access token: ..."
# Enter the token in the dashboard login prompt
```

## 11. Sandbox Not Working

**Symptom:** Bash commands fail with container errors, or sandbox isn't initialized after `skimpyclaw onboard`.

**Causes:**

- Container runtime not started
- Sandbox not initialized (image not built)
- Runtime not detected during onboarding

**Fix:**

```bash
# 1. Start the container runtime
# Apple Containers (macOS 26+):
container system start

# Docker:
open -a Docker
# or: docker info   (to verify it's running)

# 2. Initialize sandbox (builds image, updates config)
skimpyclaw sandbox init

# 3. Verify everything works
skimpyclaw sandbox doctor

# 4. Restart daemon to pick up sandbox config
skimpyclaw restart
```

**Switching runtimes:**

```bash
# Force Docker instead of Apple Containers
skimpyclaw sandbox init --runtime docker

# Force Apple Containers
skimpyclaw sandbox init --runtime container
```

**Image build fails:**

```bash
# Check if Dockerfile exists
ls $(pnpm root -g)/skimpyclaw/sandbox/Dockerfile

# Rebuild with verbose output
skimpyclaw sandbox init --profile minimal
```

## 12. Coding Agent Validation Fails on Monorepos

**Symptom:** `code_with_agent` completes but final validation times out or runs the wrong commands.

**Causes:**

- Workdir set to a package subdirectory instead of repo root — package manager detection fails
- Full monorepo build/test runs instead of scoped to changed packages
- Validation timeout too short for the project

**Fix:**

```bash
# Check what validation would run
skimpyclaw agents <id>   # look at validation output

# Option 1: Set workdir to repo root (let auto-detection scope it)
# In your prompt, specify the repo root as the working directory

# Option 2: Override validation per project in config
skimpyclaw config set codeAgents.validationCommands '{"wp-calypso": "yarn workspace @automattic/image-studio build && yarn workspace @automattic/image-studio test"}'
```

## General Debugging

```bash
# Run full diagnostics
pnpm run doctor

# Run with JSON output for scripting
pnpm run doctor -- --json

# Check dashboard Health tab for visual overview
open http://localhost:18790/dashboard
# Click "Health" tab

# View live logs
tail -f /tmp/com.skimpyclaw.gateway.log
```
