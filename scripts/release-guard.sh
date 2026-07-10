#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "$1" >&2
  exit 1
}

if [[ $# -ne 1 ]]; then
  fail "Usage: scripts/release-guard.sh <version>"
fi

VERSION="$1"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  fail "Invalid release version."
fi

if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  if [[ "${GITHUB_REF:-}" != "refs/heads/trunk" ]]; then
    fail "Releases must run from refs/heads/trunk, not ${GITHUB_REF:-an unknown ref}."
  fi
else
  if ! BRANCH="$(git symbolic-ref --quiet --short HEAD)"; then
    fail "Releases must run from trunk, not a detached HEAD."
  fi
  if [[ "$BRANCH" != "trunk" ]]; then
    fail "Releases must run from trunk, not $BRANCH."
  fi
fi

LOCAL_SHA="$(git rev-parse HEAD)"
if ! REMOTE_LINE="$(git ls-remote --exit-code origin refs/heads/trunk)"; then
  fail "Could not resolve origin/trunk."
fi
REMOTE_SHA="${REMOTE_LINE%%$'\t'*}"
if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  fail "Release HEAD $LOCAL_SHA does not match origin/trunk $REMOTE_SHA."
fi
