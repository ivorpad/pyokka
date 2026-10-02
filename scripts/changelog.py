#!/usr/bin/env python3
"""Turn the `## Unreleased` section into a released one, and hand back its text.

CHANGELOG.md keeps one `## Unreleased` section on top and a `## X.Y.Z` section per
release below it. Cutting a release renames the first and opens a fresh one, so the
notes a release carries are the ones that were written while the work happened rather
than a list of commit subjects assembled afterwards.

    changelog.py --notes       print the Unreleased body, change nothing
    changelog.py --cut 0.1.0   rename it to `## 0.1.0`, open a new Unreleased, print the body

Exits 1 when Unreleased is empty, which lets the caller fall back to commit subjects.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

PATH = Path(__file__).resolve().parent.parent / 'CHANGELOG.md'
# the Unreleased heading, its body, and wherever the next section starts (or the file ends)
SECTION = re.compile(r'^## Unreleased[ \t]*\n(.*?)(?=^## |\Z)', re.M | re.S)


def main() -> int:
    ap = argparse.ArgumentParser(description='Cut the Unreleased changelog section.')
    ap.add_argument('--notes', action='store_true', help='print the body, write nothing')
    ap.add_argument('--cut', metavar='X.Y.Z', help='rename the section and open a new one')
    args = ap.parse_args()

    text = PATH.read_text()
    found = SECTION.search(text)
    if not found:
        print('changelog.py: no "## Unreleased" section', file=sys.stderr)
        return 1

    body = found.group(1).strip()
    if not body:
        print('changelog.py: "## Unreleased" is empty', file=sys.stderr)
        return 1

    if args.cut:
        PATH.write_text(text[:found.start()]
                        + f'## Unreleased\n\n## {args.cut}\n\n{body}\n\n'
                        + text[found.end():])
    print(body)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
