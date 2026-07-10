#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/release.sh <version>"
  echo "Example: scripts/release.sh 0.1.1"
  exit 1
fi

VERSION="$1"
TAG="v${VERSION}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/release-guard.sh" "$VERSION"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash changes first."
  exit 1
fi

remote_ref_sha() {
  local ref="$1"
  local line
  line="$(git ls-remote --exit-code origin "$ref" 2>/dev/null)" || return 1
  printf '%s' "${line%%$'\t'*}"
}

load_remote_tag() {
  REMOTE_TAG_OBJECT=""
  REMOTE_TAG_COMMIT=""
  REMOTE_TAG_PEELED=false
  local lines sha ref
  lines="$(git ls-remote --tags origin "refs/tags/$TAG" "refs/tags/$TAG^{}")"
  while IFS=$'\t' read -r sha ref; do
    if [[ "$ref" == "refs/tags/$TAG" ]]; then
      REMOTE_TAG_OBJECT="$sha"
    elif [[ "$ref" == "refs/tags/$TAG^{}" ]]; then
      REMOTE_TAG_COMMIT="$sha"
      REMOTE_TAG_PEELED=true
    fi
  done <<< "$lines"
  if [[ -n "$REMOTE_TAG_OBJECT" && -z "$REMOTE_TAG_COMMIT" ]]; then
    REMOTE_TAG_COMMIT="$REMOTE_TAG_OBJECT"
  fi
}

CURRENT_VERSION="$(node -p "require('./package.json').version")"
LOCAL_TAG_OBJECT=""
LOCAL_TAG_COMMIT=""
REMOTE_TAG_OBJECT=""
REMOTE_TAG_COMMIT=""
REMOTE_TAG_PEELED=false
CREATE_RELEASE_RECORD=false
NEEDS_PUSH=false

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  LOCAL_TAG_OBJECT="$(git rev-parse "refs/tags/$TAG")"
fi
load_remote_tag

if [[ -n "$REMOTE_TAG_OBJECT" && -z "$LOCAL_TAG_OBJECT" ]]; then
  git fetch --quiet origin "refs/tags/$TAG:refs/tags/$TAG"
  LOCAL_TAG_OBJECT="$(git rev-parse "refs/tags/$TAG")"
fi

if [[ -n "$LOCAL_TAG_OBJECT" || -n "$REMOTE_TAG_OBJECT" ]]; then
  if [[ "$(git cat-file -t "refs/tags/$TAG")" != "tag" ]]; then
    echo "Release tag $TAG must be annotated." >&2
    exit 1
  fi
  LOCAL_TAG_COMMIT="$(git rev-parse "$TAG^{commit}")"
  HEAD_SHA="$(git rev-parse HEAD)"
  if [[ "$LOCAL_TAG_COMMIT" != "$HEAD_SHA" ]]; then
    echo "Release tag $TAG does not point to release HEAD." >&2
    exit 1
  fi
  if [[ -n "$REMOTE_TAG_COMMIT" && "$REMOTE_TAG_COMMIT" != "$HEAD_SHA" ]]; then
    echo "Remote release tag $TAG does not point to release HEAD." >&2
    exit 1
  fi
  if [[ -n "$REMOTE_TAG_OBJECT" && "$REMOTE_TAG_OBJECT" != "$LOCAL_TAG_OBJECT" ]]; then
    echo "Local and remote release tag $TAG objects differ." >&2
    exit 1
  fi
  if [[ "$CURRENT_VERSION" != "$VERSION" ]]; then
    echo "Release tag $TAG exists but package.json is version $CURRENT_VERSION." >&2
    exit 1
  fi
  if [[ "$(git log -1 --pretty=%s)" != "release: $TAG" ]]; then
    echo "Release tag $TAG is not attached to the expected release commit." >&2
    exit 1
  fi
  if [[ -z "$REMOTE_TAG_OBJECT" ]]; then
    NEEDS_PUSH=true
  fi
else
  if [[ "$CURRENT_VERSION" == "$VERSION" ]]; then
    echo "package.json is already version $VERSION but release tag $TAG is missing." >&2
    exit 1
  fi
  npm version "$VERSION" --no-git-tag-version
  CREATE_RELEASE_RECORD=true
  NEEDS_PUSH=true
fi

pnpm --dir web/dashboard install --frozen-lockfile
pnpm build
pnpm test
pnpm --dir web/dashboard test
npm pack --dry-run

if [[ "$CREATE_RELEASE_RECORD" == "true" ]]; then
  git add package.json
  if git diff --cached --quiet; then
    echo "Version bump did not produce a release change." >&2
    exit 1
  fi
  git commit -m "release: $TAG"
  git tag -a "$TAG" -m "Release $TAG"
fi

if [[ "$NEEDS_PUSH" == "true" ]]; then
  git push --atomic origin \
    "HEAD:refs/heads/trunk" \
    "refs/tags/$TAG:refs/tags/$TAG"
fi

HEAD_SHA="$(git rev-parse HEAD)"
REMOTE_TRUNK_SHA="$(remote_ref_sha refs/heads/trunk)" || {
  echo "Could not verify origin/trunk after release push." >&2
  exit 1
}
load_remote_tag
LOCAL_TAG_OBJECT="$(git rev-parse "refs/tags/$TAG")"
if [[ "$REMOTE_TRUNK_SHA" != "$HEAD_SHA" \
  || "$REMOTE_TAG_COMMIT" != "$HEAD_SHA" \
  || "$REMOTE_TAG_OBJECT" != "$LOCAL_TAG_OBJECT" \
  || "$REMOTE_TAG_PEELED" != "true" ]]; then
  echo "Release commit and tag are not both durable on origin." >&2
  exit 1
fi

if ! npm publish --access public; then
  echo "npm publish failed after $TAG was pushed. Re-run this version to reuse the exact Git record; if npm reports it already exists, verify the registry state manually." >&2
  exit 1
fi

echo "Released $TAG"
