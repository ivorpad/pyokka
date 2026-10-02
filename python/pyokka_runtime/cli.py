"""``python -m pyokka_runtime run FILE``: run in-process and print events."""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any

from .execute import Execution, RunSpec, install_step_streams
from .protocol import decode_steps, dumps, ev_run_finished


def _pretty(event: dict, out: Any, main: str = "") -> None:
    kind = event.get("type")
    if kind == "log":
        ctx = event.get("context")
        prefix = "%s@%s" % (event.get("kind"), event.get("rid"))
        line = "[%-14s] %s%s" % (prefix, ("%s = " % ctx) if ctx else "", event.get("text", ""))
        if event.get("time"):
            line += "  %s" % event["time"]
        out.write(line + "\n")
    elif kind == "output":
        out.write("[%s] %s" % (event.get("stream"), event.get("text", "")))
        if not str(event.get("text", "")).endswith("\n"):
            out.write("\n")
    elif kind == "error":
        out.write("[error @%s%s] %s: %s\n" % (event.get("rid"), "" if not event.get("handled") else ", handled", event.get("errorType"), event.get("message")))
    elif kind == "coverage":
        states = event.get("states", [])
        summary = {s: states.count(s) for s in sorted(set(states))}
        out.write("[coverage file %s] %s\n" % (event.get("fileId"), summary))
    elif kind == "trace":
        steps = decode_steps(event["steps"])
        out.write("[trace%s] %d steps, %d scopes%s\n" % (" partial" if event.get("partial") else "", len(steps) // 4, len(event.get("scopes", [])), ", truncated" if event.get("truncated") else ""))
        if event.get("truncated") and not event.get("partial"):
            from .agent.recording import cap_info, warning_lines
            from .agent.source import display_path

            for line in warning_lines(cap_info(event, {"file": main}, lambda p: display_path(p, os.path.dirname(main)), len(steps) // 4) or {}):
                out.write(line + "\n")
    elif kind == "time":
        out.write("[time @%s] n=%s total=%.3fms min=%.3f max=%.3f\n" % (event.get("rid"), event.get("n"), event.get("total"), event.get("min"), event.get("max")))
    elif kind == "watch":
        val = event.get("valueBag", {}).get("data", {}).get("value") if event.get("valueBag") else event.get("error")
        out.write("[watch %s step %s] %s\n" % (event.get("watchId"), event.get("step"), val))
    elif kind == "file.instrumented":
        out.write("[file %s] %s: %d ranges, %d statements, %d functions, magic=%s\n" % (event.get("fileId"), event.get("path"), len(event.get("ranges", [])), len(event.get("statements", [])), len(event.get("functions", [])), event.get("magic")))
    elif kind == "locals":
        out.write("[locals] %d entries\n" % len(event.get("entries", [])))
    else:
        out.write("[%s] %s\n" % (kind, {k: v for k, v in event.items() if k not in ("type",)}))


def run_file(args: Any, recording: dict | None = None) -> int:
    path = os.path.abspath(args.file)
    real_stdout = sys.stdout
    seq = [0]

    def emit(event: dict) -> None:
        seq[0] += 1
        event.setdefault("runId", "cli")
        event["seq"] = seq[0]
        if args.json:
            real_stdout.write(dumps(event) + "\n")
        else:
            _pretty(event, real_stdout, path)
        real_stdout.flush()

    request = {
        "type": "run",
        "runId": "cli",
        "file": {"path": path, "displayName": os.path.basename(path)},
        "workspaceRoot": os.path.dirname(path),
        "cwd": os.path.dirname(path),
        "argv": [],
        "env": {},
        "projectFiles": [],
        "config": {"autoLog": bool(args.auto_log), "timeoutMs": int(args.timeout or 0), "recordLocals": bool(args.record_locals), "http": getattr(args, "http", "off"), "libraryCode": bool(getattr(args, "library_code", False)), **{k: v for k, v in (recording or {}).items() if v not in (None, [])}},
        "markers": [],
        "expressionsToEvaluate": {},
        "watch": [{"id": "w%d" % i, "exp": w} for i, w in enumerate(args.watch or [])],
        "mode": args.mode,
    }
    if args.trace_context is not None:
        request["traceContext"] = {"step": args.trace_context, "prefetch": 10}
    spec = RunSpec.from_request(request)
    if args.instrumented:
        from .instrument import InstrumentOptions, Instrumenter

        info = Instrumenter(open(path, encoding="utf-8").read(), path, 1, 0, InstrumentOptions(mode=args.mode, auto_log=bool(args.auto_log))).run()
        real_stdout.write((info.instrumented_source or info.error or "") + "\n")
        return 0
    execution = Execution(spec, emit)
    install_step_streams(emit, lambda: execution.tracer)
    # Same as the run child: no interactive stdin, so input() raises EOFError instead of hanging.
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)
    sys.stdin = open(0, "r", closefd=False)
    started = time.perf_counter()
    emit({"type": "run.started", "pid": os.getpid()})
    try:
        result = execution.run()
    finally:
        sys.stdout = real_stdout
    emit(ev_run_finished(exit_code=result.exit_code, duration_ms=(time.perf_counter() - started) * 1000, timed_out=False, stopped=False, step_count=result.step_count, log_count=result.log_count, profile=result.profile, extra=result.extra))
    return 0


def cache_command(args: Any, out: Any = None) -> int:
    """``pyokka cache``: the library-file cache's directory, entry count and size; ``--clear`` empties it."""
    from . import cache
    from .agent.http import format_bytes

    out = out or sys.stdout
    result = cache.clear() if args.clear else cache.status()
    if args.json:
        out.write(json.dumps(result, ensure_ascii=False) + "\n")
        return 0
    if not result["dir"]:
        out.write("library cache off (PYOKKA_CACHE_DIR is empty); nothing to clear\n" if args.clear else "library cache off (PYOKKA_CACHE_DIR is empty)\n")
        return 0
    if args.clear:
        line = "removed %s (%s) from %s" % (_entries(result["removed"]), format_bytes(result["bytes"]), result["dir"])
        if result["failed"]:
            line += "; %s could not be removed (in use or read-only)" % _entries(result["failed"])
    else:
        line = "%s: %s, %s" % (result["dir"], _entries(result["entries"]), format_bytes(result["bytes"]))
    out.write(line + "\n")
    return 0


def _entries(n: int) -> str:
    return "1 entry" if n == 1 else "%d entries" % n
