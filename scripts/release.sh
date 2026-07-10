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

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Tag already exists: $TAG"
  exit 1
fi
if git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1; then
  echo "Tag already exists on origin: $TAG"
  exit 1
fi

CURRENT_VERSION="$(node -p "require('./package.json').version")"
if [[ "$CURRENT_VERSION" != "$VERSION" ]]; then
  npm version "$VERSION" --no-git-tag-version
fi

pnpm --dir web/dashboard install --frozen-lockfile
pnpm build && pnpm test
npm publish --access public

git add package.json
git commit -m "release: $TAG"
git tag -a "$TAG" -m "Release $TAG"
git push origin HEAD
git push origin "$TAG"

echo "Released $TAG"
