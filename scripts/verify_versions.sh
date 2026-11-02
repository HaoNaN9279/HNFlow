#!/usr/bin/env bash
# Verify that every project version source agrees.
#
# Sources checked:
#   backend/pyproject.toml             — version
#   frontend/package.json              — version
#
# Usage:
#   scripts/verify_versions.sh             # all sources must be mutually equal
#   scripts/verify_versions.sh 2.1.0       # all sources must equal 2.1.0
#
# Exit status is 0 when consistent, 1 otherwise. The release workflow
# (.github/workflows/container.yaml) calls this on v* tags — via the reusable
# .github/workflows/verify-versions.yml — to gate publishing when a version
# source was forgotten.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PYPROJECT="$ROOT/backend/pyproject.toml"
PACKAGE="$ROOT/frontend/package.json"

for f in "$PYPROJECT" "$PACKAGE"; do
  if [ ! -f "$f" ]; then
    echo "::error::missing version file: $f" >&2
    exit 1
  fi
done

PY_VERSION=$(awk -F'"' '/^version[[:space:]]*=/ {print $2; exit}' "$PYPROJECT")
JS_VERSION=$(grep -m1 '"version"' "$PACKAGE" | awk -F'"' '{print $4}')

printf 'backend/pyproject.toml: %s\n' "$PY_VERSION"
printf 'frontend/package.json:  %s\n' "$JS_VERSION"

# mismatch <name> <actual> <expected>: prints a GitHub Actions annotation and
# returns 1 when they differ, 0 when equal.
mismatch() {
  if [ "$2" != "$3" ]; then
    echo "::error::$1 is '$2' but expected '$3'." >&2
    return 1
  fi
  return 0
}

EXPECTED="${1:-}"
status=0

if [ -n "$EXPECTED" ]; then
  printf 'Expected:               %s (from tag v%s)\n\n' "$EXPECTED" "$EXPECTED"
  mismatch "backend/pyproject.toml" "$PY_VERSION" "$EXPECTED" || status=1
  mismatch "frontend/package.json"  "$JS_VERSION" "$EXPECTED" || status=1
else
  echo
  mismatch "backend/pyproject.toml" "$PY_VERSION" "$JS_VERSION" || status=1
fi

if [ "$status" -ne 0 ]; then
  if [ -n "$EXPECTED" ]; then
    echo "Tip: run scripts/bump_version.sh $EXPECTED to align all sources." >&2
  else
    echo "Tip: run scripts/bump_version.sh <version> to align all sources." >&2
  fi
  exit 1
fi

echo "OK — all version sources agree on ${PY_VERSION}."
