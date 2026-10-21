"""Workflows over a recording: ``investigate`` follows one value, ``learn`` hides a checkpoint's
values until a prediction is made, ``pin`` keeps a baseline, ``verify`` checks a fix against it.

Each verb reads the same evidence as the single verbs (``var``, ``why``, ``origin``, ``exceptions``,
``coverage``, ``diff``) and composes their answers; none re-derives what they compute. A live
session counts as a recording through its ``recording`` reply, as ``coverage`` reads it.
"""

from __future__ import annotations

import json
import os
import re
import shlex
from typing import Any

from ..protocol import MAX_LOCALS_ENTRIES
from .recording import CUT_RE
from .source import AgentError, SavedRun


def saved(source: Any) -> SavedRun:
    """The saved run behind ``source``: the run itself, or the open session's recording."""
    if isinstance(source, SavedRun):
        return source
    if hasattr(source, "recording"):
        run = SavedRun("live-run.json", doc=source.recording())
        run.live = True  # type: ignore[attr-defined]
        return run
    raise AgentError("this command needs a recording", "save one with `pyokka run FILE --save run.json`, or use --live on a recording session")


def _source_ref(run: SavedRun, args: Any = None) -> tuple[str, str]:
    """How the caller names this recording: the CLI words and the MCP fields, with the real path."""
    if getattr(run, "live", False):
        return "--live", '"live": true'
    path = os.path.abspath(str(getattr(args, "run", None) or run.path))
    return path, '"run": %s' % json.dumps(path)


def private_write(path: str, data: bytes) -> str:
    """Write ``data`` to a new file readable by its owner only; an existing file is refused."""
    target = os.path.abspath(path)
    try:
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise AgentError("%s already exists" % target, "choose a new path; the existing file is kept as it is") from None
    except OSError as exc:
        raise AgentError("cannot write %s: %s" % (target, exc.strerror or exc), "choose a path in a directory that exists and is writable (%s is not)" % (os.path.dirname(target) or ".")) from None
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    return target


def run_bytes(run: SavedRun) -> bytes:
    """The recording as stored: the file's own bytes, or the live session's document as JSON."""
    if not getattr(run, "live", False):
        with open(run.path, "rb") as fh:
            return fh.read()
    return (json.dumps({"meta": run.meta, "events": run.events}, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def gap_notes(run: SavedRun, name: str | None = None) -> list[str]:
    """Where the recording has gaps, said before anything is concluded from it."""
    notes = ["Evidence covers this input only."]
    if not run.locals_entries:
        notes.append("No locals were recorded (saved with --no-locals?); record again with locals to see assigned values.")
    elif len(run.locals_entries) >= MAX_LOCALS_ENTRIES:
        notes.append("The locals recording reached its limit of %s entries; later changes may be missing." % format(MAX_LOCALS_ENTRIES, ","))
    if run.recording:
        notes.append("The recording is truncated at its step cap; nothing after step %s is recorded." % format(max(0, run.trace.count - 1), ","))
    if run.mid_run:
        notes.append("Recording began partway through execution (--record-from); earlier values and causes are not recorded.")
    if not run.finished:
        notes.append("The recording has no run.finished event; final values are not established.")
    from .walkthrough import is_user_file

    main = str(run.meta.get("file") or "")
    missing = [run.display_path(str(f["path"])) for f in run.sorted_files if is_user_file(str(f["path"]), run.workspace_root, main) and run.kept_source(str(f["path"])) is None]
    if missing:
        notes.append("No recorded source copy of %s; its source is read from disk, which may differ from what ran." % ", ".join(missing[:6]))
    # a cut value matters when it is the one under investigation, not anywhere in the run
    if name and any(CUT_RE.search(str(c.get("text") or "")) for e in run.locals_entries for c in e.get("changes") or [] if str(c.get("name") or "") == name or str(c.get("name") or "").startswith(name + ".")):
        notes.append("Recorded values of %s were cut at maxValueChars (they end in …(+N chars)); record again with --max-value-chars 0 to keep them whole." % name)
    return notes


def _or_note(notes: list[str], what: str, call: Any) -> Any:
    """``call()``, or None with a note when the recording cannot answer it."""
    try:
        return call()
    except AgentError as exc:
        notes.append("No %s: %s." % (what, exc.message))
        return None


# -- investigate ----------------------------------------------------------------------------------------------

#: values that usually mean something went wrong upstream: Python's spellings of NaN, infinity and nothing
SUSPICIOUS = re.compile(r"\bnan\b|\binf\b|^None$")


def investigate_command(args: Any, source: Any) -> dict:
    from .coverage import coverage_report
    from .history import History

    run = saved(source)
    name = (getattr(args, "value", None) or "").strip()
    notes = gap_notes(run, name)
    at = getattr(args, "at", None)
    history = run.var(name, limit=MAX_LOCALS_ENTRIES) if name else None
    changes = (history or {}).get("changes") or []
    suspicious = next((c for c in changes if SUSPICIOUS.search(str(c.get("text") or ""))), None)
    selected = suspicious or (changes[-1] if changes else None)
    automatic = at is None
    observed: int | None = None
    if automatic and selected and selected.get("source") == "locals":
        # the locals entry that reported the change: the first step where the new value is visible
        index = History(run)
        observed = next((s for s, sid, text, _ in index.locals_by_name.get(str(selected["name"]), ()) if sid == selected["scopeId"] and text == selected.get("text") and index.made_at(s, sid, str(selected["name"])) == selected["step"]), None)
    if not automatic:
        step = at
    elif observed is not None:
        step = observed
    elif selected:
        step = selected["step"]
    elif name:
        cli, mcp = _source_ref(run, args)
        raise AgentError("nothing recorded for %s: no assignment of it ran" % name, 'check the spelling, or search the run: `pyokka find %s %s` (MCP: pyokka_map {"action": "find", %s, "text": %s}); drop the value to start at the first exception' % (cli, name, mcp, json.dumps(name)))
    else:
        step = run.errors[0].get("step") if run.errors else None
    result: dict[str, Any] = {
        "kind": "investigation",
        "name": name or None,
        "notes": notes,
        "exceptions": _or_note(notes, "exceptions", run.exceptions),
        "coverage": _or_note(notes, "coverage", lambda: coverage_report(run)),
        "history": history,
    }
    if automatic and selected:
        result["selection"] = {"changeStep": selected["step"], "observedStep": observed, "suspicious": suspicious is not None}
    if step is not None:
        step = run.check_step(int(step))
        result["step"] = step
        result["context"] = run.context(step=step)
        if name:
            why_step = selected["step"] if automatic and selected else step
            result["why"] = _or_note(notes, "why", lambda: run.why(why_step, name, depth=5))
            if automatic and selected and selected.get("source") == "locals" and observed is None:
                notes.append("The selected change could not be matched to the step that observed it; its origin is not established.")
            else:
                result["origin"] = _or_note(notes, "origin", lambda: run.origin(step, name, depth=20))
            result["comparisons"] = [c for c in changes if suspicious is None or c.get("text") != suspicious.get("text")][:5]
    return result


def render_investigate(result: dict, source: Any, args: Any) -> list[str]:
    from .exceptions import render_exceptions
    from .origin.text import render_origin
    from .render import _loc, _one_line, render_var, render_why

    out = ["investigate %s" % (result["name"] or "the run")]
    out.extend("note: %s" % n for n in result["notes"])
    sel = result.get("selection")
    history = result.get("history")
    row = next((c for c in history["changes"] if c["step"] == sel["changeStep"]), None) if sel and history else None
    if row is not None:
        why = "the first suspicious value" if sel["suspicious"] else "the last change"
        seen = ", visible from #%s" % sel["observedStep"] if sel.get("observedStep") not in (None, row["step"]) else ""
        value = "= " + _one_line(row["text"], 100) if row.get("text") is not None else "assigned here (value not recorded)"
        out.append("selected: #%s %s %s  %s %s  (%s%s)" % (row["step"], _loc(source, row.get("file"), row.get("line")), row.get("function"), row["name"], value, why, seen))
    elif result.get("step") is not None:
        out.append("at #%s" % result["step"])
    sections = [
        ("history (var)", history, render_var),
        ("why", result.get("why"), render_why),
        ("origin", result.get("origin"), render_origin),
        ("exceptions", result.get("exceptions"), render_exceptions),
    ]
    for title, part, fn in sections:
        if part is not None:
            out.extend(["", "-- " + title])
            out.extend(fn(part, source, args))
    out.extend(_not_run_lines(result.get("coverage")))
    return out


def _not_run_lines(coverage: dict | None) -> list[str]:
    """The project files with lines that did not run or ran in part, one line each."""
    files = [f for f in ((coverage or {}).get("files") or []) if not f.get("library") and (f.get("notRun") or f.get("partial"))]
    if not files:
        return []
    out = ["", "-- lines that did not run or ran in part (project files)"]
    for f in files:
        out.append("%s: not run %s; partial %s" % (f["file"], ", ".join(map(str, f["notRun"])) or "none", ", ".join(map(str, f["partial"])) or "none"))
    return out


# -- learn ------------------------------------------------------------------------------------------------------

CHECKPOINT_KINDS = ("call", "decision", "error", "print")
CHECKPOINTS = 12
PREDICT = "Predict the value, branch or outcome here before revealing it."
_TOOK = re.compile(r" took (.+)$")


def _recorded(moment: dict, observed: dict, step: int) -> list[dict]:
    """What the run recorded at a checkpoint, as ``{name, text, step}``: the moment's values, the arm a
    decision took, what a print printed, then the values the statement at ``step`` and the next made."""
    out = [{"name": v.get("name"), "text": v.get("text"), "step": step} for v in moment.get("values") or [] if isinstance(v, dict)]
    text = str(moment.get("text") or "")
    took = _TOOK.search(text)
    if moment.get("kind") == "decision" and took:
        out.append({"name": "branch", "text": took.group(1), "step": step})
    if moment.get("kind") == "print" and text.startswith("prints "):
        out.append({"name": "printed", "text": text[len("prints "):], "step": step})
    out.extend({"name": v.get("context") or v.get("name") or "value", "text": v.get("text"), "step": v.get("step")} for v in observed.get("values") or [] if v.get("step") in (step, step + 1))
    return out


def _unquote(text: str) -> str:
    t = text.strip()
    return t[1:-1] if len(t) >= 2 and t[0] == t[-1] and t[0] in "'\"" else t


def _match(prediction: str, recorded: list[dict]) -> dict:
    """The first recorded value whose text, or the text without its repr quotes, equals the prediction."""
    want = prediction.strip()
    for r in recorded:
        text = str(r.get("text") if r.get("text") is not None else "")
        if want and want in (text.strip(), _unquote(text)):
            return {"matched": True, **r}
    return {"matched": False}


def learn_command(args: Any, source: Any) -> dict:
    from .coverage import coverage_report

    run = saved(source)
    notes = gap_notes(run)
    walk = run.walkthrough()
    moments = [m for m in walk.get("moments") or [] if m.get("kind") in CHECKPOINT_KINDS]
    checkpoints = []
    for m in moments[:CHECKPOINTS]:
        loc = m.get("location") or {}
        lines = run.source_lines(int(loc.get("fileId", -1))) if loc.get("fileId") is not None else []
        line = int(loc.get("line") or 0)
        checkpoints.append({"step": m["step"], "kind": m["kind"], "file": loc.get("file"), "line": line, "function": loc.get("function"), "source": lines[line - 1].strip() if 0 < line <= len(lines) else "", "prompt": PREDICT})
    result: dict[str, Any] = {"kind": "learning", "notes": notes, "coverage": _or_note(notes, "coverage", lambda: coverage_report(run)), "checkpoints": checkpoints}
    at = getattr(args, "at", None)
    prediction = getattr(args, "prediction", None)
    steps = ", ".join("#%d" % c["step"] for c in checkpoints) or "none"
    cli, mcp = _source_ref(run, args)
    if at is None:
        if prediction is not None or getattr(args, "reveal", False):
            raise AgentError("--prediction and --reveal need --at STEP", 'pick a checkpoint step (%s): `pyokka learn %s --at STEP --prediction TEXT` (MCP: pyokka_learn {%s, "at": STEP, "prediction": "TEXT"})' % (steps, cli, mcp))
        return result
    if int(at) not in {m.get("step") for m in moments}:
        raise AgentError("step %s is not a checkpoint" % at, "checkpoints: %s; list them with `pyokka learn %s` (MCP: pyokka_learn {%s})" % (steps, cli, mcp))
    step = run.check_step(int(at))
    result["step"] = step
    result["prediction"] = prediction
    if not getattr(args, "reveal", False):
        result["prompt"] = "Record your prediction, then add --reveal at this step to compare it with the run (MCP: call again with the same at and prediction plus \"reveal\": true)."
        return result
    observed = run.context(step=step)
    here = [m for m in moments if m.get("step") == step]
    result["observed"] = observed
    result["moments"] = here
    recorded = [r for m in here for r in _recorded(m, observed, step)] or _recorded({}, observed, step)
    result["recorded"] = recorded
    if prediction is not None:
        result["match"] = _match(prediction, recorded)
    return result


def render_learn(result: dict, source: Any, args: Any) -> list[str]:
    from .render import _loc, _one_line

    out = ["learn from this run"]
    out.extend("note: %s" % n for n in result["notes"])
    if result.get("step") is None:
        out.append("checkpoints (%s): pick one with --at STEP --prediction TEXT, then add --reveal (MCP: at, prediction, then reveal: true)" % PREDICT[:-1].lower())
        for c in result["checkpoints"]:
            out.append("  #%s %s  %s %s  %s" % (c["step"], c["kind"], _loc(source, c.get("file"), c.get("line")), c.get("function"), _one_line(c.get("source"), 100)))
        out.extend(_not_run_lines(result.get("coverage")))
        return out
    c = next((c for c in result["checkpoints"] if c["step"] == result["step"]), None)
    out.append("at #%s%s" % (result["step"], "  %s %s  %s" % (c["kind"], _loc(source, c.get("file"), c.get("line")), _one_line(c.get("source"), 100)) if c else ""))
    if result.get("prediction") is not None:
        out.append("your prediction: %s" % result["prediction"])
    if "observed" not in result:
        out.append(result.get("prompt") or "")
        return out
    out.append("recorded:")
    for m in result.get("moments") or []:
        out.append("  %s" % _one_line(m.get("text"), 120))
    out.extend("  #%s %s = %s" % (r.get("step"), r.get("name"), _one_line(r.get("text"), 120)) for r in result.get("recorded") or [])
    if not result.get("recorded"):
        out.append("  (no value recorded at this step)")
    match = result.get("match")
    if match is not None:
        out.append("match: yes, %s = %s at #%s" % (match["name"], _one_line(match["text"], 80), match["step"]) if match["matched"] else "match: no recorded value at #%s equals %s" % (result["step"], _one_line(result["prediction"], 80)))
    return out


# -- pin ---------------------------------------------------------------------------------------------------------

def pin_command(args: Any, source: Any) -> dict:
    run = saved(source)
    return {"pinned": private_write(args.out, run_bytes(run)), "from": run.path, "steps": run.trace.count}


def render_pin(result: dict, source: Any, args: Any) -> list[str]:
    return ["pinned %s (%d steps) to %s" % (result["from"], result["steps"], result["pinned"])]


# -- verify -----------------------------------------------------------------------------------------------------

UNSUPPORTED = "the final value is not supported by a complete recording"
TEST_TEMPLATE = '''"""Written by `pyokka verify --test-out`: run %(name)s again and check its final recorded values.

It runs the Pyokka runtime at RUNTIME with the interpreter that recorded the baseline (or this one).
"""

import json
import os
import subprocess
import sys

SPEC = %(spec)s
RUNTIME = %(runtime)r


def test_recorded_regression(tmp_path):
    python = SPEC["python"] if SPEC["python"] and os.path.exists(SPEC["python"]) else sys.executable
    env = dict(os.environ, PYTHONPATH=os.pathsep.join(p for p in (RUNTIME, os.environ.get("PYTHONPATH")) if p))
    pyokka = [python, "-m", "pyokka_runtime"]
    run = str(tmp_path / "run.json")
    argv = ["--", *SPEC["argv"]] if SPEC["argv"] else []
    done = subprocess.run([*pyokka, "run", SPEC["file"], "--save", run, "--python", python, *SPEC["flags"], *argv], env=env, capture_output=True, text=True)
    assert os.path.exists(run), done.stdout + done.stderr
    for expected in SPEC["expectations"]:
        out = subprocess.run([*pyokka, "var", run, expected["name"], "--limit", "100000", "--json"], env=env, capture_output=True, text=True, check=True)
        changes = json.loads(out.stdout)["changes"]
        assert changes and changes[-1].get("text") == expected["expected"], expected["name"]
'''


def _expectations(items: list[str]) -> list[dict]:
    out = []
    for text in items or []:
        name, sep, value = str(text).partition("=")
        if not sep or not name.strip():
            raise AgentError("--expect wants NAME=VALUE, got %r" % text, "VALUE is the recorded text of the value, its repr: --expect total=22, --expect name=\"'Ada'\"")
        out.append({"name": name.strip(), "expected": value})
    return out


def _rerun_flags(meta: dict) -> list[str]:
    """The ``pyokka run`` flags that record the way the baseline was recorded; recorded HTTP is replayed."""
    cfg = meta.get("config") or {}
    flags: list[str] = []
    if meta.get("cwd") and os.path.abspath(str(meta["cwd"])) != os.path.dirname(os.path.abspath(str(meta.get("file") or ""))):
        flags += ["--cwd", str(meta["cwd"])]
    http = "replay" if cfg.get("http") == "record" else cfg.get("http")
    if http and http != "off":
        flags += ["--http", str(http)]
    if cfg.get("libraryCode"):
        flags.append("--library-code")
    if cfg.get("timeoutMs"):
        flags += ["--timeout", str(cfg["timeoutMs"])]
    if cfg.get("maxTraceSteps"):
        flags += ["--max-steps", str(cfg["maxTraceSteps"])]
    if cfg.get("maxValueChars") is not None:
        flags += ["--max-value-chars", str(cfg["maxValueChars"])]
    for key, flag in (("exclude", "--exclude"), ("only", "--only")):
        for item in cfg.get(key) or []:
            flags += [flag, str(item)]
    return flags


def _rerun(before: SavedRun, out: str) -> SavedRun:
    """Run the baseline's file again as it was recorded, into ``out``."""
    from .interpreter import choose, probe
    from .save import save_run

    meta = before.meta
    cfg = meta.get("config") or {}
    file = str(meta.get("file") or "")
    if not os.path.isfile(file):
        raise AgentError("the baseline's file %s is gone" % file, "record the after run yourself and pass it with --after PATH")
    exe = meta.get("executable")
    python = probe(choose(file, str(exe) if exe and os.path.exists(str(exe)) else None))
    recording = {k: cfg.get(k) for k in ("maxTraceSteps", "exclude", "only", "maxValueChars")}
    try:
        save_run(file, out, library_code=bool(cfg.get("libraryCode")), record_locals=True, auto_log=bool(cfg.get("autoLog")), timeout_ms=int(cfg.get("timeoutMs") or 0), argv=list(meta.get("argv") or []), http="replay" if cfg.get("http") == "record" else str(cfg.get("http") or "off"), recording=recording, python=python, cwd=meta.get("cwd"))
    except (RuntimeError, OSError) as exc:
        raise AgentError("the rerun failed: %s" % exc, "run it yourself with `pyokka run %s --save after.json` and pass --after after.json" % file) from None
    return SavedRun(out)


def _check(after: SavedRun, name: str, expected: str) -> dict:
    """One ``--expect``: the last recorded change of NAME against VALUE, only on a complete recording."""
    history = after.var(name, limit=MAX_LOCALS_ENTRIES)
    last = (history.get("changes") or [None])[-1]
    actual = last.get("text") if last else None
    reason = None
    if after.recording or after.mid_run or not after.finished or len(after.locals_entries) >= MAX_LOCALS_ENTRIES or history.get("truncated"):
        reason = UNSUPPORTED
    elif actual is not None and CUT_RE.search(str(actual)):
        reason = "the recorded value was cut at maxValueChars; record with --max-value-chars 0"
    elif last and last.get("unchanged"):
        reason = "the last change of %s was made in place (#%s), and its value after that statement is not recorded" % (name, last.get("step"))
    out = {"name": name, "expected": expected, "actual": actual, "step": last.get("step") if last else None, "passed": reason is None and actual == expected}
    if reason:
        out["reason"] = reason
    return out


def verify_command(args: Any, source: Any) -> dict:
    import tempfile

    from .coverage import coverage_report
    from .diff import Side, diff_sides

    before = saved(source)
    if bool(getattr(args, "after", None)) == bool(getattr(args, "rerun", False)):
        raise AgentError("verify needs one of --after PATH or --rerun", "e.g. `pyokka verify before.json --after after.json --expect total=22`")
    expectations = _expectations(getattr(args, "expect", None) or [])
    if getattr(args, "test_out", None) and not expectations:
        raise AgentError("--test-out needs at least one --expect NAME=VALUE", "the test checks the values you expect; review them first, e.g. --expect total=22")
    if getattr(args, "out", None) and not getattr(args, "rerun", False):
        raise AgentError("--out saves the rerun, so it goes with --rerun", "drop --out, or use --rerun")
    test_out = getattr(args, "test_out", None)
    if test_out and os.path.exists(test_out):
        raise AgentError("%s already exists" % os.path.abspath(test_out), "choose a new path for --test-out; the existing file is kept as it is")
    cli, mcp = _source_ref(before, args)
    if getattr(args, "after", None) and not os.path.exists(args.after):
        file = str(before.meta.get("file") or "FILE")
        raise AgentError("no saved run at %s" % os.path.abspath(args.after), 'record it with `pyokka run %s --save %s`, or run the baseline\'s file again: `pyokka verify %s --rerun` (MCP: pyokka_verify {%s, "rerun": true})' % (file, os.path.abspath(args.after), cli, mcp))
    rerun_notes: list[str] = []
    with tempfile.TemporaryDirectory(prefix="pyokka-verify-") as tmp:
        if getattr(args, "rerun", False):
            out = getattr(args, "out", None)
            if out and os.path.exists(out):
                raise AgentError("%s already exists" % os.path.abspath(out), "choose a new path for --out")
            after = _rerun(before, out or os.path.join(tmp, "rerun.json"))
            label = os.path.abspath(out) if out else "rerun"
            if (before.meta.get("config") or {}).get("http") not in ("record", "replay"):
                rerun_notes = ["HTTP was not replayed: the baseline was not recorded with --http record, so any HTTP calls the rerun made were real."]
        else:
            after = SavedRun(args.after)
            label = args.after
        checks = [_check(after, e["name"], e["expected"]) for e in expectations]
        before_label = "--live" if getattr(before, "live", False) else str(getattr(args, "run", None) or before.path)
        comparison = diff_sides(Side("a", before_label, before), Side("b", label, after), limit=100, ignore=list(getattr(args, "ignore", None) or []))
        # edited statements first, then the rest, each in step order
        comparison["statements"].sort(key=lambda e: e["status"] == "same")
        notes = rerun_notes + list(comparison["notes"]) + gap_notes(after)
        result = {**comparison, "checks": checks, "notes": notes,
                  "verified": bool(checks) and all(c["passed"] for c in checks) and after.finished.get("exitCode") == 0,
                  "coverage": _or_note(notes, "coverage", lambda: coverage_report(after)), "exceptions": _or_note(notes, "exceptions", after.exceptions)}
    if not checks:
        result["verdict"] = _verdict_without_expectations(result)
    elif all(c["passed"] for c in checks) and after.finished.get("exitCode") != 0:
        # every value holds and the run failed: name the error, not the code
        uncaught = next((e for e in after.errors if not e.get("handled")), None)
        error = " (%s: %s)" % (uncaught.get("errorType"), uncaught.get("message")) if uncaught else ""
        result["next"] = "every expected value holds, but the run ended with exit code %s%s; a passing check counts only in a run that ends without an error" % (after.finished.get("exitCode"), error)
    elif not result["verified"]:
        expects = " ".join("--expect %s" % shlex.quote("%s=%s" % (e["name"], e["expected"])) for e in expectations)
        mcp_expects = json.dumps(["%s=%s" % (e["name"], e["expected"]) for e in expectations])
        result["next"] = 'fix the code and check again with `pyokka verify %s --rerun %s` (MCP: pyokka_verify {%s, "rerun": true, "expect": %s}), or correct the expected value (the actual one is above)' % (cli, expects, mcp, mcp_expects)
    if getattr(args, "test_out", None):
        import pprint

        import pyokka_runtime

        meta = before.meta
        spec = {"file": meta.get("file"), "argv": list(meta.get("argv") or []), "python": meta.get("executable"), "flags": _rerun_flags(meta), "expectations": expectations}
        text = TEST_TEMPLATE % {"name": os.path.basename(str(meta.get("file") or "the file")), "spec": pprint.pformat(spec, sort_dicts=False), "runtime": os.path.dirname(os.path.dirname(os.path.abspath(pyokka_runtime.__file__)))}
        result["test"] = private_write(test_out, text.encode("utf-8"))
    return result


def _verdict_without_expectations(result: dict) -> str:
    """The last line of a ``verify`` without ``--expect``: still a verdict, so a reader never has to infer one from the diff.

    A run that behaved like the baseline is a PASS; one that differs says in how many statements and
    how to get a verdict on a value. The exit code stays 0 either way: only a failed expectation fails.
    """
    a, b = result["a"], result["b"]
    total = int(result.get("total") or 0)
    if not total and a.get("exitCode") == b.get("exitCode"):
        return "PASS: no expectations given; the after run has no behaviour difference from the baseline"
    if not total:
        return "no expectations given; the runs end with different exit codes (%s → %s); pass --expect NAME=VALUE for a verdict" % (a.get("exitCode"), b.get("exitCode"))
    return "no expectations given; the runs differ in %d statement%s (see above); pass --expect NAME=VALUE for a verdict" % (total, "" if total == 1 else "s")


def render_verify(result: dict, source: Any, args: Any) -> list[str]:
    from .diff import render_diff
    from .render import _one_line

    out = render_diff(result, source, args)
    for c in result["checks"]:
        where = " at #%s" % c["step"] if c.get("step") is not None else ""
        out.append("%s %s = %s%s (expected %s)%s" % ("PASS" if c["passed"] else "FAIL", c["name"], _one_line(c["actual"], 80) if c["actual"] is not None else "(no recorded value)", where, _one_line(c["expected"], 80), "; " + c["reason"] if c.get("reason") else ""))
    if result.get("test"):
        out.append("wrote %s: `python -m pytest %s` reruns the file and checks these values%s" % (result["test"], result["test"], "" if result["verified"] else "; it fails until they hold"))
    if result.get("verdict"):
        out.append(str(result["verdict"]))
    else:
        out.append("verified: the expected values hold for this input" if result["verified"] else "not verified" + (": %s" % result["next"] if result.get("next") else ""))
    return out


__all__ = ["saved", "private_write", "gap_notes", "investigate_command", "render_investigate", "learn_command", "render_learn", "pin_command", "render_pin", "verify_command", "render_verify"]
