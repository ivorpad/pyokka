#!/usr/bin/env python3
"""Time a 500,000-iteration loop five ways: plain, run-all, and a debugger with and without a recording.

Run from anywhere: `python3 scripts/bench-debug.py [--python PATH] [--repeat N] [--json]`.
`--python` defaults to the interpreter running the script; the runner is started as
`<python> -m pyokka_runtime serve` with `python/` as its working directory, so no install is needed.

Every row is wall time from before the process starts to after the run's last event, so
interpreter start, instrumentation and the event pipe all count. The three runner-driven rows
(`run-all`, `debugger`, `debugger + recording`) are the comparison; `plain python` is the floor and
the in-process row shows the recording's own cost without a runner and a child.

The `debugger` row needs a runtime that advertises the `record` capability. Against an older one it
prints `not available before the change` and nothing is measured.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

PY_DIR = Path(__file__).resolve().parents[1] / "python"

# 1,000,003 statements: two module statements, the loop header once per iteration plus once to end
# it, and the body per iteration. `never_runs` adds no statement of its own: a `def` is recorded for
# coverage and is not a step.
PROGRAM = """total = 0
for i in range(500_000):
    total += i
print(total)


def never_runs():
    return 0
"""
STATEMENTS = 1_000_003

RUN_ALL_CONFIG = {"recordLocals": False, "timeoutMs": 0}
DEBUG_CONFIG = {"debug": True, "record": False, "stopOnEntry": False, "timeoutMs": 0}
DEBUG_RECORDING_CONFIG = {"debug": True, "stopOnEntry": False, "timeoutMs": 0, "recordLocals": True, "autoLog": True}
# Inside the function nobody calls: the breakpoint resolves, so the hook is armed for every
# statement of the loop, and it can never hit. That is the honest worst case.
NEVER_HIT_LINE = PROGRAM.splitlines().index("    return 0") + 1


class Measurement:
    """One row's numbers: the median wall time, the step count and the event count."""

    def __init__(self, label: str) -> None:
        self.label = label
        self.times: list[float] = []
        self.steps: int | None = None
        self.events: int | None = None
        self.skipped: str | None = None

    @property
    def wall(self) -> float:
        return statistics.median(self.times) if self.times else 0.0

    def to_json(self) -> dict:
        out: dict = {"row": self.label}
        if self.skipped is not None:
            out["skipped"] = self.skipped
            return out
        out.update(wall=round(self.wall, 3), samples=[round(t, 3) for t in self.times])
        if self.steps is not None:
            out["steps"] = self.steps
        if self.events is not None:
            out["events"] = self.events
        return out


def python_version(python: str) -> str:
    out = subprocess.run([python, "-c", "import platform; print(platform.python_version())"], capture_output=True, text=True)
    return out.stdout.strip() or "?"


def time_process(argv: list[str], cwd: str) -> float:
    started = time.perf_counter()
    subprocess.run(argv, cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    return time.perf_counter() - started


class RunnerRun:
    """One `run` request over a fresh runner, timed from before the process starts."""

    def __init__(self, python: str, program: str, config: dict, breakpoints: list[dict] | None) -> None:
        self.python = python
        self.program = program
        self.config = config
        self.breakpoints = breakpoints or []

    def capabilities(self) -> list[str]:
        proc = self._serve()
        try:
            self._send(proc, {"type": "hello", "id": 1, "version": "bench"})
            ready = self._recv(proc)
            return [str(c) for c in (ready.get("capabilities") or [])]
        finally:
            self._shutdown(proc)

    def measure(self) -> tuple[float, int, int]:
        started = time.perf_counter()
        proc = self._serve()
        try:
            self._send(proc, {"type": "hello", "id": 1, "version": "bench"})
            self._recv(proc)
            self._send(proc, self._request())
            events = 0
            finished: dict = {}
            while True:
                event = self._recv(proc)
                if not event:
                    break
                events += 1
                if event.get("type") == "run.finished":
                    finished = event
                    break
            wall = time.perf_counter() - started
        finally:
            self._shutdown(proc)
        return wall, int(finished.get("stepCount") or 0), events

    def _request(self) -> dict:
        return {
            "type": "run",
            "id": 2,
            "runId": "bench",
            "file": {"path": self.program, "displayName": os.path.basename(self.program)},
            "workspaceRoot": os.path.dirname(self.program),
            "cwd": os.path.dirname(self.program),
            "argv": [],
            "env": {},
            "projectFiles": [],
            "config": dict(self.config),
            "markers": [],
            "expressionsToEvaluate": {},
            "watch": [],
            "mode": "normal",
            "breakpoints": list(self.breakpoints),
        }

    def _serve(self) -> subprocess.Popen:
        return subprocess.Popen(
            [self.python, "-m", "pyokka_runtime", "serve"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=str(PY_DIR),
        )

    @staticmethod
    def _send(proc: subprocess.Popen, message: dict) -> None:
        assert proc.stdin is not None
        proc.stdin.write((json.dumps(message) + "\n").encode("utf-8"))
        proc.stdin.flush()

    @staticmethod
    def _recv(proc: subprocess.Popen) -> dict:
        assert proc.stdout is not None
        line = proc.stdout.readline()
        return json.loads(line) if line.strip() else {}

    def _shutdown(self, proc: subprocess.Popen) -> None:
        try:
            self._send(proc, {"type": "shutdown", "id": 99})
            proc.wait(timeout=10)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=10)


def measure(python: str, program: str, repeat: int, supports_record: bool) -> list[Measurement]:
    program_dir = os.path.dirname(program)
    rows = [
        Measurement("plain python"),
        Measurement("run-all (in-process pyokka run)"),
        Measurement("run-all"),
        Measurement("debugger"),
        Measurement("debugger + recording"),
    ]
    plain, in_process, run_all, debugger, debugger_recording = rows
    if not supports_record:
        debugger.skipped = "not available before the change"
    runs = {
        run_all: RunnerRun(python, program, RUN_ALL_CONFIG, None),
        debugger: RunnerRun(python, program, DEBUG_CONFIG, [{"path": program, "line": NEVER_HIT_LINE}]),
        debugger_recording: RunnerRun(python, program, DEBUG_RECORDING_CONFIG, [{"path": program, "line": NEVER_HIT_LINE}]),
    }
    for _ in range(repeat):
        plain.times.append(time_process([python, program], program_dir))
        in_process.times.append(time_process([python, "-m", "pyokka_runtime", "run", program, "--json"], str(PY_DIR)))
        in_process.steps = STATEMENTS
        for row, runner in runs.items():
            if row.skipped is not None:
                continue
            wall, steps, events = runner.measure()
            row.times.append(wall)
            row.steps, row.events = steps, events
    return rows


def print_table(rows: list[Measurement], python: str, version: str, repeat: int) -> None:
    plain = rows[0].wall
    print("program: 500,000-iteration loop (%s statements)" % format(STATEMENTS, ","))
    print("python: %s (%s), median of %d" % (python, version, repeat))
    print()
    print("%-35s %-9s %-9s %-12s %s" % ("row", "wall", "x plain", "steps", "events"))
    for row in rows:
        if row.skipped is not None:
            print("%-35s %s" % (row.label, row.skipped))
            continue
        ratio = "1.0" if row is rows[0] else ("%.1f" % (row.wall / plain) if plain else "-")
        print("%-35s %-9s %-9s %-12s %s" % (row.label, "%.2f s" % row.wall, ratio, row.steps if row.steps else "-", row.events if row.events is not None else "-"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Time the debugger against run-all on a 1,000,003-statement loop.")
    parser.add_argument("--python", default=sys.executable, help="interpreter to measure (default: the one running this script)")
    parser.add_argument("--repeat", type=int, default=3, help="runs per row; the median is reported (default 3)")
    parser.add_argument("--json", action="store_true", help="JSON instead of the table")
    args = parser.parse_args(argv)
    repeat = max(1, int(args.repeat))
    with tempfile.TemporaryDirectory(prefix="pyokka-bench-") as tmp:
        program = os.path.join(tmp, "bench_loop.py")
        Path(program).write_text(PROGRAM, encoding="utf-8")
        capabilities = RunnerRun(args.python, program, {}, None).capabilities()
        rows = measure(args.python, program, repeat, "record" in capabilities)
        version = python_version(args.python)
    if args.json:
        print(json.dumps({"python": args.python, "pythonVersion": version, "repeat": repeat, "statements": STATEMENTS, "rows": [r.to_json() for r in rows]}, indent=2))
    else:
        print_table(rows, args.python, version, repeat)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
