"""Where a recorded function or class was defined: ``defined: {fileId, line}`` on a locals change.

Both recorders (``Tracer._record_locals`` and ``ExactTracer._emit``) call ``defined_at`` for each change.
``def`` and ``class`` statements are never steps, so ``History`` gives such a value no producing step; the
link says which ``def`` it came from instead. ``line`` is ``co_firstlineno`` (a class's ``__firstlineno__``),
which is the first decorator's line for a decorated definition, as Python counts it.

No user code runs here: a function is read only when ``type(v)`` is exactly ``FunctionType`` (its
``__code__`` and ``__dict__`` are the type's own slots), a decorator's ``__wrapped__`` only from that
``__dict__`` (where ``functools.wraps`` stores it), a bound method through ``__func__``, a class through
``type``'s own ``__dict__`` descriptor (a metaclass ``__getattr__`` is not reached) and its module's file
from the module's dict. Only a file this run instrumented gets a link (``files``, keyed by filename).
"""

from __future__ import annotations

import sys
import types
from typing import Any

WRAPPED_MAX = 16  # `__wrapped__` hops followed from one function
_FN = types.FunctionType
_METHOD = types.MethodType
_CLASS_DICT = type.__dict__["__dict__"]
_MODULE_DICT = types.ModuleType.__dict__["__dict__"]


def skipped_at_module(name: str, v: Any, defined: dict | None) -> bool:
    """A module-level name no change is recorded for: a dunder, a module, a builtin, and a function, method or
    class that ``defined_at`` did not link (an import from a file the run did not instrument)."""
    t = type(v)
    if name.startswith("__") or issubclass(t, types.ModuleType) or t is types.BuiltinFunctionType:
        return True
    return defined is None and (t is _FN or t is _METHOD or issubclass(t, type))


def _code_site(fn: Any, files: dict) -> dict | None:
    code = fn.__code__
    info = files.get(code.co_filename)
    return {"fileId": info.file_id, "line": code.co_firstlineno} if info is not None else None


def _function_site(fn: Any, files: dict) -> dict | None:
    """The innermost instrumented function of the ``__wrapped__`` chain from ``fn``."""
    best = _code_site(fn, files)
    for _ in range(WRAPPED_MAX):
        inner = fn.__dict__.get("__wrapped__")
        if type(inner) is _METHOD:
            inner = inner.__func__
        if type(inner) is not _FN:
            break
        fn = inner
        best = _code_site(fn, files) or best
    return best


def _class_site(cls: type, files: dict) -> dict | None:
    d = _CLASS_DICT.__get__(cls)
    line = d.get("__firstlineno__")  # 3.13+; older classes get no link
    mod = sys.modules.get(d.get("__module__")) if type(d.get("__module__")) is str else None
    if type(line) is not int or not isinstance(mod, types.ModuleType):
        return None
    path = _MODULE_DICT.__get__(mod).get("__file__")
    info = files.get(path) if type(path) is str else None
    return {"fileId": info.file_id, "line": line} if info is not None else None


def defined_at(v: Any, files: dict) -> dict | None:
    """``{fileId, line}`` of the ``def`` or ``class`` that made ``v``, when that file is in ``files``; else None."""
    try:
        t = type(v)
        if t is _METHOD:
            v = v.__func__
            t = type(v)
        if t is _FN:
            return _function_site(v, files)
        if issubclass(t, type):
            return _class_site(v, files)
    except Exception:  # noqa: BLE001 - a link is optional
        return None
    return None


__all__ = ["defined_at", "skipped_at_module", "WRAPPED_MAX"]
