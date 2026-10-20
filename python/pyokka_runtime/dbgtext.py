"""A paused frame's values for a reader who asked for more than the editor shows.

The editor reads a paused frame through ``locals`` and ``evaluate`` with no limits and gets what it
always got: ``short_repr`` at ``PREVIEW_LEN``, 200 characters, for the hover, the Variables view,
the watches and the Debug Console. An agent reads the same frame to reason about it, and 200
characters cut a dataclass in the middle of its fields: in the smoke test of 2026-10-19 the
``policy`` local at ``_policy.py:210``, a 256-character ``SSRFPolicy``, came back cut. So both
requests take ``limits: {"textLen": N}``. The text is then ``value_text`` at N, whose cut says how
much it left out, and a local that is still cut lists its ``fields`` under it: the reviewing agent's
point was that the fields of a cut value help more than a longer single line.

``fields`` are read without running the program's code beyond ``repr``: an object's ``__dict__``
through ``object.__getattribute__`` and its ``__slots__`` through their member descriptors, a
namedtuple by ``_fields``, a dict through the unbound ``dict.items``, the first items of a list or
a tuple. Each text is cut at ``PREVIEW_LEN`` and masked under the field's own name, as the
serializer masks a child, so an ``api_token`` field is masked here as it is in the value bag.
"""

from __future__ import annotations

import itertools
import types
from typing import Any, Iterator

from . import secrets
from .values import PREVIEW_LEN, _instance_dict, _slot_names, short_repr, value_chars, value_text

#: the fields listed under a cut value; the ones past it are counted in ``fieldsMore``
FIELDS_MAX = 20
#: characters of a dict key in a field's name (``['host']``)
KEY_LEN = 60


def text_len(limits: Any) -> int | None:
    """The text length a request's ``limits`` asks for, clamped as ``maxValueChars`` is; None when it asks for none."""
    if not isinstance(limits, dict) or limits.get("textLen") is None:
        return None
    return value_chars(limits.get("textLen"), PREVIEW_LEN)


def shown(name: Any, value: Any, limit: int | None) -> tuple[str, bool]:
    """``(text, cut)`` of ``name = value``, masked: ``short_repr`` without a limit, as before, else ``value_text`` at it.

    A masked text is never reported cut, the rule of ``values.cut_entry``: its length would say something about the secret."""
    if limit is None:
        return secrets.current.mask_text(name, value, short_repr(value)), False
    text, _length, cut = value_text(value, limit)
    masked = secrets.current.mask_text(name, value, text)
    return masked, cut and masked == text


def local_text(name: str, value: Any, limit: int | None) -> dict:
    """A local's ``text``, plus ``fields`` (and ``fieldsMore``) when a limit was asked for and the text is still cut."""
    text, cut = shown(name, value, limit)
    out: dict[str, Any] = {"text": text}
    if cut:
        pairs, more = fields(value)
        if pairs:
            out["fields"] = pairs
            if more:
                out["fieldsMore"] = more
    return out


def fields(value: Any) -> tuple[list[list[str]], int]:
    """Up to ``FIELDS_MAX`` ``[name, text]`` pairs of ``value`` and how many it has past them.

    A name reads as the access that reaches the field (``.attr``, ``['key']``, ``[0]``), so it can be
    appended to the local's name in an ``eval``. ``([], 0)`` for a kind without fields: a string, a
    number, a set."""
    try:
        found = _children(value)
        if found is None:
            return [], 0
        children, total = found
        pairs = [[label, secrets.current.mask_text(mask_as, child, value_text(child, PREVIEW_LEN)[0])] for label, mask_as, child in itertools.islice(children, FIELDS_MAX)]
    except Exception:  # noqa: BLE001 - a dict another thread resized, a broken descriptor: the value's own text stands
        return [], 0
    return pairs, max(0, total - len(pairs))


def _children(value: Any) -> tuple[Iterator[tuple[str, Any, Any]], int] | None:
    """``(children, count)``, a child being ``(label, name it is masked under, value)`` in the value's own order.

    The kind is read off ``type(value)``: ``isinstance`` would ask the value for ``__class__``, which a
    proxy answers with its own code (a lazy object evaluates itself there)."""
    t = type(value)
    if issubclass(t, (str, bytes, bytearray)):
        return None
    if issubclass(t, dict):
        return (("[%s]" % short_repr(k, KEY_LEN), k, v) for k, v in dict.items(value)), dict.__len__(value)
    if issubclass(t, tuple) and t is not tuple and isinstance(getattr(t, "_fields", None), tuple):
        return ((".%s" % n, n, v) for n, v in zip(t._fields, tuple.__iter__(value))), tuple.__len__(value)
    if issubclass(t, (list, tuple)):
        kind = list if issubclass(t, list) else tuple
        # an element has no name of its own, so it is scrubbed, not masked, as the serializer treats it
        return (("[%d]" % i, None, v) for i, v in enumerate(kind.__iter__(value))), kind.__len__(value)
    attrs = _attributes(value)
    return (iter(attrs), len(attrs)) if attrs else None


def _attributes(value: Any) -> list[tuple[str, Any, Any]]:
    """An object's own attributes: its ``__dict__``, then each ``__slots__`` member that holds a value."""
    d = _instance_dict(value)
    out: list[tuple[str, Any, Any]] = [(".%s" % k, k, v) for k, v in dict.items(d)] if d is not None else []
    seen = {name for _label, name, _v in out}
    for cls in type(value).__mro__:
        for slot in _slot_names(cls):
            desc = vars(cls).get(slot)
            if slot in seen or not isinstance(desc, types.MemberDescriptorType):
                continue  # only the C member descriptor: a property of the same name would run the program's code
            try:
                out.append((".%s" % slot, slot, desc.__get__(value, cls)))
            except AttributeError:
                continue  # declared and never set
            seen.add(slot)
    return out


__all__ = ["FIELDS_MAX", "fields", "local_text", "shown", "text_len"]
