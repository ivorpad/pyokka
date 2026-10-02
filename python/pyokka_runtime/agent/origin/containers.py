"""Where an element came from when its container is not followed further back.

The recording keeps a value's text, not its identity, so this is a match by key and text over the
statements that insert into containers (``append``, ``x[k] = v``, ``{"k": v}``, ``setdefault``);
every link it makes is marked ``inferred``.
"""

from __future__ import annotations

import ast
from typing import Any

from ..reprs import path_text

_APPENDERS = ("append", "add", "appendleft", "insert")


class ContainerMixin:
    """``OriginBuilder``'s element search."""

    def inserts(self, step: int) -> list[tuple[str, Any, ast.expr]]:
        """``(kind, key, value node)`` for each place the statement at ``step`` puts a value into a container."""
        rid = self.trace.rid(step)
        if rid in self._inserts:
            return self._inserts[rid]
        node = self.stmt(step)
        out: list[tuple[str, Any, ast.expr]] = []
        if node is not None and not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            for n in ast.walk(node):
                if isinstance(n, ast.Dict):
                    for k, v in zip(n.keys, n.values):
                        if isinstance(k, ast.Constant):
                            out.append(("key", k.value, v))
                elif isinstance(n, ast.Assign):
                    for t in n.targets:
                        if isinstance(t, ast.Subscript):
                            out.append(("key", t.slice, n.value))
                elif isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute):
                    if n.func.attr in _APPENDERS and n.args:
                        out.append(("item", None, n.args[-1]))
                    elif n.func.attr == "setdefault" and len(n.args) == 2 and isinstance(n.args[0], ast.Constant):
                        out.append(("key", n.args[0].value, n.args[1]))
        self._inserts[rid] = out
        return out

    def element_search(self, path: list, before: int, carried: str | None) -> None:
        """The container the value sat in is not followed further back: find the statement that put a value with this key and text into one."""
        key = next((k for k in reversed(path) if isinstance(k, str)), None)
        tail = path[path.index(key) + 1:] if key is not None else []
        if carried is None:
            self.end = "the value sits at %s in a container the recording does not follow further" % path_text("…", path)
            return
        found: list[tuple[int, ast.expr]] = []
        for j in range(min(before, self.trace.count) - 1, -1, -1):
            for kind, k, v in self.inserts(j):
                if key is not None:
                    if kind != "key":
                        continue
                    kv = k if not isinstance(k, ast.AST) else self.key_of(k, j)
                    if kv != key:
                        continue
                elif kind != "item":
                    continue
                text = self.simple_text(v, tail, j)
                if text == carried:
                    found.append((j, v))
        if not found:
            where = "under key %r" % key if key is not None else "as an element"
            self.end = "no statement before #%d put this value %s with the same text; the container was probably filled in place after it was made, which the recording does not tie to a statement" % (before, where)
            return
        j, v = found[0]
        where = 'under key %r' % key if key is not None else "as an element"
        note = "put %s here; matched by key and value text, the recording has no object identity" % where
        if len(found) > 1:
            note += "; %d statements put the same text there, the latest is shown" % len(found)
        if self.add(j, self.seg(j, v), carried, "element", "inferred", note=note) is None:
            return
        self.follow_expr(v, tail, j, carried)


__all__ = ["ContainerMixin"]
