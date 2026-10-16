"""Questions the walk asks a statement's syntax tree, with no recording involved."""

from __future__ import annotations

import ast

from ..reprs import parse, type_of


def is_mutation(node: ast.stmt, name: str) -> bool:
    """``name[k] = v``, ``name.x = v``, ``name[k] += v`` or ``name.append(v)``: the statement changes ``name`` in place."""
    targets: list[ast.expr] = []
    if isinstance(node, ast.Assign):
        targets = list(node.targets)
    elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
        targets = [node.target]
    elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Attribute):
        targets = [node.value.func]
    for t in targets:
        if isinstance(t, (ast.Subscript, ast.Attribute)) and base_name(t) == name:
            return True
    return False


def binds_name(node: ast.AST, name: str) -> bool:
    """The statement stores to ``name`` itself (an assignment, an unpacking, a loop or `with` target, a walrus)."""
    return any(isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store) and n.id == name for n in ast.walk(node))


def base_name(node: ast.expr) -> str | None:
    while isinstance(node, (ast.Subscript, ast.Attribute)):
        node = node.value
    return node.id if isinstance(node, ast.Name) else None


def names_in(node: ast.AST) -> list[str]:
    out: list[str] = []
    for n in ast.walk(node):
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and n.id not in out:
            out.append(n.id)
    return out


def is_literal(node: ast.expr) -> bool:
    try:
        ast.literal_eval(node)
        return True
    except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
        return isinstance(node, ast.JoinedStr)


def raw_string(text: str | None) -> str | None:
    """The characters of a recorded ``str`` text, for finding it in source."""
    if type_of(text) != "str":
        return None
    value = parse(text)
    return value if isinstance(value, str) and value else None


__all__ = ["is_mutation", "binds_name", "base_name", "names_in", "is_literal", "raw_string"]
