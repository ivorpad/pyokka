"""A source parsed once for the plan: its tree, its statements in line order and its functions.

``plan_items`` asks ``breakable_line`` about each changed span of a file in turn, and every call parsed the whole
file again, sorted its statements and walked it for the function around the line; ``edges`` walked a changed file's
whole tree once per node on a changed line to name the node's function. On a langchain range (2026-10-19: 7410
changed lines in 66 Python files, 397 spans, 7682 nodes) those walks were 17 of the 20 seconds ``review start`` spent
before VS Code launched. Here a source is parsed once and its functions are listed once; the answers are the ones
the walks gave.
"""

from __future__ import annotations

import ast
import functools
from typing import NamedTuple, Sequence

FUNCTION_NODES = (ast.FunctionDef, ast.AsyncFunctionDef)


class Parsed(NamedTuple):
    """A parsed source: the tree, every statement by line (the outer of two that start on one line first), and every
    function in ``ast.walk`` order."""

    tree: ast.Module
    statements: tuple[ast.stmt, ...]
    functions: tuple[ast.FunctionDef | ast.AsyncFunctionDef, ...]


def functions(tree: ast.AST) -> tuple[ast.FunctionDef | ast.AsyncFunctionDef, ...]:
    """Every ``def`` and ``async def`` in ``tree``, in ``ast.walk`` order."""
    return tuple(n for n in ast.walk(tree) if isinstance(n, FUNCTION_NODES))


def function_at(funcs: Sequence[ast.FunctionDef | ast.AsyncFunctionDef], line: int) -> str | None:
    """The name of the innermost function around ``line``; None at module level.

    Of the functions whose lines hold ``line``, the one that starts last, and on a tie the first in walk order: the
    rule the walk per node applied, so a nested ``def`` names itself and the lines after it name the one around it.
    """
    best: ast.FunctionDef | ast.AsyncFunctionDef | None = None
    for f in funcs:
        if f.lineno <= line <= (f.end_lineno or f.lineno) and (best is None or f.lineno > best.lineno):
            best = f
    return best.name if best is not None else None


@functools.lru_cache(maxsize=2)
def parsed(source: str) -> Parsed | None:
    """``source`` parsed, or None when it does not parse.

    Two entries are enough, since ``plan_items`` asks about one file's spans in a row; the MCP server lives on between
    reviews, and the tree of a large file holds 7 to 8 MB (langchain's ``runnables/base.py``, 6,729 lines).
    """
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return None
    statements = sorted((n for n in ast.walk(tree) if isinstance(n, ast.stmt)), key=lambda n: (n.lineno, -(n.end_lineno or n.lineno)))
    return Parsed(tree, tuple(statements), functions(tree))


__all__ = ["FUNCTION_NODES", "Parsed", "function_at", "functions", "parsed"]
