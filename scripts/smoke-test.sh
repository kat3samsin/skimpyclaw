#!/usr/bin/env bash
# Smoke test: build, start on test port, verify gateway responds, kill.
# Exit 0 = pass, exit 1 = fail.
# Usage: ./scripts/smoke-test.sh

set -euo pipefail

PORT="${SKIMPYCLAW_SMOKE_PORT:-19999}"
TOKEN=$(node -e "const c=JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.skimpyclaw/config.json','utf-8')); console.log(c.dashboard?.token||'')" 2>/dev/null || echo "")
TIMEOUT=15
PID=""

cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "=== SkimpyClaw Smoke Test ==="

# 1. Build
echo "[1/4] Building..."
pnpm build 2>&1
echo "  ✓ Build passed"

# 2. Start on test port
echo "[2/4] Starting gateway on port $PORT..."
SKIMPYCLAW_SMOKE_TEST=1 SKIMPYCLAW_SMOKE_PORT="$PORT" node dist/index.js &
PID=$!

# Wait for gateway to be ready
READY=0
for i in $(seq 1 $TIMEOUT); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/dashboard/status" -H "Authorization: Bearer $TOKEN" 2>/dev/null; then
    READY=1
    break
  fi
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  echo "  ✗ Gateway failed to start within ${TIMEOUT}s"
  exit 1
fi
echo "  ✓ Gateway started (PID $PID)"

# 3. Hit status endpoint
echo "[3/4] Checking status endpoint..."
STATUS=$(curl -sf "http://127.0.0.1:$PORT/api/dashboard/status" -H "Authorization: Bearer $TOKEN" 2>/dev/null)
if [ -z "$STATUS" ]; then
  echo "  ✗ Status endpoint returned empty"
  exit 1
fi

# Verify response has expected fields
HAS_UPTIME=$(echo "$STATUS" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(typeof d.uptime === 'number' ? 'yes' : 'no')" 2>/dev/null || echo "no")
if [ "$HAS_UPTIME" != "yes" ]; then
  echo "  ✗ Status response missing expected fields"
  exit 1
fi
echo "  ✓ Status endpoint healthy"

# 4. Check cron endpoint
echo "[4/4] Checking cron endpoint..."
CRON=$(curl -sf "http://127.0.0.1:$PORT/api/dashboard/cron" -H "Authorization: Bearer $TOKEN" 2>/dev/null)
if [ -z "$CRON" ]; then
  echo "  ✗ Cron endpoint returned empty"
  exit 1
fi
echo "  ✓ Cron endpoint healthy"

# Cleanup
kill "$PID" 2>/dev/null
wait "$PID" 2>/dev/null || true
PID=""

echo ""
echo "=== SMOKE TEST PASSED ==="
exit 0
