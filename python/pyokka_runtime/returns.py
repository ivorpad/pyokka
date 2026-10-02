"""How a function left, as the exit hook records it: the markers ``_pk_rv_`` holds and the text of a returned value.

The instrumenter gives every function body ``_pk_rv_ = _pk_u`` (``UNSET``), turns each
``return value`` into ``return (_pk_rv_ := value)`` and ends the body with
``_pk_rv_ = _pk_end`` (``END``); the ``finally`` calls ``_pk_x(_pk_scope_, _pk_rv_)``.
"""

from __future__ import annotations

from typing import Any

from . import secrets
from .values import LOCALS_CHARS

RETURN_TEXT_MAX = LOCALS_CHARS  # a recorded return value's text by default: as long as a recorded local's (`maxValueChars` changes both)
INT_FAST = 10**18  # ints inside this take plain `repr`; past it `short_repr` bounds the length
MIN_SECRET_LEN = secrets.MIN_VALUE_LEN

_PLAIN_ITEMS = 16  # reprlib's own cut-off (`short_repr` elides past 16 items)
_PLAIN_SCALARS = frozenset((int, float, bool, type(None)))


def plain_text(val: Any, max_len: int = RETURN_TEXT_MAX) -> str | None:
    """``repr`` of a short string or a small list, tuple or dict of numbers and short strings, when it fits ``max_len``.

    The builtin ``repr`` of these runs no user code and costs a tenth of ``short_repr``'s
    reprlib walk (2 µs for a two-key dict), which a function returning a dict in a loop paid on
    every call. Anything else (nested, large, user objects) answers None and goes through
    ``short_repr``. A dict keeps its insertion order here, where reprlib sorts the keys. A text
    longer than ``max_len`` also answers None, so the cut is made (and marked) by ``values.value_text``.
    """
    t = type(val)
    if t is str:
        if len(val) > max_len:
            return None
    elif t is list or t is tuple:
        if len(val) > _PLAIN_ITEMS:
            return None
        for item in val:
            it = type(item)
            if it not in _PLAIN_SCALARS and not (it is str and len(item) <= max_len):
                return None
    elif t is dict:
        if len(val) > _PLAIN_ITEMS:
            return None
        for k, item in val.items():
            if type(k) is not str or len(k) > max_len:
                return None
            it = type(item)
            if it not in _PLAIN_SCALARS and not (it is str and len(item) <= max_len):
                return None
    else:
        return None
    try:
        text = repr(val)
    except ValueError:  # an int past `sys.get_int_max_str_digits()`
        return None
    return text if len(text) <= max_len else None


class _Marker:
    """A value ``_pk_rv_`` can hold that no program returns."""

    __slots__ = ("name",)

    def __init__(self, name: str) -> None:
        self.name = name

    def __repr__(self) -> str:
        return "<pyokka %s>" % self.name


UNSET = _Marker("no return yet")  # `_pk_u`
END = _Marker("end of body")  # `_pk_end`
MODULE_EXIT = _Marker("module body")  # `_pk_x(_pk_scope_)` of a module body passes no value
