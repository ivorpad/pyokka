"""Convert a ``cProfile`` run into a Chrome ``.cpuprofile`` JSON file.

The output is a *flat* profile: every function is a child of ``(root)`` with
its self time turned into synthetic samples (one sample per millisecond, at
least one). VS Code's built-in profile table shows self time per function;
the call tree is not reconstructed (cProfile aggregates per caller pair, not
per path).
"""

from __future__ import annotations

import json
import os
import pstats
import re
import tempfile
import time
from typing import Any


RUNTIME_DIR = os.path.dirname(os.path.abspath(__file__))


def _is_runtime_frame(filename: str) -> bool:
    """True for pyokka_runtime's own frames (print capture, event pipe), which are noise in a user profile."""
    if not filename or filename.startswith("<"):
        return False
    return os.path.abspath(filename).startswith(RUNTIME_DIR + os.sep)


def write_cpuprofile(prof: Any, display_name: str) -> str:
    stats = pstats.Stats(prof).stats  # type: ignore[attr-defined]
    nodes: list[dict] = []
    samples: list[int] = []
    deltas: list[int] = []
    root = {"id": 1, "callFrame": {"functionName": "(root)", "scriptId": "0", "url": "", "lineNumber": -1, "columnNumber": -1}, "hitCount": 0, "children": []}
    nodes.append(root)
    next_id = 2
    for (filename, line, name), (cc, nc, tt, ct, callers) in stats.items():
        if _is_runtime_frame(filename):
            continue
        node_id = next_id
        next_id += 1
        self_us = int(tt * 1_000_000)
        k = max(1, round(tt * 1000)) if self_us > 0 else 0
        nodes.append({
            "id": node_id,
            "callFrame": {"functionName": name, "scriptId": str(node_id), "url": _url(filename), "lineNumber": max(int(line) - 1, 0), "columnNumber": 0},
            "hitCount": k,
            "children": [],
            "positionTicks": [{"line": int(line), "ticks": k}] if k else [],
            "callCount": nc,
            "totalTime": ct * 1000,
        })
        root["children"].append(node_id)
        if k:
            per = self_us // k
            for _ in range(k):
                samples.append(node_id)
                deltas.append(per)
    start = int(time.time() * 1_000_000)
    total = sum(deltas)
    profile = {"nodes": nodes, "startTime": start, "endTime": start + total, "samples": samples, "timeDeltas": deltas}
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", display_name) or "scratch"
    fd, path = tempfile.mkstemp(prefix="pyokka-%s-" % safe, suffix=".cpuprofile")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(profile, fh)
    return path


def _url(filename: str) -> str:
    if filename.startswith("<"):
        return ""
    return "file://" + os.path.abspath(filename)
