# Coding Agent Execution

> **Prerequisite:** `code_with_agent` and `code_with_team` require at least one external coding CLI installed on your system:
> - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
> - [Codex CLI](https://github.com/openai/codex) (`codex`)
>
> Without one of these installed and on your `PATH`, coding agent tools will fail.

`code_with_agent` and `code_with_team` run external CLIs via `buildCodeAgentArgs()` in `src/code-agents/utils.ts`.

## Worker Commands

- Claude: `claude -p --verbose --output-format stream-json --dangerously-skip-permissions ... <task>`
- Codex: `codex exec --full-auto --json --color never ... <task>`
- Kimi: `kimi --yolo -p <task> ...`

## Execution Flow

- Tool schemas: `src/tools/definitions.ts` (`code_with_agent`, `code_with_team`)
- Orchestration: `src/code-agents/index.ts`
- Command construction: `src/code-agents/utils.ts`

Normal tool calling (`Read/Write/Bash/Browser`) is separate from coding-agent CLI execution.

## Validation & Package Manager Detection

When `validate: true` (default), both `code_with_agent` and `code_with_team` run a post-completion validation step. The validation command is **auto-detected** with monorepo awareness:

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

## Team Orchestration — Git Worktree Isolation

When `code_with_team` runs parallel agents in the same wave, each agent gets its own **git worktree** so they can't overwrite each other's files. After the wave completes, branches are merged back sequentially.

### Flow
1. Before each parallel wave: `git worktree add` creates `.skimpyclaw-worktrees/<childId>` on branch `skimpyclaw-team/<childId>`
2. Each child agent runs in its own worktree directory
3. After wave: child commits are merged back into the main branch one at a time
4. Merge conflicts are detected and reported (not silently lost)
5. Worktrees are cleaned up after each wave and on error/cancel

### Fallbacks
- Waves with only 1 child skip worktrees (no isolation needed)
- Non-git repos fall back to shared workdir
- Stale worktrees from crashed runs are cleaned up on next team start

Implementation: `src/code-agents/worktree.ts` and wave execution in `src/code-agents/orchestrator.ts`.

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
