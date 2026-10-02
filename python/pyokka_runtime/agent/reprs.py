"""Reading a recorded value back from its text: the type it names and, when it is a literal, the value.

A recording keeps values as ``repr`` text, cut to a budget (``'abc…'…(+69 chars)``, ``[{...}, {...}]``
for a level the serializer did not open, ``<Foo object at 0x…>`` for an object). ``pyokka origin``
needs two things from that text: the type, so it can say where a value's type stops fitting, and
the elements, so it can follow ``items[0]["unit_price"]`` into a list of dicts. Both are best
effort: a cut text parses up to the cut, and what did not parse is ``UNKNOWN``.
"""

from __future__ import annotations

import ast
import re
import warnings
from typing import Any

_CUT = re.compile(r"…\(\+\d+ chars\)$")
_NUMBER = re.compile(r"^-?(\d[\d_]*)?(\.\d*)?([eE][-+]?\d+)?j?$")
_OBJECT = re.compile(r"^<([A-Za-z_][\w.]*)(?: object)?\b")
_CALL_REPR = re.compile(r"^([A-Za-z_][\w.]*)\(")
NUMERIC = frozenset({"int", "float", "complex", "bool", "Decimal", "Fraction"})


class _Unknown:
    """A part of a value the text does not show (cut off, or a level the serializer left closed)."""

    def __repr__(self) -> str:
        return "UNKNOWN"


UNKNOWN: Any = _Unknown()


def type_of(text: str | None) -> str | None:
    """The type a recorded text names: ``str`` for ``'a'``, ``float`` for ``49.9``, ``Foo`` for ``<Foo object at …>``."""
    if text is None:
        return None
    t = _CUT.sub("", str(text).strip())
    if not t:
        return None
    if t[0] in "'\"":
        return "str"
    if t[:2] in ("b'", 'b"'):
        return "bytes"
    if t in ("None",):
        return "NoneType"
    if t in ("True", "False"):
        return "bool"
    if t in ("inf", "-inf", "nan"):
        return "float"
    if _NUMBER.match(t) and any(c.isdigit() for c in t):
        if t.endswith("j"):
            return "complex"
        return "float" if any(c in t for c in ".eE") else "int"
    if t[0] == "[":
        return "list"
    if t[0] == "(":
        return "tuple"
    if t[0] == "{":
        return "dict" if t == "{}" or _top_level_colon(t) else "set"
    if t.startswith("<function ") or t.startswith("<bound method "):
        return "function"
    m = _OBJECT.match(t)
    if m:
        return m.group(1).rsplit(".", 1)[-1]
    m = _CALL_REPR.match(t)
    if m:
        return m.group(1).rsplit(".", 1)[-1]
    return None


def type_of_value(value: Any) -> str | None:
    """The type name of a value ``parse`` returned; ``None`` for a part the text did not show."""
    if value is UNKNOWN or isinstance(value, _Opaque):
        return value.type if isinstance(value, _Opaque) else None
    return type(value).__name__


def _top_level_colon(t: str) -> bool:
    depth = 0
    quote: str | None = None
    i = 0
    while i < len(t):
        c = t[i]
        if quote:
            if c == "\\":
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in "'\"":
            quote = c
        elif c in "[({":
            depth += 1
        elif c in "])}":
            depth -= 1
        elif c == ":" and depth == 1:
            return True
        i += 1
    return False


class _Opaque:
    """An object the text shows only by its type (``<Foo object at 0x…>``)."""

    def __init__(self, type_name: str) -> None:
        self.type = type_name

    def __repr__(self) -> str:
        return "<%s object>" % self.type


def parse(text: str | None) -> Any:
    """The value a recorded text shows, as Python objects; ``UNKNOWN`` for what it does not show.

    A literal parses whole. A cut text keeps its complete elements and closes the brackets it
    opened; a level the serializer left closed (``{...}``) and an object (``<Foo …>``) become
    ``UNKNOWN`` and ``_Opaque`` respectively.
    """
    if text is None:
        return UNKNOWN
    t = str(text).strip()
    try:
        return _fix(_literal(t))
    except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
        pass
    cut = bool(_CUT.search(t))
    t = _CUT.sub("", t)
    if t.startswith("<"):
        name = type_of(t)
        return _Opaque(name) if name else UNKNOWN
    if t[:1] in "'\"" or not t[:1] in "[({":
        return UNKNOWN  # a cut string, or a repr we cannot read
    repaired = _repair(t, cut)
    if repaired is None:
        return UNKNOWN
    try:
        return _fix(_literal(repaired))
    except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
        return UNKNOWN


def _literal(text: str) -> Any:
    """``ast.literal_eval`` without the ``SyntaxWarning`` a cut text's stray backslash gives."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return ast.literal_eval(text)


_MARK = "\ufffd"
_PLACEHOLDER = "'%sunknown'" % _MARK


def _repair(t: str, cut: bool) -> str | None:
    """``t`` with objects and closed levels replaced by a placeholder and, when it was cut, its last partial element dropped and its brackets closed."""
    out: list[str] = []
    stack: list[str] = []
    quote: str | None = None
    last_boundary = 0  # len(out) after the last complete element at any depth
    boundary_stack: list[str] = []
    i = 0
    pairs = {"[": "]", "(": ")", "{": "}"}
    while i < len(t):
        c = t[i]
        if quote:
            out.append(c)
            if c == "\\" and i + 1 < len(t):
                out.append(t[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c in "'\"":
            quote = c
            out.append(c)
        elif c == "<":
            j = _skip_angle(t, i)
            if j < 0:
                break
            name = type_of(t[i:j])
            out.append("'%sobj:%s'" % (_MARK, name) if name else _PLACEHOLDER)
            i = j
            continue
        elif t.startswith("...", i):
            out.append(_PLACEHOLDER)
            i += 3
            continue
        elif c in pairs:
            stack.append(pairs[c])
            out.append(c)
        elif c in "])}":
            if not stack:
                return None
            stack.pop()
            out.append(c)
        elif c == "," and len(stack) == 1:
            # only a top-level element is kept whole: a dict cut inside would read as one without its later keys
            last_boundary = len(out)
            boundary_stack = list(stack)
            out.append(c)
        else:
            out.append(c)
        i += 1
    if not cut and not quote and not stack:
        return "".join(out)
    if not cut:
        return None
    body = "".join(out[:last_boundary]) if last_boundary else "".join(out)
    closers = boundary_stack if last_boundary else stack
    if not last_boundary:
        return None
    return body + "".join(reversed(closers))


def _skip_angle(t: str, i: int) -> int:
    depth = 0
    while i < len(t):
        if t[i] == "<":
            depth += 1
        elif t[i] == ">":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return -1


def _fix(value: Any) -> Any:
    """The placeholder back to ``UNKNOWN``; a set of ``...`` (``{...}``) is a closed level, ``UNKNOWN`` too."""
    if isinstance(value, str) and value.startswith(_MARK):
        return _Opaque(value[len(_MARK) + 4:]) if value.startswith(_MARK + "obj:") else UNKNOWN
    if value is Ellipsis:
        return UNKNOWN
    if isinstance(value, list):
        return [_fix(v) for v in value]
    if isinstance(value, tuple):
        return tuple(_fix(v) for v in value)
    if isinstance(value, dict):
        return {k: _fix(v) for k, v in value.items()}
    if isinstance(value, (set, frozenset)):
        return UNKNOWN if all(v is Ellipsis or (isinstance(v, str) and v.startswith(_MARK)) for v in value) else value
    return value


def project(value: Any, path: list) -> Any:
    """``value[p0][p1]…``; ``UNKNOWN`` as soon as a step does not apply. An ``int`` key indexes a list or tuple."""
    for key in path:
        if value is UNKNOWN:
            return UNKNOWN
        try:
            if isinstance(value, dict):
                value = value[key] if key in value else UNKNOWN
            elif isinstance(value, (list, tuple, str)) and isinstance(key, int):
                value = value[key] if -len(value) <= key < len(value) else UNKNOWN
            else:
                return UNKNOWN
        except TypeError:
            return UNKNOWN
    return value


def text_of(value: Any) -> str | None:
    """The text a value would have had in the recording; ``None`` when part of it is not known."""
    if _has_unknown(value):
        return None
    return repr(value)


def _has_unknown(value: Any) -> bool:
    if value is UNKNOWN or isinstance(value, _Opaque):
        return True
    if isinstance(value, (list, tuple)):
        return any(_has_unknown(v) for v in value)
    if isinstance(value, dict):
        return any(_has_unknown(v) for v in value.values())
    return False


def path_text(base: str, path: list) -> str:
    """``items[0]["unit_price"]``."""
    out = base
    for key in path:
        out += "[%s]" % (repr(key).replace("'", '"') if isinstance(key, str) else key)
    return out


__all__ = ["UNKNOWN", "NUMERIC", "parse", "project", "text_of", "type_of", "type_of_value", "path_text"]
