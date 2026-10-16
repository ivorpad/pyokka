"""A question and named checkpoints anchored to one saved run, and the check that the run is still that run.

``save_investigation`` writes ``{kind: "investigation", version: 1, run, sha256, question,
checkpoints: [{name, step}]}`` next to nothing else: ``run`` is relative to the artifact and
``sha256`` is the digest of the run.json's bytes. It refuses to overwrite a file. ``open_investigation``
reads it back, refuses a run whose digest changed (a re-recorded run has different steps, so the
checkpoints would point at other moments), and answers each checkpoint's context. Neither runs code.
"""

from __future__ import annotations

import hashlib
import json
import os
from typing import Any

from .mcp_session import gap_notes
from .source import AgentError, SavedRun

MAX_CHECKPOINTS = 20
MAX_TEXT = 4096
RECORD_HINT = 'record one with pyokka_run {"file": "/abs/app.py", "save": "/abs/run.json"} (CLI: pyokka run FILE --save run.json) and pass the run path it prints'


def _text(value: Any, name: str, limit: int = MAX_TEXT) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit or "\0" in value:
        raise AgentError("%s must be a nonempty string of at most %d characters" % (name, limit))
    return value


def _checkpoints(value: Any) -> list[dict]:
    if not isinstance(value, list) or not value or len(value) > MAX_CHECKPOINTS:
        raise AgentError("an investigation has 1 to %d checkpoints" % MAX_CHECKPOINTS, 'e.g. "checkpoints": [{"name": "total goes wrong", "step": 12}]')
    names: set[str] = set()
    out = []
    for item in value:
        if not isinstance(item, dict):
            raise AgentError("each checkpoint needs a name and a recorded step")
        name = _text(item.get("name"), "checkpoint name", 256).strip()
        if name in names:
            raise AgentError("duplicate checkpoint name: %s" % name)
        names.add(name)
        step = item.get("step")
        if not isinstance(step, int) or isinstance(step, bool) or step < 0:
            raise AgentError("checkpoint %s needs a nonnegative integer step" % name)
        out.append({"name": name, "step": step})
    return out


def _read_run(path: str) -> tuple[str, str, SavedRun]:
    """``(realpath, sha256 of the bytes, the run)``."""
    try:
        real = os.path.realpath(_text(path, "run"))
        with open(real, "rb") as fh:
            raw = fh.read()
        doc = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError) as exc:
        raise AgentError("cannot open the investigation's run %s: %s" % (path, exc), RECORD_HINT) from None
    return real, hashlib.sha256(raw).hexdigest(), SavedRun(real, doc)


def _resume(path: str, artifact: dict, real: str, digest: str, run: SavedRun) -> dict:
    stops = []
    for cp in artifact["checkpoints"]:
        try:
            run.check_step(cp["step"])
        except AgentError as exc:
            raise AgentError("checkpoint %s: %s" % (cp["name"], exc.message),
                             'pick a step with pyokka_map {"action": "steps", "run": %s} or {"action": "find", "run": %s, "text": "..."} (CLI: pyokka steps %s, pyokka find %s TEXT)'
                             % (json.dumps(real), json.dumps(real), real, real)) from None
        stops.append({**cp, "context": run.context(step=cp["step"])})
    return {
        "kind": "saved-investigation", "version": 1, "path": path, "run": real, "sha256": digest,
        "question": artifact["question"], "checkpoints": stops,
        "identity": {"runId": run.meta.get("runId"), "file": run.meta.get("file"), "steps": run.trace.count},
        "recording": {"truncated": bool(run.recording), "midRun": run.mid_run, "completed": run.finished.get("type") == "run.finished", "exitCode": run.finished.get("exitCode")},
        "notes": ["These are recorded moments of this run only; opening them runs no code and moves no debugger.", *gap_notes(run)],
    }


def save_investigation(args: dict) -> dict:
    requested = os.path.abspath(_text(args.get("path"), "path"))
    parent = os.path.realpath(os.path.dirname(requested))
    if not os.path.isdir(parent):
        raise AgentError("no directory %s for the investigation" % parent)
    path = os.path.join(parent, os.path.basename(requested))
    question = _text(args.get("question"), "question")
    stops = _checkpoints(args.get("checkpoints"))
    if not isinstance(args.get("run"), str) or not args["run"].strip():
        raise AgentError("run must name a saved run.json; a live session cannot be saved", RECORD_HINT)
    real, digest, run = _read_run(args["run"])
    artifact = {"kind": "investigation", "version": 1, "run": os.path.relpath(real, parent), "sha256": digest, "question": question, "checkpoints": stops}
    result = _resume(path, artifact, real, digest, run)  # every checkpoint is checked before anything is written
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise AgentError("%s exists; an investigation is never overwritten" % path, "give a new path") from None
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(artifact, ensure_ascii=False) + "\n")
    return result


def open_investigation(args: dict) -> dict:
    try:
        path = os.path.realpath(_text(args.get("path"), "path"))
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError) as exc:
        raise AgentError("cannot open investigation %s: %s" % (args.get("path"), exc)) from None
    if not isinstance(doc, dict) or doc.get("kind") != "investigation" or doc.get("version") != 1:
        found = (lambda k: json.dumps(doc.get(k) if isinstance(doc, dict) else None))  # noqa: E731
        raise AgentError("%s is not an investigation: kind %s, version %s (expected kind \"investigation\", version 1)" % (path, found("kind"), found("version")),
                         'pyokka_save_investigation writes investigations; a run.json is read with pyokka_map {"action": "walkthrough", "run": %s}' % json.dumps(path))
    digest_saved = doc.get("sha256")
    if not isinstance(digest_saved, str) or len(digest_saved) != 64:
        raise AgentError("the investigation has no sha256 of its run")
    artifact = {"run": _text(doc.get("run"), "run"), "question": _text(doc.get("question"), "question"), "checkpoints": _checkpoints(doc.get("checkpoints"))}
    resolved = os.path.join(os.path.dirname(path), artifact["run"])
    try:
        real, digest, run = _read_run(resolved)
    except AgentError as exc:
        raise AgentError("%s keeps its run as %s, relative to its own folder, and %s is missing or unreadable (%s)" % (path, json.dumps(artifact["run"]), resolved, exc.message),
                         'move the investigation back beside its run, or put the run at that path; if the run lives elsewhere now, save a new investigation: '
                         'pyokka_save_investigation {"path": "<new file>", "run": "<the run\'s path>", "question": %s, "checkpoints": %s}'
                         % (json.dumps(artifact["question"]), json.dumps(artifact["checkpoints"]))) from None
    if digest != digest_saved:
        raise AgentError("the run %s changed since %s was saved (sha256 differs): it was re-recorded or edited, so the saved steps may be other moments" % (real, path),
                         'find the checkpoints again in the new run with pyokka_map {"action": "walkthrough", "run": %s} (CLI: pyokka walkthrough %s), then save them to a new file: '
                         'pyokka_save_investigation {"path": "<new file>", "run": %s, "question": %s, "checkpoints": [{"name": "...", "step": N}]}; '
                         'to reopen this file as saved, restore the run.json it was saved over'
                         % (json.dumps(real), real, json.dumps(real), json.dumps(artifact["question"])))
    return _resume(path, artifact, real, digest, run)


__all__ = ["save_investigation", "open_investigation"]
