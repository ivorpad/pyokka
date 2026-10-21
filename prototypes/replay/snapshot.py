"""A whole value, copied at the moment a replay watch is evaluated.

The recorder keeps a local as 120 characters of repr, three levels deep. A replay has the real
object in hand, so it copies all of it into plain JSON: every key, every item, every level, up
to limits that only exist so one value cannot fill the disk. Nothing here calls the program's
code: containers are read through the built-in types' own methods and objects through their
``__dict__``, so a ``__repr__`` or a property of the program never runs during the copy.
"""

from __future__ import annotations

import collections
import enum
import math
import types
from typing import Any

from pyokka_runtime import secrets

MAX_DEPTH = 40
MAX_ITEMS = 10_000
MAX_CHARS = 1_000_000
MASK = "••••••••"

# (base type, how it iterates, brackets) for the containers copied item by item
_SEQUENCES: tuple[tuple[type, str, str], ...] = (
    (list, "[", "]"),
    (tuple, "(", ")"),
    (set, "{", "}"),
    (frozenset, "frozenset({", "})"),
    (collections.deque, "deque([", "])"),
)
# types whose repr is C code or the standard library's: safe to call, and the clearest text for them
_REPR_MODULES = ("builtins", "datetime", "decimal", "fractions", "uuid", "pathlib", "ipaddress", "enum")


def snapshot(value: Any, name: Any = None) -> dict:
    """``value`` as a JSON tree. ``kind`` is ``leaf``, ``map``, ``seq`` or ``obj``."""
    return _copy(value, name, 0, ())


def _copy(value: Any, name: Any, depth: int, path: tuple[int, ...]) -> dict:
    kind = type(value)
    tname = kind.__name__
    if value is None or kind in (bool, int):
        return {"kind": "leaf", "type": tname, "value": value}
    if kind is float:
        return {"kind": "leaf", "type": tname, "value": value if math.isfinite(value) else repr(value)}
    if isinstance(value, str):
        text = MASK if secrets.current.secret_name(name) else secrets.current.scrub(str.__str__(value))
        out: dict[str, Any] = {"kind": "leaf", "type": tname, "value": text[:MAX_CHARS]}
        if len(text) > MAX_CHARS:
            out["cut"] = len(text)
        return out
    if isinstance(value, (bytes, bytearray)):
        text = repr(MASK.encode()) if secrets.current.secret_name(name) else repr(bytes(value[:MAX_CHARS]))
        return {"kind": "leaf", "type": tname, "repr": text, **({"cut": len(value)} if len(value) > MAX_CHARS else {})}
    if id(value) in path:
        return {"kind": "leaf", "type": tname, "repr": "<cycle>"}
    if depth >= MAX_DEPTH:
        return {"kind": "leaf", "type": tname, "repr": "…"}
    inner = path + (id(value),)
    if isinstance(value, dict):
        items = []
        for i, (k, v) in enumerate(dict.items(value)):
            if i >= MAX_ITEMS:
                break
            items.append([_copy(k, None, depth + 1, inner), _copy(v, k, depth + 1, inner)])
        return {"kind": "map", "type": tname, "items": items, "length": len(value)}
    for base, open_, close in _SEQUENCES:
        if isinstance(value, base):
            items = []
            for i, v in enumerate(base.__iter__(value)):
                if i >= MAX_ITEMS:
                    break
                items.append(_copy(v, None, depth + 1, inner))
            return {"kind": "seq", "type": tname, "open": open_, "close": close, "items": items, "length": len(value)}
    if isinstance(value, (types.FunctionType, types.BuiltinFunctionType, types.MethodType, type, types.ModuleType)):
        label = getattr(value, "__qualname__", None) or getattr(value, "__name__", None) or tname
        return {"kind": "leaf", "type": tname, "repr": "<%s %s>" % (tname, label)}
    if kind.__module__ in _REPR_MODULES or isinstance(value, (int, float, complex, enum.Enum)):
        return {"kind": "leaf", "type": tname, "repr": secrets.current.scrub(repr(value))[:MAX_CHARS]}
    try:
        attrs = object.__getattribute__(value, "__dict__")
    except AttributeError:
        return {"kind": "leaf", "type": tname, "repr": "<%s object>" % tname}
    fields = {}
    for i, (k, v) in enumerate(dict.items(attrs)):
        if i >= MAX_ITEMS:
            break
        fields[str(k)] = _copy(v, k, depth + 1, inner)
    return {"kind": "obj", "type": tname, "attrs": fields}


def render(node: dict, width: int = 100, indent: int = 0, used: int | None = None) -> str:
    """The tree as Python-like text: one line when it fits in ``width``, else one item per line.

    ``indent`` is where this value's own lines start; ``used`` is how much of the current line
    the label in front of it already took.
    """
    flat = _flat(node)
    children = _children(node)
    if len(flat) + (indent if used is None else used) <= width or not children:
        return flat
    pad = " " * (indent + 4)
    open_, close = _brackets(node)
    lines = [open_]
    for label, child in children:
        lines.append(pad + label + render(child, width, indent + 4, indent + 4 + len(label)) + ",")
    more = node.get("length", len(children)) - len(children)
    if more > 0:
        lines.append(pad + "… %d more" % more)
    lines.append(" " * indent + close)
    return "\n".join(lines)


def _brackets(node: dict) -> tuple[str, str]:
    if node["kind"] == "obj":
        return node["type"] + "(", ")"
    if node["kind"] == "map":
        return ("{", "}") if node["type"] == "dict" else (node["type"] + "({", "})")
    return node["open"], node["close"]


def _children(node: dict) -> list[tuple[str, dict]]:
    if node["kind"] == "obj":
        return [(k + "=", v) for k, v in node["attrs"].items()]
    if node["kind"] == "map":
        return [(_flat(k) + ": ", v) for k, v in node["items"]]
    if node["kind"] == "seq":
        return [("", v) for v in node["items"]]
    return []


def _flat(node: dict) -> str:
    if node["kind"] == "leaf":
        if "repr" in node:
            return node["repr"]
        v = node["value"]
        return v if node["type"] == "float" and isinstance(v, str) else repr(v)
    if node["kind"] == "seq" and node["type"] == "set" and not node["items"]:
        return "set()"
    open_, close = _brackets(node)
    parts = [label + _flat(child) for label, child in _children(node)]
    more = node.get("length", len(parts)) - len(parts)
    if more > 0:
        parts.append("… %d more" % more)
    if node["kind"] == "seq" and node["type"] == "tuple" and len(parts) == 1:
        parts[0] += ","
    return open_ + ", ".join(parts) + close
