"""Which value at the failing statement the exception is about: the odd-typed operand, the dict without the key, the short sequence."""

from __future__ import annotations

import ast
from typing import Any

from ..reprs import UNKNOWN, parse, path_text, project, text_of, type_of, type_of_value
from .need import Need


class PickMixin:
    """``OriginBuilder``'s way of reading values out of the failing statement."""

    def comprehension_targets(self, node: ast.AST) -> dict[str, ast.expr]:
        out: dict[str, ast.expr] = {}
        for n in ast.walk(node):
            if isinstance(n, ast.comprehension) and isinstance(n.target, ast.Name):
                out[n.target.id] = n.iter
        return out

    def evaluate(self, node: ast.expr, step: int, comp: dict[str, ast.expr], depth: int = 0) -> list[tuple[str, list, Any]]:
        """``(base name, path, value)`` for an access chain at ``step``; a comprehension's variable fans out over its iterable."""
        if depth > 6:
            return []
        if isinstance(node, ast.Name):
            if node.id in comp:
                out = []
                for base, path, value in self.evaluate(comp[node.id], step, comp, depth + 1):
                    if isinstance(value, (list, tuple)):
                        out.extend((base, path + [i], el) for i, el in enumerate(value))
                return out
            found = self.value(node.id, step)
            if found.get("text") is None or found.get("step") is None and type_of(found.get("text")) == "function":
                return []
            return [(node.id, [], parse(found["text"]))]
        if isinstance(node, ast.Subscript):
            k = self.key_of(node.slice, step)
            if k is UNKNOWN:
                return []
            return [(b, p + [k], project(v, [k])) for b, p, v in self.evaluate(node.value, step, comp, depth + 1)]
        return []

    def pick(self, step: int, need: Need | None, error_type: str) -> dict | None:
        """The bad value at the failing statement: ``{expr, base, path, text, chosen}``, or ``None``."""
        node = self.stmt(step)
        if node is None or need is None:
            return None
        comp = self.comprehension_targets(node)
        candidates: list[tuple[int, ast.expr, str, list, Any, str]] = []
        for n in ast.walk(node):
            if isinstance(n, ast.comprehension):
                continue
            if need.kind == "type" and isinstance(n, (ast.Name, ast.Subscript)):
                if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store):
                    continue
                for base, path, value in self.evaluate(n, step, comp):
                    if value is UNKNOWN:
                        continue
                    t = type_of_value(value)
                    if t == need.bad:
                        candidates.append((len(path), n, base, path, value, "the %s operand" % t if error_type == "TypeError" else "the %s" % t))
            if need.kind == "type" and need.attr and isinstance(n, ast.Attribute) and n.attr == need.attr:
                for base, path, value in self.evaluate(n.value, step, comp):
                    if type_of_value(value) == need.bad:
                        candidates.append((100 + len(path), n.value, base, path, value, "the %s whose .%s was read" % (need.bad, need.attr)))
            if need.kind == "key" and isinstance(n, ast.Subscript) and self.key_of(n.slice, step) == need.key:
                for base, path, value in self.evaluate(n.value, step, comp):
                    if isinstance(value, dict) and need.key not in value:
                        candidates.append((100 + len(path), n.value, base, path, value, "the dict without key %r" % (need.key,)))
            if need.kind == "index" and isinstance(n, ast.Subscript):
                k = self.key_of(n.slice, step)
                if isinstance(k, int) and not isinstance(k, bool):
                    for base, path, value in self.evaluate(n.value, step, comp):
                        if isinstance(value, (list, tuple, str)) and not -len(value) <= k < len(value):
                            need.index = k
                            candidates.append((100 + len(path), n.value, base, path, value, "the sequence of length %d read at index %d" % (len(value), k)))
        if not candidates:
            return None
        # attribute/key/index hits first, then the longest access path; the first element that fits the error in iteration order
        candidates.sort(key=lambda c: -c[0])
        _, n, base, path, value, chosen = candidates[0]
        text = text_of(value)
        if text is None:
            found = self.value(base, step)
            text = text_of(project(parse(found.get("text")), path)) if path else found.get("text")
        if need.kind == "type" and need.attr:
            expr = path_text(base, path) if path else self.seg(step, n)
        else:
            expr = path_text(base, path)
        return {"expr": expr, "base": base, "path": path, "text": text, "chosen": chosen, "source": self.seg(step, n)}


__all__ = ["PickMixin"]
