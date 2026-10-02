"""Source spans and attachment logic for statements, expressions, comments and markers.

A span is ``(startLine, startCol, endLine, endCol)`` with 1-based lines and
0-based columns, the ``ast`` convention. Compound statements get a *header*
span (``if x:`` rather than the whole block) so the gutter and the Time
Machine highlight the line that executes.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass, field
from typing import Iterable

Span = tuple[int, int, int, int]

COMPOUND = (
    ast.FunctionDef,
    ast.AsyncFunctionDef,
    ast.ClassDef,
    ast.If,
    ast.For,
    ast.AsyncFor,
    ast.While,
    ast.With,
    ast.AsyncWith,
    ast.Try,
    getattr(ast, "TryStar", ast.Try),
    ast.Match,
)
BODY_FIELDS = ("body", "orelse", "finalbody", "handlers", "cases")
_KEYWORD_LEN = {
    ast.FunctionDef: 3,
    ast.AsyncFunctionDef: 9,
    ast.ClassDef: 5,
    ast.If: 2,
    ast.For: 3,
    ast.AsyncFor: 9,
    ast.While: 5,
    ast.With: 4,
    ast.AsyncWith: 10,
    ast.Try: 3,
    getattr(ast, "TryStar", ast.Try): 3,
    ast.Match: 5,
}


def has_pos(node: ast.AST) -> bool:
    return getattr(node, "lineno", None) is not None and getattr(node, "end_lineno", None) is not None


def full_span(node: ast.AST) -> Span:
    return (node.lineno, node.col_offset, node.end_lineno, node.end_col_offset)  # type: ignore[attr-defined]


def _end(node: ast.AST) -> tuple[int, int]:
    return (node.end_lineno, node.end_col_offset)  # type: ignore[attr-defined]


def header_end(stmt: ast.stmt) -> tuple[int, int]:
    """End position of a compound statement's header (the part before the colon)."""
    parts: list[ast.AST] = []
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
        a = stmt.args
        parts.extend(a.posonlyargs + a.args + a.kwonlyargs + a.defaults + [d for d in a.kw_defaults if d])
        if a.vararg:
            parts.append(a.vararg)
        if a.kwarg:
            parts.append(a.kwarg)
        if stmt.returns:
            parts.append(stmt.returns)
        parts.extend(getattr(stmt, "type_params", []) or [])
    elif isinstance(stmt, ast.ClassDef):
        parts.extend(stmt.bases)
        parts.extend(stmt.keywords)
        parts.extend(getattr(stmt, "type_params", []) or [])
    elif isinstance(stmt, (ast.If, ast.While)):
        parts.append(stmt.test)
    elif isinstance(stmt, (ast.For, ast.AsyncFor)):
        parts.append(stmt.iter)
    elif isinstance(stmt, (ast.With, ast.AsyncWith)):
        for item in stmt.items:
            parts.append(item.optional_vars or item.context_expr)
    elif isinstance(stmt, ast.Match):
        parts.append(stmt.subject)
    best: tuple[int, int] | None = None
    for p in parts:
        if has_pos(p):
            e = _end(p)
            if best is None or e > best:
                best = e
    if best is not None:
        return best
    extra = 0
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        extra = 1 + len(stmt.name)
    return (stmt.lineno, stmt.col_offset + _KEYWORD_LEN.get(type(stmt), 2) + extra)


def node_span(node: ast.AST) -> Span:
    """The span a range id is keyed by: header span for compound statements, full span otherwise."""
    if isinstance(node, COMPOUND):
        el, ec = header_end(node)
        return (node.lineno, node.col_offset, el, ec)
    return full_span(node)


def module_span(source: str) -> Span:
    lines = source.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    if not lines:
        return (1, 0, 1, 0)
    return (1, 0, len(lines), len(lines[-1]))


def is_docstring(stmt: ast.stmt, index: int) -> bool:
    return (
        index == 0
        and isinstance(stmt, ast.Expr)
        and isinstance(stmt.value, ast.Constant)
        and isinstance(stmt.value.value, str)
    )


def is_future_import(stmt: ast.stmt) -> bool:
    return isinstance(stmt, ast.ImportFrom) and stmt.module == "__future__"


def contains(outer: Span, inner: Span) -> bool:
    return (outer[0], outer[1]) <= (inner[0], inner[1]) and (outer[2], outer[3]) >= (inner[2], inner[3])


def span_size(s: Span) -> tuple[int, int]:
    return (s[2] - s[0], s[3] - s[1] if s[2] == s[0] else s[3] + 10_000)


@dataclass
class Candidates:
    """Statements and value-position expressions eligible for logging."""

    stmts: list[ast.stmt] = field(default_factory=list)
    exprs: list[ast.expr] = field(default_factory=list)
    excluded: set[int] = field(default_factory=set)

    def stmt_ok(self, s: ast.stmt) -> bool:
        return id(s) not in self.excluded and has_pos(s)


def _exclude_subtree(node: ast.AST | None, excluded: set[int]) -> None:
    if node is None:
        return
    for sub in ast.walk(node):
        excluded.add(id(sub))


def collect_candidates(tree: ast.AST) -> Candidates:
    c = Candidates()
    # Subtrees whose expressions must never be rewritten.
    for node in ast.walk(tree):
        if isinstance(node, ast.arg):
            _exclude_subtree(node.annotation, c.excluded)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            _exclude_subtree(node.returns, c.excluded)
            for tp in getattr(node, "type_params", []) or []:
                _exclude_subtree(tp, c.excluded)
        elif isinstance(node, ast.ClassDef):
            for tp in getattr(node, "type_params", []) or []:
                _exclude_subtree(tp, c.excluded)
        elif isinstance(node, ast.AnnAssign):
            _exclude_subtree(node.annotation, c.excluded)
        elif isinstance(node, ast.match_case):
            _exclude_subtree(node.pattern, c.excluded)
        elif type(node).__name__ == "TypeAlias":
            _exclude_subtree(node, c.excluded)
    # Docstrings and __future__ imports are statements we never hook or wrap.
    for node in ast.walk(tree):
        body = getattr(node, "body", None)
        if isinstance(body, list) and body and isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            if is_docstring(body[0], 0):
                _exclude_subtree(body[0], c.excluded)
            for s in body:
                if isinstance(s, ast.stmt) and is_future_import(s):
                    _exclude_subtree(s, c.excluded)
    for node in ast.walk(tree):
        if id(node) in c.excluded or not has_pos(node):
            continue
        if isinstance(node, ast.stmt):
            c.stmts.append(node)
        elif isinstance(node, ast.expr):
            if isinstance(node, (ast.Slice, ast.Starred)):
                continue
            ctx = getattr(node, "ctx", None)
            if ctx is not None and not isinstance(ctx, ast.Load):
                continue
            c.exprs.append(node)
    return c


def innermost(stmts: Iterable[ast.stmt]) -> ast.stmt | None:
    best = None
    for s in stmts:
        if best is None or (s.lineno, s.col_offset) > (best.lineno, best.col_offset):
            best = s
    return best


def header_covers(stmt: ast.stmt, line: int) -> bool:
    """True when ``line`` is on the executing part of ``stmt`` (header for compound statements)."""
    if isinstance(stmt, COMPOUND):
        return stmt.lineno <= line <= header_end(stmt)[0]
    return stmt.lineno <= line <= stmt.end_lineno  # type: ignore[operator]


def statement_at_line(c: Candidates, line: int) -> ast.stmt | None:
    """Innermost statement whose executing part covers ``line``."""
    starting = [s for s in c.stmts if s.lineno == line]
    if starting:
        return innermost(starting)
    covering = [s for s in c.stmts if header_covers(s, line)]
    return innermost(covering)


def attach_to_line(c: Candidates, line: int) -> tuple[str, ast.AST] | None:
    """Containment attachment for a trailing comment on ``line``.

    1. innermost statement ending on the line;
    2. else innermost compound statement whose header covers the line;
    3. else the largest expression ending on the line (mid-chain logging).
    """
    ending = [s for s in c.stmts if s.end_lineno == line and not isinstance(s, COMPOUND)]
    if ending:
        return ("stmt", innermost(ending))
    heads = [s for s in c.stmts if isinstance(s, COMPOUND) and header_covers(s, line)]
    if heads:
        return ("stmt", innermost(heads))
    exprs = [e for e in c.exprs if e.end_lineno == line]
    if exprs:
        best = None
        for e in exprs:
            if best is None or (e.lineno, e.col_offset) < (best.lineno, best.col_offset) or (
                (e.lineno, e.col_offset) == (best.lineno, best.col_offset) and _end(e) > _end(best)
            ):
                best = e
        return ("expr", best)
    return None


def find_covering(c: Candidates, rng: Span) -> tuple[str, ast.AST] | None:
    """Smallest expression (else statement) whose span contains ``rng``; exact matches win."""
    best: ast.expr | None = None
    best_span: Span | None = None
    for e in c.exprs:
        s = full_span(e)
        if s == rng:
            return ("expr", e)
        if contains(s, rng) and (best_span is None or contains(best_span, s)):
            best, best_span = e, s
    if best is not None:
        return ("expr", best)
    stmt_best = None
    for st in c.stmts:
        s = full_span(st)
        if contains(s, rng) and (stmt_best is None or contains(full_span(stmt_best), s)):
            stmt_best = st
    if stmt_best is not None:
        return ("stmt", stmt_best)
    return None


def load_copy(target: ast.expr) -> ast.expr:
    """Re-parse a Store-context target (``a, b[i].c``) as a Load expression."""
    text = ast.unparse(target)
    node = ast.parse(text, mode="eval").body
    for sub in ast.walk(node):
        ast.copy_location(sub, target)
    return node


def bound_names(stmt: ast.Import | ast.ImportFrom) -> list[str]:
    names = []
    for alias in stmt.names:
        if alias.name == "*":
            continue
        names.append(alias.asname or alias.name.split(".")[0])
    return names
