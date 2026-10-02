"""Secret masking: keys and passwords never leave the child process in the clear.

Detecting secrets by the *shape* of a value (``sk-...`` prefixes, entropy) is a
losing game: every provider has its own format. The runtime instead uses two
facts it already has, its provenance:

* **value provenance** - the value of an environment variable whose *name*
  looks secret (``OPENAI_API_KEY``, ``DB_PASSWORD``) is replaced by ``MASK``
  wherever it appears in an outgoing event: inside a repr, a print, an
  exception message, a URL, a header dict. Variables added while the code runs
  (``load_dotenv()``) are picked up as well. This is what GitHub Actions'
  ``add-mask`` does.
* **name provenance** - a ``str``/``bytes`` value sitting under a secret-looking
  name (attribute ``api_key``, dict key ``'password'``, keyword
  ``token=...`` in a repr, a local variable) is masked, whatever the value.

``current`` is the filter of the running execution; the serializer, the
tracer and the emit pipe consult it. The webview only ever sees ``MASK``
(nodes carry ``secret: true`` so it can render them as blurred).
"""

from __future__ import annotations

import functools
import os
import re
from typing import Any

MASK = "••••••••"
MIN_VALUE_LEN = 8

# Whole words after splitting a name on `_`, `-`, `.`, digits and camelCase; adjacent
# pairs are joined too so `api_key`, `apiKey`, `API-KEY` and `apikey` all match.
# Bare `key` is deliberately absent: `for key, value in d.items()` is not a secret.
SECRET_WORDS = frozenset(
    {
        "apikey",
        "accesskey",
        "secretkey",
        "privatekey",
        "signingkey",
        "encryptionkey",
        "sessionkey",
        "masterkey",
        "licensekey",
        "secret",
        "secrets",
        "password",
        "passwd",
        "passphrase",
        "credential",
        "credentials",
        "token",
        "tokens",
        "auth",
        "authorization",
        "bearer",
        "dsn",
    }
)

_NAME_TOKENS = re.compile(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+")
# `name='value'` / `name="value"` / `'name': 'value'` inside a repr (bytes prefix allowed)
_REPR_KWARG = re.compile(r"""(?<![\w'"])([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(b?)('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")""")
_REPR_ITEM = re.compile(r"""(['"])([A-Za-z_][A-Za-z0-9_-]*)\1(\s*:\s*)(b?)('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")""")


def name_tokens(name: str) -> list[str]:
    return [t.lower() for t in _NAME_TOKENS.findall(name)]


def is_secret_name(name: Any, extra: frozenset[str] = frozenset()) -> bool:
    """``api_key``, ``ADMIN_API_KEY``, ``webhook_secret``, ``password`` -> True; ``key``, ``author`` -> False."""
    if not isinstance(name, str) or not name:
        return False
    return _secret_words(name, extra)


@functools.lru_cache(maxsize=4096)
def _secret_words(name: str, extra: frozenset[str]) -> bool:
    parts = name_tokens(name)
    for i, p in enumerate(parts):
        if p in SECRET_WORDS or p in extra:
            return True
        if i + 1 < len(parts) and (p + parts[i + 1]) in SECRET_WORDS:
            return True
    return False


class SecretFilter:
    def __init__(self, enabled: bool = True, names: list[str] | tuple[str, ...] = ()) -> None:
        self.enabled = enabled
        self.extra = frozenset(t for n in names for t in name_tokens(str(n)))
        self.values: set[str] = set()
        self._pattern: re.Pattern[str] | None = None
        self._env_size = -1

    # -- value provenance ------------------------------------------------------------
    def add_value(self, value: str) -> None:
        if isinstance(value, str) and len(value) >= MIN_VALUE_LEN and value not in self.values:
            self.values.add(value)
            self._pattern = None

    def refresh_env(self) -> None:
        """Pick up variables the program added (``load_dotenv``); cheap when nothing changed."""
        if not self.enabled:
            return
        env = os.environ
        if len(env) == self._env_size:
            return
        self._env_size = len(env)
        for k, v in list(env.items()):
            if self.secret_name(k):
                self.add_value(v)

    def _compiled(self) -> re.Pattern[str] | None:
        if self._pattern is None and self.values:
            alts = sorted(self.values, key=len, reverse=True)
            self._pattern = re.compile("|".join(re.escape(v) for v in alts))
        return self._pattern

    # -- name provenance -------------------------------------------------------------
    def secret_name(self, name: Any) -> bool:
        return self.enabled and is_secret_name(name, self.extra)

    def mask_leaf(self, node: dict) -> dict:
        """A value node under a secret name: ``str``/``bytes`` become the mask, others are left alone."""
        if not self.enabled or node.get("secret"):
            return node
        if node.get("type") in ("str", "bytes"):
            node["value"] = MASK
            node.pop("capped", None)
            node["secret"] = True
        return node

    def mask_text(self, name: Any, obj: Any, text: str) -> str:
        """Inline text for ``name = obj``: the quoted mask when the name is secret and the value a string."""
        if self.secret_name(name) and isinstance(obj, (str, bytes, bytearray)):
            return ("b%r" if isinstance(obj, (bytes, bytearray)) else "%r") % MASK
        return self.scrub(text)

    # -- text -------------------------------------------------------------------------
    def scrub(self, text: str) -> str:
        """Known secret values and ``secret_name=<literal>`` pairs inside a repr, masked."""
        if not self.enabled or not isinstance(text, str) or not text:
            return text
        pat = self._compiled()
        if pat is not None:
            text = pat.sub(MASK, text)
        if "=" in text:
            text = _REPR_KWARG.sub(self._kwarg, text)
        if ":" in text:
            text = _REPR_ITEM.sub(self._item, text)
        return text

    def _kwarg(self, m: re.Match[str]) -> str:
        if not self.secret_name(m.group(1)):
            return m.group(0)
        return "%s%s%s%s%s%s" % (m.group(1), m.group(2), m.group(3), m.group(4)[0], MASK, m.group(4)[-1])

    def _item(self, m: re.Match[str]) -> str:
        if not self.secret_name(m.group(2)):
            return m.group(0)
        return "%s%s%s%s%s%s%s%s" % (m.group(1), m.group(2), m.group(1), m.group(3), m.group(4), m.group(5)[0], MASK, m.group(5)[-1])

    # -- events -----------------------------------------------------------------------
    def scrub_event(self, event: Any) -> Any:
        """Every string in an outgoing event, scrubbed (copy on write). Value nodes whose ``value`` changed get ``secret: true``."""
        if not self.enabled:
            return event
        self.refresh_env()
        if self._compiled() is None:
            # only the name rule can apply, and the serializer / tracer already applied it
            return event
        return self._walk(event)

    def _walk(self, obj: Any) -> Any:
        if isinstance(obj, str):
            pat = self._compiled()
            return pat.sub(MASK, obj) if pat is not None else obj
        if isinstance(obj, dict):
            out = None
            for k, v in obj.items():
                if k == "steps":
                    continue  # base64 step buffer: numbers only
                nv = self._walk(v)
                if nv is not v:
                    if out is None:
                        out = dict(obj)
                    out[k] = nv
                    if k == "value" and "type" in obj:
                        out["secret"] = True
            return obj if out is None else out
        if isinstance(obj, list):
            out_list = None
            for i, v in enumerate(obj):
                nv = self._walk(v)
                if nv is not v:
                    if out_list is None:
                        out_list = list(obj)
                    out_list[i] = nv
            return obj if out_list is None else out_list
        return obj


current = SecretFilter(enabled=False)


def install(enabled: bool, names: list[str] | tuple[str, ...] = ()) -> SecretFilter:
    """Make ``filter`` the execution's filter (seeds it from the environment)."""
    global current
    current = SecretFilter(enabled, names)
    current.refresh_env()
    return current
