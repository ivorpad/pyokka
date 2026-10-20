"""``pyokka debug FILE``: the three routes to a window (docs/design/debugger-product.md, 3.10).

In order, stopping at the first that applies:

(a) a ``kind: "debug"`` descriptor whose launch matches: connect and read the current pause.
(b) else a ``kind: "run"`` descriptor for the file: send ``debug`` with the launch over that
    socket. The window is already answering, which sidesteps the focused-window problem of (c).
(c) else the URI: ``<code> --open-url vscode://ivor.pyokka/debug?…``, then poll
    ``$PYOKKA_HOME/sessions`` (``~/.pyokka/sessions`` by default) for the descriptor the window writes and connect to it.
    The URI carries ``windowId`` of the window the command was invoked from when one is known
    (``vscode_window.py``), so VS Code hands it to that window rather than the focused one.

When the invoking window is known from the terminal or the process tree, (a) and (b) prefer its
sockets, and (b) takes only its own: a recording in another window would start the debug session there.

Only user-writable paths are involved: that sessions directory and the ``code`` binary the user
already has. No admin rights, no privileged step.
"""

from __future__ import annotations

import calendar
import json
import os
import re
import shutil
import subprocess
import time
from typing import Any
from urllib.parse import quote

from .live import LiveRun, list_sessions, read_descriptor, sessions_dir
from .sessions import descriptor_kind
from .source import AgentError
from .web import code_launchers

#: how long the CLI waits for the window to write a descriptor, and how often it looks
POLL_TIMEOUT_S = 20.0
POLL_INTERVAL_S = 0.1
#: a descriptor written this long before the request still counts (clock slack between processes)
CLOCK_SLACK_S = 1.0

URI_PREFIX = "vscode://ivor.pyokka/debug?"

CODE_MISSING = "cannot find the `code` command"
CODE_MISSING_HINT = 'VS Code may not be installed (https://code.visualstudio.com); if it is, install it from VS Code\'s Command Palette ("Shell Command: Install code command in PATH"), or set PYOKKA_CODE to the binary'

EXTENSION_ID = "ivor.pyokka"

TIMEOUT_HINT = (
    "look at the VS Code window first: the first time, VS Code asks whether to let Pyokka open the URI and waits for an answer. "
    "Click Open and the session starts anyway, however late the click comes, so `pyokka state --live` is the next command, not a "
    "second `debug`. To stop VS Code asking, add `ivor.pyokka` to the setting `extensions.confirmedUriHandlerExtensionIds`. "
    "Then check `pyokka.agentAccess`: with it off the window asks whether to allow agents, and Allow starts this same launch, so the "
    "answer to that question is also followed by `pyokka state --live`. "
    "Then check that the folder is open in VS Code with the Pyokka extension active: the URI goes to the window the agent runs in when Pyokka can tell which, else to the focused window, and a window "
    "that is not running Pyokka cannot answer. The Pyokka output channel logs every URI it received."
)

AT_UNREADABLE = "--at wants FILE:LINE or a function name"

#: a function name ``--at`` accepts: ``rrf``, or ``Ranker.rank`` for a method
AT_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$")


def build_launch(*, program: str | None = None, module: str | None = None, args: list[str] | None = None, cwd: str | None = None, env: dict[str, str] | None = None, python: str | None = None, stop_on_entry: bool = False, library_code: bool = False, record: bool = False, record_from: str | None = None) -> dict:
    """The launch the host parses: absolute paths, a dotted module, the flags that are set."""
    if not program and not module:
        raise AgentError("debug needs a file or --module M", "e.g. `pyokka debug app.py`, or `pyokka debug --module app.server --args --port 8000`")
    if program and module:
        raise AgentError("give a file or --module, not both", "a module launch has no file: `pyokka debug --module app.server`")
    launch: dict[str, Any] = {"args": list(args or []), "env": dict(env or {}), "stopOnEntry": bool(stop_on_entry), "libraryCode": bool(library_code), "record": bool(record)}
    if program:
        launch["program"] = os.path.abspath(program)
    if module:
        launch["module"] = module
    launch["cwd"] = os.path.abspath(cwd) if cwd else (os.path.dirname(launch["program"]) if program else os.getcwd())
    if python:
        from .interpreter import on_path

        launch["python"] = on_path(python, "--python")
    if record_from:
        launch["record"] = True  # recording from a pause is a recording session that starts later
        launch["recordFrom"] = record_from
    return launch


def parse_at(at: str) -> dict:
    """``FILE:LINE`` -> ``{"file": F, "line": L}``; a function name -> ``{"function": NAME}``.

    The runtime resolves a function name, not the host: a module imported later gets its
    breakpoint when it loads, which an AST scan of the program cannot do.
    """
    value = (at or "").strip()
    file, _, line = value.rpartition(":")
    if file and line.isdigit() and int(line) >= 1:
        return {"file": file, "line": int(line)}
    if AT_NAME_RE.match(value):
        return {"function": value}
    raise AgentError("%s, got %r" % (AT_UNREADABLE, at), "e.g. `--at rrf` for a function, `--at app.py:42` for a line")


def resolve_at(at: str) -> dict:
    """``parse_at``, with ``FILE`` resolved against the directory the CLI was run in.

    ``build_launch`` makes ``program`` absolute against the invocation directory; ``--at`` used to
    travel as typed and was resolved again at the other end, against the launch cwd — which
    defaults to the program's own directory. ``pyokka debug pkg/run.py --at pkg/run.py:28`` from
    the parent of ``pkg`` therefore asked for ``pkg/pkg/run.py:28``: a breakpoint that never
    resolved and said nothing, so the run paused on whatever else was set and looked like it had
    worked (``src/debug/debugUri.ts`` for the other end of it).

    A file that is not there is refused rather than sent, for the same reason: the failure it
    causes is silent, and it arrives long after the typo.
    """
    spec = parse_at(at)
    if "function" in spec:
        return spec
    given = str(spec["file"])
    line = int(spec["line"])
    path = os.path.abspath(given)
    if os.path.isfile(path):
        return {"file": path, "line": line}
    # a bare name is not a path: the host matches it against the files of the run, which is how a
    # file that is not under the invocation directory is named, so it travels as typed
    if os.sep not in given and (os.altsep or os.sep) not in given:
        return {"file": given, "line": line}
    raise AgentError(
        "--at names no file: %s" % given,
        "--at is resolved from the directory you ran `pyokka` in, like FILE itself; "
        "give `--at %s:%d`, a path that exists from here, or an absolute one" % (os.path.basename(given), line),
    )


def at_text(spec: dict) -> str:
    """A parsed ``--at`` back as the one string the URI and the socket both carry."""
    return str(spec["function"]) if "function" in spec else "%s:%d" % (spec["file"], spec["line"])


def build_uri(launch: dict, at: str | list[str] | None = None, *, window_id: str | None = None) -> str:
    """The ``vscode://ivor.pyokka/debug`` URI of a launch; every value is percent-encoded.

    ``window_id`` is VS Code's own routing key: its URL router sends a URI with ``windowId=N`` to window N.
    """
    parts: list[tuple[str, str]] = []
    if launch.get("program"):
        parts.append(("program", str(launch["program"])))
    if launch.get("module"):
        parts.append(("module", str(launch["module"])))
    if launch.get("args"):
        parts.append(("args", json.dumps(list(launch["args"]), separators=(",", ":"))))
    if launch.get("cwd"):
        parts.append(("cwd", str(launch["cwd"])))
    if launch.get("env"):
        parts.append(("env", json.dumps(dict(launch["env"]), separators=(",", ":"))))
    if launch.get("python"):
        parts.append(("python", str(launch["python"])))
    if launch.get("stopOnEntry"):
        parts.append(("stopOnEntry", "1"))
    if launch.get("record"):
        parts.append(("record", "1"))
    if launch.get("recordFrom"):
        parts.append(("recordFrom", str(launch["recordFrom"])))
    if launch.get("libraryCode"):
        parts.append(("libraryCode", "1"))
    if launch.get("breakOnException") and launch["breakOnException"] != "uncaught":
        parts.append(("breakOnException", str(launch["breakOnException"])))
    for one in ([at] if isinstance(at, str) else list(at or [])):
        if one:
            parts.append(("at", one))  # repeated: every `--at` is set before the program starts
    if window_id:
        parts.append(("windowId", str(window_id)))
    return URI_PREFIX + "&".join("%s=%s" % (k, quote(v, safe="")) for k, v in parts)


def code_command() -> str:
    """``$PYOKKA_CODE`` if set, else ``code`` on PATH, else the launcher where VS Code and Homebrew install it."""
    explicit = os.environ.get("PYOKKA_CODE")
    if explicit:
        return explicit
    found = shutil.which("code")
    if found:
        return found
    tried = code_launchers()
    for candidate in tried:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    raise AgentError(CODE_MISSING, "looked for $PYOKKA_CODE, `code` on PATH, %s. %s" % (", ".join(tried), CODE_MISSING_HINT))


def matches_launch(descriptor: dict, launch: dict) -> bool:
    """A debug descriptor that describes this launch: the same program (by realpath) or module."""
    if descriptor_kind(descriptor) != "debug":
        return False
    d = descriptor.get("launch") if isinstance(descriptor.get("launch"), dict) else {}
    if launch.get("module"):
        return d.get("module") == launch["module"]
    program = launch.get("program")
    if not program:
        return False
    theirs = d.get("program") or descriptor.get("file")
    try:
        return bool(theirs) and os.path.realpath(str(theirs)) == os.path.realpath(str(program))
    except OSError:
        return str(theirs) == str(program)


def find_debug_descriptor(launch: dict, *, since: float | None = None, directory: str | None = None, prefer_pid: int | None = None) -> dict | None:
    """The debug descriptor of this launch, newest first, one in window `prefer_pid` before any other; `since` ignores one written before the request."""
    found = [d for d in list_sessions(directory) if matches_launch(d, launch) and (since is None or _started_at_or_after(d, since))]
    return next((d for d in found if prefer_pid is not None and d.get("pid") == prefer_pid), found[0] if found else None)


def _started_at_or_after(descriptor: dict, since: float) -> bool:
    started = descriptor.get("started")
    if not isinstance(started, str):
        return True  # no timestamp to judge by: take it
    try:
        stamp = calendar.timegm(time.strptime(started[:19], "%Y-%m-%dT%H:%M:%S"))  # the host writes UTC
    except (ValueError, OverflowError):
        return True
    return stamp >= since - CLOCK_SLACK_S


def find_run_descriptor(launch: dict, *, directory: str | None = None, only_pid: int | None = None) -> dict | None:
    """A run-all descriptor for the launch's program: route (b), the common case; with `only_pid`, only window `only_pid`'s."""
    program = launch.get("program")
    if not program:
        return None
    for d in list_sessions(directory):
        if descriptor_kind(d) != "debug" and _same_file(d.get("file"), program) and (only_pid is None or d.get("pid") == only_pid):
            return d
    return None


def _same_file(a: Any, b: Any) -> bool:
    if not a or not b:
        return False
    try:
        return os.path.realpath(str(a)) == os.path.realpath(str(b))
    except OSError:
        return str(a) == str(b)


def build_route(launch: dict, *, directory: str | None = None, caller: tuple[dict | None, str | None] = (None, None)) -> tuple[str, dict | None]:
    """Which route applies: ``('debug', d)``, ``('run', d)`` or ``('uri', None)``.

    ``caller`` is ``vscode_window.invoking_window``'s answer. A window found by the terminal or the process
    tree is where the person is, so its sockets come first and a recording elsewhere is not used; one
    found only by its folder is a guess, which steers the URI and nothing else.
    """
    window, how = caller
    pid = window.get("pid") if window and how in ("terminal", "process") else None
    debug = find_debug_descriptor(launch, directory=directory, prefer_pid=pid)
    if debug is not None:
        return "debug", debug
    run = find_run_descriptor(launch, directory=directory, only_pid=pid)
    if run is not None:
        return "run", run
    return "uri", None


def open_url(uri: str, command: str | None = None) -> None:
    """Hand the URI to VS Code: window ``windowId`` when the URI names one, else the focused one."""
    command = command or code_command()
    try:
        proc = subprocess.run([command, "--open-url", uri], check=False, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise AgentError("cannot run %s: %s" % (command, exc), CODE_MISSING_HINT) from None
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()[-400:]
        raise AgentError("`%s --open-url` failed (exit %d)%s" % (command, proc.returncode, ": " + detail if detail else ""), "set PYOKKA_CODE to a working VS Code launcher; %s" % CODE_MISSING_HINT)


def check_extension(command: str, launch: dict) -> None:
    """Refuse before opening the URI when VS Code lists its extensions and ivor.pyokka is not one of them.

    A launcher that cannot list them (it fails, or takes over 10 s) proves nothing, so the start goes on.
    """
    try:
        proc = subprocess.run([command, "--list-extensions"], check=False, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return
    if proc.returncode != 0:
        return
    if EXTENSION_ID in (proc.stdout or "").lower().split():
        return
    if launch.get("module"):
        cli, mcp = "--module %s" % launch["module"], '"module": %s' % json.dumps(str(launch["module"]))
    else:
        cli, mcp = str(launch.get("program") or "FILE"), '"file": %s' % json.dumps(str(launch.get("program") or "FILE"))
    raise AgentError(
        "the Pyokka extension (%s) is not installed in the VS Code of %s" % (EXTENSION_ID, command),
        'install it with `%s --install-extension %s` (or a .vsix path in place of the id), then start again: `pyokka debug %s` (MCP: pyokka_debug {"action": "start", %s})'
        % (command, EXTENSION_ID, cli, mcp),
    )


def poll_for_descriptor(launch: dict, since: float, *, timeout: float = POLL_TIMEOUT_S, directory: str | None = None) -> dict:
    """Wait for the window to write the debug descriptor of this launch, or say why it did not."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        found = find_debug_descriptor(launch, since=since, directory=directory)
        if found is None and launch.get("record"):
            found = _recording_in_debug(launch, since, directory)
        if found is not None:
            return found
        time.sleep(POLL_INTERVAL_S)
    name = launch.get("module") and "-m %s" % launch["module"] or os.path.basename(str(launch.get("program") or ""))
    raise AgentError("the VS Code window did not start a debug session for %s" % name, TIMEOUT_HINT)


def _recording_in_debug(launch: dict, since: float, directory: str | None) -> dict | None:
    """`--record`: the window runs it as a recording session, whose descriptor is `kind: "run"`.

    It is the one once its debug run has paused: a URI start always pauses first (at the breakpoint,
    or on entry when none can hit), and asking any earlier races the run's own start, where a
    `debug` request would begin a second run.
    """
    from .live import LiveRun

    for d in list_sessions(directory):
        if descriptor_kind(d) == "debug" or not _same_file(d.get("file"), launch.get("program")) or not _started_at_or_after(d, since):
            continue
        try:
            source = LiveRun(d)
            try:
                debug = source.request({"type": "state"}).get("debug")
                if isinstance(debug, dict) and debug.get("paused"):
                    return d
            finally:
                source.close()
        except AgentError:
            continue
    return None


def focus_editor(file: str, line: int) -> bool:
    """Bring the VS Code window to the front at `file:line`, for the first stop of a session an agent started.

    The CLI runs in a terminal, so without this the editor moves to the stop behind it and the user
    sees nothing. `code --goto` picks the window whose workspace holds the file. Best effort: a
    missing launcher or a failed call loses only the convenience. `PYOKKA_NO_FOCUS=1` turns it off.
    """
    if os.environ.get("PYOKKA_NO_FOCUS") or not file or not line:
        return False
    try:
        command = code_command()
        subprocess.Popen([command, "--goto", "%s:%d" % (file, int(line))], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (AgentError, OSError, ValueError):
        return False
    return True


def start_via_uri(launch: dict, at: str | list[str] | None = None, *, timeout: float = POLL_TIMEOUT_S, directory: str | None = None, window_id: str | None = None) -> dict:
    """Route (c): open the URI (aimed at window `window_id` when known), poll for the descriptor, return it.

    With no VS Code running, VS Code is started on the program's repository first, and a failure to start
    it, or a window that never activates Pyokka, is refused with what to do rather than left to the poll.
    """
    command = code_command()
    check_extension(command, launch)
    if not window_id:
        from .vscode_window import launch_window, list_windows, vscode_running

        if not list_windows() and not vscode_running():
            # nothing to hand the URI to: `--open-url` alone would start VS Code on whatever it restores
            window_id = str(launch_window(command, launch).get("windowId") or "") or None
    since = time.time()
    open_url(build_uri(launch, at, window_id=window_id), command)
    return poll_for_descriptor(launch, since, timeout=timeout, directory=directory)


def open_debug_session(launch: dict, at: str | list[str] | None = None, *, timeout: float = POLL_TIMEOUT_S, directory: str | None = None) -> tuple[LiveRun, dict | None, str]:
    """The three routes, in order. Returns the connection, the launch to send over it, and the route.

    Routes (a) and (c) answer on a debug socket, so nothing more has to be said: `debug` reads the
    pause (or waits for the first one). Route (b) answers on a run socket, so the launch goes with
    the request and the host starts the session.
    """
    from .vscode_window import invoking_window

    caller = invoking_window(launch)
    route, descriptor = build_route(launch, directory=directory, caller=caller)
    if route == "debug":
        return LiveRun(descriptor or {}), None, route
    if route == "run":
        return LiveRun(descriptor or {}), launch, route
    window_id = caller[0].get("windowId") if caller[0] else None
    return LiveRun(start_via_uri(launch, at, timeout=timeout, directory=directory, window_id=str(window_id) if window_id else None)), None, route


__all__ = [
    "AT_UNREADABLE",
    "CODE_MISSING",
    "CODE_MISSING_HINT",
    "POLL_TIMEOUT_S",
    "TIMEOUT_HINT",
    "build_launch",
    "build_route",
    "at_text",
    "build_uri",
    "code_command",
    "find_debug_descriptor",
    "find_run_descriptor",
    "focus_editor",
    "matches_launch",
    "open_debug_session",
    "open_url",
    "parse_at",
    "resolve_at",
    "poll_for_descriptor",
    "sessions_dir",
    "read_descriptor",
    "start_via_uri",
]
