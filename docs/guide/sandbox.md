# Sandbox

SkimpyClaw can run Bash tool commands inside a container instead of directly on the host. This isolates agent-executed commands from your system — the agent can install packages, compile code, and run scripts without risk to your machine.

## How It Works

When sandbox is enabled, every `Bash` tool call is routed to a container:

1. Agent calls `Bash` tool with a command
2. SkimpyClaw translates host paths to container mount paths
3. Command executes inside the container
4. Output is translated back to host paths and returned to the agent

The container has network access, mounted project directories, and common CLI tools.

## Supported Runtimes

| Runtime | Platform | Notes |
|---------|----------|-------|
| Apple Containers | macOS 26+ | Preferred — lightweight, fast startup |
| Docker | Any | Fallback — requires Docker Desktop or daemon |

## Quick Start

```bash
# Initialize sandbox (detects runtime, builds image, updates config)
skimpyclaw sandbox init

# Verify
skimpyclaw sandbox doctor
```

## Setup Options

```bash
# Use Docker instead of Apple Containers
skimpyclaw sandbox init --runtime docker

# Build with more tools
skimpyclaw sandbox init --profile dev
skimpyclaw sandbox init --profile full
```

### Profiles

| Profile | Includes |
|---------|----------|
| `minimal` (default) | bash, curl, git, gh, jq, python3, ripgrep, pnpm, Node.js |
| `dev` | minimal + gcc, g++, make |
| `full` | dev + pip3, sqlite3, unzip, less |

## What `sandbox init` Does

1. Detects container runtime (Apple Containers or Docker)
2. Builds the sandbox image from the bundled Dockerfile
3. Runs smoke tests (CLI tools, network, hostname)
4. Updates `~/.skimpyclaw/config.json` with sandbox configuration

## Configuration

After `sandbox init`, your config will include:

```json
"sandbox": {
  "enabled": true,
  "runtime": "container",
  "image": "skimpyclaw-sbx",
  "mounts": {
    "/Users/you/.skimpyclaw": "/workspace/.skimpyclaw",
    "/Users/you/Projects": "/workspace/Projects"
  }
}
```

### Key Fields

| Field | Description |
|-------|-------------|
| `enabled` | Master switch — `false` runs Bash on host |
| `runtime` | `container` (Apple Containers) or `docker` |
| `image` | Image name used for containers |
| `mounts` | Host → container path mappings |

## Path Translation

The agent sees host paths (e.g. `/Users/you/Projects/app`). SkimpyClaw transparently translates these to container paths (`/workspace/Projects/app`) before execution, and reverses the translation in output.

Only paths listed in `mounts` are accessible inside the container.

## Exec Approval + Sandbox

Sandbox and [exec approval](./tools.md#exec-approval) work together:

- **Unattended contexts** (cron, heartbeat): Commands run in sandbox without approval
- **Attended contexts** (Discord, Telegram): High-risk commands (tier 2-3) still require human approval before sandbox execution
- Approval happens **before** the command reaches the container

## Management Commands

```bash
skimpyclaw sandbox status       # List active sandbox containers
skimpyclaw sandbox prune        # Remove orphaned containers
skimpyclaw sandbox doctor       # Run targeted sandbox diagnostics
```

## What Runs in Sandbox (and What Doesn't)

| Component | Sandboxed? | Notes |
|-----------|-----------|-------|
| `Bash` tool | ✅ Yes | All Bash commands route through the container |
| `Read` / `Write` / `Glob` | ❌ No | File tools run on host (path-validated) |
| `Browser` tool | ❌ No | Playwright runs on host |
| `code_with_agent` / `code_with_team` | ❌ No | Coding agents spawn CLI processes on host |
| Cron `script` payloads | ❌ No | Scripts run on host |

Coding agents (`claude`, `codex`, `kimi`) manage their own execution environment. See [Coding Agents](./coding-agents.md#sandbox) for details.

## Per-Job Sandbox

Cron jobs and coding agents can have independent sandbox settings. Each coding agent spawned via `code_with_agent` gets its own container instance.

## Disabling Sandbox

```bash
skimpyclaw config set sandbox.enabled false
skimpyclaw restart
```

Or edit `~/.skimpyclaw/config.json` directly and set `"sandbox": { "enabled": false }`.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `container: command not found` | macOS 26+ required for Apple Containers |
| Image build fails | Check `skimpyclaw sandbox doctor` for specific errors |
| Mount permission denied | Ensure host paths exist and are readable |
| Slow startup | Apple Containers is faster than Docker; consider switching |
| Network issues in container | Check `skimpyclaw sandbox doctor` — verifies DNS + connectivity |
