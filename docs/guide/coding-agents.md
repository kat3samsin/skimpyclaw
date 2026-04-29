# Coding Agents

This document covers how `code_with_agent` executes external coding CLIs. For configured SkimpyClaw agents and reusable Discord `@alias` profiles, see [Agents](./agents.md).

## What this tool is

- `code_with_agent`: run one coding worker CLI (`claude` or `codex`)

This is separate from in-process tool calling (`Read`, `Write`, `Glob`, `Bash`, `Fetch`).

## Exact CLI commands

Commands are constructed by `buildCodeAgentArgs()` in `src/code-agents/utils.ts`.

### Claude worker

```bash
claude -p --verbose --output-format stream-json --dangerously-skip-permissions \
  --allowedTools Edit --allowedTools Read --allowedTools Write --allowedTools Bash --allowedTools Glob --allowedTools Grep \
  --max-turns <N> \
  --append-system-prompt "Output text only..." \
  [--model <model>] \
  <task>
```

### Codex worker

```bash
codex exec --full-auto --json --color never \
  [-C <workdir>] \
  [-m <model>] \
  <task>
```

## Code locations

- Tool definitions: `src/tools/definitions.ts`
- Runtime orchestration: `src/code-agents/index.ts`
- CLI argument builder: `src/code-agents/utils.ts`
- Worktree isolation: `src/code-agents/worktrees.ts`

## Worktree Isolation

`code_with_agent` supports `worktree: true | false | "auto"`.

- `auto` is the default. It creates an isolated git worktree for PR review, pull request, compare/diff, and rebase-style tasks.
- `true` forces a worktree and fails if the workdir is not inside a git repo.
- `false` runs directly in the requested checkout.

Worktrees are created detached under `~/.skimpyclaw/worktrees/<repo>/<task-id>` by default. The dashboard and reports show both the source checkout and the worktree path. This lets multiple reviews/rebases run in parallel without colliding in the same checkout.

After the agent finishes, SkimpyClaw removes the worktree only when it is clean and still at the original HEAD. Dirty worktrees, rebased branches, or changed HEADs are preserved so useful work is not lost.

## CLI monitoring

```bash
skimpyclaw agents              # List all agents (active + recent)
skimpyclaw agents <id>         # Show details for an agent (task, children, live output)
skimpyclaw agents <id> --follow  # Follow live output (refreshes every 3s until done)
```

For team coordinators, this shows all child agents grouped by wave with status, elapsed time, and live output.

The dashboard (`/dashboard` → Coding page) also shows real-time agent status with expandable subagent cards.

## Discord notifications

When a coding agent starts from a Discord message, a thread is automatically created from the triggering message (unless `threadedReplies: false` in config). Status updates and completion results route to the thread first, falling back to the default channel.

Notification format:
- **Start**: Response includes "Started coding agent ca-N" which triggers thread creation
- **Success**: `✅ Coding agent {id} completed ({duration}). Task: {preview}. Result: {output}`
- **Failure**: Includes error details and output snippet
- **Team tasks**: Structured summary with per-child status and validation results

Notifications are also sent to the active channel (Telegram or Discord) via `sendActiveChannelProactiveMessage()`. Long messages are chunked at 1900 characters for Discord.

## Interactive Sessions (Discord)

Pass `interactive: true` to `code_with_agent` to start a **bidirectional** coding session pinned to a Discord thread:

```
code_with_agent { task: "...", interactive: true }
```

- **Discord-only**, `claude` agents only at runtime today.
- The first turn is started with a stable session UUID (`--session-id` for Claude).
- Subsequent messages in the thread are routed directly to `claude --resume <session-id>` instead of the main agent, letting you iterate with the coding agent without spawning a new process each time.
- Messages are queued per-thread (FIFO) to prevent concurrent `--resume` subprocesses from corrupting session history.
- Session state is persisted to `~/.skimpyclaw/logs/code-agents/interactive-sessions.json` so sessions survive gateway restarts.
- Session status transitions: `active` → `errored` (on subprocess crash) or `archived` (manual/cleanup). A non-`active` session posts a warning and stops routing.

### Sending follow-up messages

Once an interactive session is active, just post a message in the Discord thread. No command prefix needed — the Discord handler detects the thread binding and routes automatically.

To end the session, start a new `code_with_agent` call or close the thread.

## Selection behavior

- Agent selection supports `claude` and `codex`
- `codeAgents.defaultAgent` is used when no explicit `agent` is passed
- Legacy-like values (`claude-coder`, `codex5.3`, etc.) normalize to supported agent IDs

## Long-running tasks

For tasks that should run on a schedule or without a user present (nightly syncs, daily digests, background refactors), use **cron** instead of a coding agent triggered ad-hoc:

```json
{
  "cron": {
    "jobs": [
      {
        "name": "nightly-refactor",
        "schedule": "0 2 * * *",
        "payload": {
          "agentTurn": {
            "agentId": "main",
            "prompt": "Run the nightly refactor script in ~/Sites/myproject and commit the results."
          }
        }
      }
    ]
  }
}
```

Cron jobs run with the full agent loop (tools, coding agents, file access) and their output is logged to `~/.skimpyclaw/logs/cron/`.
