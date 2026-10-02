"""Completions for a watch expression, from the live namespace: names in scope for a bare
prefix, attributes after a dot.

``complete(text, globals_, locals_)`` takes the expression up to the cursor. The trailing
identifier is the prefix being typed. When what precedes it ends with a dot, the balanced
expression before that dot (``payload``, ``rows[0]``, ``self.items``, ``sorted(keys)``) is
evaluated under the same rule as ``evaluate`` (``pure.py``: no call to a user function, no
lambda) and its attributes are listed; otherwise locals, then globals, then builtins and the
constant keywords.
Attribute kinds come from ``inspect.getattr_static``, so a property is never run while
completing, only when the finished expression is evaluated.

The reply is ``{"prefix": <typed prefix>, "items": [{"label", "kind", "type"?}]}``; an object
that cannot be evaluated gives no items and an ``error`` line instead of failing the request.
Underscored names are listed only once the prefix starts with an underscore.
"""

from __future__ import annotations

import ast
import builtins
import inspect
import keyword
import re
import types
from typing import Any

from .pure import eval_pure

_PREFIX = re.compile(r"[A-Za-z_][A-Za-z0-9_]*$")
_CLOSERS = {")": "(", "]": "[", "}": "{"}
KINDS = ("variable", "attribute", "function", "method", "property", "class", "module", "builtin", "keyword")
_KEYWORDS = ("None", "True", "False", "and", "or", "not", "in", "is", "if", "else")
_PROPERTY_TYPES = ("member_descriptor", "getset_descriptor", "cached_property")


def split_expression(text: str) -> tuple[str | None, str]:
    """``(object expression or None, prefix)``: ``"payload.it"`` -> ``("payload", "it")``, ``"tot"`` -> ``(None, "tot")``."""
    m = _PREFIX.search(text)
    prefix = m.group(0) if m else ""
    head = text[: len(text) - len(prefix)]
    if not head.endswith("."):
        return None, prefix
    head = head[:-1]
    # the balanced expression that ends at the dot: identifiers, dots, and bracketed groups
    i = len(head)
    depth: list[str] = []
    while i > 0:
        ch = head[i - 1]
        if ch in _CLOSERS:
            depth.append(_CLOSERS[ch])
        elif ch in "([{":
            if not depth or depth[-1] != ch:
                break
            depth.pop()
        elif not depth and not (ch.isalnum() or ch in "_."):
            break
        i -= 1
    obj = head[i:].strip()
    if not obj or depth or obj.endswith(".") or obj.startswith("."):
        return None, prefix
    return obj, prefix


def _matches(name: str, prefix: str) -> bool:
    return name.startswith(prefix) and (not name.startswith("_") or prefix.startswith("_"))


def _type_name(value: Any) -> str | None:
    try:
        return type(value).__name__
    except Exception:  # noqa: BLE001
        return None


def _item(label: str, kind: str, type_name: str | None = None) -> dict:
    out: dict[str, Any] = {"label": label, "kind": kind}
    if type_name:
        out["type"] = type_name
    return out


def _attribute_item(owner: Any, name: str) -> dict | None:
    """One attribute of ``owner`` classified without running descriptors."""
    try:
        static = inspect.getattr_static(owner, name)
    except Exception:  # noqa: BLE001
        return None
    if isinstance(static, property) or type(static).__name__ in _PROPERTY_TYPES:
        return _item(name, "property")
    if isinstance(static, (staticmethod, classmethod)) or inspect.isroutine(static):
        return _item(name, "function" if isinstance(owner, types.ModuleType) else "method")
    if isinstance(static, type):
        return _item(name, "class")
    if isinstance(static, types.ModuleType):
        return _item(name, "module")
    return _item(name, "attribute", _type_name(static))


def _name_item(name: str, value: Any, default_kind: str) -> dict:
    if isinstance(value, type):
        return _item(name, "class")
    if isinstance(value, types.ModuleType):
        return _item(name, "module")
    if default_kind == "builtin":
        return _item(name, "builtin")
    if inspect.isroutine(value):
        return _item(name, "function")
    return _item(name, default_kind, _type_name(value))


def _names(namespace: dict, prefix: str, default_kind: str, seen: set[str], out: list[dict], limit: int) -> None:
    for name in sorted(k for k in namespace if isinstance(k, str)):
        if len(out) >= limit:
            return
        if name in seen or name.startswith("_pk_") or not _matches(name, prefix):
            continue
        if default_kind == "builtin" and keyword.iskeyword(name):
            continue  # None, True, False: listed as keywords below
        seen.add(name)
        out.append(_name_item(name, namespace[name], default_kind))


def complete(text: str, globals_: dict, locals_: dict | None = None, limit: int = 100) -> dict:
    """Completions for the expression ``text`` (the part before the cursor) in the given namespaces."""
    obj, prefix = split_expression(text)
    out: list[dict] = []
    if obj is not None:
        try:
            tree = ast.parse(obj, mode="eval")
            value = eval_pure(tree.body, globals_, locals_, "<pyokka-complete>")
            names = sorted(set(dir(value)))
        except Exception as exc:  # noqa: BLE001
            return {"prefix": prefix, "items": [], "error": "%s: %s" % (type(exc).__name__, exc)}
        for name in names:
            if len(out) >= limit:
                break
            if not _matches(name, prefix):
                continue
            item = _attribute_item(value, name)
            if item is not None:
                out.append(item)
        return {"prefix": prefix, "items": out}
    seen: set[str] = set()
    if locals_ is not None and locals_ is not globals_:
        _names(locals_, prefix, "variable", seen, out, limit)
    _names(globals_, prefix, "variable", seen, out, limit)
    _names(vars(builtins), prefix, "builtin", seen, out, limit)
    if prefix:
        for name in _KEYWORDS:
            if len(out) >= limit:
                break
            if name not in seen and name.startswith(prefix):
                seen.add(name)
                out.append(_item(name, "keyword"))
    return {"prefix": prefix, "items": out}
