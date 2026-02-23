# Coding Agents

This document covers how `code_with_agent` and `code_with_team` execute external coding CLIs.

## What these tools are

- `code_with_agent`: run one coding worker CLI (`claude`, `codex`, or `kimi`)
- `code_with_team`: decompose a task and run multiple `code_with_agent` workers in parallel

These are separate from in-process tool calling (`Read`, `Write`, `Glob`, `Bash`, `Browser`).

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

### Kimi worker

```bash
kimi --yolo -p <task> \
  [-w <workdir>] \
  [-m <model>]
```

## Code locations

- Tool definitions: `src/tools/definitions.ts`
- Runtime orchestration: `src/code-agents/index.ts`
- CLI argument builder: `src/code-agents/utils.ts`

## Selection behavior

- Agent selection supports `claude`, `codex`, `kimi`
- `subagents.defaultCodeAgent` is used when no explicit `agent` is passed
- Legacy-like values (`claude-think`, `codex5.3`, etc.) normalize to supported agent IDs
