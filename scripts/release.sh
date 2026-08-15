#!/usr/bin/env bash
#
# Ship a change: verify, then move the v1 tag callers resolve against.
#
#   npm run release
#
# Callers reference notion-sync-workflow@v1, never main, so a push alone changes
# nothing for them. This moves the tag — and refuses to do so if dist/ does not
# match src/, which is the one mistake that fails silently: GitHub keeps running
# the old bundle while the source looks correct.
set -euo pipefail

cd "$(dirname "$0")/.."

fail() { printf '\n  %s\n\n' "$*" >&2; exit 1; }

[ -z "$(git status --porcelain --untracked-files=no)" ] ||
  fail "Working tree is dirty. Commit your changes first, then run this."

branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "main" ] || fail "On '$branch'. The v1 tag should only ever point at main."

echo "→ typecheck"
npm run --silent typecheck

echo "→ test"
npm run --silent test

echo "→ build"
npm run --silent build

# dist/ is the compiled bundle the Action actually runs. If rebuilding changed
# it, what is committed is not what src/ produces — so commit the rebuild rather
# than making the human remember to. A separate commit, never an amend: amending
# an already-pushed commit would make the push below fail in a way that is far
# harder to understand than one extra line of history.
if [ -n "$(git status --porcelain dist)" ]; then
  echo "→ dist/ was stale; committing the rebuild"
  git add dist
  git commit -q -m "Rebuild dist"
fi

echo "→ push main"
git push origin main

echo "→ move v1 → $(git rev-parse --short HEAD)"
git tag -f v1 > /dev/null
git push -f origin v1

printf '\n  Released. ubcuxhub/uxhub now runs %s\n\n' "$(git rev-parse --short HEAD)"
