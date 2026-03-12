# Team Scratchpad

Run-scoped collaboration scratchpad for parallel coding agents.

Data lives under:

- `.tmp/team-runs/<run_id>/meta.json`
- `.tmp/team-runs/<run_id>/scratchpad.jsonl`
- `.tmp/team-runs/<run_id>/scratchpad.md` (generated)

## Automatic `code_with_team` integration

`code_with_team` now initializes and updates the team scratchpad automatically.

- Run ID: deterministic `team-<parent_code_agent_id>` (example: `team-ca-42`)
- Auto-posted events: coordinator start/progress/validation/finish, worker start/progress/completion/failure, blockers on failures
- Auto-finalization: `summary` and `render-md` run at team completion (success or failure)

Disable automatic scratchpad usage with:

```bash
SKIMPYCLAW_TEAM_SCRATCHPAD=0
```

If scratchpad commands fail, team execution continues and logs warnings.

## Manual Quickstart

```bash
# 1) Initialize run
python3 scripts/team_scratchpad.py init \
  --run-id run-2026-03-11-abc123 \
  --task "Implement run-scoped team scratchpad" \
  --base-branch main \
  --repo /Users/katre/Sites/skimpyclaw

# 2) Post updates from workers
python3 scripts/team_scratchpad.py post \
  --run-id run-2026-03-11-abc123 \
  --agent worker-1 \
  --phase implement \
  --status in_progress \
  --summary "Added CLI parser and validation" \
  --files "scripts/team_scratchpad.py,docs/team-scratchpad.md" \
  --next "Run smoke checks"

# 3) Check latest team state
python3 scripts/team_scratchpad.py summary --run-id run-2026-03-11-abc123

# 4) Render markdown dashboard
python3 scripts/team_scratchpad.py render-md --run-id run-2026-03-11-abc123
```

## Command Usage

### `init`

```bash
python3 scripts/team_scratchpad.py init \
  --run-id <id> \
  --task "<text>" \
  [--base-branch <name>] \
  [--repo <path>]
```

Creates run directory and files.

### `post`

```bash
python3 scripts/team_scratchpad.py post \
  --run-id <id> \
  --agent <name> \
  --phase <phase> \
  --status <start|in_progress|blocked|red|green|review|done> \
  --summary "<text>" \
  [--files "a.ts,b.ts"] \
  [--blockers "needs api key,merge conflict"] \
  [--next "<text>"]
```

Appends one JSONL entry with file locking for safe concurrent writes.

### `tail`

```bash
python3 scripts/team_scratchpad.py tail --run-id <id> [--lines N]
```

Prints recent updates.

### `summary`

```bash
python3 scripts/team_scratchpad.py summary --run-id <id>
```

Shows latest status per agent, active blockers, and last-updated timestamps.

### `render-md`

```bash
python3 scripts/team_scratchpad.py render-md --run-id <id>
```

Generates a concise dashboard markdown file at `scratchpad.md`.

## Prompt Snippet For `code_with_team` Workers

Use this snippet in worker prompts so updates are posted consistently:

```text
You are worker <agent_name> in run <run_id>.
Post to the team scratchpad with:
python3 scripts/team_scratchpad.py post --run-id <run_id> --agent <agent_name> ...

When to post:
1) Start of task: status=start
2) If tests fail (red): status=red, include blockers if any
3) After tests pass (green): status=green
4) When ready for review: status=review
5) If blocked waiting on dependency/review: status=blocked with blockers
6) On completion: status=done and include next handoff

Each post should include: phase, summary, files (CSV when relevant), blockers (CSV when relevant), and next.
```

## Smoke Check

```bash
RUN_ID="scratchpad-smoke-$(date +%s)"
python3 scripts/team_scratchpad.py init --run-id "$RUN_ID" --task "smoke"
python3 scripts/team_scratchpad.py post --run-id "$RUN_ID" --agent smoke-worker --phase setup --status start --summary "smoke started"
python3 scripts/team_scratchpad.py post --run-id "$RUN_ID" --agent smoke-worker --phase setup --status done --summary "smoke done"
python3 scripts/team_scratchpad.py summary --run-id "$RUN_ID"
python3 scripts/team_scratchpad.py render-md --run-id "$RUN_ID"
python3 scripts/team_scratchpad.py tail --run-id "$RUN_ID" --lines 5
```

Or run the helper script:

```bash
./scripts/team_scratchpad_smoke.sh
```
