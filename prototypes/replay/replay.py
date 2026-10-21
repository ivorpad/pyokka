"""Prototype: replay a recorded run, check it step by step, and watch values after the fact.

Not part of Pyokka; it imports the runtime from this checkout and changes none of it.

    python prototypes/replay/replay.py record FILE --out REC.json
    python prototypes/replay/replay.py replay REC.json|RUN.json [--watch [FILE:]LINE:EXPR]... [--values OUT.json] [--no-inputs]

``record`` runs FILE under Pyokka's own recorder, in this process, and also keeps what the
program read from outside it (inputs.py). ``replay`` takes that recording, or a ``run.json``
from ``pyokka run --save``, runs the program again with the same recorder, hands the recorded
inputs back, and compares every step with the recording: it stops at the first step that went
another way and says where. A watch given to ``replay`` was never part of the recording; it is
evaluated before its line runs, every time it runs, and keeps the whole value.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
import time
from array import array
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "python"))

from pyokka_runtime.agent.save import build_request  # noqa: E402
from pyokka_runtime.execute import Execution, RunSpec  # noqa: E402
from pyokka_runtime.redact import redact, redact_value  # noqa: E402

from inputs import Inputs  # noqa: E402
from probe import Probe, Watch  # noqa: E402
from snapshot import render  # noqa: E402

FORMAT = "pyokka-replay-prototype/1"
DEFAULT_CONFIG = {"libraryCode": False, "recordLocals": True, "autoLog": False, "http": "off", "httpObserve": True}
LINES_PER_HIT = 30
_clock = time.perf_counter  # taken before any patch: timing the runs is this tool's read, not the program's


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def read(path: str) -> str:
    with open(path, encoding="utf-8") as fh:
        return fh.read()


class Recording:
    """A prototype recording or a Pyokka ``run.json``, read into the same fields."""

    def __init__(self, path: str) -> None:
        self.path = path
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        if data.get("format") == FORMAT:
            self.kind = "prototype"
            self.file, self.sha256, self.config = data["file"], data["sha256"], data["config"]
            self.steps = _decode(data["steps"])
            self.steps_run, self.truncated = data["stepsRun"], data["truncated"]
            self.scopes = {int(k): v for k, v in data["scopes"].items()}
            self.files, self.inputs, self.logs = data["files"], data["inputs"], data["logs"]
            self.exit_code, self.duration_ms, self.locals = data["exitCode"], data["durationMs"], data["locals"]
            return
        if "meta" not in data or "events" not in data:
            raise SystemExit("error: %s is neither a recording of this prototype nor a pyokka run.json" % path)
        self.kind = "pyokka"
        meta, events = data["meta"], data["events"]
        self.file, self.config = meta["file"], meta.get("config") or dict(DEFAULT_CONFIG)
        self.sha256 = next((f.get("sha256") for f in meta.get("files") or [] if f.get("path") == self.file), None)
        trace = next((e for e in reversed(events) if e.get("type") == "trace" and not e.get("partial")), None)
        if trace is None:
            raise SystemExit("error: %s has no trace to replay against" % path)
        self.steps = _decode(trace["steps"])
        self.steps_run, self.truncated = meta.get("stepCount"), bool(trace.get("truncated"))
        self.scopes = {s["scopeId"]: s["name"] for s in trace.get("scopes") or []}
        self.files = [{"path": e["path"], "rangeBase": e["rangeBase"], "ranges": e["ranges"]} for e in events if e.get("type") == "file.instrumented"]
        self.inputs = None  # a run.json keeps no outside inputs
        self.logs = [e.get("text") for e in events if e.get("type") == "log"]
        self.exit_code, self.duration_ms = meta.get("exitCode"), meta.get("durationMs")
        self.locals = [entry for e in events if e.get("type") == "locals" for entry in e.get("entries") or []]

    @property
    def count(self) -> int:
        return len(self.steps) // 4

    def locate(self, rid: int, scope: int) -> str:
        for f in self.files:
            i = rid - f["rangeBase"]
            if 0 <= i < len(f["ranges"]) and f["ranges"][i]:
                return "%s:%d %s" % (os.path.basename(f["path"]), f["ranges"][i][0], self.scopes.get(scope, "?"))
        return "rid %d" % rid

    def kept(self, name: str, step: int) -> str | None:
        """The text the recorder kept for ``name`` as of ``step``, in that step's scope, else the module's."""
        scope = self.steps[4 * step + 1] if step < self.count else 0
        found: dict[int, str] = {}
        for entry in self.locals:
            if entry["step"] > step:
                break
            if entry["scopeId"] in (scope, 0):
                for change in entry.get("changes") or []:
                    if change.get("name") == name:
                        found[entry["scopeId"]] = change.get("text")
        return found.get(scope, found.get(0))


def _decode(b64: str) -> array:
    steps = array("i")
    steps.frombytes(base64.b64decode(b64))
    if sys.byteorder == "big":
        steps.byteswap()
    return steps


def _encode(steps: array) -> str:
    copy = array("i", steps)
    if sys.byteorder == "big":
        copy.byteswap()
    return base64.b64encode(copy.tobytes()).decode("ascii")


def run_program(path: str, content: str, config: dict, probe: Probe, inputs: Inputs) -> dict:
    """One run of ``path`` under Pyokka's recorder, in this process, with ``probe`` as its debugger."""
    request = build_request(path, content, library_code=bool(config.get("libraryCode")), record_locals=bool(config.get("recordLocals", True)), auto_log=bool(config.get("autoLog")), timeout_ms=0, argv=[], run_id="replay", http=str(config.get("http") or "off"), http_observe=bool(config.get("httpObserve", True)))
    events: list[dict] = []
    execution = Execution(RunSpec.from_request(request), events.append)
    execution.on_tracer = probe.attach
    inputs.install()
    started = _clock()
    try:
        result = execution.run()
    finally:
        inputs.uninstall()
    took = (_clock() - started) * 1000
    probe.note(result.uncaught)  # a read the recording never made stopped the program
    probe.finish()
    tracer = execution.tracer
    return {"exit": result.exit_code, "ms": took, "events": events, "tracer": tracer, "stepsRun": tracer.n_steps if tracer else 0}


def cmd_record(args: argparse.Namespace) -> int:
    path = os.path.abspath(args.file)
    content = read(path)
    probe = Probe(path, None, None, [])
    inputs = Inputs("record")
    out = run_program(path, content, DEFAULT_CONFIG, probe, inputs)
    tracer, events = out["tracer"], out["events"]
    data = {
        "format": FORMAT,
        "file": path,
        "sha256": sha256(content),
        "config": DEFAULT_CONFIG,
        "steps": _encode(tracer.steps),
        "stepsRun": tracer.n_steps,
        "truncated": tracer.n_steps > tracer.cap,
        "scopes": {str(s["scopeId"]): s["name"] for s in tracer.scopes},
        "files": [{"path": f.filename, "rangeBase": f.range_base, "ranges": f.ranges} for f in tracer.file_order],
        "inputs": inputs.kept,
        "logs": [e.get("text") for e in events if e.get("type") == "log"],
        "exitCode": out["exit"],
        "durationMs": round(out["ms"], 1),
        "locals": [entry for e in events if e.get("type") == "locals" for entry in e.get("entries") or []],
    }
    redact_value(data["logs"])
    redact_value(data["locals"])
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    reads = inputs.kept["reads"]
    print("recorded %s: %d steps, exit %s, the random seed and %d outside read%s kept, in %.0f ms" % (os.path.basename(path), len(tracer.steps) // 4, out["exit"], len(reads), "" if len(reads) == 1 else "s", out["ms"]))
    print("  saved %s" % args.out)
    return 0


def parse_watch(text: str) -> Watch:
    head, _, rest = text.partition(":")
    if head.strip().isdigit():
        return Watch(None, int(head), rest.strip())
    line, _, expr = rest.partition(":")
    if not line.strip().isdigit() or not expr.strip():
        raise SystemExit("error: a watch is [FILE:]LINE:EXPR, got %r" % text)
    return Watch(head.strip(), int(line), expr.strip())


def cmd_replay(args: argparse.Namespace) -> int:
    rec = Recording(args.recording)
    path = rec.file
    try:
        content = read(path)
    except OSError as exc:
        raise SystemExit("error: cannot read %s: %s" % (path, exc))
    if rec.sha256 and sha256(content) != rec.sha256:
        print("refused: %s changed since it was recorded, so its steps cannot be compared; record it again" % os.path.basename(path))
        return 2
    watches = [parse_watch(w) for w in args.watch]
    probe = Probe(path, rec.steps, rec.locate, watches)
    mode = "off" if args.no_inputs or rec.inputs is None else "replay"
    inputs = Inputs(mode, rec.inputs)
    config = dict(rec.config)
    if config.get("http") == "record":
        config["http"] = "replay"  # the recorded responses answer; the replay opens no connection
    out = run_program(path, content, config, probe, inputs)
    logs = [e.get("text") for e in out["events"] if e.get("type") == "log"]
    redact_value(logs)
    report(rec, probe, inputs, out, logs, mode)
    if args.values:
        write_values(args.values, rec, probe)
    return 0 if probe.diverged is None and probe.matched == rec.count else 1


def report(rec: Recording, probe: Probe, inputs: Inputs, out: dict, logs: list, mode: str) -> None:
    name = os.path.basename(rec.file)
    source = "a recording of this prototype" if rec.kind == "prototype" else "a pyokka run.json"
    print("replay of %s against %s (%s)" % (name, os.path.basename(rec.path), source))
    if probe.diverged is not None:
        d = probe.diverged
        print("  the replay went another way at step #%d of %d" % (d["step"], rec.count))
        print("    %s" % d["why"])
        if d["after"]:
            print("    the last step both runs took: #%d %s" % (d["step"] - 1, d["after"]))
        if d["caught"] > d["step"] + 1:
            print("    with nothing watched the check runs every 1,024 steps, so the program ran on to step #%d before it was caught" % (d["caught"] - 1))
        print("  values after #%d would come from a different run, so the watches end there" % (d["step"] - 1))
    elif probe.matched < rec.count:
        print("  the replay ended at step #%d; the recording went on to #%d" % (probe.matched - 1, rec.count - 1))
    else:
        same_exit = "exit code %s both times" % out["exit"] if out["exit"] == rec.exit_code else "exit code %s, the recording's was %s" % (out["exit"], rec.exit_code)
        print("  %d of %d steps matched, %s" % (probe.matched, rec.count, same_exit))
        if rec.truncated:
            print("  the recording stopped at its cap of %d steps; the program ran %s, and the steps past the cap were not compared" % (rec.count, "{:,}".format(rec.steps_run) if rec.steps_run else "more"))
        if logs == rec.logs:
            print("  printed the same %d line%s" % (len(logs), "" if len(logs) == 1 else "s"))
        else:
            first = next((i for i, (a, b) in enumerate(zip(logs, rec.logs)) if a != b), min(len(logs), len(rec.logs)))
            print("  printed something else at line %d: %r, the recording %r" % (first + 1, logs[first] if first < len(logs) else None, rec.logs[first] if first < len(rec.logs) else None))
    if mode == "replay":
        reads = (rec.inputs or {}).get("reads") or []
        print("  outside inputs: the random seed and %d of %d recorded reads handed back" % (inputs.pos, len(reads)))
    elif rec.inputs is None:
        print("  outside inputs: none recorded (a run.json keeps none), so the clock and random numbers were read fresh")
    else:
        print("  outside inputs: not handed back (--no-inputs), so the clock and random numbers were read fresh")
    # only a recording of this prototype ran the same way (in process); a run.json's time includes starting a runner
    took = " (the recording: %.0f ms)" % rec.duration_ms if rec.kind == "prototype" and isinstance(rec.duration_ms, (int, float)) else ""
    print("  the replay took %.0f ms in process%s" % (out["ms"], took))
    for w in probe.watches:
        hits = [h for wh, h in probe.hits if wh is w]
        where = "%s:%d" % (w.file or name, w.line)
        print()
        if not w.rids:
            print("watch %s at %s: no statement starts on that line" % (w.expr, where))
            continue
        print("watch %s at %s, before the line runs: %d hit%s" % (w.expr, where, len(hits), "" if len(hits) == 1 else "s"))
        if not hits and rec.truncated:
            print("  the line may only run past the recording's cap of %d steps, where nothing is compared or watched" % rec.count)
        for h in hits:
            step = h["step"]
            scope_name = rec.scopes.get(rec.steps[4 * step + 1], "?") if step < rec.count else "?"
            if "value" not in h:
                print("  #%d %s  %s" % (step, scope_name, h.get("missing") or h.get("error")))
                continue
            lines = redact(render(h["value"], width=96)).split("\n")
            print("  #%d %s" % (step, scope_name))
            for line in lines[:LINES_PER_HIT]:
                print("      " + line)
            if len(lines) > LINES_PER_HIT:
                print("      … %d more lines in the values file" % (len(lines) - LINES_PER_HIT))
            kept = rec.kept(w.expr, step) if w.expr.isidentifier() else None
            if kept is not None:
                print("    the recording kept: %s" % redact(kept))


def write_values(path: str, rec: Recording, probe: Probe) -> None:
    data = {
        "recording": os.path.abspath(rec.path),
        "file": rec.file,
        "matched": probe.matched,
        "steps": rec.count,
        "diverged": probe.diverged,
        "watches": [{"file": w.file, "line": w.line, "expr": w.expr, "hits": [h for wh, h in probe.hits if wh is w]} for w in probe.watches],
    }
    redact_value(data)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
    print()
    print("full values: %s" % path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="replay.py", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("record", help="run FILE under Pyokka's recorder and keep its outside inputs too")
    p.add_argument("file")
    p.add_argument("--out", required=True, metavar="REC.json")
    p = sub.add_parser("replay", help="run the program again and compare every step with the recording")
    p.add_argument("recording", metavar="REC.json|RUN.json")
    p.add_argument("--watch", action="append", default=[], metavar="[FILE:]LINE:EXPR", help="evaluate EXPR before LINE runs, at every hit, keeping the whole value")
    p.add_argument("--values", metavar="OUT.json", help="write every watch hit's whole value here")
    p.add_argument("--no-inputs", action="store_true", help="do not hand the recorded inputs back (to see what they change)")
    args = parser.parse_args(argv)
    return cmd_record(args) if args.command == "record" else cmd_replay(args)


if __name__ == "__main__":
    sys.exit(main())
