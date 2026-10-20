"""The diff's hunks with both numberings, and the removed and added lines an agenda item keeps of them.

``plan_items`` stores these lines on each item of a review in the debugger, so ``review stop`` can print
what changed at the pause. The agenda named only the file, line, function and changed line numbers,
and on 2026-10-19 Codex read the source with ``sed`` at its first stop because the diff it had seen
was two turns back. ``changed_lines`` (``edges.py``) keeps head's line numbers alone; this parse keeps
the text and base's numbers as well.
"""

from __future__ import annotations

import re

from ..recording import cut_line

HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
CHANGE_LINES = 30  # changed lines an item keeps; the stop prints them all and counts the rest
LINE_CHARS = 200  # a kept line's text: one generated line of thousands would swell review.json


def parse_hunks(diff_text: str) -> dict[str, list[dict]]:
    """``{file: [{old_start, new_start, lines: [[sign, number, text]]}]}`` from ``git diff`` output.

    ``sign`` is ``-`` (numbered in base), ``+`` or a space for context (both numbered in head). The
    header's counts bound each hunk, so a removed line whose text starts with ``-- `` (``--- `` in the
    diff) or an added one starting with ``++ `` stays in its hunk, where a reader that looks at
    prefixes alone would take it for the next file. Files are keyed by the ``+++`` path with ``b/``
    stripped, as ``changed_lines`` keys them, so the items it produced find their hunks; a deleted
    file has none. ``\\ No newline at end of file`` counts on neither side and is dropped.
    """
    files: dict[str, list[dict]] = {}
    current: list[dict] | None = None
    hunk: dict | None = None
    old = new = old_left = new_left = 0
    for raw in diff_text.split("\n"):  # not splitlines: a form feed inside a source line is not a line break
        line = raw[:-1] if raw.endswith("\r") else raw
        if hunk is not None and (old_left > 0 or new_left > 0):
            sign, text = line[:1] or " ", line[1:]  # an empty line is a blank context line whose space was stripped
            if sign == "\\":
                continue
            if sign in ("-", " "):
                hunk["lines"].append([sign, old if sign == "-" else new, text])
                old, old_left = old + 1, old_left - 1
                if sign == " ":
                    new, new_left = new + 1, new_left - 1
                continue
            if sign == "+":
                hunk["lines"].append(["+", new, text])
                new, new_left = new + 1, new_left - 1
                continue
            hunk = None  # the header counted more lines than came: read this one as a header
        if line.startswith("+++ "):
            name = line[4:].strip()
            name = name[2:] if name.startswith("b/") else name
            current = None if name == "/dev/null" else files.setdefault(name, [])
            hunk = None
            continue
        m = HUNK_RE.match(line)
        if m and current is not None:
            old, new = int(m.group(1)), int(m.group(3))
            old_left = int(m.group(2)) if m.group(2) is not None else 1
            new_left = int(m.group(4)) if m.group(4) is not None else 1
            hunk = {"old_start": old, "new_start": new, "lines": []}
            current.append(hunk)
    return files


def runs(lines: list[list]) -> list[list[list]]:
    """A hunk's changed lines in runs: the removed and added lines between two context lines."""
    out: list[list[list]] = []
    run: list[list] = []
    for entry in lines:
        if entry[0] == " ":
            if run:
                out.append(run)
            run = []
        else:
            run.append(entry)
    if run:
        out.append(run)
    return out


def _cut_run(run: list[list], room: int) -> list[list]:
    """``room`` lines of a run too long to keep whole, in diff order: the removed lines get at most a
    third of them, so a rewritten body still shows the added lines a pause is on."""
    minus = [e for e in run if e[0] == "-"]
    plus = [e for e in run if e[0] == "+"]
    keep_plus = min(len(plus), room - min(len(minus), room // 3))
    keep_minus = min(len(minus), room - keep_plus)
    kept = {id(e) for e in minus[:keep_minus]} | {id(e) for e in plus[:keep_plus]}
    return [e for e in run if id(e) in kept]


def item_hunks(file_hunks: list[dict], spans: list) -> tuple[list[dict], int]:
    """``(hunks, left_out)``: the runs whose added lines fall in ``spans``, hunk by hunk, at most
    ``CHANGE_LINES`` lines of them, and the number of changed lines left out.

    A run of added lines is one span by construction, and its removed lines are the ones it replaces.
    A run that only removes lines belongs to no item, since removed lines have no place in head to
    stop at, and a run of another function in the same hunk stays with that function's item: on the
    shop fixture one hunk holds the module docstring, ``loyalty_rate`` and ``spend_tier_rate``, and a
    whole hunk would print all three at ``loyalty_rate``'s stop. Runs are kept whole in diff order;
    the first one that does not fit is cut and the rest are counted.
    """
    bounds = [(int(lo), int(hi)) for lo, hi in spans if lo is not None and hi is not None]
    picked: list[tuple[dict, list[list[list]]]] = []
    for hunk in file_hunks:
        mine = [r for r in runs(hunk.get("lines") or []) if any(sign == "+" and any(lo <= n <= hi for lo, hi in bounds) for sign, n, _ in r)]
        if mine:
            picked.append((hunk, mine))
    total = sum(len(r) for _, rs in picked for r in rs)
    out: list[dict] = []
    room = CHANGE_LINES
    for hunk, rs in picked:
        kept: list[list] = []
        for run in rs:
            if room <= 0:
                break
            piece = run if len(run) <= room else _cut_run(run, room)  # a cut run fills the room exactly
            kept.extend(piece)
            room -= len(piece)
        if kept:
            out.append({"old_start": hunk["old_start"], "new_start": hunk["new_start"], "lines": [[sign, n, cut_line(text, LINE_CHARS)] for sign, n, text in kept]})
        if room <= 0:
            break
    return out, total - sum(len(h["lines"]) for h in out)


def attach_hunks(items: list[dict], diff_text: str) -> None:
    """Store on each item its ``hunks`` and ``hunks_more``, the changed lines left out of them."""
    per_file = parse_hunks(diff_text)
    for item in items:
        item["hunks"], item["hunks_more"] = item_hunks(per_file.get(str(item.get("file") or ""), []), item.get("spans") or [])


__all__ = ["CHANGE_LINES", "LINE_CHARS", "attach_hunks", "item_hunks", "parse_hunks", "runs"]
