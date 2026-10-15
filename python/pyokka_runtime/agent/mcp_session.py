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

import os
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
            "displayName": text("displayName"), "pid": d.get("pid") if isinstance(d.get("pid"), int) else None, "started": text("started")}


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
        return {"kind": "session", "mode": "list", "sessions": [_descriptor(d) for d in sessions],
                "notes": ["Descriptors show published sessions, not confirmed pauses or visible editors. Pass live: true or session to read one's state."]}
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
        raise AgentError("run must name a saved recording", "record one with pyokka_run {file}")
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
