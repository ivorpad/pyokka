"""Where the person is looking, and how a stop moves their view there.

``detect`` names the surface: ``page`` when a Pyokka bridge answers ``GET /api/state`` on the port
with one browser tab connected, ``vscode-debug`` when a live VS Code session is paused in the
debugger, ``vscode-recording`` when a live session holds a finished recording, else ``chat``.
``move_to`` moves that surface to a stop: the page gets ``goto step_b`` with the ``say`` text (refused
when the page shows another file than the review's entry), a debug session gets a breakpoint at the
stop's line with a condition made of up to two of the stop's locals whose text is a literal, then
``continue``; a recording session gets ``step --to step_b``; chat moves nothing. Nothing here starts
a server or opens an editor: a missing surface is reported, never created.
"""

from __future__ import annotations

import ast
import json
import os
import urllib.error
import urllib.request
from typing import Any

from ..live import LiveRun, list_sessions, stop_reason
from ..sessions import _file_matches, descriptor_kind, pick_session
from ..source import AgentError
from ..web import DEFAULT_PORT, listening

SURFACES = ("page", "vscode-debug", "vscode-recording", "chat")
STATE_TIMEOUT_S = 3.0  # a bridge with a tab answers at once; one whose tab hangs waits 15 s, which detect must not
COMMAND_TIMEOUT_S = 30.0
CONDITION_VALUES = 2
LITERAL_MAX = 80


def default_port(port: Any = None) -> int:
    """``port``, else ``$PYOKKA_PORT``, else 4777: the bridge's own rule."""
    if port not in (None, "", 0, False):
        return int(port)
    return int(os.environ.get("PYOKKA_PORT") or DEFAULT_PORT)


# -- the page ---------------------------------------------------------------------------------------------

def http_json(port: int, path: str, payload: dict | None = None, timeout: float = COMMAND_TIMEOUT_S) -> tuple[int, Any]:
    """One request to the bridge: ``GET`` without a payload, ``POST`` JSON with one; ``(status, decoded body)``."""
    url = "http://127.0.0.1:%d%s" % (port, path)
    if payload is None:
        req = urllib.request.Request(url)
    else:
        req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, json.loads(res.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(body)
        except ValueError:
            return exc.code, {"error": body.strip() or exc.reason}


def page_state(port: int) -> dict | None:
    """``{url, file, pages, state, error?}`` from ``GET /api/state``, or None when nothing answers on the port
    (a sandbox that blocks the connection counts as nothing, since no page could be moved through it)."""
    try:
        if not listening(port, 0.5):
            return None
    except AgentError:
        return None
    try:
        _, body = http_json(port, "/api/state", timeout=STATE_TIMEOUT_S)
    except (OSError, ValueError):
        return None
    return body if isinstance(body, dict) else None


def page_is_open(state: dict | None) -> bool:
    return isinstance(state, dict) and state.get("pages") == 1


# -- VS Code ----------------------------------------------------------------------------------------------

def _sessions(session: str | None, entry: str | None = None) -> list[dict]:
    """The live descriptors, debug sessions first.

    ``session`` keeps the ones on that file or the exact descriptor path (a file may have both
    kinds); without it, ``entry`` keeps the ones on the review's entry, so a session paused on some
    other file is never read or moved.
    """
    sessions = list_sessions()
    wanted_file = session or entry
    if wanted_file:
        wanted = os.path.abspath(wanted_file)
        sessions = [d for d in sessions if d.get("descriptor") == wanted or _file_matches(d, wanted_file)]
    return sorted(sessions, key=lambda d: descriptor_kind(d) != "debug")


def classify(descriptor: dict) -> tuple[str | None, LiveRun | None]:
    """``vscode-debug`` for a session paused in the debugger, ``vscode-recording`` for a run session with a recording, else None; the open connection rides along."""
    try:
        live = LiveRun(descriptor)
    except AgentError:
        return None, None
    try:
        state = live.state()
    except AgentError:
        live.close()
        return None, None
    dbg = state.get("debug")
    if isinstance(dbg, dict) and isinstance(dbg.get("paused"), dict):
        return "vscode-debug", live
    if descriptor_kind(descriptor) == "run" and (state.get("finished") or int((state.get("nav") or {}).get("count") or 0) > 0):
        return "vscode-recording", live
    live.close()
    return None, None


def detect_vscode(session: str | None, entry: str | None = None) -> tuple[str, LiveRun | None]:
    """The VS Code surface among the live sessions (``session``, else ``entry``, narrows them): a debug pause wins over a recording; ``chat`` when neither."""
    recording: LiveRun | None = None
    for d in _sessions(session, entry):
        kind, live = classify(d)
        if kind == "vscode-debug":
            if recording is not None:
                recording.close()
            return kind, live
        if kind == "vscode-recording" and recording is None:
            recording = live
        elif live is not None:
            live.close()
    return ("vscode-recording", recording) if recording is not None else ("chat", None)


def detect(port: int | None, session: str | None, entry: str | None = None) -> str:
    """``page`` | ``vscode-debug`` | ``vscode-recording`` | ``chat``: the first surface that answers (VS Code sessions on ``entry`` only, unless ``session`` names one)."""
    if page_is_open(page_state(default_port(port))):
        return "page"
    kind, live = detect_vscode(session, entry)
    if live is not None:
        live.close()
    return kind


# -- the condition ----------------------------------------------------------------------------------------

def is_literal(text: Any) -> bool:
    """Whether a rendered value is a Python literal the debugger can compare against (no cut, no object repr)."""
    if not isinstance(text, str) or not text.strip() or len(text) > LITERAL_MAX or "…" in text or "(value not recorded)" in text:
        return False
    try:
        ast.literal_eval(text.strip())
    except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
        return False
    return True


def condition_for(stop: dict, limit: int = CONDITION_VALUES) -> str | None:
    """``name == <text> and name2 == <text2>`` from the stop's locals that are live at ``step_b`` (observed at or before it)
    and literal; the anomaly's own name first, then the latest; None when there is none."""
    step_b = stop.get("step_b")
    latest: dict[str, tuple[int, str]] = {}
    for v in stop.get("locals") or []:
        name, text, step = v.get("name"), v.get("text"), v.get("step")
        if not isinstance(name, str) or not name.isidentifier() or not is_literal(text):
            continue
        if step_b is not None and step is not None and int(step) > int(step_b):
            continue
        at = int(step) if step is not None else -1
        if name not in latest or at >= latest[name][0]:
            latest[name] = (at, str(text).strip())
    if not latest:
        return None
    order = sorted(latest, key=lambda n: (n != stop.get("name"), -latest[n][0]))
    return " and ".join("%s == %s" % (n, latest[n][1]) for n in order[:limit])


# -- moving -----------------------------------------------------------------------------------------------

def _head_meta(head_json: Any) -> dict:
    if isinstance(head_json, dict):
        return head_json.get("meta") or head_json
    try:
        with open(str(head_json), encoding="utf-8") as fh:
            return (json.load(fh) or {}).get("meta") or {}
    except (OSError, ValueError):
        return {}


def entry_of(head_json: Any) -> str:
    """The review's entry file: the head recording's ``meta.file``."""
    return str(_head_meta(head_json).get("file") or "")


def start_commands(head_json: Any) -> tuple[str, str]:
    """The commands that open a surface on the entry, for a note that found none: a VS Code session (``--record``, so the stops move its Time Machine in any order once it finished) and the page."""
    entry = entry_of(head_json) or "ENTRY"
    root = str(_head_meta(head_json).get("workspaceRoot") or os.path.dirname(entry) or "REPO")
    return "pyokka debug %s --record --cwd %s" % (entry, root), "pyokka web %s --cwd %s" % (entry, root)


def no_session_note(session: str | None, head_json: Any) -> str:
    """The note of a ``--surface vscode`` stop with no session to move: which file was looked for and the command that starts one."""
    which = ("matches %s" % session) if session else ("on %s" % (os.path.basename(entry_of(head_json)) or "the entry"))
    return "no live VS Code session %s; start one on the entry (%s, let it finish) and stop again" % (which, start_commands(head_json)[0])


def _same_file(a: str | None, b: str | None) -> bool:
    return bool(a and b) and os.path.realpath(str(a)) == os.path.realpath(str(b))


def stop_file(stop: dict, head_json: Any) -> str:
    """The stop's file as a breakpoint wants it: absolute under the head run's root when that file exists, else as the stop names it."""
    file = str(stop.get("file") or "")
    if not file or os.path.isabs(file):
        return file
    meta = _head_meta(head_json)
    root = str(meta.get("workspaceRoot") or os.path.dirname(str(meta.get("file") or "")))
    candidate = os.path.join(root, file) if root else file
    return candidate if os.path.isfile(candidate) else file


def _connect(session: str | None, prefer: str, entry: str) -> LiveRun:
    """The session to move: ``--session`` when given, else the one on the entry; never a session on another file."""
    picked = pick_session(list_sessions(), session=session or (entry or None), file_hint=os.path.basename(entry) if entry else None, prefer=prefer)
    return LiveRun(picked)


def _move_page(stop: dict, say: str | None, port: int, head_json: Any) -> dict:
    state = page_state(port)
    if state is None:
        return {"surface": "page", "moved": False, "note": "no Pyokka page answers on 127.0.0.1:%d" % port}
    if not page_is_open(state):
        return {"surface": "page", "moved": False, "note": str(state.get("error") or "%s browser tabs are open on the page; keep exactly one" % state.get("pages"))}
    entry = entry_of(head_json)
    if not _same_file(state.get("file"), entry):
        return {"surface": "page", "moved": False, "note": "the page on port %d shows %s, not the review's entry %s; nothing moved" % (port, state.get("file"), entry or "(unknown)")}
    step = stop.get("step_b")
    if step is None:
        return {"surface": "page", "moved": False, "note": "the stop has no head step to go to"}
    command = {"action": "goto", "step": int(step), **({"say": say} if say else {})}
    try:
        status, body = http_json(port, "/api/command", command)
    except (OSError, ValueError) as exc:
        return {"surface": "page", "moved": False, "note": "the page did not take the command: %s" % exc}
    error = body.get("error") if isinstance(body, dict) else "unexpected answer"
    if status != 200 or error:
        return {"surface": "page", "moved": False, "note": "the page refused goto %d: %s" % (step, error or "HTTP %d" % status)}
    return {"surface": "page", "moved": True, "note": "page at step %d%s" % (step, " with the explanation shown" if say else ""), "command": command}


def _move_debug(stop: dict, session: str | None, head_json: Any) -> dict:
    line = stop.get("line")
    if line is None:
        return {"surface": "vscode-debug", "moved": False, "note": "the stop has no line to break at"}
    live = _connect(session, "debug", entry_of(head_json))
    try:
        condition = condition_for(stop)
        bp: dict[str, Any] = {"file": stop_file(stop, head_json), "line": int(line)}
        if condition:
            bp["condition"] = condition
        live.breakpoints(add=[bp])
        reply = live.continue_()
    finally:
        live.close()
    out: dict[str, Any] = {"surface": "vscode-debug", "moved": False, "breakpoint": bp, "condition": condition}
    finished = reply.get("finished")
    if isinstance(finished, dict):
        # The stops are ranked, not in run order, so a stop behind the pause is only reached by running
        # again: a `--record` session is now a finished recording and the next `stop` moves its Time
        # Machine; one without a recording restarts.
        again = ("stop %s again moves the Time Machine there" % stop.get("n")) if live.kind == "run" else ("pyokka restart --live --stop-on-entry, then stop %s again" % stop.get("n"))
        out["note"] = "the program ended (exit %s) without reaching %s:%s%s; %s: %s" % (
            finished.get("exitCode"), stop.get("file"), line, (" with %s" % condition) if condition else "",
            "the recording is complete" if live.kind == "run" else "a debug session only runs forward", again)
        return out
    paused = reply.get("paused") if isinstance(reply.get("paused"), dict) else {}
    loc = reply.get("location") or {}
    at_file = str(paused.get("file") or loc.get("file") or "")
    at_line = paused.get("line") if paused.get("line") is not None else loc.get("line")
    here = os.path.basename(at_file) == os.path.basename(str(stop.get("file") or "")) and at_line == int(line)
    out["moved"] = bool(here)
    where = "%s:%s" % (os.path.basename(at_file) or "?", at_line)
    reason = stop_reason(paused) if paused else "stop"
    out["note"] = "paused at %s (%s)%s" % (where, reason, "" if here else "; the stop at %s:%s was not reached" % (stop.get("file"), line))
    return out


def _move_recording(stop: dict, session: str | None, head_json: Any) -> dict:
    step = stop.get("step_b")
    if step is None:
        return {"surface": "vscode-recording", "moved": False, "note": "the stop has no head step to move to"}
    live = _connect(session, "run", entry_of(head_json))
    try:
        reply = live.step(None, to=int(step))
    finally:
        live.close()
    loc = reply.get("location") or {}
    where = "%s:%s" % (os.path.basename(str(loc.get("file") or "")), loc.get("line")) if loc.get("file") else ""
    return {"surface": "vscode-recording", "moved": True, "note": "Time Machine at step %d%s" % (step, ("  " + where) if where else "")}


def move_to(stop: dict, say: str | None, surface: str | None, port: int | None, session: str | None, head_json: Any) -> dict:
    """``{surface, moved, note}``: move the surface to ``stop`` (``auto`` detects; ``vscode`` picks debug over recording).

    A refusal or a surface that stopped answering is ``moved: False`` with the reason in ``note``; nothing raises.
    """
    port = default_port(port)
    chosen = surface or "auto"
    entry = entry_of(head_json)
    try:
        if chosen == "auto":
            chosen = detect(port, session, entry)
            if chosen == "chat":
                in_vscode, on_page = start_commands(head_json)
                return {"surface": "chat", "moved": False, "note": "nothing to move: no page on 127.0.0.1:%d, no VS Code session on %s (start one where the person is: %s, or %s)" % (port, os.path.basename(entry) or "the entry", in_vscode, on_page)}
        elif chosen == "vscode":
            chosen, live = detect_vscode(session, entry)
            if live is not None:
                live.close()
            if chosen == "chat":
                return {"surface": "chat", "moved": False, "note": no_session_note(session, head_json)}
        if chosen == "page":
            return _move_page(stop, say, port, head_json)
        if chosen == "vscode-debug":
            return _move_debug(stop, session, head_json)
        if chosen == "vscode-recording":
            return _move_recording(stop, session, head_json)
        if chosen == "chat":
            return {"surface": "chat", "moved": False, "note": "nothing to move"}
        return {"surface": str(chosen), "moved": False, "note": "unknown surface %r; one of auto, page, vscode, chat" % chosen}
    except AgentError as exc:
        return {"surface": chosen, "moved": False, "note": "%s%s" % (exc.message, (": " + exc.hint) if exc.hint else "")}


__all__ = ["SURFACES", "condition_for", "default_port", "detect", "detect_vscode", "entry_of", "http_json", "is_literal", "move_to", "no_session_note", "page_is_open", "page_state", "start_commands", "stop_file"]
