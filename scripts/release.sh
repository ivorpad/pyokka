#!/bin/sh
# Cut a release: move the version, run the checks, build the vsix, install it, tag, and
# put the artifact on GitHub.
#
#   scripts/release.sh             level from the Bump: trailers since the last tag
#   scripts/release.sh minor       force a level
#   scripts/release.sh --set 1.2.3 force a number
#
# The checks run before anything is written, so a failing test leaves the tree clean
# rather than half-bumped. The bump then happens before the build, so the vsix that gets
# installed and uploaded is the one the tag names.
set -e
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "release: the working tree is dirty. Commit first, the release wants a clean diff to tag." >&2
  exit 1
fi

LAST=$(git tag --list 'v*' --sort=-v:refname | head -1)
if [ -n "$LAST" ] && [ "$(git rev-list --count "$LAST"..HEAD)" -eq 0 ]; then
  echo "release: nothing has been committed since $LAST. There is no release to cut." >&2
  exit 1
fi

VERSION=$(python3 scripts/version.py "$@" --next)
TAG="v$VERSION"
VSIX="pyokka-$VERSION.vsix"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "release: $TAG already exists. Force a level or a number to go past it." >&2
  exit 1
fi
echo "releasing $TAG"

echo "==> checks"
scripts/check.sh

echo "==> version"
python3 scripts/version.py "$@" --auto

echo "==> changelog"
NOTES=$(mktemp -t pyokka-notes)
trap 'rm -f "$NOTES" "$NOTES.cut"' EXIT
if python3 scripts/changelog.py --cut "$VERSION" > "$NOTES"; then
  # GitHub caps release notes at 125000 characters; CHANGELOG.md keeps the whole entry
  if [ "$(wc -c < "$NOTES")" -gt 100000 ]; then
    head -c 100000 "$NOTES" > "$NOTES.cut"
    printf '\n\n(truncated; the full entry is in CHANGELOG.md)\n' >> "$NOTES.cut"
    mv "$NOTES.cut" "$NOTES"
  fi
else
  git log --format='- %s' "${LAST:-$(git rev-list --max-parents=0 HEAD)}"..HEAD > "$NOTES"
fi

echo "==> build"
node esbuild.mjs --production
./node_modules/.bin/vsce package --no-dependencies

echo "==> install"
code --install-extension "$PWD/$VSIX" --force

echo "==> tag"
git add -A
git commit -m "Release $TAG"
git tag -a "$TAG" -m "Pyokka $VERSION"

echo "==> publish"
git push -u origin HEAD
git push origin "$TAG"
gh release create "$TAG" "$VSIX" --title "$TAG" --notes-file "$NOTES" --latest

echo
echo "$TAG released. Run \"Developer: Reload Window\" in every open VS Code window."
