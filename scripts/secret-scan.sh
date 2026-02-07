#!/usr/bin/env bash
set -euo pipefail

# Lightweight pre-push secret scan.
# Scans commit contents in ranges being pushed for common credential patterns.

patterns=(
  'AKIA[0-9A-Z]{16}'
  'ghp_[A-Za-z0-9]{36,}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'xox[baprs]-[A-Za-z0-9-]+'
  '-----BEGIN (RSA|OPENSSH|EC|DSA)? ?PRIVATE KEY-----'
  'sk-[A-Za-z0-9]{20,}'
)

scan_range() {
  local range="$1"
  if [[ -z "$range" ]]; then
    return 0
  fi

  local hit=0
  for p in "${patterns[@]}"; do
    if git -c color.ui=never grep -nE "$p" "$range" -- . ':!node_modules' ':!dist' >/tmp/skimpyclaw-secret-scan.out 2>/dev/null; then
      echo "[secret-scan] Potential secret match for pattern: $p"
      cat /tmp/skimpyclaw-secret-scan.out
      hit=1
    fi
  done

  if [[ "$hit" -eq 1 ]]; then
    echo "[secret-scan] Push blocked. Remove or rotate secrets and try again."
    return 1
  fi
  return 0
}

# pre-push receives ref updates on stdin:
# <local ref> <local sha1> <remote ref> <remote sha1>
# Build commit ranges and scan each.
while read -r local_ref local_sha remote_ref remote_sha; do
  [[ -z "${local_sha:-}" ]] && continue

  # Deleted branch/tag
  if [[ "$local_sha" =~ ^0+$ ]]; then
    continue
  fi

  if [[ "$remote_sha" =~ ^0+$ ]]; then
    # New branch: scan all ancestors reachable from local tip.
    scan_range "$local_sha" || exit 1
  else
    # Existing branch update: scan commits being introduced.
    scan_range "$remote_sha..$local_sha" || exit 1
  fi
done

exit 0
