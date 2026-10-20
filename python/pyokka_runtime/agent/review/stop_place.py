"""Where a stop of the review in the debugger pauses: on what the changed lines decide, not on their first assignment.

``breakable_line`` gives the first statement of a changed span, and a stop there often lands on ``total = 0``,
where the only thing to say is the value. ``stop_line`` looks through every changed span of the function for a
statement that decides something (an ``if``, a ``while``, a ``match``, a ``return``, a ``raise``, an ``assert``,
or a value made by a comparison or a boolean test), else a ``for`` loop or a call into code other than a builtin,
and pauses at the first of the best kind. A candidate counts only when the program reaches it whenever it reaches the first
statement: no branch, loop body, ``except`` or ``case`` holds the candidate without also holding that statement.
With no candidate the stop stays where ``breakable_line`` put it.
"""

from __future__ import annotations

import ast
import builtins
from typing import Sequence

from .syntax import FUNCTION_NODES, parsed

#: statements where the program decides, leaves or checks something: a stop there has a reason to give
DECIDES = (ast.If, ast.While, ast.Match, ast.Return, ast.Raise, ast.Assert)
#: a ``for`` header shows what the loop will walk, which is worth less than a decision and more than an assignment
LOOPS = (ast.For, ast.AsyncFor)
#: the parts of a block that may run zero times or on one path only; a ``try`` or ``with`` body and a ``finally`` run
CONDITIONAL: dict[type, tuple[str, ...]] = {ast.If: ("body", "orelse"), ast.For: ("body", "orelse"), ast.AsyncFor: ("body", "orelse"),
                                            ast.While: ("body", "orelse"), ast.Match: ("cases",), ast.Try: ("handlers", "orelse")}
if hasattr(ast, "TryStar"):
    CONDITIONAL[ast.TryStar] = ("handlers", "orelse")
#: a nested scope runs at another time than the function around it
SCOPES = (*FUNCTION_NODES, ast.ClassDef, ast.Lambda)
BUILTINS = frozenset(dir(builtins))


def rank(node: ast.stmt) -> int:
    """0 for a statement that decides, 1 for a ``for`` loop or one that calls code other than a builtin, 2 for anything else."""
    if isinstance(node, DECIDES):
        return 0
    if isinstance(node, LOOPS):
        return 1
    value = getattr(node, "value", None) if isinstance(node, (ast.Assign, ast.AugAssign, ast.AnnAssign, ast.Expr)) else None
    if value is None:
        return 2
    calls = False
    for sub in ast.walk(value):
        if isinstance(sub, (ast.Compare, ast.BoolOp, ast.IfExp)) or isinstance(sub, ast.UnaryOp) and isinstance(sub.op, ast.Not):
            return 0
        if isinstance(sub, ast.Call) and not (isinstance(sub.func, ast.Name) and sub.func.id in BUILTINS):
            calls = True
    return 1 if calls else 2


def _held(function: ast.AST) -> dict[int, frozenset[int]]:
    """``id(statement)`` to the ids of the blocks whose conditional parts hold it, for each statement of ``function``'s own
    body (not of a nested ``def``, ``class`` or ``lambda``)."""
    out: dict[int, frozenset[int]] = {}

    def visit(node: ast.AST, held: frozenset[int]) -> None:
        conditional = CONDITIONAL.get(type(node), ())
        for field, value in ast.iter_fields(node):
            inner = held | {id(node)} if field in conditional else held
            for child in value if isinstance(value, list) else [value]:
                if not isinstance(child, ast.AST) or isinstance(child, SCOPES):
                    continue
                if isinstance(child, ast.stmt):
                    out[id(child)] = inner
                visit(child, inner)

    for statement in getattr(function, "body", []):
        out[id(statement)] = frozenset()
        if not isinstance(statement, SCOPES):
            visit(statement, frozenset())
    return out


def stop_line(source: str, spans: Sequence[tuple[int, int]], first_line: int) -> int:
    """The line a stop on ``spans`` (one function's changed spans, in order) pauses at; ``first_line`` is
    ``breakable_line``'s answer for the first span, kept when nothing better is reached as surely."""
    p = parsed(source)
    if p is None:
        return first_line
    around = [f for f in p.functions if f.lineno <= first_line <= (f.end_lineno or f.lineno)]
    if not around:
        return first_line
    function = max(around, key=lambda f: f.lineno)  # the innermost, as function_at names it
    held = _held(function)
    first = next((n for n in p.statements if n.lineno == first_line and id(n) in held), None)
    if first is None:
        return first_line
    best, best_rank = first_line, rank(first)
    for node in p.statements:
        if id(node) not in held or node.lineno <= first_line or not held[id(node)] <= held[id(first)]:
            continue
        if not any(lo <= node.lineno <= hi for lo, hi in spans):
            continue
        r = rank(node)
        if r < best_rank:
            best, best_rank = node.lineno, r
    return best if best_rank < 2 else first_line


__all__ = ["DECIDES", "rank", "stop_line"]
