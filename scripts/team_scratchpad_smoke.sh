#!/usr/bin/env bash
set -euo pipefail

RUN_ID="scratchpad-smoke-$(date +%s)"

echo "Using run id: ${RUN_ID}"
python3 scripts/team_scratchpad.py init --run-id "${RUN_ID}" --task "team scratchpad smoke"
python3 scripts/team_scratchpad.py post --run-id "${RUN_ID}" --agent smoke-worker --phase setup --status start --summary "smoke started"
python3 scripts/team_scratchpad.py post --run-id "${RUN_ID}" --agent smoke-worker --phase setup --status done --summary "smoke done" --next "render markdown"
python3 scripts/team_scratchpad.py summary --run-id "${RUN_ID}"
python3 scripts/team_scratchpad.py render-md --run-id "${RUN_ID}"
python3 scripts/team_scratchpad.py tail --run-id "${RUN_ID}" --lines 5

echo "Smoke test finished for ${RUN_ID}"
