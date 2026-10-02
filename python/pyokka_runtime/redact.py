"""Secret redaction for everything that leaves the process: saved runs, CLI output, bridge replies.

The rules are the contract in ``docs/PROTOCOL.md`` ("Redaction") and are mirrored by
``src/util/redact.ts``; ``test/unit/fixtures/redact.json`` pins both. Whole tokens of the
common shapes (``sk-…``, ``AKIA…``, ``ghp_…``, ``xox[abp]-…``, JWTs, ``Bearer <token>``) and
the value of any key whose name mentions a credential become ``«redacted»``. ``None``,
numbers and short words are left alone.
"""

from __future__ import annotations

import re
from typing import Any

REDACTED = "«redacted»"

_KEY_WORDS = r"api_key|apikey|secret|token|password|passwd|authorization"
_MIN_VALUE_LEN = 6

# key=value, key: value, 'key': 'value', key='value' (quotes stay, the value goes); an unquoted value
# ends at `&` so `?api_key=…&v=1` keeps its other query parameters
#
# The lookbehind after the quote is what keeps this linear. Without it the leading
# `[A-Za-z0-9_.-]*` can start at every offset of a run of those characters, and at each one it
# consumes to the end of the run and backtracks the whole way looking for a key word: O(n²) in the
# length of the run, which is seconds for a line of a few tens of KB and a program is free to
# print one. It costs nothing, because the prefix class is closed: a match starting inside a run
# always has an equivalent starting where the run does, and a left-to-right scan finds that one
# first. So the only starts ruled out are ones that could never have won.
_KV = re.compile(
    r"""(?P<key>(?P<q>['"]?)(?<![A-Za-z0-9_.\-])[A-Za-z0-9_.\-]*(?:%s)[A-Za-z0-9_\-]*(?P=q))(?P<sep>\s*[=:]\s*)(?P<value>(?P<vq>['"])(?:\\.|(?!(?P=vq)).)*(?P=vq)|[^\s,;()\[\]{}'"&]+)"""
    % _KEY_WORDS,
    re.IGNORECASE,
)
_BEARER = re.compile(r"\b(?P<prefix>[Bb]earer\s+)(?P<token>[A-Za-z0-9._~+/=\-]{6,})")
_TOKENS = [
    re.compile(r"(?<![A-Za-z0-9_\-])sk-[A-Za-z0-9_\-]{16,}(?![A-Za-z0-9_\-])"),
    re.compile(r"(?<![A-Za-z0-9])AKIA[A-Z0-9]{16}(?![A-Za-z0-9])"),
    re.compile(r"(?<![A-Za-z0-9_])ghp_[A-Za-z0-9]{30,}(?![A-Za-z0-9_])"),
    re.compile(r"(?<![A-Za-z0-9_\-])xox[abp]-[A-Za-z0-9\-]{8,}(?![A-Za-z0-9_\-])"),
    re.compile(r"(?<![A-Za-z0-9_\-])eyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}(?![A-Za-z0-9_\-])"),
]
_NUMBER = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$")
# `Authorization: Bearer <token>` is a scheme word plus a token; the Bearer rule takes the token.
_LITERALS = {"none", "null", "true", "false", "nan", "inf", "bearer", "basic", REDACTED.lower()}


def _keep_value(raw: str) -> bool:
    """``None``, numbers and short words are never redacted."""
    inner = raw
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"":
        inner = raw[1:-1]
    if inner.lower() in _LITERALS or _NUMBER.match(inner):
        return True
    return len(inner) < _MIN_VALUE_LEN


def _kv_sub(m: re.Match) -> str:
    value = m.group("value")
    if _keep_value(value):
        return m.group(0)
    if not m.group("vq") and m.string[m.end() : m.end() + 1] in ("(", "["):
        return m.group(0)  # `api_key = getenv("X")`, `token = cfg["t"]`: code, not a secret
    q = m.group("vq") or ""
    return "%s%s%s%s%s" % (m.group("key"), m.group("sep"), q, REDACTED, q)


def redact(text: str) -> str:
    if not text or not isinstance(text, str):
        return text
    out = _KV.sub(_kv_sub, text)
    out = _BEARER.sub(lambda m: m.group("prefix") + REDACTED, out)
    for pat in _TOKENS:
        out = pat.sub(REDACTED, out)
    return out


# Event fields that carry user-visible text (`url`: an `http.exchange` row's). Everything else (paths, ids,
# base64 step arrays, range tables) is structural and left alone: a base64 run of 20 upper/digit chars is not a key.
_TEXT_FIELDS = frozenset({"text", "value", "message", "traceback", "context", "capped", "keyRepr", "detail", "instrumentedSource", "url"})


def redact_value(obj: Any) -> Any:
    """Redact the text fields of an event, value node or reply tree in place (and return it)."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, str):
                if k in _TEXT_FIELDS:
                    obj[k] = redact(v)
            elif isinstance(v, (dict, list)):
                redact_value(v)
    elif isinstance(obj, list):
        for item in obj:
            if isinstance(item, (dict, list)):
                redact_value(item)
    return obj


__all__ = ["REDACTED", "redact", "redact_value"]
