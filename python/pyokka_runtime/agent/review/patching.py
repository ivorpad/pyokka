"""A unified-diff applier in pure Python, for ``fix --patch FILE.diff`` on the copy of head.

Paths lose one leading component (``a/``, ``b/``: what ``patch -p1`` strips); ``/dev/null`` makes or
deletes a file. A hunk applies where its header says, else at the nearest place its context
matches (an offset, never a fuzz: every context line must match). Every file's new text is built
first and written only when every hunk of every file applied, so a refusal leaves the copy as it was.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

from .state import inside

HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


class PatchError(Exception):
    pass


@dataclass
class Hunk:
    old_start: int
    old_len: int
    new_start: int
    new_len: int
    lines: list[tuple[str, str]] = field(default_factory=list)

    def header(self) -> str:
        return "@@ -%d,%d +%d,%d @@" % (self.old_start, self.old_len, self.new_start, self.new_len)


@dataclass
class FilePatch:
    old: str | None
    new: str | None
    hunks: list[Hunk] = field(default_factory=list)
    new_trailing_newline: bool | None = None  # False when `\ No newline at end of file` follows the new side's last line


def _path(raw: str) -> str | None:
    text = raw.strip().split("\t")[0].strip()
    if text.startswith('"') and text.endswith('"') and len(text) >= 2:
        text = text[1:-1]
    if text == "/dev/null":
        return None
    parts = text.split("/")
    return "/".join(parts[1:]) if len(parts) > 1 else text


def parse_patch(text: str) -> list[FilePatch]:
    files: list[FilePatch] = []
    cur: FilePatch | None = None
    hunk: Hunk | None = None
    old_left = new_left = 0
    last_tag = ""
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if hunk is not None and (old_left > 0 or new_left > 0):
            tag, body = (line[0], line[1:]) if line else (" ", "")
            if tag == " ":
                old_left -= 1
                new_left -= 1
            elif tag == "-":
                old_left -= 1
            elif tag == "+":
                new_left -= 1
            elif tag == "\\":
                if cur is not None and last_tag in (" ", "+"):
                    cur.new_trailing_newline = False
                i += 1
                continue
            else:
                raise PatchError("line %d is not part of hunk %s: %r" % (i + 1, hunk.header(), line[:80]))
            if old_left < 0 or new_left < 0:
                raise PatchError("hunk %s has more lines than its header counts (line %d)" % (hunk.header(), i + 1))
            hunk.lines.append((tag, body))
            last_tag = tag
            i += 1
            continue
        if line.startswith("\\") and cur is not None and last_tag in (" ", "+"):
            cur.new_trailing_newline = False
            i += 1
            continue
        if line.startswith("--- ") and i + 1 < len(lines) and lines[i + 1].startswith("+++ "):
            cur = FilePatch(_path(line[4:]), _path(lines[i + 1][4:]))
            files.append(cur)
            hunk = None
            i += 2
            continue
        m = HUNK_RE.match(line)
        if m:
            if cur is None:
                raise PatchError("hunk %s before any --- / +++ header (line %d)" % (line[:40], i + 1))
            hunk = Hunk(int(m.group(1)), int(m.group(2)) if m.group(2) is not None else 1, int(m.group(3)), int(m.group(4)) if m.group(4) is not None else 1)
            old_left, new_left = hunk.old_len, hunk.new_len
            cur.hunks.append(hunk)
            last_tag = ""
            i += 1
            continue
        i += 1  # diff --git, index, mode lines, text between patches
    if not files:
        raise PatchError("no file change in the patch (no `--- a/FILE` / `+++ b/FILE` headers)")
    return files


def _locate(lines: list[str], expect: list[str], start: int, minimum: int) -> int | None:
    """Where ``expect`` sits in ``lines``: at ``start`` (0-based), else the nearest match at or after ``minimum``."""
    n = len(expect)
    if n == 0:
        return max(min(start, len(lines)), minimum)

    def fits(at: int) -> bool:
        return minimum <= at <= len(lines) - n and lines[at:at + n] == expect

    if fits(start):
        return start
    for delta in range(1, max(len(lines), start) + 1):
        if fits(start - delta):
            return start - delta
        if fits(start + delta):
            return start + delta
    return None


def _apply_hunks(fp: FilePatch, old: list[str], name: str) -> list[str]:
    out: list[str] = []
    pos = 0
    offset = 0
    for h in fp.hunks:
        expect = [body for tag, body in h.lines if tag in (" ", "-")]
        anchor = h.old_start - 1 if h.old_len else h.old_start  # a pure insertion names the line it follows
        found = _locate(old, expect, max(anchor + offset, 0), pos)
        if found is None:
            at = min(max(anchor + offset, 0), max(len(old) - 1, 0))
            seen = old[at] if old else ""
            first = expect[0] if expect else ""
            raise PatchError("%s: hunk %s does not apply: expected %r around line %d, found %r" % (name, h.header(), first, at + 1, seen))
        out.extend(old[pos:found])
        out.extend(body for tag, body in h.lines if tag in (" ", "+"))
        pos = found + len(expect)
        offset = found - anchor
    out.extend(old[pos:])
    return out


def apply_patch(text: str, root: str) -> list[str]:
    """Apply the unified diff ``text`` under ``root``; the files changed, relative to it. ``PatchError`` leaves nothing written."""
    root = os.path.abspath(root)
    pending: list[tuple[str, str | None, str]] = []  # (absolute path, new content or None to delete, relative name)
    for fp in parse_patch(text):
        target = fp.new or fp.old
        if target is None:
            raise PatchError("a file change with /dev/null on both sides")
        for rel in (fp.old, fp.new):
            if rel is not None and (os.path.isabs(rel) or not inside(os.path.join(root, rel), root)):
                raise PatchError("%s leaves the tree" % rel)
        if fp.old is None:
            if os.path.exists(os.path.join(root, target)):
                raise PatchError("%s: the patch creates it, but it already exists" % target)
            old_lines: list[str] = []
            trailing = True
        else:
            try:
                with open(os.path.join(root, fp.old), "r", encoding="utf-8") as fh:
                    content = fh.read()
            except OSError:
                raise PatchError("%s is not in the tree" % fp.old) from None
            trailing = content.endswith("\n")
            old_lines = content.split("\n")
            if trailing:
                old_lines.pop()
        new_lines = _apply_hunks(fp, old_lines, target)
        if fp.new is None:
            pending.append((os.path.join(root, str(fp.old)), None, str(fp.old)))
            continue
        if fp.new_trailing_newline is not None:
            trailing = fp.new_trailing_newline
        if fp.old is not None and fp.old != fp.new:
            pending.append((os.path.join(root, fp.old), None, fp.old))
        pending.append((os.path.join(root, fp.new), "\n".join(new_lines) + ("\n" if trailing and new_lines else ""), fp.new))
    changed: list[str] = []
    for path, content, rel in pending:
        if content is None:
            try:
                os.remove(path)
            except FileNotFoundError:
                pass
        else:
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(content)
        if rel not in changed:
            changed.append(rel)
    return changed


__all__ = ["PatchError", "FilePatch", "Hunk", "parse_patch", "apply_patch"]
