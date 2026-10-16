"""Why ``pyokka origin RUN STEP EXPR`` has no value for EXPR: the name, or the step of its path the recording does not show."""

from __future__ import annotations

import ast
from typing import Any

from ..reprs import UNKNOWN, Attr, Record, _Opaque, parse, path_text, project, type_of_value

HINT = 'give a name the statement read, or a subscript or attribute of one (items[0]["price"], line.unit_price)'


def chain_of(builder: Any, tree: ast.expr | None, step: int) -> tuple[str, list] | None:
    """``(base, path)`` of an access chain (``a.b[0].c``); None for anything else."""
    keys: list = []
    cur = tree
    while isinstance(cur, (ast.Subscript, ast.Attribute)):
        if isinstance(cur, ast.Attribute):
            keys.insert(0, Attr(cur.attr))
        else:
            k = builder.key_of(cur.slice, step)
            if k is UNKNOWN:
                return None
            keys.insert(0, k)
        cur = cur.value
    return (cur.id, keys) if isinstance(cur, ast.Name) else None


def explain_missing(builder: Any, tree: ast.expr | None, expr: str, step: int) -> str:
    """The ``end`` text when EXPR has no value at ``step``: which part of it the recording lacks, and what would have it."""
    chain = chain_of(builder, tree, step)
    if chain is None:
        return "%s has no recorded value at #%d; %s" % (expr, step, HINT)
    base, path = chain
    found = builder.value(base, step)
    if found.get("text") is None:
        return "%s has no recorded value at #%d; %s" % (base, step, HINT)
    value = parse(found["text"])
    cut = "…(+" in str(found["text"])
    for i, key in enumerate(path):
        here = path_text(base, path[:i])
        nxt = project(value, [key])
        if nxt is not UNKNOWN:
            value = nxt
            continue
        if value is UNKNOWN or (cut and isinstance(value, Record) and isinstance(key, Attr)):
            return "the recording cut %s at maxValueChars before %s was whole; record again with --max-value-chars 0 to keep it" % (here, path_text(here, [key]))
        if isinstance(key, Attr):
            if isinstance(value, _Opaque):
                return "%s is recorded as <%s object>, a repr that prints no fields, so .%s is not in the recording; a dataclass, a namedtuple or a __repr__ that prints the field would be" % (here, value.type, key.name)
            if isinstance(value, Record):
                return "%s is recorded as %s(…) without a field %s" % (here, value.type, key.name)
            if isinstance(value, dict):
                return '%s is a dict at #%d, so .%s reads no attribute; its key is %s["%s"]' % (here, step, key.name, here, key.name)
            return "%s is a %s at #%d, whose attributes the recording does not print" % (here, type_of_value(value), step)
        if isinstance(value, Record):
            return "%s is a %s at #%d, not a container; its fields read as %s.%s" % (here, type_of_value(value), step, here, next(iter(value.fields), "field"))
        if isinstance(value, dict):
            keys = ", ".join(repr(k) for k in list(value)[:8])
            return "%s has no key %r at #%d%s" % (here, key, step, "; its keys: %s" % keys if keys else "")
        if isinstance(value, (list, tuple, str)) and isinstance(key, int):
            return "%s is a %s of length %d at #%d, so [%d] is past its end" % (here, type_of_value(value), len(value), step, key)
        return "%s is a %s at #%d, not a container that %s indexes" % (here, type_of_value(value) or "value", step, path_text("", [key]))
    return "%s has no recorded value at #%d; %s" % (expr, step, HINT)


__all__ = ["chain_of", "explain_missing", "HINT"]
