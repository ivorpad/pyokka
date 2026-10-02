"""``pyokka run FILE --save run.json``: run through a ``serve`` runner and write the saved run.

The file is ``{"meta": {...}, "events": [...]}`` (``docs/PROTOCOL.md``, "Saved run"). Every
event is redacted before it is written. With ``--keep`` the runner lives on behind a keeper
(``keep.py``) and ``meta.keep`` says how to reach it.
"""

from __future__ import annotations

import base64
import datetime as _dt
import hashlib
import importlib.util
import json
import os
import sys
from typing import Any, Callable

from .. import __version__
from ..redact import redact, redact_value
from . import keep as keep_mod
from .link import LinkClosed, PipeLink, SocketLink


def read_text(path: str) -> str:
    with open(path, "rb") as fh:
        return importlib.util.decode_source(fh.read())


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def file_hash(path: str) -> str | None:
    try:
        return sha256_text(read_text(path))
    except (OSError, UnicodeDecodeError, SyntaxError):
        return None


def build_request(path: str, content: str, *, library_code: bool, record_locals: bool, auto_log: bool, timeout_ms: int, argv: list[str], run_id: str, http: str = "off", http_observe: bool = True, recording: dict | None = None) -> dict:
    """``recording`` holds the run's limits as config keys: ``maxTraceSteps``, ``exclude``, ``only``, ``maxValueChars`` (the ones given)."""
    request = {
        "type": "run",
        "runId": run_id,
        "file": {"path": path, "displayName": os.path.basename(path), "content": content},
        "workspaceRoot": os.path.dirname(path),
        "cwd": os.path.dirname(path),
        "argv": list(argv),
        "env": {},
        "projectFiles": [],
        "config": {"timeoutMs": int(timeout_ms), "libraryCode": bool(library_code), "recordLocals": bool(record_locals), "autoLog": bool(auto_log), "http": http, "httpObserve": bool(http_observe)},
        "markers": [],
        "expressionsToEvaluate": {},
        "watch": [],
        "mode": "normal",
    }
    request["config"].update({k: v for k, v in (recording or {}).items() if v not in (None, [])})
    return request


def save_run(file: str, out_path: str, *, library_code: bool = False, keep: bool = False, record_locals: bool = True, auto_log: bool = False, timeout_ms: int = 0, argv: list[str] | None = None, http: str = "off", http_observe: bool = True, progress: Callable[[str], None] | None = None, recording: dict | None = None, python: Any = None) -> dict:
    """Run ``file`` and write ``out_path``. Returns the meta written (``exitCode`` included).

    ``http`` (``off`` | ``record`` | ``replay``) is the run's ``config.http`` and ``http_observe`` its
    ``config.httpObserve`` (false: the HTTP clients are left alone, no ``http.exchange`` rows);
    ``meta.config`` records both. ``recording`` adds the run's limits (``build_request``); ``python`` is
    the ``interpreter.Interpreter`` the runner starts under (pyokka's own when None)."""
    path = os.path.abspath(file)
    content = read_text(path)
    run_id = "cli-%d" % int(_dt.datetime.now().timestamp() * 1000)
    request = build_request(path, content, library_code=library_code, record_locals=record_locals, auto_log=auto_log, timeout_ms=timeout_ms, argv=argv or [], run_id=run_id, http=http, http_observe=http_observe, recording=recording)
    started = _dt.datetime.now(_dt.timezone.utc)
    keep_info: dict | None = None
    if keep:
        sock = keep_mod.socket_path()
        pid = keep_mod.spawn(sock, python=python.path if python is not None else None)
        keep_info = {"pid": pid, "socket": sock}
        link: Any = SocketLink(sock, timeout=15.0)
    else:
        link = PipeLink(python=python.path if python is not None else None, cwd=os.path.dirname(path))
    events: list[dict] = []
    finished: dict | None = None
    try:
        ready = link.call({"type": "hello", "version": __version__})
        ok = link.call(request, events.append)
        if ok.get("type") == "error":
            raise RuntimeError(ok.get("message") or "run request refused")
        while True:
            msg = link.recv()
            if msg.get("runId") != run_id:
                continue
            events.append(msg)
            if msg.get("type") == "run.finished":
                finished = msg
                break
    except LinkClosed as exc:
        if finished is None:
            raise RuntimeError("the runner stopped before the run finished: %s" % exc) from exc
    finally:
        if keep:
            link.close()  # the keeper stays; only this connection goes
        else:
            link.close()
    for ev in events:
        redact_value(ev)
    from .walkthrough import is_user_file

    files: list[dict] = []
    for ev in events:
        if ev.get("type") == "file.instrumented":
            p = str(ev.get("path"))
            digest = sha256_text(content) if os.path.abspath(p) == path else file_hash(p)
            entry: dict[str, Any] = {"fileId": ev.get("fileId"), "path": p, "sha256": digest}
            # the user's own files keep the text that ran, so `pyokka diff` can read a run after the edit
            if is_user_file(p, request["workspaceRoot"], path):
                try:
                    entry["source"] = redact(content if os.path.abspath(p) == path else read_text(p))
                except (OSError, UnicodeDecodeError, SyntaxError):
                    pass
            files.append(entry)
    meta: dict[str, Any] = {
        "runtimeVersion": ready.get("runtimeVersion") or __version__,
        "python": ready.get("pythonVersion") or sys.version.split()[0],
        "executable": ready.get("executable") or sys.executable,
        "interpreterSource": python.source if python is not None else "pyokka's own",
        "runId": run_id,
        "file": path,
        "workspaceRoot": request["workspaceRoot"],
        "argv": request["argv"],
        "config": request["config"],
        "started": started.isoformat(timespec="seconds"),
        "durationMs": (finished or {}).get("durationMs"),
        "exitCode": (finished or {}).get("exitCode"),
        "stepCount": (finished or {}).get("stepCount"),
        "files": files,
    }
    if keep_info is not None:
        meta["keep"] = keep_info
    trace = next((e for e in reversed(events) if e.get("type") == "trace" and not e.get("partial")), None)
    if trace is not None and trace.get("truncated"):
        from .recording import cap_info
        from .source import display_path

        kept = len(base64.b64decode(str(trace.get("steps") or ""))) // 16
        meta["recording"] = cap_info(trace, meta, lambda p: display_path(p, request["workspaceRoot"]), kept)
    out_abs = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_abs) or ".", exist_ok=True)
    tmp = out_abs + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"meta": meta, "events": events}, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    os.replace(tmp, out_abs)
    if progress is not None:
        progress(summary_line(out_abs, meta, events))
    return meta


def summary_line(out_path: str, meta: dict, events: list[dict]) -> str:
    uncaught = next((e for e in events if e.get("type") == "error" and not e.get("handled")), None)
    cap = meta.get("recording") if isinstance(meta.get("recording"), dict) else None
    steps = "%s of %s steps recorded" % (format(cap["kept"], ","), format(meta.get("stepCount"), ",") if isinstance(meta.get("stepCount"), int) else "?") if cap else "%s steps" % meta.get("stepCount")
    bits = ["saved %s: %s, %d files, exit %s" % (out_path, steps, len(meta.get("files") or []), meta.get("exitCode"))]
    if uncaught is not None:
        bits.append("error: %s: %s" % (uncaught.get("errorType"), str(uncaught.get("message", ""))[:160]))
    if isinstance(meta.get("recording"), dict):
        from .recording import warning_lines

        bits.extend(warning_lines(meta["recording"]))
    if meta.get("keep"):
        bits.append("kept: pid %s, socket %s" % (meta["keep"]["pid"], meta["keep"]["socket"]))
    return "\n".join(bits)


__all__ = ["save_run", "read_text", "sha256_text", "file_hash", "build_request", "summary_line"]
