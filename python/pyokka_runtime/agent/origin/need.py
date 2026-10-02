"""What the failing statement needed from the value, read from the exception's type and message."""

from __future__ import annotations

import ast
import re
from typing import Any

from ..reprs import NUMERIC, UNKNOWN, parse, type_of

_QUOTED = re.compile(r"'([A-Za-z_][\w.]*)'")


class Need:
    """What the failing statement needed from the value, read from the error."""

    def __init__(self, kind: str, *, bad: str | None = None, fits: str | None = None, key: Any = None, index: int | None = None, attr: str | None = None) -> None:
        self.kind = kind  # "type", "key", "index", "differs"
        self.bad = bad
        self.fits_type = fits
        self.key = key
        self.index = index
        self.attr = attr

    def describe(self) -> str:
        if self.kind == "type":
            want = "a number" if self.fits_type == "number" else ("a %s" % self.fits_type if self.fits_type else "a value that is not %s" % ("None" if self.bad == "NoneType" else "a " + str(self.bad)))
            return want
        if self.kind == "key":
            return "a dict with key %r" % (self.key,)
        if self.kind == "index":
            return "a sequence longer than %d" % (self.index or 0)
        return ""

    def type_fits(self, t: str | None) -> bool | None:
        if t is None:
            return None
        if self.fits_type == "number":
            return t in NUMERIC
        if self.fits_type:
            return t == self.fits_type
        return t != self.bad

    def fits(self, text: str | None) -> bool | None:
        """Whether a recorded value would have done; ``None`` when its text does not tell."""
        if text is None:
            return None
        if self.kind == "type":
            return self.type_fits(type_of(text))
        if self.kind == "key":
            value = parse(text)
            if not isinstance(value, dict):
                return None if value is UNKNOWN else False
            return True if self.key in value else (None if "…(+" in str(text) else False)
        if self.kind == "index":
            value = parse(text)
            if not isinstance(value, (list, tuple, str)) or "…(+" in str(text):
                return None
            return len(value) > int(self.index or 0)
        return None


def need_from_error(error_type: str, message: str) -> Need | None:
    """``Need`` for the error kinds origin reads; ``None`` for the rest."""
    if error_type == "KeyError":
        try:
            key = ast.literal_eval(message)
        except (ValueError, SyntaxError):
            key = message.strip("'\"")
        return Need("key", key=key)
    if error_type == "IndexError":
        return Need("index")
    if error_type == "AttributeError":
        m = re.match(r"'([\w.]+)' object has no attribute '(\w+)'", message)
        if m:
            return Need("type", bad=m.group(1), attr=m.group(2))
        return None
    if error_type == "TypeError":
        m = re.match(r'can only concatenate (\w+) \(not "(\w+)"\) to \w+', message)
        if m:
            return Need("type", bad=m.group(2), fits=m.group(1))
        types = _QUOTED.findall(message)
        if "NoneType" in types:
            return Need("type", bad="NoneType")
        m = re.search(r"unsupported operand type\(s\) for [^:]+: '(\w+)' and '(\w+)'", message)
        if m:
            a, b = m.group(1), m.group(2)
            if a in NUMERIC and b not in NUMERIC:
                return Need("type", bad=b, fits="number")
            if b in NUMERIC and a not in NUMERIC:
                return Need("type", bad=a, fits="number")
            return Need("type", bad=b, fits=a)
        m = re.search(r"not '(\w+)'$", message) or re.match(r"'(\w+)' object", message)
        if m:
            return Need("type", bad=m.group(1))
    return None


__all__ = ["Need", "need_from_error"]
