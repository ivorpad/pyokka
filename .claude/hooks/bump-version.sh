#!/bin/sh
# PreToolUse(Bash): a build that produces an installable vsix gets a fresh version first.
#
# The bump has to happen before the command runs, not after, or the artifact carries the
# number of the release before it. A PreToolUse hook cannot rewrite the command, so it
# moves the files and lets the original command build against them.
#
# scripts/version.py --auto is a no-op when the current version is already ahead of the
# last tag, so building five times before committing still lands on one new number.
set -e

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
COMMAND=$(jq -r '.tool_input.command // ""')

case "$COMMAND" in
  # release.sh moves the version itself, and check.sh's plain esbuild run is not a build
  # anyone installs
  *release.sh*) exit 0 ;;
  *"vsce package"*|*"--install-extension"*|*"esbuild.mjs --production"*) ;;
  *) exit 0 ;;
esac

MOVE=$(python3 "$ROOT/scripts/version.py" --auto 2>/dev/null) || exit 0
[ -n "$MOVE" ] || exit 0

jq -n --arg move "$MOVE" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: ("Version bumped before this build: " + $move +
      ". The vsix this command writes carries the new number, so use it in any path that names the file.")
  }
}'
