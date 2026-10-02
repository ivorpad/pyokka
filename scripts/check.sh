#!/bin/sh
# Full local check: typecheck, unit tests, python tests, build, the Claude Code band.
set -e
cd "$(dirname "$0")/.."
npm run typecheck
npx vitest run
(cd python && uv run --group dev pytest -q)
node esbuild.mjs
# The band (claude-plugin/pyokka-band) is checked by Claude Code itself. Without `claude` on
# PATH (CI, a machine without Claude Code) these two steps are skipped, and say so.
if command -v claude >/dev/null 2>&1; then
  claude plugin validate --strict .
  claude plugin validate --strict claude-plugin/pyokka-band
  claude plugin test claude-plugin/pyokka-band
else
  echo "claude not found: skipped the band's validate and test"
fi
echo "all checks passed"
