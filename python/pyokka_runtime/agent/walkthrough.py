"""The walkthrough: what happened, in order, one moment per line (``docs/PROTOCOL.md``, "Walkthrough").

Deterministic and instant: every moment comes from the recording (scope entries, decisions,
loops, logged values, prints, errors) with a templated sentence; a model only ever adds
``gloss`` (``narrate.py``). ``src/session/walkthrough.ts`` is the same builder over a live
session; ``test/unit/fixtures/walkthrough-*.json`` pins both to identical moments.
"""

from __future__ import annotations

import math
import os
from .recording import cut_line
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .source import SavedRun

CAP = 400
PRINT_MAX = 120
VALUE_MAX = 200
INLINE_MAX = 60
_LIBRARY_MARKERS = ("site-packages", "dist-packages")


# -- files ------------------------------------------------------------------------------------------------------

def is_user_file(path: str | None, workspace_root: str, main_file: str | None) -> bool:
    """The main file and files under the workspace that are not an installed package."""
    if not path:
        return False
    if main_file and os.path.abspath(path) == os.path.abspath(main_file):
        return True
    parts = path.split(os.sep)
    if any(p in _LIBRARY_MARKERS for p in parts):
        return False
    root = workspace_root.rstrip(os.sep) + os.sep
    return bool(workspace_root) and path.startswith(root)


def package_of(path: str | None) -> str | None:
    """``openai`` for ``.../site-packages/openai/_client.py``; ``None`` for user files."""
    if not path:
        return None
    for marker in _LIBRARY_MARKERS:
        i = path.rfind(marker + os.sep)
        if i >= 0:
            rest = path[i + len(marker) + 1 :].split(os.sep)
            top = rest[0]
            return top[:-3] if top.endswith(".py") else top
    return None


def library_package(path: str | None) -> str | None:
    """The package a library file belongs to: ``package_of``, else (a path on ``sys.path`` outside
    site-packages, like the e2e suite's ``pylib``) the directory of an ``__init__.py`` or the module's stem."""
    pkg = package_of(path)
    if pkg or not path:
        return pkg
    base = os.path.basename(path)
    if base == "__init__.py":
        return os.path.basename(os.path.dirname(path))
    return base[:-3] if base.endswith(".py") else base


def format_duration(ms: float | None) -> str:
    """``70 ms`` / ``3.7 s``; rounding is half-up on both sides (``src/session/walkthrough.ts`` prints the same)."""
    if ms is None:
        return "?"
    if ms < 1000:
        return "%d ms" % math.floor(ms + 0.5)
    return "%.1f s" % (math.floor(ms / 100 + 0.5) / 10)


def cut(text: Any, limit: int) -> str:
    return cut_line(" ".join(str(text if text is not None else "").split()), limit)


# -- windows and the cap ---------------------------------------------------------------------------------------

def _collapse(moments: list[dict], kind: str, key_of: Any) -> list[dict]:
    firsts: dict[Any, dict] = {}
    out: list[dict] = []
    for m in moments:
        if m["kind"] != kind:
            out.append(m)
            continue
        key = key_of(m)
        if key is None:
            out.append(m)
            continue
        if key in firsts:
            firsts[key]["more"] = int(firsts[key].get("more", 0)) + 1
            continue
        firsts[key] = m
        out.append(m)
    return out


def _drop_inside(moments: list[dict], removed: list[dict]) -> list[dict]:
    """Drop moments that happened inside a collapsed call (its step range)."""
    ranges = [(int(m["entryStep"]), int(m["endStep"])) for m in removed if m.get("entryStep") is not None]
    if not ranges:
        return moments
    return [m for m in moments if not any(a <= int(m["step"]) <= b for a, b in ranges) or m in removed]


def walkthrough(run: "SavedRun", *, file: str | None = None, scope: str | None = None, start: int | None = None, end: int | None = None, all_scopes: bool = False, cap: int = CAP, gloss: dict | None = None) -> dict:
    from .moments import MomentBuilder

    builder = MomentBuilder(run, all_scopes=all_scopes)
    moments = builder.build()
    total = len(moments)
    glosses = gloss if gloss is not None else (run.meta.get("walkthroughGloss") or {})
    for m in moments:
        g = glosses.get(m["id"]) if isinstance(glosses, dict) else None
        m["gloss"] = str(g) if isinstance(g, str) and g else None
    windowed = file is not None or scope is not None or start is not None or end is not None
    if file is not None:
        fid = int(run.resolve_file(file)["fileId"])
        moments = [m for m in moments if m["location"].get("fileId") == fid]
    if scope is not None:
        ranges = [(int(s["first"]), int(s["last"])) for s in run.trace.scopes if str(s["name"]) == scope or builder.scope_qualname(int(s["scopeId"])).endswith(scope)]
        moments = [m for m in moments if any(a <= int(m["step"]) <= b for a, b in ranges) or (m["kind"] in ("call", "tool") and m.get("callee", {}).get("function", "").endswith(scope))]
    if start is not None:
        moments = [m for m in moments if int(m["step"]) >= start]
    if end is not None:
        moments = [m for m in moments if int(m["step"]) <= end]
    capped = False
    truncated = False
    if not windowed and len(moments) > cap:
        capped = True
        before = list(moments)
        moments = _collapse(moments, "call", lambda m: m.get("key"))
        kept = {id(m) for m in moments}
        moments = _drop_inside(moments, [m for m in before if id(m) not in kept])
        if len(moments) > cap:
            moments = _collapse(moments, "value", lambda m: (m["location"].get("fileId"), m["location"].get("line"), m["text"].split(" = ")[0]))
        if len(moments) > cap:
            moments = moments[:cap]
            truncated = True
    for m in moments:
        m.pop("key", None)
    return {
        "count": run.trace.count,
        "total": total,
        "shown": len(moments),
        "capped": capped,
        "truncated": truncated,
        "file": run.meta.get("file"),
        "exitCode": run.meta.get("exitCode"),
        "stale": bool(run.stale_files()),
        "staleFiles": run.stale_files(),
        "moments": moments,
    }


__all__ = ["walkthrough", "is_user_file", "package_of", "library_package", "format_duration", "CAP", "cut"]
