# Coding Agent Execution

> **Prerequisite:** `code_with_agent` requires at least one external coding CLI installed on your system:
> - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
> - [Codex CLI](https://github.com/openai/codex) (`codex`)
>
> Without one of these installed and on your `PATH`, coding agent tools will fail.

`code_with_agent` runs external CLIs via `buildCodeAgentArgs()` in `src/code-agents/utils.ts`.

## Worker Commands

- Claude: `claude -p --verbose --output-format stream-json --dangerously-skip-permissions ... <task>`
- Codex: `codex exec --full-auto --json --color never ... <task>`

## Execution Flow

- Tool schema: `src/tools/definitions.ts` (`code_with_agent`)
- Orchestration: `src/code-agents/index.ts`
- Command construction: `src/code-agents/utils.ts`
- Worktree isolation: `src/code-agents/worktrees.ts`

Normal tool calling (`Read/Write/Bash/Fetch`) is separate from coding-agent CLI execution.

## Git Worktrees

`code_with_agent` can run in isolated git worktrees:

- default `worktree: "auto"` creates a detached worktree for review/rebase-style tasks
- `worktree: true` forces isolation
- `worktree: false` runs in the original checkout

The default root is `~/.skimpyclaw/worktrees`. Use `codeAgents.worktrees.root` to change it, or `codeAgents.worktrees.mode` to set `off`, `auto`, or `always`.

Cleanup is safe by default: clean worktrees at the original HEAD are removed after completion, while dirty worktrees or worktrees whose HEAD changed are preserved.

## Validation & Package Manager Detection

When `validate: true` (default), `code_with_agent` runs a post-completion validation step. The validation command is **auto-detected** with monorepo awareness:

### Resolution order
1. **Per-project override** from config `codeAgents.validationCommands` (keyed by project directory name)
2. **Monorepo auto-detection** — if the root `package.json` has `workspaces` (or `pnpm-workspace.yaml` exists), scopes validation to only the changed packages:
   - Uses `git diff` to find changed files
   - Maps files → package directories (finds nearest `package.json`)
   - Runs scoped `yarn workspace <name> build` / `yarn workspace <name> test` per package
   - Falls back to `yarn test-packages <path>` if the root has a `test-packages` script and the package has no `test` script
3. **Simple project** — runs `build` and `test` scripts from root `package.json` using the detected package manager

### Package manager detection (first match wins)
1. `package.json` `packageManager` field (e.g. `"yarn@4.1.0"`)
2. Lockfile: `yarn.lock` → yarn, `pnpm-lock.yaml` → pnpm, `bun.lockb`/`bun.lock` → bun, `package-lock.json` → npm
3. Fallback: `pnpm` (SkimpyClaw default)

Implementation: `detectPackageManager()`, `buildMonorepoValidationCommand()`, and `buildValidationCommand()` in `src/code-agents/executor.ts`.

## Exec Approval

`src/exec-approval.ts` classifies Bash commands before execution:
- **Tier 0** — safe, auto-approved
- **Tier 1** — low risk, auto-approved
- **Tier 2** — medium risk (sudo, chmod 777, gh pr review), prompts user
- **Tier 3** — catastrophic/irreversible (rm -rf, mkfs, dd, DROP TABLE), always requires approval

Pending approvals are held in an EventEmitter registry. The active channel sends the request; user replies inline to approve or deny.

## Skills System

Skills are loaded from `~/.skimpyclaw/skills/<name>/SKILL.md`. Each `SKILL.md` has YAML frontmatter:

```markdown
---
name: my-skill
description: What this skill does
triggers: ["keyword1", "keyword2"]
priority: 100
---
```

`src/skills.ts` scans the directory, loads valid skills, and injects relevant ones into the system prompt based on triggers and token budget (`maxPromptTokens`, default 4000 chars ≈ 1000 tokens).

## Interactive Sessions

Interactive coding sessions let Discord users hold a back-and-forth conversation with a running Claude process across multiple thread messages, without spawning a new process for each reply. Codex workers are supported for non-interactive `code_with_agent` tasks, but Codex interactive sessions are still gated off at runtime.

### How it works

1. `code_with_agent` is called with `interactive: true` (Discord only; `claude` agent only today).
2. `runCodeAgentBackground()` assigns a stable UUID as `cliSessionId` on the `CodeAgentTask` and passes it to `buildCodeAgentArgs()` via the `sessionId` field.
3. Claude receives `--session-id <uuid>` on the first turn, pinning that UUID to the session.
4. Before the Discord thread is created, the session is registered in the pending map keyed by task ID (`addPendingSession()`). Once the Discord thread exists, `linkThread()` re-keys it by thread ID and writes it to the main store.
5. For every subsequent message in that thread, `handleIncomingMessage()` in `src/channels/discord/handlers.ts` checks the session store and, if found, calls `handleInteractiveThreadMessage()` instead of the normal agent path.
6. `handleInteractiveThreadMessage()` enqueues the message and, if no subprocess is already running, drains the queue — one `claude --resume <session-id>` subprocess per message, serialized via an in-memory FIFO lock.

### Key files

| File | Role |
|------|------|
| `src/code-agents/interactive-sessions.ts` | Session store (disk-persisted + in-memory), FIFO queue per thread |
| `src/code-agents/interactive-resume.ts` | Spawns `claude --resume` subprocesses, drains queue, posts output |
| `src/code-agents/stream-formatter.ts` | `stripAnsi`, `chunkForDiscord`, `parseCodexJsonl`, `formatCodexOutput` |

### Stream formatter

`src/code-agents/stream-formatter.ts` converts raw CLI stdout to Discord-ready chunks:

- **Claude**: plain-text output, ANSI stripped, paragraph-aware chunking at ≤1900 chars
- **Codex**: JSONL stream parsed for non-interactive output formatting (`item.completed` agent messages, command results, file changes)

### Storage

Sessions persist to `~/.skimpyclaw/logs/code-agents/interactive-sessions.json` (JSON array of `InteractiveSession`). The FIFO queues are in-memory only and reset on restart.

### `InteractiveSession` type (`src/types.ts`)

```ts
interface InteractiveSession {
  discordThreadId: string;
  cliSessionId: string;               // UUID for claude interactive sessions
  cliAgent: 'claude' | 'codex';       // persisted type; interactive runtime currently accepts claude only
  status: 'active' | 'errored' | 'archived';
  createdAt: string;                  // ISO 8601
  lastActivityAt: string;             // ISO 8601
  initialTask: string;
}
```

Subprocess env for both the initial spawn and `--resume` turns is prepared by `buildCodeAgentSpawnEnv()` in `src/code-agents/utils.ts`, which drops `CLAUDECODE` (so nested claude invocations start cleanly), drops `GH_TOKEN` / `GITHUB_TOKEN` (so `gh` falls back to keychain auth), and pins Codex CLI state to `~/.codex` via `CODEX_HOME`.

If a `--resume` subprocess errors, the session is marked `errored` and any queued follow-ups are drained with a single notice — they are not retried.

## Dashboard Architecture

The dashboard is framework-only (Preact/Vite).

| Concern | Location |
|---------|---------|
| Frontend source | `web/dashboard/` |
| Built assets | `dist/dashboard/` |
| Route | `GET /dashboard` via `registerDashboard()` in `src/dashboard-frontend.ts` |
| Backend API | `src/api.ts` — all endpoints under `/api/dashboard/*` |
| Auth | Bearer token from `config.dashboard.token` |

If `dist/dashboard/index.html` is missing, `GET /dashboard` returns `503` with a build hint.

### Dashboard Tests

- `src/__tests__/dashboard.test.ts` — framework route contract tests
- `src/__tests__/dashboard-mode.test.ts` — framework static serving and safety checks
- `src/__tests__/api.test.ts` — backend API contract tests
