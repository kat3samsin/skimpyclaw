# Exec Approval

Exec approval is a human-in-the-loop safety gate for the `Bash` tool. When the agent tries to run a potentially dangerous command, it pauses and asks for your approval via Telegram, Discord, or the Dashboard before executing.

## How It Works

1. Agent calls the `Bash` tool with a command
2. SkimpyClaw classifies the command's **risk tier** (0–3)
3. If the tier requires approval (default: tiers 2 and 3), the agent pauses
4. An approval card is sent to the active channel with the command, risk tier, and reason
5. You tap **Approve** or **Deny**
6. The agent continues or returns a denial error

Requests expire after 5 minutes (configurable) if not acted on.

## Risk Tiers

| Tier | Level | Approval | Examples |
|------|-------|----------|----------|
| **0** | Safe | Auto-approved | `ls`, `cat`, `grep`, `pnpm test` |
| **1** | Caution | Auto-approved | `git reset`, `npm publish`, `docker rm` |
| **2** | Dangerous | **Requires approval** | `sudo`, `chmod 777`, `curl | sh`, `kubectl delete`, `git push --force`, `gh pr review` |
| **3** | Critical | **Requires approval** | `rm -rf`, `mkfs`, `dd if=`, `DROP TABLE`, inline heredoc/interpreter scripts |

### Tier 3: Opaque Script Detection

Tier 3 also triggers for commands that execute inline scripts where the content isn't visible in the command itself:

- **Heredocs**: `bash <<EOF ... EOF`
- **Inline interpreters**: `python3 -c "..."`, `node -e "..."`, `ruby -e "..."`

## Configuration

```json
"tools": {
  "execApproval": {
    "enabled": true,
    "ttlMs": 300000,
    "requireForTiers": [2, 3]
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Master switch |
| `ttlMs` | `300000` (5 min) | How long before unanswered requests expire |
| `requireForTiers` | `[2, 3]` | Which tiers need human approval |

You can require approval for tier 1 commands too by setting `requireForTiers: [1, 2, 3]`.

## Channel Behavior

| Context | Behavior |
|---------|----------|
| **Discord** | Approval card with Approve/Deny buttons in the channel |
| **Telegram** | Inline keyboard with Approve/Deny buttons |
| **Dashboard** | Approvals page shows pending requests |
| **Cron jobs** | Auto-denied (no human present) |
| **Heartbeats** | Auto-denied (no human present) |

## Interaction with Sandbox

When [sandbox](./sandbox.md) is enabled, exec approval runs **before** the command reaches the container:

1. Command is classified → tier determined
2. If approval required → wait for human response
3. If approved → command executes inside the sandbox container
4. If denied → agent gets denial error, no execution

The sandbox isolates *what* runs. Exec approval controls *whether* it runs.

## Dashboard

The Dashboard **Approvals** page shows:

- **Pending** requests waiting for action
- **Recent** approvals and denials with timestamps
- Who approved/denied and when

You can approve or deny from the Dashboard as an alternative to channel buttons.

## Dangerous Pattern Reference

### Tier 3 (Critical)
- `rm -rf` — Recursive force delete
- `mkfs` — Filesystem format
- `dd if=` — Raw disk write
- `DROP DATABASE/TABLE/SCHEMA` — SQL destructive operations
- Heredoc scripts (`bash <<EOF`)
- Inline interpreter code (`python3 -c`, `node -e`)

### Tier 2 (Dangerous)
- `sudo` — Elevated privileges
- `chmod 777` — World-writable permissions
- `curl ... | sh` / `wget ... | sh` — Remote code execution
- `kubectl delete` — Kubernetes resource deletion
- `docker system prune` / `docker volume prune` — Docker cleanup
- `gh pr review` — GitHub PR review (visible to others)
- `git push --force` — Force push to remote

### Tier 1 (Caution)
- `git reset` — Git reset
- `npm publish` — Package publish
- `docker rm` — Container removal
