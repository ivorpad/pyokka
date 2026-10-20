"""Opening the person's view when a ``--full`` review starts, and closing what the review opened.

The default review's view is its debug session (``debugger.py``); this module is the recorded review's.

``review start`` opens VS Code by default: a recording session on the entry, run to its end through
the same interpreter, arguments and cwd as the head recording, so ``stop`` moves its Time Machine to
the step ``head.json`` names. ``--surface page`` serves the browser page instead (a ``pyokka web``
process the review started, so the review stops it) and ``--surface chat`` opens nothing. A review of
one test has no view at all: ``pyokka debug FILE --record`` and ``pyokka web FILE`` run the test file as
a program, which is another run than the test's (its imports and definitions, not the test), so the
review stays in chat and says so, and no hint of this module names either command for it.

Nothing here raises: a view that would not open is reported in ``start``'s answer and the review goes
on in chat. ``review view`` (``open_later``) opens one later, the same way, when ``start`` opened none or
the person moved; every hint that names a way to open a view names it, and no other tool, since a
session started outside the review is another run, which the review does not move. What was opened
is kept in the review state under ``view``; ``report`` and ``close`` stop the page's server through
``close_view``, and a second ``start`` on the same directory stops the first one's. The VS Code
session is left alone: a finished recording runs nothing, and the person keeps reading it.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from typing import Any

from ..source import AgentError
from .state import STATE_FILE, now

ENV_SURFACE = "PYOKKA_REVIEW_SURFACE"
CONTINUES = 8  # a recording that is still paused after this many resumes is not finishing
SERVER_WAIT_S = 20.0
TAB_WAIT_S = 20.0
STOP_WAIT_S = 3.0
MAC_CODE = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"


def code_found() -> str:
    """Where the ``code`` command is, for a hint: ``found at PATH``, else where VS Code ships it on a Mac."""
    try:
        from ..debug_start import code_command

        path = str(code_command() or "")
    except Exception:  # noqa: BLE001  not found, or a debug_start without it
        path = ""
    return ("found at %s" % path) if path else ("not found; on a Mac it ships at %s" % MAC_CODE)


def one_test_note(test: Any) -> str:
    """Why a review of one test has no view: a VS Code session or a page runs a file as a program, never a test, and a debug session
    of the test is another run, which the review does not move. The note names no command: the field review of 2026-10-16 showed an
    agent reading the commands named as the way to make a view, and the commands cannot."""
    return ("a review of one test (%s) stays in chat: no VS Code session and no page can show it, since both run a file as a program and not a test, "
            "and a debug session of the test would be another run, which the review does not move; its stops print in the conversation" % test)


VIEW_VSCODE = 'review view vscode (MCP: pyokka_review {"action": "view", "surface": "vscode"})'
VIEW_PAGE = 'review view page (MCP: pyokka_review {"action": "view", "surface": "page"})'


def start_hints(test: Any = None) -> tuple[str, str]:
    """The review's own commands that open a view later, VS Code and the page, with what VS Code needs. They name no other
    tool: a session started outside the review is another run, which the review does not move (the field reviews of
    2026-10-16 and 2026-10-17 followed a `pyokka debug` hint into one). For a review of one test both are the reason there is none."""
    if test:
        return one_test_note(test), one_test_note(test)
    return ("%s records the entry in VS Code as the review's run; VS Code needs the pyokka.agentAccess setting on and the code command (%s)" % (VIEW_VSCODE, code_found()),
            "%s serves the page; have the person open its URL in one browser tab" % VIEW_PAGE)


def data_hints(data: dict) -> tuple[str, str]:
    """``start_hints`` for a review's state."""
    return start_hints(data.get("test"))


def wanted(f: dict) -> str:
    """``vscode``, ``page`` or ``chat``: ``--surface``, else ``$PYOKKA_REVIEW_SURFACE``, else VS Code."""
    value = str(f.get("surface") or os.environ.get(ENV_SURFACE) or "auto")
    return "vscode" if value == "auto" else value


def open_view(data: dict, f: dict) -> tuple[dict, list[str]]:
    """``(view, lines)``: what ``start`` opened, for the state, and the lines that tell the person (and the agent) where to look."""
    kind = wanted(f)
    if data.get("test"):
        note = one_test_note(data["test"])
        return {"kind": "chat", "why": "test"}, ["view: chat. %s%s. Say so to the person before the first stop; your text is the review." % (note[0].upper(), note[1:])]
    if kind == "chat":
        return {"kind": "chat"}, ["view: chat. Stops print in the conversation and move no editor or page; your text is the review. To show them later: %s; or %s." % data_hints(data)]
    return _open(kind, data, f)


def _open(kind: str, data: dict, f: dict) -> tuple[dict, list[str]]:
    try:
        if kind == "page":
            return open_page(data, f.get("port"))
        if kind == "vscode":
            return open_vscode(data)
        return {"kind": "chat", "why": "unknown surface %r" % kind}, ["view: chat. Unknown surface %r; one of auto, vscode, page, chat." % kind]
    except (AgentError, OSError) as exc:
        hint = getattr(exc, "hint", "") or ""
        message = getattr(exc, "message", None) or str(exc)
        vs, page = data_hints(data)
        return {"kind": "chat", "why": message}, ["view: chat. Could not open %s: %s%s" % ("VS Code" if kind == "vscode" else "the page", message, (". " + hint) if hint else ""),
                                                  "The stops print in the conversation until a view is open: tell the person what the message asks of them, then %s; or %s." % (vs, page)]


# -- a view opened later ---------------------------------------------------------------------------------------------

def open_later(review: Any, f: dict) -> dict:
    """``review view``: open the person's view after ``start`` (it opened none, or the person moved), the same opening as
    ``start``'s on the review's state. A page the review had open is stopped first, since the new view replaces it; a VS Code
    recording stays. The answer's ``next:`` is the review's own: the next stop, or the wait for the person."""
    from .state import result

    data = review.data
    _check_later(review, data, f)
    closed = close_view(data)
    view, lines = open_view(data, f)
    data["view"] = view
    review.save()
    return result(review, [*([closed] if closed else []), *lines], view=view)


def _check_later(review: Any, data: dict, f: dict) -> None:
    """What the asked view needs, before anything opens (as ``start`` checks): an explicit vscode a VS Code to reach, page a free port."""
    if data.get("test"):
        return
    if str(f.get("surface") or "") == "vscode":
        from ..live import list_sessions

        if not list_sessions():
            try:
                from ..debug_start import code_command

                code_command()
            except Exception:  # noqa: BLE001  not found, or a debug_start without it
                raise review.refuse("surface vscode needs VS Code: no live Pyokka session answers and the code command was not found (%s)" % code_found(),
                                    ["VS Code needs the pyokka.agentAccess setting on and the code command: tell the person, and run this again once they have them",
                                     "or the page: %s" % start_hints()[1]],
                                    "review view --surface page, or the stops in chat") from None
    if wanted(f) == "page":
        from ..web import DEFAULT_PORT, listening

        port = int(f.get("port") or os.environ.get("PYOKKA_PORT") or DEFAULT_PORT)
        try:
            taken = listening(port)
        except AgentError:
            return  # a sandbox that blocks the probe: open_page reports what it finds
        if taken:
            raise review.refuse("surface page needs a free port and %d is taken, most likely by another page" % port,
                                ['`pyokka web ctl --port %d state` (MCP: pyokka_page {"action": "state", "port": %d}) shows what it serves' % (port, port)],
                                "review view --surface page --port N with a free N, or --surface vscode")


# -- VS Code ------------------------------------------------------------------------------------------------------------

def open_vscode(data: dict) -> tuple[dict, list[str]]:
    """A recording session on the entry in the person's VS Code, run to its end."""
    from ..debug_start import build_launch, focus_editor, open_debug_session

    entry = os.path.join(str(data["repo"]), str(data["entry"]))
    launch = build_launch(program=entry, args=list(data.get("argv") or []), cwd=str(data["repo"]), env={"PYTHONDONTWRITEBYTECODE": "1"}, python=data.get("python"), record=True)
    source, send, route = open_debug_session(launch)
    try:
        reply = source.debug(launch=send)
        if route in ("uri", "run") and isinstance(reply.get("paused"), dict) and not isinstance(reply.get("finished"), dict):
            focus_editor(str(reply["paused"].get("file") or entry), int(reply["paused"].get("line") or 1))
        for _ in range(CONTINUES):
            if isinstance(reply.get("finished"), dict):
                break
            reply = source.continue_()
    finally:
        source.close()
    finished = reply.get("finished")
    if not isinstance(finished, dict):
        raise AgentError("the recording in VS Code did not finish after %d resumes" % CONTINUES, "look at the editor, or `pyokka state --live`")
    view = {"kind": "vscode", "route": route, "opened_at": now(), "exit": finished.get("exitCode")}
    how = "launched VS Code (code --open-url) and recorded" if route == "uri" else "recorded in the open VS Code window"
    return view, ["view: VS Code. %s %s (exit %s); each stop moves its Time Machine." % (how, os.path.basename(entry), finished.get("exitCode"))]


# -- the page -----------------------------------------------------------------------------------------------------------

def open_page(data: dict, port: Any) -> tuple[dict, list[str]]:
    """``pyokka web ENTRY --open`` as a process of its own; its pid is kept so the review can stop it."""
    from ..web import listening
    from .surfaces import default_port, page_is_open, page_state

    port = default_port(port)
    if listening(port):
        raise AgentError("port %d is taken, most likely by another page" % port, "pass --port N for a free one, or `pyokka web ctl --port %d state` to see what it shows" % port)
    entry = os.path.join(str(data["repo"]), str(data["entry"]))
    log = os.path.join(str(data["dir"]), "web.log")
    argv = [sys.executable, "-m", "pyokka_runtime", "web", entry, "--cwd", str(data["repo"]), "--port", str(port), "--open"]
    if data.get("python"):
        argv += ["--python", str(data["python"])]
    with open(log, "ab") as out:
        proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=out, stderr=out, start_new_session=True, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
    view: dict[str, Any] = {"kind": "page", "pid": proc.pid, "port": port, "opened_at": now(), "log": log}
    if not _wait(lambda: listening(port) or proc.poll() is not None, SERVER_WAIT_S) or proc.poll() is not None:
        close_view({"view": view})
        raise AgentError("the page server did not start on port %d" % port, "its output is in %s" % log)
    url = "http://127.0.0.1:%d/" % port
    if not _wait(lambda: page_is_open(page_state(port)), TAB_WAIT_S):
        return view, ["view: page. Serving %s but no browser tab connected; open it there (the review stops the server at report or close)." % url]
    return view, ["view: page at %s. Each stop moves it, and `try` runs show in its Scratchpad; the review stops the server at report or close." % url]


def _wait(done: Any, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if done():
            return True
        time.sleep(0.2)
    return bool(done())


# -- closing --------------------------------------------------------------------------------------------------------------

def _ours(pid: int, port: Any) -> bool:
    """Whether ``pid`` still runs the page server this review started (a pid can be reused after the server exits)."""
    try:
        done = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return False
    command = done.stdout.strip()
    return bool(command) and ("server.js" in command or "pyokka_runtime" in command) and (not port or str(port) in command)


def _alive(pid: int) -> bool:
    try:
        reaped, _ = os.waitpid(pid, os.WNOHANG)  # our child, when this process started it: a zombie counts as gone
        if reaped == pid:
            return False
    except ChildProcessError:
        pass
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def close_view(data: dict) -> str | None:
    """Stop the page server ``start`` opened; the line that says what happened, or None when the review opened no server."""
    view = data.get("view")
    if not isinstance(view, dict) or view.get("kind") != "page" or not view.get("pid") or view.get("closed"):
        return None
    pid, port = int(view["pid"]), view.get("port")
    if not _alive(pid) or not _ours(pid, port):
        view["closed"] = now()
        return "view: the page server on port %s had already stopped" % port
    try:
        os.killpg(pid, signal.SIGTERM)
    except OSError:
        os.kill(pid, signal.SIGTERM)
    if not _wait(lambda: not _alive(pid), STOP_WAIT_S):
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            pass
        _wait(lambda: not _alive(pid), STOP_WAIT_S)
    view["closed"] = now()
    return "view: stopped the page server on port %s" % port


def close_previous(directory: str) -> None:
    """A second ``start`` on a review directory stops the page server the first one left running."""
    try:
        with open(os.path.join(directory, STATE_FILE), encoding="utf-8") as fh:
            old = json.load(fh)
    except (OSError, ValueError):
        return
    if isinstance(old, dict):
        close_view(old)


__all__ = ["VIEW_PAGE", "VIEW_VSCODE", "close_previous", "close_view", "code_found", "data_hints", "one_test_note", "open_later", "open_view", "start_hints", "wanted"]
