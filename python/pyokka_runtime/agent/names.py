"""The names a statement assigns and reads, from its source text alone (``docs/PROTOCOL.md``, "statement").

A character scanner, not a parser: string literals (with their prefixes, triple quotes and the
``{…}`` parts of f-strings) and comments are recognised so that the identifiers of the rest
can be picked out with a regex. ``src/session/names.ts`` is the same scanner; the execution
graph fixtures pin both to the same ``targets`` / ``reads`` on every statement they hold.
"""

from __future__ import annotations

import re

KEYWORDS = frozenset(
    "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case".split()
)
_PREFIX = frozenset("rRbBfFuU")
_OPEN = "([{"
_CLOSE = ")]}"
# a name that is not the tail of a number (`10_000`, `0x1f`)
_NAME = re.compile(r"(?<![A-Za-z0-9_])[A-Za-z_][A-Za-z0-9_]*")
_TARGETS = re.compile(r"^\s*[A-Za-z_]\w*(\s*,\s*[A-Za-z_]\w*)*\s*(:\s*[^=]*)?\s*$")
_AUGMENTED = ("//", "**", "<<", ">>", "+", "-", "*", "/", "%", "@", "&", "|", "^")


def _scan(lines: list[str], keep_literals: bool) -> list[str]:
    """One output line per input line: comments gone; literals kept verbatim or replaced by a space plus the f-string expression parts."""
    out_lines: list[str] = []
    lit: dict | None = None  # {quote, triple, fstring, depth}: depth > 0 inside an f-string's `{…}`
    for line in lines:
        out: list[str] = []
        i = 0
        n = len(line)
        while i < n:
            ch = line[i]
            if lit is None:
                if ch == "#":
                    break
                if ch in "'\"":
                    j = i
                    while j > 0 and i - j < 2 and line[j - 1] in _PREFIX:
                        j -= 1
                    prefix = line[j:i]
                    triple = line[i : i + 3] == ch * 3
                    lit = {"quote": ch, "triple": triple, "fstring": "f" in prefix or "F" in prefix, "depth": 0}
                    if keep_literals:
                        out.append(line[i : i + 3] if triple else ch)
                    else:
                        if prefix:
                            del out[-len(prefix) :]
                        out.append(" ")
                    i += 3 if triple else 1
                    continue
                out.append(ch)
                i += 1
                continue
            if keep_literals:
                if ch == "\\":
                    out.append(line[i : i + 2])
                    i += 2
                    continue
                if lit["depth"] > 0:
                    if ch == "{":
                        lit["depth"] += 1
                    elif ch == "}":
                        lit["depth"] -= 1
                elif lit["fstring"] and ch in "{}" and line[i + 1 : i + 2] == ch:
                    out.append(ch + ch)
                    i += 2
                    continue
                elif lit["fstring"] and ch == "{":
                    lit["depth"] = 1
                elif lit["triple"] and line[i : i + 3] == lit["quote"] * 3:
                    out.append(line[i : i + 3])
                    lit = None
                    i += 3
                    continue
                elif not lit["triple"] and ch == lit["quote"]:
                    lit = None
                out.append(ch)
                i += 1
                continue
            if lit["depth"] > 0:
                if ch == "{":
                    lit["depth"] += 1
                elif ch == "}":
                    lit["depth"] -= 1
                out.append(ch)
                i += 1
                continue
            if ch == "\\":
                i += 2
                continue
            if lit["fstring"] and ch in "{}" and line[i + 1 : i + 2] == ch:
                i += 2
                continue
            if lit["fstring"] and ch == "{":
                lit["depth"] = 1
                out.append(ch)
                i += 1
                continue
            if lit["triple"]:
                if line[i : i + 3] == lit["quote"] * 3:
                    lit = None
                    i += 3
                    continue
            elif ch == lit["quote"]:
                lit = None
            i += 1
        if lit is not None and not lit["triple"]:
            lit = None
        out_lines.append("".join(out))
    return out_lines


def strip_comments(lines: list[str]) -> list[str]:
    """The lines without their comments, literals kept: the source a statement node shows."""
    return _scan(lines, True)


def strip_code(lines: list[str]) -> str:
    """The lines joined by a space, comments gone, literals reduced to a space plus their f-string expression parts."""
    return " ".join(_scan(lines, False))


def _identifiers(stripped: str) -> list[str]:
    out: list[str] = []
    depth = 0
    pos = 0
    n = len(stripped)
    for m in _NAME.finditer(stripped):
        for ch in stripped[pos : m.start()]:
            if ch in _OPEN:
                depth += 1
            elif ch in _CLOSE:
                depth -= 1
        pos = m.end()
        name = m.group()
        if m.start() > 0 and stripped[m.start() - 1] == ".":
            continue
        if name in KEYWORDS:
            continue
        j = pos
        while j < n and stripped[j] in " \t":
            j += 1
        if depth > 0 and j < n and stripped[j] == "=" and stripped[j + 1 : j + 2] != "=":
            continue
        out.append(name)
    return out


def _targets(stripped: str) -> tuple[list[str], bool]:
    depth = 0
    eq = -1
    for i, ch in enumerate(stripped):
        if ch in _OPEN:
            depth += 1
        elif ch in _CLOSE:
            depth -= 1
        elif ch == "=" and depth == 0:
            prev = stripped[i - 1] if i > 0 else ""
            nxt = stripped[i + 1 : i + 2]
            if prev not in ("=", "!", "<", ">", ":") and nxt != "=":
                eq = i
                break
    if eq < 0:
        return [], False
    left = stripped[:eq]
    augmented = False
    for op in _AUGMENTED:
        if left.endswith(op):
            left = left[: -len(op)]
            augmented = True
            break
    if not _TARGETS.match(left):
        return [], augmented
    return _NAME.findall(left.split(":", 1)[0]), augmented


def names_of(lines: list[str]) -> tuple[list[str], list[str]]:
    """``(targets, reads)`` of a statement given as its raw source lines."""
    stripped = strip_code(lines)
    targets, augmented = _targets(stripped)
    seen: set[str] = set()
    reads: list[str] = []
    for name in _identifiers(stripped):
        if name in seen or (name in targets and not augmented):
            continue
        seen.add(name)
        reads.append(name)
    return targets, reads


def loop_names(text: str) -> tuple[list[str], list[str]]:
    """``(targets, reads)`` of a ``for`` header's ``<target> in <iterable>`` text (the file map's loop text)."""
    head, sep, rest = text.partition(" in ")
    if not sep:
        return [], names_of([text])[1]
    return _NAME.findall(head), names_of([rest])[1]


__all__ = ["names_of", "loop_names", "strip_code", "strip_comments", "KEYWORDS"]
