"""What a source file's statements *are*, for the walkthrough: decisions, loops, returns, qualified names.

Pure functions over source text (``ast``); nothing here reads a run. The host mirrors this in
``src/session/decisions.ts`` from indentation, and ``test/unit/fixtures/walkthrough-*`` pins
both to the same moments. Shapes:

- ``decisions``: by header line. ``if``/``elif`` (each is its own statement and its own step):
  ``{"kind": "if", "label": "if"|"elif", "line", "text": <condition>, "body": [first, last], "orelse":
  [first, last]}``, the body's line span (the next step landing in it means the condition took True)
  and the else arm's (an ``elif`` chain: its header through the end of the chain; ``[0, 0]`` without
  one; the execution graph's ``notRun`` reads it). ``match``:
  ``{"kind": "match", "line", "text": <subject>, "arms": [{"text": <pattern>, "body": [first, last]}]}``.
- ``loops``: by header line, ``{"kind": "for"|"while", "line", "text", "end"}``.
- ``returns``: the set of lines holding a ``return`` statement.
- ``qualnames``: by ``def`` line, ``Class.method`` (nested classes joined with dots).
"""

from __future__ import annotations

import ast
from typing import Any

_WORD_CUT = 60


def collapse(text: str, limit: int = _WORD_CUT) -> str:
    s = " ".join(text.split())
    return s if len(s) <= limit else s[: limit - 1] + "…"


def _segment(lines: list[str], node: ast.AST) -> str:
    """Source text of an expression node (``ast.get_source_segment`` needs the joined text; do it by hand)."""
    a, b = getattr(node, "lineno", 0), getattr(node, "end_lineno", 0)
    ca, cb = getattr(node, "col_offset", 0), getattr(node, "end_col_offset", 0)
    if not a or not b or a > len(lines):
        return ""
    if a == b:
        return lines[a - 1][ca:cb]
    parts = [lines[a - 1][ca:]] + lines[a : b - 1] + [lines[b - 1][:cb]]
    return " ".join(parts)


def _span(body: list[ast.stmt]) -> list[int]:
    """``[first, last]`` source lines of a block (``[0, 0]`` when empty)."""
    return [int(body[0].lineno), _end(body[-1])] if body else [0, 0]


def _end(node: ast.AST) -> int:
    return int(getattr(node, "end_lineno", getattr(node, "lineno", 0)) or 0)


class _Walker(ast.NodeVisitor):
    def __init__(self, lines: list[str]) -> None:
        self.lines = lines
        self.decisions: dict[int, dict] = {}
        self.loops: dict[int, dict] = {}
        self.returns: set[int] = set()
        self.qualnames: dict[int, str] = {}
        self.functions: dict[int, dict] = {}
        self._classes: list[str] = []

    # -- structure -------------------------------------------------------------------------------
    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self._classes.append(node.name)
        self.generic_visit(node)
        self._classes.pop()

    def _def(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        qual = ".".join(self._classes + [node.name])
        self.qualnames[int(node.lineno)] = qual
        self.functions[int(node.lineno)] = {"name": qual, "line": int(node.lineno), "end": _end(node)}
        self.generic_visit(node)

    visit_FunctionDef = _def  # type: ignore[assignment]
    visit_AsyncFunctionDef = _def  # type: ignore[assignment]

    def visit_Return(self, node: ast.Return) -> None:
        self.returns.add(int(node.lineno))
        self.generic_visit(node)

    # -- decisions --------------------------------------------------------------------------------
    def visit_If(self, node: ast.If) -> None:
        line = self.lines[node.lineno - 1] if node.lineno - 1 < len(self.lines) else ""
        label = "elif" if line[node.col_offset :].lstrip().startswith("elif") else "if"
        self.decisions[int(node.lineno)] = {"kind": "if", "label": label, "line": int(node.lineno), "text": collapse(_segment(self.lines, node.test)), "body": _span(node.body), "orelse": _span(node.orelse)}
        self.generic_visit(node)

    def visit_Match(self, node: ast.Match) -> None:
        arms = [{"text": collapse(_segment(self.lines, case.pattern)), "body": _span(case.body)} for case in node.cases]
        self.decisions[int(node.lineno)] = {"kind": "match", "line": int(node.lineno), "text": collapse(_segment(self.lines, node.subject)), "arms": arms}
        self.generic_visit(node)

    # -- loops -----------------------------------------------------------------------------------
    def _loop(self, node: ast.For | ast.AsyncFor | ast.While, kind: str, text: str) -> None:
        self.loops[int(node.lineno)] = {"kind": kind, "line": int(node.lineno), "text": collapse(text), "end": _end(node)}
        self.generic_visit(node)

    def visit_For(self, node: ast.For) -> None:
        self._loop(node, "for", "%s in %s" % (_segment(self.lines, node.target), _segment(self.lines, node.iter)))

    def visit_AsyncFor(self, node: ast.AsyncFor) -> None:
        self._loop(node, "for", "%s in %s" % (_segment(self.lines, node.target), _segment(self.lines, node.iter)))

    def visit_While(self, node: ast.While) -> None:
        self._loop(node, "while", _segment(self.lines, node.test))


def file_map(source: str) -> dict[str, Any]:
    """Decisions, loops, return lines, qualified names and function spans of ``source``; empty on a syntax error."""
    lines = source.split("\n")
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return {"decisions": {}, "loops": {}, "returns": set(), "qualnames": {}, "functions": {}}
    w = _Walker(lines)
    w.visit(tree)
    return {"decisions": w.decisions, "loops": w.loops, "returns": w.returns, "qualnames": w.qualnames, "functions": w.functions}


def enclosing_function(fmap: dict[str, Any], line: int) -> dict | None:
    """The innermost function whose span holds ``line`` (``None`` at module level)."""
    best: dict | None = None
    for fn in fmap["functions"].values():
        if fn["line"] <= line <= fn["end"] and (best is None or fn["end"] - fn["line"] <= best["end"] - best["line"]):
            best = fn
    return best


__all__ = ["file_map", "enclosing_function", "collapse"]
