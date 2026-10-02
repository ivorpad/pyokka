"""Guarded value helpers shared by the serializer and the tracer.

``short_repr`` is the one-line bounded rendering used for inline log text;
``Registry`` keeps logged objects addressable for ``expand`` requests;
``child_by_segment`` walks a ``queryPath`` segment without calling ``dir()``.
"""

from __future__ import annotations

import datetime as _dt
import decimal
import enum
import fractions
import itertools
import pathlib
import re
import reprlib
import traceback
import types
import uuid
from collections import OrderedDict, deque

from . import secrets
from collections.abc import Mapping
from typing import Any

LOAD_MORE_SUFFIX = " +"
PREVIEW_LEN = 200
_LEAF_TYPES = (
    _dt.datetime,
    _dt.date,
    _dt.time,
    _dt.timedelta,
    decimal.Decimal,
    fractions.Fraction,
    pathlib.PurePath,
    uuid.UUID,
    range,
    slice,
    memoryview,
    re.Pattern,
    re.Match,
)


class _BoundedRepr(reprlib.Repr):
    def __init__(self, max_len: int) -> None:
        super().__init__()
        self.maxlevel = 3
        self.maxtuple = self.maxlist = self.maxarray = self.maxdict = self.maxset = self.maxfrozenset = 16
        self.maxdeque = 16
        self.maxstring = max(32, max_len)
        self.maxlong = 60
        self.maxother = max(32, max_len)

    def repr_int(self, x: Any, level: int) -> str:  # noqa: D401 - reprlib API
        # Python 3.12's reprlib lets `sys.get_int_max_str_digits()` raise; 3.13+ names the size
        try:
            return super().repr_int(x, level)
        except ValueError:
            return "<int with roughly %d digits>" % (int(abs(x).bit_length() * 0.30103) + 1)

    def repr_instance(self, x: Any, level: int) -> str:  # noqa: D401 - reprlib API
        try:
            s = repr(x)
        except BaseException:  # noqa: BLE001 - user __repr__ may raise anything
            return "<%s object>" % type(x).__name__
        if len(s) > self.maxother:
            s = s[: self.maxother - 1] + "…"
        return s


def short_repr(obj: Any, max_len: int = PREVIEW_LEN) -> str:
    """One-line, guarded, bounded ``repr`` (used for inline log text and previews)."""
    try:
        text = _BoundedRepr(max_len).repr(obj)
    except BaseException:  # noqa: BLE001
        try:
            text = "<%s object>" % type(obj).__name__
        except BaseException:  # noqa: BLE001
            text = "<object>"
    if "\n" in text or "\r" in text:
        text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\\n")
    if len(text) > max_len:
        text = text[: max_len - 1] + "…"
    return secrets.current.scrub(text)


# Recorded value text (`config.maxValueChars`): the defaults are what a local and a logged value
# kept before the setting existed; 0 asks for no limit and gets the ceiling, which bounds what one
# value can cost in memory and in run.json (a run keeps up to MAX_LOCALS_ENTRIES of them).
LOCALS_CHARS = 120
LOG_CHARS = 200
VALUE_CHARS_CEILING = 1_000_000
_FILL = "\x00"  # reprlib's elision mark while measuring: a repr never holds a raw NUL, so its presence means "cut"
_LEN_BUDGET = 20_000  # nodes `_full_len` visits before it gives up on knowing the length


def value_chars(setting: Any, default: int) -> int:
    """The text budget for one recorded value: ``default`` when unset, the ceiling for 0 or more than it."""
    if setting is None:
        return default
    try:
        n = int(setting)
    except (TypeError, ValueError):
        return default
    if n <= 0 or n > VALUE_CHARS_CEILING:
        return VALUE_CHARS_CEILING
    return max(32, n)


class _MeasuredRepr(_BoundedRepr):
    """``_BoundedRepr`` that remembers whether it left anything out."""

    def __init__(self, max_len: int) -> None:
        super().__init__(max_len)
        self.fillvalue = _FILL
        self.cut = False
        self.instance_len: int | None = None
        if max_len > 1000:  # a caller who asked for long values wants the whole list, not its first 16 items
            self.maxlevel = 6
            self.maxtuple = self.maxlist = self.maxarray = self.maxdict = self.maxset = self.maxfrozenset = self.maxdeque = max(16, max_len // 10)

    def repr_instance(self, x: Any, level: int) -> str:
        try:
            s = repr(x)
        except BaseException:  # noqa: BLE001 - user __repr__ may raise anything
            return "<%s object>" % type(x).__name__
        if len(s) > self.maxother:
            self.cut = True
            if level == self.maxlevel:
                self.instance_len = len(s)
            s = s[: self.maxother - 1] + "…"
        return s


def _full_len(obj: Any, budget: list[int], depth: int = 0) -> int | None:
    """The length of ``repr(obj)`` without building it, for builtin values only; None when unknown."""
    budget[0] -= 1
    if budget[0] < 0 or depth > 40:
        return None
    t = type(obj)
    if t is str or t is bytes or t is bytearray:
        return len(repr(obj))
    if obj is None or t is bool or t is float or t is complex:
        return len(repr(obj))
    if t is int:
        return len(_int_repr(obj))
    if t is dict:
        total = 2 + max(0, 2 * (len(obj) - 1))
        for k, v in obj.items():
            a = _full_len(k, budget, depth + 1)
            b = _full_len(v, budget, depth + 1)
            if a is None or b is None:
                return None
            total += a + b + 2
        return total
    if t is list or t is tuple or t is set or t is frozenset:
        n = len(obj)
        if t is set and n == 0:
            return 5  # set()
        if t is frozenset:
            if n == 0:
                return 11  # frozenset()
            total = 13  # frozenset({})
        else:
            total = 2 + (1 if t is tuple and n == 1 else 0)
        total += max(0, 2 * (n - 1))
        for item in obj:
            m = _full_len(item, budget, depth + 1)
            if m is None:
                return None
            total += m
        return total
    return None


def value_text(obj: Any, max_len: int = PREVIEW_LEN) -> tuple[str, int | None, bool]:
    """``short_repr`` that says what it left out: ``(text, full_length, cut)``.

    A cut text ends in ``…(+N chars)``, N being what the full ``repr`` had beyond the shown text,
    or in ``…(cut)`` when the full length is unknown (an object whose repr is not a builtin's).
    ``full_length`` is None when nothing was cut or the length is unknown.
    """
    measure = _MeasuredRepr(max_len)
    try:
        text = measure.repr(obj)
    except BaseException:  # noqa: BLE001
        try:
            text = "<%s object>" % type(obj).__name__
        except BaseException:  # noqa: BLE001
            text = "<object>"
    cut = measure.cut
    if _FILL in text:
        cut = True
        text = text.replace(_FILL, "...")
    if "\n" in text or "\r" in text:
        text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\\n")
    if len(text) > max_len:
        cut = True
        text = text[: max_len - 1] + "…"
    text = secrets.current.scrub(text)
    if not cut:
        return text, None, False
    length = measure.instance_len
    if length is None:
        try:
            length = _full_len(obj, [_LEN_BUDGET])
        except BaseException:  # noqa: BLE001 - a dict whose keys compare badly, a str subclass ...
            length = None
    shown = text[:-1] if text.endswith("…") else text
    if length is not None and length > len(shown):
        return "%s…(+%s chars)" % (shown, format(length - len(shown), ",")), length, True
    return "%s…(cut)" % shown, None, True


def cut_entry(entry: dict, name: Any, obj: Any, max_len: int) -> dict:
    """``entry`` with ``text`` for ``name = obj``, plus ``truncated`` / ``length`` when the text was cut.

    A masked secret keeps neither: its length would say something about the secret."""
    text, length, cut = value_text(obj, max_len)
    masked = secrets.current.mask_text(name, obj, text)
    entry["text"] = masked
    if cut and masked == text:
        entry["truncated"] = True
        if length is not None:
            entry["length"] = length
    return entry


def type_name(obj: Any) -> str:
    if obj is None:
        return "None"
    t = type(obj)
    if t is bool:
        return "bool"
    if t is int or t is float or t is complex:
        return "number"
    if t is str:
        return "str"
    if t is list:
        return "list"
    if t is tuple:
        return "tuple"
    if t is dict:
        return "dict"
    if t is set:
        return "set"
    if t is frozenset:
        return "frozenset"
    if t in (bytes, bytearray):
        return "bytes"
    if isinstance(obj, type):
        return "class"
    if isinstance(obj, types.ModuleType):
        return "module"
    if isinstance(
        obj,
        (
            types.FunctionType,
            types.BuiltinFunctionType,
            types.MethodType,
            types.BuiltinMethodType,
            types.LambdaType,
            types.WrapperDescriptorType,
            types.MethodWrapperType,
            types.MethodDescriptorType,
            types.ClassMethodDescriptorType,
            functools_partial_type(),
        ),
    ):
        return "function"
    return t.__name__


def functools_partial_type() -> type:
    import functools

    return functools.partial


class Registry:
    """Keeps logged objects addressable by node id (and by root runtime key) for ``expand``."""

    def __init__(self, max_entries: int = 20_000) -> None:
        self.max_entries = max_entries
        self.objects: OrderedDict[str, Any] = OrderedDict()
        self.roots: dict[str, Any] = {}

    def clear(self) -> None:
        self.objects.clear()
        self.roots.clear()

    def register(self, node_id: str, obj: Any) -> None:
        self.objects[node_id] = obj
        if len(self.objects) > self.max_entries:
            self.objects.popitem(last=False)

    def set_root(self, key: str, obj: Any) -> None:
        self.roots[key] = obj

    def resolve(self, value_id: str | None, query_path: list[str] | None) -> tuple[Any, list[str], bool]:
        """Return ``(obj, path, load_more)``. Raises ``LookupError`` when nothing matches."""
        load_more = False
        if value_id and value_id.endswith(LOAD_MORE_SUFFIX):
            value_id = value_id[: -len(LOAD_MORE_SUFFIX)]
            load_more = True
        if value_id and value_id in self.objects:
            return self.objects[value_id], list(query_path or []), load_more
        if query_path:
            root_key = query_path[0]
            if root_key not in self.roots:
                raise LookupError("unknown runtime key %r" % root_key)
            obj = self.roots[root_key]
            for segment in query_path[1:]:
                obj = child_by_segment(obj, segment)
            return obj, list(query_path), load_more
        raise LookupError("value %r is no longer available" % value_id)


def child_by_segment(obj: Any, segment: str) -> Any:
    name = segment[3:] if segment.startswith("_p_") else segment
    if isinstance(obj, Mapping):
        for key in obj:
            if _key_name(key) == name or _guarded_repr(key) == name:
                return obj[key]
        raise LookupError("no key %r" % name)
    if isinstance(obj, (list, tuple, deque, set, frozenset)):
        idx = int(name)
        if isinstance(obj, (set, frozenset)):
            return next(itertools.islice(obj, idx, idx + 1))
        return obj[idx]
    if isinstance(obj, BaseException):
        if name == "args":
            return obj.args
        if name == "__cause__":
            return obj.__cause__
        if name == "__context__":
            return obj.__context__
        if name == "traceback":
            return _tb_summary(obj)
    d = _instance_dict(obj)
    if d is not None and name in d:
        return d[name]
    for cls in type(obj).__mro__:
        slots = _slot_names(cls)
        if name in slots:
            desc = vars(cls)[name] if name in vars(cls) else None
            if desc is not None:
                return desc.__get__(obj, cls)
    if isinstance(obj, type):
        for cls in obj.__mro__:
            if name in vars(cls):
                return vars(cls)[name]
    if isinstance(obj, enum.Enum):
        if name == "name":
            return obj.name
        if name == "value":
            return obj.value
    # Last resort (resolve_getters style): getattr, which may run a property.
    return getattr(obj, name)


def _key_name(key: Any) -> str:
    if isinstance(key, str):
        return key
    return _guarded_repr(key)


def _guarded_repr(obj: Any, max_len: int = 120) -> str:
    return short_repr(obj, max_len)


def _instance_dict(obj: Any) -> dict[str, Any] | None:
    try:
        d = object.__getattribute__(obj, "__dict__")
    except Exception:  # noqa: BLE001
        return None
    return d if isinstance(d, dict) else None


def _slot_names(cls: type) -> tuple[str, ...]:
    slots = vars(cls).get("__slots__") if isinstance(cls, type) else None
    if slots is None:
        return ()
    if isinstance(slots, str):
        slots = (slots,)
    out = []
    for s in slots:
        if isinstance(s, str) and s not in ("__dict__", "__weakref__"):
            out.append(s)
    return tuple(out)


def _tb_summary(exc: BaseException, limit: int = 20) -> list[str]:
    tb = exc.__traceback__
    if tb is None:
        return []
    try:
        frames = traceback.extract_tb(tb, limit=limit)
    except Exception:  # noqa: BLE001
        return []
    return ["%s:%d in %s" % (f.filename, f.lineno or 0, f.name) for f in frames]



def _index_expr(expr: str, i: int) -> str:
    return "%s[%d]" % (expr or "$", i)


def _int_repr(value: int) -> str:
    try:
        return repr(value)
    except ValueError:  # exceeds int max str digits
        return "<int with %d bits>" % value.bit_length()


def _function_repr(obj: Any) -> str:
    name = getattr(obj, "__qualname__", None) or getattr(obj, "__name__", None)
    if name:
        return "<function %s>" % name
    return short_repr(obj, 120)


def _is_namedtuple(obj: Any) -> bool:
    t = type(obj)
    return isinstance(obj, tuple) and t is not tuple and isinstance(getattr(t, "_fields", None), tuple)


def _safe_type_name(obj: Any) -> str:
    try:
        return type_name(obj)
    except Exception:  # noqa: BLE001
        return "object"
