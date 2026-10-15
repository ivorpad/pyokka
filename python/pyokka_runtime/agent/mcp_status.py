"""``pyokka_debug`` action ``status``: the live session's state, after waiting for a pause when the program runs.

The person drives VS Code (a breakpoint, a step) while the agent waits in one tool call. The
watch on the bridge is in place before the state is read, so a pause that lands between the two
is still seen: connection A subscribes (``watch``), connection B reads ``state``; when the debug
run is running, A's next ``paused`` or ``finished`` event ends the wait, else ``wait_seconds`` does.
"""

from __future__ import annotations

import json
import socket
import threading
import time
from typing import Any, Callable

MAX_WAIT_S = 600


def call_status(a: dict, run_words: Callable[[list[str]], tuple[str, bool]], tool_error: Callable[..., Exception]) -> tuple[str, bool]:
    raw = a.get("wait_seconds")
    seconds = 0 if raw is None or raw == "" else int(raw)
    if seconds < 0 or seconds > MAX_WAIT_S:
        raise tool_error("wait_seconds must be 0 to %d, got %d" % (MAX_WAIT_S, seconds))
    session = ["--session=%s" % a["session"]] if a.get("session") else []
    words = ["state", "--live", *session, *(["--json"] if a.get("json") else [])]
    if not seconds:
        return run_words(words)

    from .commands import open_source
    from .shell import build_parser

    source: Any = open_source(build_parser().parse_args(["watch", "--live", *session]))
    subscribed = threading.Event()
    ended = threading.Event()
    stop: list[dict] = []

    def on_event(ev: dict) -> None:
        if ev.get("event") in ("paused", "finished") and not stop:
            stop.append(ev)
            ended.set()

    def follow() -> None:
        try:
            source.watch(on_event, subscribed.set)
        except Exception:  # noqa: BLE001 - a refused watch or a closed bridge ends the wait; the state read says why
            pass
        finally:
            subscribed.set()
            ended.set()

    thread = threading.Thread(target=follow, name="pyokka-mcp-status", daemon=True)
    started = time.monotonic()
    thread.start()
    try:
        subscribed.wait(10)
        text, is_error = run_words(["state", "--live", "--json", *session])
        try:
            now = json.loads(text)
        except ValueError:
            now = {}
        debug = now.get("debug") if isinstance(now, dict) else None
        if is_error or not isinstance(debug, dict) or not debug.get("active") or debug.get("paused"):
            return run_words(words)  # paused already, finished, or no debug run: nothing to wait for
        ended.wait(max(0.0, seconds - (time.monotonic() - started)))
        waited = round(time.monotonic() - started, 1)
        text, is_error = run_words(words)
        if a.get("json"):
            return text, is_error
        if stop:
            ev = stop[0]
            what = "paused" if ev.get("event") == "paused" else "finished: exit %s" % ev.get("exitCode", "?")
            head = "%s after waiting %s s" % (what, waited)
        else:
            head = "still running after %d s" % seconds
        return "%s\n%s" % (head, text), is_error
    finally:
        try:
            source.link.sock.shutdown(socket.SHUT_RDWR)  # wakes the watch thread's read; close alone does not on macOS
        except (AttributeError, OSError):
            pass
        source.close()
        thread.join(2)


__all__ = ["call_status", "MAX_WAIT_S"]
