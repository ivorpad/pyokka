"""Replaying a recording that began at a pause: `startedAt` on the recording, `replay.startAt` on the replay.

A recording that began at a pause (`recordFrom`, or the `record` action at a later pause) numbers
its steps from that pause. Its trace says where it began, as the debugger's statement count there,
and a replay given that count runs unrecorded up to it, switches to recording at the same
statement, and checks from step 0 as any replay does (replay.py).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.test_replay import INVOICES, entries, expect, normalized, of, props, quads, result
from tests.test_runner import Client

DEBUG = {"timeoutMs": 20000, "debug": True, "stopOnEntry": False, "recordLocals": True}
REPLAY = {"timeoutMs": 20000, "recordLocals": True}  # what the host sends: no debug, no recordFrom, no breakpoints
RATE_LINE = 41  # `rate = DISCOUNTS.get(...)` in invoice_total, once per customer
TOTALS_LINE = 47  # `totals = {...}` in main


@pytest.fixture
def runner():
    c = Client()
    c.send(type="hello", version="test")
    assert "replay" in c.recv()["capabilities"]
    yield c
    c.close()


@pytest.fixture
def invoices(tmp_path) -> Path:
    path = tmp_path / "invoices.py"
    path.write_text(INVOICES, encoding="utf-8")
    return path


def base(path: Path) -> dict:
    return {"file": {"path": str(path), "displayName": path.name}, "workspaceRoot": str(path.parent), "cwd": str(path.parent), "argv": [], "env": {}, "projectFiles": [], "markers": [], "expressionsToEvaluate": {}, "watch": [], "mode": "normal"}


def record(runner, path: Path, record_from: object, breakpoints: list[dict], *, record_at: int | None = None) -> list[dict]:
    """A recording debug run: continue at every pause, or send `record` at the ``record_at``-th pause before the recording began."""
    runner.send(type="run", runId="rec", config={**DEBUG, "recordFrom": record_from}, breakpoints=breakpoints, **base(path))
    events: list[dict] = []
    plain = 0
    while True:
        m = runner.recv()
        events.append(m)
        if m.get("runId") != "rec":
            continue
        if m.get("type") == "debug.paused":
            if not m.get("recordingStarted"):
                plain += 1
                if plain == record_at:
                    runner.send(type="debug", runId="rec", action="record")  # the stop comes again as step 0
                    continue
            runner.send(type="debug", runId="rec", action="continue")
        if m.get("type") == "run.finished":
            return events


def started_at(events: list[dict]) -> int:
    """The recording's start point, the same on the pause that started it and on every trace event, partials included."""
    (pause,) = [e for e in of(events, "debug.paused") if e.get("recordingStarted")]
    traces = of(events, "trace")
    assert traces and all(t.get("midRun") is True and t.get("startedAt") == pause["startedAt"] for t in traces)
    assert isinstance(pause["startedAt"], int) and pause["startedAt"] > 0
    return pause["startedAt"]


def observed(events: list[dict], name: str, scope_name: str) -> tuple[int, dict]:
    """The first recorded change of ``name`` in ``scope_name``: (the step that observed it, the change)."""
    trace = [t for t in of(events, "trace") if not t.get("partial")][-1]
    scopes = {s["scopeId"]: s["name"] for s in trace["scopes"]}
    for entry in entries(events):
        if scopes.get(entry["scopeId"]) == scope_name:
            for c in entry["changes"]:
                if c["name"] == name:
                    return entry["step"], c
    raise AssertionError("no change of %s in %s" % (name, scope_name))


def replay(runner, path: Path, recorded: list[dict], at: int, expr: str, start: int, *, check: str | None = None, run_id: str = "rp") -> list[dict]:
    body: dict = {"expect": expect(quads(recorded), at), "at": {"step": at, "expr": expr}, "startAt": start}
    if check is not None:
        body["check"] = {"step": at, "name": check}
    [inputs] = of(recorded, "inputs")  # a recordFrom run keeps its inputs from the program's start
    body["inputs"] = {"seed": inputs["seed"], "reads": inputs["reads"]}
    return runner.run(path, runId=run_id, config=dict(REPLAY), replay=body)


def same_locals_before(recorded: list[dict], replayed: list[dict], n: int) -> None:
    before = lambda events: [e for e in entries(events) if e["step"] < n]  # noqa: E731
    assert before(replayed) and normalized(before(replayed)) == normalized(before(recorded))


def test_a_recording_from_a_function_replays_from_its_start_point(runner, invoices):
    recorded = record(runner, invoices, {"function": "main"}, [{"path": "", "line": 0, "function": "main"}])
    start = started_at(recorded)
    n, kept = observed(recorded, "orders", "main")  # assigned after the switch, cut by the recorder
    assert kept.get("truncated")
    replayed = replay(runner, invoices, recorded, n, "orders", start, check="orders")
    got = result(replayed)
    assert got["status"] == "reached" and got["step"] == n and got["matched"] == n + 1
    assert got["check"] == {"step": n, "text": kept["text"]}
    assert sorted(props(got["value"]["data"])) == ["Ana", "Ben", "Caro", "Dani"]
    trace = [t for t in of(replayed, "trace") if not t.get("partial")][-1]
    assert trace["midRun"] is True and trace["startedAt"] == start, "the replay's own recording began at the same statement"
    same_locals_before(recorded, replayed, n)


def test_a_recording_from_a_line_replays_from_its_start_point(runner, invoices):
    recorded = record(runner, invoices, {"path": str(invoices), "line": TOTALS_LINE}, [{"path": str(invoices), "line": TOTALS_LINE}])
    start = started_at(recorded)
    n, kept = observed(recorded, "totals", "main")
    got = result(replay(runner, invoices, recorded, n, "totals", start, check="totals"))
    assert got["status"] == "reached" and got["matched"] == n + 1 and got["check"]["text"] == kept["text"]
    assert props(got["value"]["data"])["Ben"]["value"] == "0.0"


def test_a_recording_the_record_action_began_at_a_later_pause_replays_from_there(runner, invoices):
    # paused at line 41 for Ana first, recorded from the pause for Ben: Ana's call ran unrecorded
    recorded = record(runner, invoices, {"function": "never_defined"}, [{"path": str(invoices), "line": RATE_LINE}], record_at=2)
    start = started_at(recorded)
    n, kept = observed(recorded, "totals", "main")  # main was on the stack at the switch: its later change is recorded
    replayed = replay(runner, invoices, recorded, n, "totals", start, check="totals")
    got = result(replayed)
    assert got["status"] == "reached" and got["matched"] == n + 1 and got["check"]["text"] == kept["text"]
    assert sorted(props(got["value"]["data"])) == ["Ana", "Ben", "Caro", "Dani"]
    rate_step, rate = observed(recorded, "rate", "invoice_total")
    got = result(replay(runner, invoices, recorded, rate_step, "rate", start, check="rate", run_id="rp2"))
    assert got["status"] == "reached" and got["check"]["text"] == rate["text"] == "0.1", "Ben's silver rate, assigned by step 0's statement"
    same_locals_before(recorded, replayed, n)


def test_a_start_point_that_does_not_match_goes_another_way_at_step_0(runner, invoices):
    recorded = record(runner, invoices, {"function": "main"}, [{"path": "", "line": 0, "function": "main"}])
    start = started_at(recorded)
    n, _ = observed(recorded, "orders", "main")
    late = result(replay(runner, invoices, recorded, n, "orders", start + 1, run_id="late"))
    assert late["status"] == "diverged" and late["step"] == 0 and late["matched"] == 0
    assert late["message"].startswith("the start point did not match: the program ended after")
    early = result(replay(runner, invoices, recorded, n, "orders", start - 1, run_id="early"))
    assert early["status"] == "diverged" and early["step"] == 0 and early["matched"] == 0
    assert early["message"].startswith("the start point did not match") and "(it ran at %d)" % start in early["message"]


def test_a_start_point_past_the_end_of_the_program_goes_another_way(runner, invoices):
    recorded = record(runner, invoices, {"function": "main"}, [{"path": "", "line": 0, "function": "main"}])
    n, _ = observed(recorded, "orders", "main")
    got = result(replay(runner, invoices, recorded, n, "orders", 10**6))
    assert got["status"] == "diverged" and got["step"] == 0 and "before statement 1000000 where the recording began" in got["message"]


def test_without_a_start_point_a_replay_of_a_recording_from_a_pause_is_refused(runner, invoices):
    recorded = record(runner, invoices, {"function": "main"}, [{"path": "", "line": 0, "function": "main"}])
    body = {"expect": expect(quads(recorded), 2), "at": {"step": 2, "expr": "orders"}}
    got = result(runner.run(invoices, runId="nostart", config={**DEBUG, "recordFrom": {"function": "main"}}, replay=body))
    assert got["status"] == "error" and "records from a pause on" in got["message"]
