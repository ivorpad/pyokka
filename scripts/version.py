#!/usr/bin/env python3
"""The version Pyokka ships under, and the rule that moves it.

Four files carry the number. `package.json` is the one that decides it: the manifest
generator keeps whatever is already there (`setdefault`), so regenerating never resets
it. The other three are written to match.

The next version is computed from the last release tag, not from the current number:

    next = max(bump(last_tag, level), current)

`level` is the strongest `Bump:` trailer on the commits since that tag, patch when none
of them says otherwise. Deriving it from the tag is what makes a rebuild a no-op. The
first build after v0.0.1 moves the files to 0.0.2, and every build after that lands on
0.0.2 again instead of walking 0.0.3, 0.0.4, 0.0.5 while nothing has been released. A
commit that later carries `Bump: minor` still escalates the same pending release to
0.1.0, because the tag it counts from has not moved.

    version.py                 print the current version
    version.py --next          print what the next release would be
    version.py --auto          move the files to --next, print "0.0.1 -> 0.0.2"
    version.py minor           force a level, counting from the current number
    version.py --set 1.2.3     force a number
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Each pattern is anchored at its own indent so it cannot match a nested "version" key
# or a dependency pin. Group 2 is the number; groups 1 and 3 are put back unchanged.
FILES = [
    ('package.json', re.compile(r'^(  "version": ")(\d+\.\d+\.\d+)(")', re.M)),
    ('python/pyproject.toml', re.compile(r'^(version = ")(\d+\.\d+\.\d+)(")', re.M)),
    ('python/pyokka_runtime/__init__.py', re.compile(r'^(__version__ = ")(\d+\.\d+\.\d+)(")', re.M)),
    # the fallback the manifest generator falls back on when package.json is missing.
    # Left stale, a regenerated manifest would quietly ship 0.0.1 again.
    ('scripts/gen-manifest.py', re.compile(r"^(    'version': ')(\d+\.\d+\.\d+)(')", re.M)),
]

LEVELS = {'major': 0, 'minor': 1, 'patch': 2}
SYNONYMS = {'breaking': 'major', 'feature': 'minor', 'feat': 'minor', 'fix': 'patch'}
TRAILER = re.compile(r'^[ \t]*Bump:[ \t]*([A-Za-z]+)[ \t]*$', re.M)
SEMVER = re.compile(r'\d+\.\d+\.\d+')


def git(*args: str) -> str:
    done = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True)
    return done.stdout.strip() if done.returncode == 0 else ''


def parse(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split('.'))


def read() -> str:
    path, pattern = FILES[0]
    found = pattern.search((ROOT / path).read_text())
    if not found:
        sys.exit(f'version.py: no version line in {path}')
    return found.group(2)


def write(version: str) -> list[str]:
    changed = []
    for path, pattern in FILES:
        target = ROOT / path
        text = target.read_text()
        new = pattern.sub(lambda m: m.group(1) + version + m.group(3), text, count=1)
        if new == text:
            continue
        target.write_text(new)
        changed.append(path)
    return changed


def last_tag() -> str | None:
    """The highest vX.Y.Z tag, or None before the first release."""
    tags = [t[1:] for t in git('tag', '--list', 'v*').splitlines()
            if re.fullmatch(r'v\d+\.\d+\.\d+', t)]
    return max(tags, key=parse) if tags else None


def level_since(tag: str) -> str:
    """The strongest Bump: trailer on the commits since `tag`. Patch if there is none."""
    body = git('log', f'v{tag}..HEAD', '--format=%B')
    named = [SYNONYMS.get(word.lower(), word.lower()) for word in TRAILER.findall(body)]
    known = [name for name in named if name in LEVELS]
    return min(known, key=lambda name: LEVELS[name]) if known else 'patch'


def bump(version: str, level: str) -> str:
    major, minor, patch = parse(version)
    if level == 'major':
        return f'{major + 1}.0.0'
    if level == 'minor':
        return f'{major}.{minor + 1}.0'
    return f'{major}.{minor}.{patch + 1}'


def next_version() -> str:
    current = read()
    tag = last_tag()
    if tag is None:
        # nothing has been released, so the number already in the files is the one to ship
        return current
    return max(bump(tag, level_since(tag)), current, key=parse)


def main() -> int:
    ap = argparse.ArgumentParser(description='Read and move Pyokka\'s version.')
    ap.add_argument('level', nargs='?', choices=sorted(LEVELS) + sorted(SYNONYMS),
                    help='force a level instead of reading the Bump: trailers')
    ap.add_argument('--next', action='store_true', help='print the next version, write nothing')
    ap.add_argument('--auto', action='store_true', help='write the next version, print the move')
    ap.add_argument('--set', dest='exact', metavar='X.Y.Z', help='force a number')
    args = ap.parse_args()

    current = read()
    if args.exact:
        if not SEMVER.fullmatch(args.exact):
            sys.exit(f'version.py: not a version: {args.exact}')
        target = args.exact
    elif args.level:
        target = bump(current, SYNONYMS.get(args.level, args.level))
    else:
        target = next_version()

    if args.next:
        print(target)
        return 0
    if not (args.auto or args.level or args.exact):
        print(current)
        return 0
    if target == current:
        return 0
    print(f'{current} -> {target} ({", ".join(write(target))})')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
