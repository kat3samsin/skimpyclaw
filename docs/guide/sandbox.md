# Sandbox

SkimpyClaw can run agent tool calls inside a container instead of directly on the host. This isolates agent-executed commands from your system — the agent can install packages, compile code, and run scripts without risk to your machine.

## How It Works

When sandbox is enabled, tool calls are routed to a container:

1. Agent calls a tool (`Bash`, `Read`, `Write`, `Glob`, or `ListDir`)
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
  "image": "skimpyclaw-sandbox"
}
```

### Key Fields

| Field | Description |
|-------|-------------|
| `enabled` | Master switch — `false` runs everything on host |
| `runtime` | `container` (Apple Containers) or `docker` |
| `image` | Image name used for containers (default: `skimpyclaw-sandbox`) |
| `cpus` | CPU limit per container (default: 2) |
| `memory` | Memory limit (default: `2G`) |
| `network` | Network mode (default: `none`) |
| `idleTimeoutMs` | Idle container timeout in ms (default: 3600000 / 1h) |
| `env` | Extra env vars injected into containers |

## Path Translation

The agent sees host paths (e.g. `/Users/you/Projects/app`). SkimpyClaw transparently translates these to container paths before execution, and reverses the translation in output.

Mounts are computed automatically from the configured `allowedPaths` in your tool config — there is no manual `mounts` field to configure. Only allowed paths are accessible inside the container.

## Exec Approval + Sandbox

Sandbox and [exec approval](./exec-approval.md) work together:

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
| `Read` / `Write` tool | ✅ Yes | File reads and writes execute inside the container |
| `ListDir` / `Glob` tool | ✅ Yes | Directory listings and glob operations execute inside the container |
| `Browser` tool | ❌ No | Playwright runs on host via MCP |
| `code_with_agent` / `code_with_team` | ❌ No | Coding agents spawn CLI processes on host (plumbing exists but is not wired up) |
| Cron `script` payloads | ✅ Yes | Scripts route through sandbox when enabled |

macOS-specific commands (`osascript`, `open`, `say`, `pbcopy`, `pbpaste`, `defaults`, etc.) bypass the sandbox and execute on the host, since they require macOS APIs unavailable in Linux containers.

### Coding Agents

Coding agents (`claude`, `codex`, `kimi`) are **not** sandboxed. They spawn CLI processes directly on the host. The executor has sandbox plumbing (container wrapping in `executor.ts`), but `sandboxConfig` is not passed through from the tool dispatch layer. This is a known gap.

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
