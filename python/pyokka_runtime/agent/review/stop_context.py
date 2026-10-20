"""What ``review stop`` prints at a pause in the debugger besides the item: the change there, and the frame's values with the ones the changed lines use first.

The change is the item's ``hunks`` (``hunks.py``): removed lines with base's numbers and added lines
with head's, in diff order, ``>`` on the added line the pause is on, as the debugger's own block
marks it. The values are the frame's locals as ``pause_values`` read them, each text as the runtime
delivered it: the runtime bounds it already, and the stop's own cut at 100 characters threw away what
the debugger had just shown (``policy = SSRFPolicy(…)`` on 2026-10-19). Nothing is evaluated to order
them. The current source is parsed and only plain names count: a call such as ``int(addr)`` would run
code, and so can an attribute (a property), so ``self.policy`` counts as ``self``. What a changed
line computes is seen by stepping over it, not by the review.
"""

from __future__ import annotations

import ast

from ..source import AgentError
from .debugger import abs_file, connect
from .state import Review


def change_lines(item: dict, line: int | None) -> list[str]:
    """``change:`` and the item's changed lines, ``>`` on the added line ``line``; nothing for an item
    without hunks (a review.json written before them, a pause outside every item)."""
    rows = [r for h in item.get("hunks") or [] if isinstance(h, dict) for r in h.get("lines") or [] if isinstance(r, (list, tuple)) and len(r) == 3]
    if not rows:
        return []
    width = max(len(str(n)) for _, n, _ in rows)
    out = ["change:"]
    for sign, n, text in rows:
        here = sign == "+" and line is not None and str(n) == str(line)
        out.append("%s%s %s%s" % (">" if here else " ", str(n).rjust(width), sign, str(text).rstrip()))
    more = int(item.get("hunks_more") or 0)
    if more:
        out.append("%s… %d more changed line%s" % (" " * (width + 2), more, "" if more == 1 else "s"))
    return out


def _compound(node: ast.AST) -> bool:
    """A statement that holds statements: ``def``, ``class``, ``if``, ``for``, ``while``, ``with``, ``try``, ``match``."""
    return hasattr(node, "body") or hasattr(node, "cases")


def names_on(source: str, lines: set[int]) -> set[str] | None:
    """The plain names the source uses on ``lines``: ``Name`` ids, a ``def``'s parameters and an
    ``except … as`` name; None when the source does not parse.

    A simple statement that touches one of the lines counts whole, so a call spread over lines is one
    use. A compound statement counts on its own lines only, never through its body, or every name of
    the enclosing function would count. The root of an attribute chain is a ``Name`` of its own, so
    ``self.policy`` gives ``self`` and the attribute is never looked at.
    """
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return None
    wide = set(lines)
    for node in ast.walk(tree):
        if isinstance(node, ast.stmt) and not _compound(node):
            span = set(range(node.lineno, (node.end_lineno or node.lineno) + 1))
            if span & lines:
                wide |= span
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.lineno in wide:
            found.add(node.id)
        elif isinstance(node, ast.arg) and node.lineno in wide:
            found.add(node.arg)  # a changed parameter line: the parameter is a local of the paused frame
        elif isinstance(node, ast.ExceptHandler) and node.name and node.lineno in wide:
            found.add(node.name)
    return found


def _span_lines(item: dict) -> set[int]:
    out: set[int] = set()
    for span in item.get("spans") or []:
        try:
            lo, hi = int(span[0]), int(span[-1])
        except (TypeError, ValueError, IndexError):
            continue
        out.update(range(lo, hi + 1))
    return out


def used_names(item: dict, path: str, line: int | None, values: list[tuple[str, str]]) -> list[str]:
    """The frame's locals that the item's changed lines and the paused line use, in the frame's order;
    none when the file cannot be read or does not parse."""
    target = _span_lines(item) | ({int(line)} if line is not None else set())
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            names = names_on(fh.read(), target) or set()
    except OSError:
        return []
    return [name for name, _ in values if name in names]


def value_rows(pairs: list[tuple[str, str]], indent: str = "  ") -> list[str]:
    """``name = text`` per value, the text whole on one line (recorded mode's ``value_lines`` cuts it)."""
    return ["%s%s = %s" % (indent, name, " ".join(str(text).split("\n")).strip()) for name, text in pairs]


def locals_lines(item: dict, path: str, line: int | None, values: list[tuple[str, str]]) -> tuple[list[str], list[str]]:
    """``(lines, used)``: the locals the changed lines and the paused line use under their own header,
    then ``other locals:``; one ``locals:`` list when none is used there or the pause is outside every
    item. ``used`` names the first group, which ``names_a_value`` does not care about: a say may name
    any local."""
    if not values:
        return ["locals: none in this frame"], []
    used = used_names(item, path, line, values) if item.get("kind") == "change" else []
    if not used:
        return ["locals:", *value_rows(values)], []
    on_changed = line is None or int(line) in _span_lines(item)
    out = ["values on the changed lines:" if on_changed else "values on the changed lines and line %d:" % int(line), *value_rows([(n, t) for n, t in values if n in used])]
    rest = [(n, t) for n, t in values if n not in used]
    if rest:
        out += ["other locals:", *value_rows(rest)]
    return out, used


def stop_context(review: Review, item: dict, line: int | None, values: list[tuple[str, str]]) -> tuple[list[str], list[str]]:
    """``(lines, used)``: the ``change:`` section and the locals, as the stop prints them after ``paused at``."""
    lines, used = locals_lines(item, abs_file(review, str(item.get("file") or "")), line, values)
    return [*change_lines(item, line), *lines], used


def remove_breakpoint(review: Review, item: dict) -> bool:
    """Remove the breakpoint ``start`` set for a change item, as ``skip`` does, once its stop is recorded:
    a review whose items were all shown or skipped leaves none behind. False when there is none (a pause
    outside every item may sit on the person's own breakpoint) or the session does not answer."""
    if item.get("kind") != "change" or item.get("line") is None or review.data.get("ended"):
        return False
    try:
        live = connect(review)
        try:
            live.breakpoints(remove=[{"file": abs_file(review, str(item["file"])), "line": int(item["line"])}])
        finally:
            live.close()
    except AgentError:
        return False
    return True


__all__ = ["change_lines", "locals_lines", "names_on", "remove_breakpoint", "stop_context", "used_names", "value_rows"]
