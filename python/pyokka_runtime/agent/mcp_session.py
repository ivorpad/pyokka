"""``pyokka_session`` and ``pyokka_seek``: where a run is, and where a value or a line happened.

``pyokka_session`` reads state only. With ``run`` it reports a saved run's read position; with
``live`` (or ``session``) it reports the open VS Code session, keeping the program's actual pause
(``livePause``) apart from the Time Machine's recorded position (``recordedSelection``), which can
sit behind it. With neither it lists the published sessions. It never selects, starts or resumes
anything.

``pyokka_seek`` finds recorded evidence in a saved run: the first or last step where NAME took the
value TEXT, or the first or last run of FILE:LINE. It evaluates nothing and moves no program.
Both answer JSON, and both say where the recording has gaps, because "not found" in an incomplete
recording does not mean "never happened".
"""

from __future__ import annotations

import json
import os
import re
import sys
from typing import Any

from ..protocol import MAX_LOCALS_ENTRIES
from .source import AgentError, SavedRun

SESSION_KEYS = ("run", "session", "live", "step")
LOCATION_KEYS = ("step", "file", "line", "col", "function", "reason", "thread")


def _location(value: Any) -> dict | None:
    if not isinstance(value, dict):
        return None
    return {k: value[k] for k in LOCATION_KEYS if k in value}


def _descriptor(d: dict) -> dict:
    """A selectable session, never its socket or token."""
    from .sessions import descriptor_kind

    text = lambda k: d.get(k) if isinstance(d.get(k), str) else None  # noqa: E731
    return {"session": text("descriptor"), "kind": descriptor_kind(d), "file": text("file"), "workspace": text("workspace"),
            "displayName": text("displayName"), "pid": d.get("pid") if isinstance(d.get("pid"), int) else None, "started": text("started"),
            "recording": descriptor_kind(d) == "run"}


START_CALL = 'open one with `pyokka debug FILE --record` (MCP: pyokka_debug {"action": "start", "file": "FILE", "record": true})'
EXTENSION_INSTALL = "gh release download --repo ivorpad/pyokka --pattern '*.vsix' && code --install-extension pyokka-*.vsix"
AGENT_ACCESS = re.compile(r'"pyokka\.agentAccess"\s*:\s*(true|false)')


def default_settings_path() -> str:
    """VS Code's user settings.json on this platform."""
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/Code/User/settings.json")
    if sys.platform.startswith("win"):
        return os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "Code", "User", "settings.json")
    return os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "Code", "User", "settings.json")


def find_code() -> str | None:
    """The `code` launcher: what debug_start uses, else the one inside VS Code.app."""
    try:
        from .debug_start import code_command

        found = code_command()
        if found:
            return found
    except Exception:  # noqa: BLE001 - a missing binary is an answer here, not a failure
        pass
    from .web import VSCODE_APPS

    for app in VSCODE_APPS:
        launcher = os.path.join(app, "Contents", "Resources", "app", "bin", "code")
        if os.path.exists(launcher):
            return launcher
    return None


def extension_version(extensions_dir: str | None = None) -> str | None:
    """The newest installed ivor.pyokka-X.Y.Z, or None."""
    directory = extensions_dir or os.path.expanduser("~/.vscode/extensions")
    try:
        names = os.listdir(directory)
    except OSError:
        return None
    versions = []
    for name in names:
        m = re.fullmatch(r"ivor\.pyokka-(\d+(?:\.\d+)*)(?:-.*)?", name)
        if m:
            versions.append((tuple(int(x) for x in m.group(1).split(".")), m.group(1)))
    return max(versions)[1] if versions else None


def agent_access(settings_path: str | None = None) -> bool | None:
    """`pyokka.agentAccess` from VS Code's user settings.json (comments allowed); None when unset or unreadable."""
    try:
        with open(settings_path or default_settings_path(), "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return None
    try:
        doc = json.loads(text)
        value = doc.get("pyokka.agentAccess") if isinstance(doc, dict) else None
        return value if isinstance(value, bool) else None
    except ValueError:
        pass
    found = None
    for m in AGENT_ACCESS.finditer(text):  # settings.json is JSONC: skip a line's commented-out setting
        if "//" not in text[text.rfind("\n", 0, m.start()) + 1:m.start()]:
            found = m.group(1) == "true"
    return found


def closed_sessions(directory: str | None = None) -> int:
    """Descriptors left by a VS Code window whose process has exited."""
    from .live import pid_alive, sessions_dir

    directory = directory or sessions_dir()
    try:
        names = [n for n in os.listdir(directory) if n.endswith(".json")]
    except OSError:
        return 0
    dead = 0
    for name in names:
        try:
            with open(os.path.join(directory, name), "r", encoding="utf-8") as fh:
                doc = json.load(fh)
        except (OSError, ValueError):
            continue
        if isinstance(doc, dict) and "pid" in doc and not pid_alive(doc.get("pid")):
            dead += 1
    return dead


def vscode_readiness(sessions_directory: str | None = None, extensions_dir: str | None = None, settings_path: str | None = None,
                     code: str | None = None) -> dict:
    """What a live session needs from this machine, read without starting anything."""
    return {"code": code or find_code(), "extension": extension_version(extensions_dir),
            "agentAccess": agent_access(settings_path), "closedSessions": closed_sessions(sessions_directory)}


def readiness_note(vscode: dict) -> str:
    """With no session open: the first thing missing, and the call that opens one."""
    closed = " %d published session(s) belong to a VS Code window that has closed." % vscode["closedSessions"] if vscode.get("closedSessions") else ""
    if not vscode.get("code"):
        return ("No live session, and VS Code was not found (no `code` on PATH, none in /Applications): install VS Code, or set PYOKKA_CODE to its bin/code; then %s." % START_CALL) + closed
    if not vscode.get("extension"):
        return ("No live session, and the Pyokka extension is not installed: `%s`; then %s." % (EXTENSION_INSTALL, START_CALL)) + closed
    if vscode.get("agentAccess") is not True:
        state = "off" if vscode.get("agentAccess") is False else "not set (default off)"
        return ('No live session, and pyokka.agentAccess is %s in VS Code\'s user settings: set "pyokka.agentAccess": true, then %s.' % (state, START_CALL)) + closed
    return ("No live session: VS Code is not running or has no Pyokka session open; %s." % START_CALL) + closed


def missing_sources(run: SavedRun) -> list[str]:
    """User files the run kept no source copy of: their text today may not be what ran."""
    from .walkthrough import is_user_file

    main = str(run.meta.get("file") or "")
    out = []
    for f in run.files.values():
        p = str(f.get("path") or "")
        if p and is_user_file(p, run.workspace_root, main) and run.kept_source(p) is None:
            out.append(p)
    return out


def gap_notes(run: SavedRun) -> list[str]:
    notes = []
    if run.finished.get("type") != "run.finished":
        notes.append("The recording has no completion event.")
    if run.recording:
        notes.append("The recording was truncated at its step cap.")
    if run.mid_run:
        notes.append("Recording began partway through execution.")
    if len(run.locals_entries) >= MAX_LOCALS_ENTRIES:
        notes.append("The local-value recording reached its limit (%d entries); later values may be missing." % MAX_LOCALS_ENTRIES)
    if missing_sources(run):
        notes.append("Some user files have no recorded source copy; their lines are read from disk and may differ from what ran.")
    return notes


def session_state(args: dict) -> dict:
    if not isinstance(args, dict):
        raise AgentError("session arguments must be an object")
    for key in args:
        if key not in SESSION_KEYS:
            raise AgentError("unknown session argument %s" % key, "pyokka_session takes run, step, live, session")
    for key in ("run", "session"):
        if key in args and (not isinstance(args[key], str) or not args[key].strip()):
            raise AgentError("%s must be a nonempty string" % key)
    if "live" in args and not isinstance(args["live"], bool):
        raise AgentError("live must be a boolean")
    step = args.get("step")
    if step is not None and (not isinstance(step, int) or isinstance(step, bool) or step < 0):
        raise AgentError("step must be a nonnegative integer")
    if args.get("run") and (args.get("live") or args.get("session")):
        raise AgentError("choose a saved run or a live session, not both")
    if step is not None and not args.get("run"):
        raise AgentError("step selects a saved run's position", "live state reports the session's own selection and pause")
    if args.get("run"):
        return _recorded_state(str(args["run"]), step)
    from .live import LiveRun, list_sessions
    from .sessions import pick_session

    sessions = list_sessions()
    if not args.get("live") and not args.get("session"):
        vscode = vscode_readiness()
        notes = [] if sessions else [readiness_note(vscode)]
        notes.append("Descriptors show published sessions, not confirmed pauses or visible editors. Pass live: true or session to read one's state.")
        return {"kind": "session", "mode": "list", "ready": bool(sessions), "vscode": vscode, "sessions": [_descriptor(d) for d in sessions], "notes": notes}
    picked = pick_session(sessions, session=args.get("session"))
    source = LiveRun(picked)
    try:
        return _live_state(picked, source.request({"type": "state"}))
    finally:
        source.close()


def _recorded_state(path: str, step: int | None) -> dict:
    run = SavedRun(path)
    count = run.trace.count
    if step is not None:
        run.check_step(step)
    at = (step if step is not None else 0) if count else None
    context = run.context(step=at) if at is not None else None
    readable = at is not None
    return {
        "kind": "session", "mode": "recorded", "run": run.path, "runId": run.meta.get("runId"), "file": run.meta.get("file"),
        "finished": run.finished.get("type") == "run.finished", "running": False,
        "exitCode": run.finished.get("exitCode", run.meta.get("exitCode")), "stale": bool(run.stale_files()),
        "livePause": None,
        "recordedSelection": {"active": readable, "step": at, "count": count, "location": _location((context or {}).get("location"))},
        "context": context,
        "capabilities": {"readContext": readable, "readRecording": True, "recordedNavigation": readable, "liveControl": False},
        "allowedActions": ["state", "walkthrough", "story", "find", "graph", "exceptions", "http", "coverage", *(["context", "step", "var", "why", "origin"] if readable else [])],
        "notes": ["A saved run's selection is a read position, not a live pause or an editor position.", *gap_notes(run)],
    }


def _live_state(picked: dict, state: dict) -> dict:
    debug = state.get("debug") if isinstance(state.get("debug"), dict) else {}
    pause = debug.get("paused") if isinstance(debug.get("paused"), dict) else None
    nav = state.get("nav") if isinstance(state.get("nav"), dict) else {}
    count = int(nav.get("count") or 0)
    recording = state.get("kind") != "debug" and count > 0
    active = recording and nav.get("active") is True
    selected = nav.get("step") if active else None
    live = debug.get("active") is True
    pause_step = pause.get("step") if pause else None
    read_context = active or (pause is not None and (state.get("kind") == "debug" or (recording and isinstance(pause_step, int) and 0 <= pause_step < count)))
    notes = ["livePause is the program's actual innermost pause; recordedSelection is the Time Machine's position in the recording, which moves on its own.",
             "State does not confirm which editor is shown or which stack frame is selected."]
    if pause and not read_context:
        notes.append("No recorded context at this pause; read live locals instead.")
    if active and pause and selected != pause_step:
        notes.append("The recording is selected behind the live pause; moving forward in the recording does not resume the program.")
    actions = ["state"]
    if recording:
        actions += ["walkthrough", "graph", "exceptions", "http", "var", "why", "origin"]
    if read_context:
        actions.append("context")
    if active or pause:
        actions.append("step")
    if pause:
        actions += ["locals", "eval", "exec", "continue"]
    if live:
        actions += ["stop", "restart", "break", "watches", *(["pause"] if not pause and state.get("running") else [])]
    return {
        "kind": "session", "mode": "live", "session": _descriptor(picked), "runId": state.get("runId"), "file": state.get("file") or picked.get("file"),
        "running": state.get("running") is True, "finished": state.get("finished") is True, "stale": state.get("stale") is True,
        "modified": state.get("modified") is True or debug.get("modified") is True,
        "livePause": {**(_location(pause) or {}), "runId": state.get("runId"), "frame": 0} if pause else None,
        "recordedSelection": {"active": active, "step": selected, "count": count, "location": _location(state.get("location")) if active else None},
        "frontier": debug.get("frontier"),
        "capabilities": {"readContext": read_context, "readRecording": recording, "recordedNavigation": recording, "liveControl": live},
        "allowedActions": actions,
        "notes": notes,
    }


def seek_recorded(args: dict) -> dict:
    path = args.get("run")
    if not isinstance(path, str) or not path.strip():
        raise AgentError("run must name a saved recording", 'record one with pyokka_run {"file": "/abs/app.py", "save": "/abs/run.json"} (CLI: pyokka run FILE --save run.json) and pass that path')
    occurrence = args.get("occurrence") or "first"
    if occurrence not in ("first", "last"):
        raise AgentError("occurrence must be first or last")
    value, equals, file, line = args.get("value"), args.get("equals"), args.get("file"), args.get("line")
    by_value = value is not None or equals is not None
    if by_value and (not isinstance(value, str) or not value.strip() or not isinstance(equals, str) or file is not None or line is not None):
        raise AgentError("choose value and equals, or file and line", 'e.g. {"value": "total", "equals": "6"} or {"file": "demo.py", "line": 57}')
    if not by_value and (not isinstance(file, str) or not file.strip() or not isinstance(line, int) or isinstance(line, bool) or line < 1):
        raise AgentError("choose value and equals, or file and a positive line", 'e.g. {"file": "demo.py", "line": 57}')
    run = SavedRun(os.path.abspath(path))
    notes = ["Searches the recording only: nothing was evaluated and no program moved."]
    if run.recording or run.mid_run or run.finished.get("type") != "run.finished":
        notes.append("The recording is incomplete, so no match does not prove it never happened.")
    if len(run.locals_entries) >= MAX_LOCALS_ENTRIES:
        notes.append("The local-value recording reached its limit; later matches may be missing.")
    if not run.locals_entries and by_value:
        notes.append("No local-value changes were recorded (--no-locals?); only logged values can match.")
    if missing_sources(run):
        notes.append("Some user files have no recorded source copy; their lines are read from disk and may differ from what ran.")
    result: dict[str, Any] = {"kind": "destination", "mode": "recorded", "run": run.path, "found": False,
                              "query": {**({"value": value, "equals": equals} if by_value else {"file": file, "line": line}), "occurrence": occurrence}, "notes": notes}
    if by_value:
        rows = [r for r in (run.var(str(value), limit=1_000_000).get("changes") or []) if r.get("name") == value and r.get("text") == equals]
        result["matches"] = len(rows)
        if not rows:
            seen = sorted({str(r.get("text")) for r in (run.var(str(value), limit=1_000_000).get("changes") or []) if r.get("name") == value})
            if seen:
                result["recordedTexts"] = seen[:20]
                notes.append("%s never took the text %s; equals must match one of recordedTexts exactly, quotes included." % (value, json.dumps(equals)))
            else:
                notes.append('%s never changed in the recording; check the name with pyokka_value {"action": "var", "run": %s, "name": %s} (CLI: pyokka var %s %s).'
                             % (value, json.dumps(run.path), json.dumps(value), run.path, value))
            return result
        chosen = rows[-1] if occurrence == "last" else rows[0]
        observed = _observed_step(run, chosen)
        result["selection"] = {"changeStep": chosen.get("step"), "observedStep": observed}
        result["evidence"] = chosen
        result["step"] = observed if observed is not None else chosen.get("step")
        if observed is None:
            notes.append("The value belongs to its recorded statement; the locals at that step are read before it ran and may differ.")
    else:
        fid = int(run.resolve_file(str(file))["fileId"])
        steps = list(run.trace.steps_on_line(fid, int(line)))
        result["matches"] = len(steps)
        if not steps:
            notes.append('line %d of %s never ran; pyokka_coverage {"run": %s, "file": %s} lists the lines that did (CLI: pyokka coverage %s --file %s).'
                         % (int(line), file, json.dumps(run.path), json.dumps(str(file)), run.path, file))
            return result
        result["step"] = steps[-1] if occurrence == "last" else steps[0]
    result["found"] = True
    result["context"] = run.context(step=int(result["step"]))
    result["next"] = {"tool": "pyokka_step", "arguments": {"run": run.path, "step": result["step"]}}
    return result


def _observed_step(run: SavedRun, row: dict) -> int | None:
    """The first step after the statement where the frame's locals show the new value: where it can be read."""
    made, scope, name, text = row.get("step"), row.get("scopeId"), row.get("name"), row.get("text")
    if not isinstance(made, int):
        return None
    best = None
    for entry in run.locals_entries:
        step = entry.get("step")
        if not isinstance(step, int) or step <= made or entry.get("scopeId") != scope or (best is not None and step >= best):
            continue
        if any(c.get("name") == name and c.get("text") == text for c in entry.get("changes") or []):
            best = step
    return best


__all__ = ["session_state", "seek_recorded", "gap_notes", "missing_sources"]
