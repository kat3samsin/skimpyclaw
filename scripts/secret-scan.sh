#!/usr/bin/env bash
set -euo pipefail

# Lightweight pre-push secret scan.
# Scans added lines in every commit being introduced for common credential patterns.

patterns=(
  'AKIA[0-9A-Z]{16}'
  'ghp_[A-Za-z0-9]{36,}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'xox[baprs]-[A-Za-z0-9-]+'
  '-----BEGIN (RSA|OPENSSH|EC|DSA)? ?PRIVATE KEY-----'
  'sk-[A-Za-z0-9]{20,}'
)

scan_dir="$(mktemp -d "${TMPDIR:-/tmp}/skimpyclaw-secret-scan.XXXXXX")"
trap 'rm -rf "$scan_dir"' EXIT

scan_commit() {
  local commit="$1"
  local patch_file="$scan_dir/patch"
  local additions_file="$scan_dir/additions"

  if ! git -c color.ui=never diff-tree --root -m --text --no-commit-id --no-ext-diff --unified=0 -r "$commit" -- . ':!node_modules' ':!dist' >"$patch_file"; then
    echo "[secret-scan] Unable to inspect commit: $commit" >&2
    return 2
  fi

  if ! sed -n -e '/^+++ /d' -e 's/^+//p' "$patch_file" >"$additions_file"; then
    echo "[secret-scan] Scanner failed while extracting additions from commit: $commit" >&2
    return 2
  fi

  local p grep_status
  for p in "${patterns[@]}"; do
    if grep -qE -e "$p" "$additions_file"; then
      echo "[secret-scan] Potential secret match in $commit for pattern: $p"
      echo "[secret-scan] Push blocked. Remove or rotate secrets and try again."
      return 1
    else
      grep_status=$?
      if [[ "$grep_status" -gt 1 ]]; then
        echo "[secret-scan] Scanner failed while inspecting commit: $commit" >&2
        return 2
      fi
    fi
  done
  return 0
}

scan_revisions() {
  local commits_file="$scan_dir/commits"
  if ! git rev-list --reverse "$@" >"$commits_file"; then
    echo "[secret-scan] Unable to enumerate pushed commits." >&2
    return 2
  fi

  local commit
  while IFS= read -r commit; do
    [[ -z "$commit" ]] && continue
    scan_commit "$commit" || return $?
  done <"$commits_file"
}

if [[ "${1:-}" == "--pre-push" ]]; then
  shift
fi
remote_name="${1:-origin}"

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
    # New branch: scan commits not already present on the destination remote.
    scan_revisions "$local_sha" --not --remotes="$remote_name" || exit $?
  else
    # Existing branch update: scan commits being introduced.
    scan_revisions "$remote_sha..$local_sha" || exit $?
  fi
done

exit 0
