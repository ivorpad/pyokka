"""The last `pyokka debug` launch per directory, so a debugger command with no session starts it again.

A debug session ends with its program. The next `continue --live` used to answer `no live session`,
and an agent then had to rebuild the launch it had already typed. Instead `pyokka debug` records the
launch here, keyed by the directory it was run from, and `break`, `continue` and `restart` with no
debug session start that launch again and print its first stop. Re-running a program repeats its
side effects, so the reply says what it re-ran, and `--no-start` refuses instead.
"""
from __future__ import annotations

import json
import os
import time
from typing import Any

from .live import sessions_dir

#: the verbs that start the remembered launch when no debug session exists
RELAUNCH_VERBS = frozenset({"break", "continue", "restart"})


def memory_path() -> str:
    """Beside the sessions directory, never in it: everything there is read as a descriptor."""
    return os.path.join(os.path.dirname(os.path.abspath(sessions_dir())), "last-debug.json")


def _load() -> dict:
    try:
        with open(memory_path(), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def remember(launch: dict, at: str | None, also: list[str] | None = None, *, cwd: str | None = None) -> None:
    """Record `launch` as the last one started from `cwd`. A failure to write loses only the convenience."""
    key = os.path.realpath(cwd or os.getcwd())
    data = _load()
    data[key] = {"launch": launch, "at": at, "also": list(also or []), "savedAt": time.time()}
    path = memory_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = "%s.%d.tmp" % (path, os.getpid())
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
        os.replace(tmp, path)
    except OSError:
        pass


def recall(cwd: str | None = None) -> dict | None:
    """The launch last started from `cwd` or the nearest directory above it; None when there is none."""
    here = os.path.realpath(cwd or os.getcwd())
    data = _load()
    best: tuple[int, dict] | None = None
    for key, entry in data.items():
        if not isinstance(entry, dict) or not isinstance(entry.get("launch"), dict):
            continue
        if here == key or here.startswith(key.rstrip(os.sep) + os.sep):
            if best is None or len(key) > best[0]:
                best = (len(key), entry)
    return best[1] if best else None


def command_line(launch: dict, at: str | None, also: list[str] | None = None) -> str:
    """The `pyokka debug` command that would start `launch`, for the reply to name what it re-ran."""
    parts = ["pyokka debug"]
    if launch.get("module"):
        parts.append("--module %s" % launch["module"])
    elif launch.get("program"):
        parts.append(os.path.relpath(str(launch["program"])))
    for one in [at, *(also or [])]:
        if one:
            parts.append("--at %s" % one)
    if launch.get("recordFrom"):
        parts.append("--record-from %s" % launch["recordFrom"])
    elif launch.get("record"):
        parts.append("--record")
    if launch.get("args"):
        parts.append("--args %s" % " ".join(str(a) for a in launch["args"]))
    return " ".join(parts)


def has_debug_session(descriptors: list[Any]) -> bool:
    from .sessions import descriptor_kind

    return any(descriptor_kind(d) == "debug" for d in descriptors)


__all__ = ["RELAUNCH_VERBS", "command_line", "has_debug_session", "memory_path", "recall", "remember"]
