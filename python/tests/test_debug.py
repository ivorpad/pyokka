"""The frontier debugger: start paused, breakpoints and conditions, step into / over / out,
break-when watches, pauses on exceptions, evaluation and locals in the live frame, the flush
at a pause, and the same protocol end to end through the runner (fork and spawn)."""

from __future__ import annotations

import threading
import time
from pathlib import Path

from pyokka_runtime.control import handle_request
from pyokka_runtime.debugger import Debugger
from pyokka_runtime.protocol import FLAG_SCOPE_ENTRY, decode_steps
from tests.test_runner import Client, client  # noqa: F401 - the fixture

LOOP = """
total = 0
for i in range(5):
    total += i
print(total)
"""

CALLS = """
def f(x):
    y = x + 1
    return y * 2


a = f(1)
b = f(2)
c = a + b
"""

# The shape of test/e2e/fixtures/debug_raise.py: a handled ValueError inside a call, then one
# nobody catches. `raise` is line 4, `return int(text)` line 10, `print("start")` line 15.
RAISES = """
def check(n):
    if n > 2:
        raise ValueError("too big: %d" % n)
    return n


def parse(text):
    try:
        return int(text)
    except ValueError:
        return -1


print("start")
print(parse("x"))
total = 0
for i in range(5):
    total += check(i)
print("end", total)
"""

GENERATOR = """
import sys


def counter():
    yield 1
    yield 2


for v in counter():
    print(v)
sys.exit(3)
"""

CONTINUE = {"type": "debug", "id": "go", "action": "continue"}


def step(kind: str) -> dict:
    return {"type": "debug", "id": "step-%s" % kind, "action": "step", "kind": kind}


class Scripted:
    """The control channel of an in-process run: at each pause one batch of requests, the last of which resumes."""

    def __init__(self, *batches):
        self.batches = [list(b) for b in batches]
        self.debuggers: list[Debugger] = []

    def serve_paused(self, debugger, frame):
        self.debuggers.append(debugger)
        batch = self.batches.pop(0) if self.batches else [CONTINUE]
        action = None
        for req in batch:
            action = handle_request(req, None, debugger.tracer.emit, frame, debugger) or action
        return action or {"action": "continue", "kind": None}


def attach(control, breakpoints=None, seen: list | None = None):
    """What `control.attach_debugger` does in the run child, for the in-process helper."""

    def on_tracer(tracer):
        tracer.dbg = Debugger(tracer, control, {"breakpoints": breakpoints or []})
        if seen is not None:
            seen.append(tracer.dbg)

    return on_tracer


def pauses(out):
    return [e for e in out.events if e["type"] == "debug.paused"]


def results(out, kind):
    return [e for e in out.events if e["type"] == kind]


def test_stop_on_entry_off_runs_to_the_first_breakpoint_or_the_end(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    out = run(LOOP, config={"debug": True, "stopOnEntry": False}, on_tracer=attach(Scripted([CONTINUE]), breakpoints=[{"path": path, "line": 5}]))
    ps = pauses(out)
    assert [(p["reason"], p["line"]) for p in ps] == [("breakpoint", 5)], "no pause at the start: the run went to the breakpoint"
    assert out.result.exit_code == 0 and [e["text"] for e in out.logs] == ["10"]
    quiet = run(LOOP, config={"debug": True, "stopOnEntry": False}, on_tracer=attach(Scripted()))
    assert pauses(quiet) == [] and quiet.result.exit_code == 0 and [e["text"] for e in quiet.logs] == ["10"], "with no breakpoint the run goes to the end, the debugger attached all along"


def test_start_paused_pauses_before_the_first_statement_and_flushes_the_trace(run):
    plain = run(LOOP)
    out = run(LOOP, config={"debug": True}, on_tracer=attach(Scripted([CONTINUE])))
    kinds = [e["type"] for e in out.events]
    (p,) = pauses(out)
    assert p["reason"] == "start" and p["step"] == 0 and p["line"] == 2 and p["fileId"] == 1 and p["scopeId"] == 0
    assert p["stack"] == [{"scopeId": 0, "name": "<module>", "rid": 0, "depth": 0}]
    assert p["thread"] == {"name": "MainThread", "ident": threading.get_ident()}, "every pause names its thread, recording or not"
    assert "modified" not in p, "nothing has written into the program"
    assert kinds.index("debug.paused") < kinds.index("log"), "paused before the program printed anything"
    # the recording so far went out before the pause: one partial trace holding step 0
    partial = [e for e in out.events if e["type"] == "trace" and e.get("partial")]
    assert partial and kinds.index("trace") < kinds.index("debug.paused")
    assert len(decode_steps(partial[0]["steps"])) // 4 == 1
    (ack,) = results(out, "debug.result")
    assert ack["id"] == "go" and ack["ok"] is True
    (resumed,) = results(out, "debug.resumed")
    assert resumed == {"type": "debug.resumed", "step": 0, "action": "continue"}
    assert out.result.exit_code == 0 and out.result.step_count == plain.result.step_count
    assert [e["text"] for e in out.logs] == ["10"]


def test_breakpoint_pauses_before_each_hit_and_evaluates_in_the_frame(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    batches = [[{"type": "evaluate", "id": "e%d" % k, "expression": "(i, total)"}, CONTINUE] for k in range(5)]
    out = run(LOOP, on_tracer=attach(Scripted(*batches), breakpoints=[{"path": path, "line": 4}]))
    ps = pauses(out)
    assert [p["reason"] for p in ps] == ["breakpoint"] * 5 and {p["line"] for p in ps} == {4}
    bp = ps[0]["breakpoint"]
    assert bp["resolvedLine"] == 4 and bp["fileId"] == 1 and bp["rid"] == ps[0]["rid"] and bp["path"] == path
    # the hook runs before the statement: `total` is the value before this iteration's addition
    assert [e["text"] for e in results(out, "evaluate.result")] == ["(0, 0)", "(1, 0)", "(2, 1)", "(3, 3)", "(4, 6)"]
    assert results(out, "evaluate.result")[0]["valueBag"]["data"]["type"] == "tuple"
    assert out.result.exit_code == 0 and [e["text"] for e in out.logs] == ["10"]


def test_conditional_breakpoint_and_a_broken_condition(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    out = run(LOOP, on_tracer=attach(Scripted([{"type": "evaluate", "id": "e", "expression": "i"}, CONTINUE]), breakpoints=[{"path": path, "line": 4, "condition": "i == 3"}]))
    (p,) = pauses(out)
    assert p["breakpoint"]["condition"] == "i == 3" and results(out, "evaluate.result")[0]["text"] == "3"
    broken = run(LOOP, on_tracer=attach(Scripted(), breakpoints=[{"path": path, "line": 4, "condition": "nope > 1"}]))
    ps = pauses(broken)
    assert len(ps) == 5 and all(p["conditionError"].startswith("NameError") for p in ps), "a condition that cannot be evaluated pauses and says why"


def test_step_into_over_and_out_follow_the_time_machine_moves(run):
    batches = [
        [step("into")],  # from `a = f(1)` into f: its entry step
        [step("into")],  # y = x + 1
        [{"type": "debug", "id": "l1", "action": "locals"}, step("into")],  # return y * 2
        [{"type": "debug", "id": "l2", "action": "locals"}, step("out")],  # back in the module: b = f(2)
        [step("over")],  # f(2) runs through: c = a + b
        [CONTINUE],
    ]
    out = run(CALLS, config={"debug": True}, on_tracer=attach(Scripted(*batches)))
    ps = pauses(out)
    assert [(p["line"], p["scopeId"], p["depth"], p["reason"], p.get("kind")) for p in ps] == [
        (7, 0, 0, "start", None),
        (2, 1, 1, "step", "into"),
        (3, 1, 1, "step", "into"),
        (4, 1, 1, "step", "into"),
        (8, 0, 0, "step", "out"),
        (9, 0, 0, "step", "over"),
    ]
    assert ps[1]["stack"][0]["name"] == "f" and ps[1]["stack"][1]["scopeId"] == 0
    trace = [e for e in out.events if e["type"] == "trace" and not e.get("partial")][0]
    quads = decode_steps(trace["steps"])
    assert quads[ps[1]["step"] * 4 + 3] & FLAG_SCOPE_ENTRY, "step into lands on the function-entry step"
    l1, l2 = results(out, "debug.result")[2], results(out, "debug.result")[4]
    assert [(v["name"], v["text"]) for v in l1["locals"]] == [("x", "1")]
    assert [(v["name"], v["text"]) for v in l2["locals"]] == [("x", "1"), ("y", "2")]
    assert [e["action"] + ("/" + e["kind"] if "kind" in e else "") for e in results(out, "debug.resumed")] == ["step/into", "step/into", "step/into", "step/out", "step/over", "continue"]
    assert out.result.exit_code == 0


def test_breakpoint_in_a_module_imported_later_resolves_when_it_is_instrumented(run, tmp_path):
    main = """
    import helper
    v = helper.twice(21)
    print(v)
    """
    helper = """
    def twice(n):
        r = n * 2
        return r
    """
    seen: list[Debugger] = []
    ctl = Scripted([{"type": "debug", "id": "l", "action": "locals"}, CONTINUE])
    out = run(main, files={"helper.py": helper}, on_tracer=attach(ctl, breakpoints=[{"path": str(tmp_path / "helper.py"), "line": 3}], seen=seen))
    (p,) = pauses(out)
    assert p["fileId"] == 2 and p["line"] == 3 and p["reason"] == "breakpoint" and p["breakpoint"]["fileId"] == 2
    assert p["stack"][0]["name"] == "twice" and p["stack"][-1]["scopeId"] == 0
    assert [(v["name"], v["text"]) for v in results(out, "debug.result")[0]["locals"]] == [("n", "21")]
    assert seen[0].breakpoints[0].rid is not None and out.logs[0]["text"] == "42"


def test_breakpoint_on_a_blank_line_moves_to_the_next_statement_and_on_a_def_pauses_at_entry(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    out = run(CALLS, on_tracer=attach(Scripted(), breakpoints=[{"path": path, "line": 5}, {"path": path, "line": 2}]))
    ps = pauses(out)
    assert [(p["line"], p["breakpoint"]["line"], p["breakpoint"]["resolvedLine"]) for p in ps] == [(7, 5, 7), (2, 2, 2), (2, 2, 2)]
    assert ps[1]["scopeId"] == 1 and ps[2]["scopeId"] == 2, "a breakpoint on a def line pauses at every entry"


def test_break_when_watches_pause_on_change_and_on_turning_true(run):
    changes = Scripted([{"type": "debug", "id": "w", "action": "watches", "set": [{"id": "w1", "exp": "total", "breakWhen": "change"}]}, CONTINUE])
    out = run(LOOP, config={"debug": True}, on_tracer=attach(changes))
    ps = pauses(out)[1:]
    assert [p["reason"] for p in ps] == ["watch"] * 4 and [p["watch"]["text"] for p in ps] == ["1", "3", "6", "10"]
    assert ps[0]["watch"] == {"id": "w1", "exp": "total", "text": "1"}
    assert results(out, "debug.result")[0]["watches"] == [{"id": "w1", "exp": "total", "breakWhen": "change"}]
    # a change watch set before the name exists fires when the name first gets a value
    appears = Scripted([{"type": "debug", "id": "w", "action": "watches", "set": [{"id": "w3", "exp": "label", "breakWhen": "change"}]}, CONTINUE])
    out = run(LOOP.replace("print(total)", "label = 'done'\nprint(total)"), config={"debug": True}, on_tracer=attach(appears))
    ps = pauses(out)[1:]
    assert [(p["line"], p["watch"]["text"]) for p in ps] == [(6, "'done'")], "the first value of a name that did not exist is a change"
    edge = Scripted([{"type": "debug", "id": "w", "action": "watches", "set": [{"id": "w2", "exp": "total >= 3", "breakWhen": "true"}]}, CONTINUE])
    out = run(LOOP, config={"debug": True}, on_tracer=attach(edge))
    ps = pauses(out)[1:]
    assert [(p["reason"], p["watch"]["text"]) for p in ps] == [("watch", "True")], "the rising edge only"


def test_uncaught_exception_pauses_at_the_raise_with_the_frame_still_readable(run):
    ctl = Scripted([{"type": "debug", "id": "l", "action": "locals"}, {"type": "evaluate", "id": "e", "expression": "n * 2"}, CONTINUE])
    out = run(RAISES, config={"debug": True, "stopOnEntry": False}, on_tracer=attach(ctl))  # breakOnException defaults to uncaught
    (p,) = pauses(out)
    assert (p["reason"], p["line"], p["fileId"]) == ("exception", 4, 1), "the raise inside check, not the caller"
    assert p["exception"] == {"type": "ValueError", "message": "too big: 3", "uncaught": True}
    assert [s["name"] for s in p["stack"]] == ["check", "<module>"] and p["depth"] == 1
    assert [(v["name"], v["text"]) for v in results(out, "debug.result")[0]["locals"]] == [("n", "3")]
    assert results(out, "evaluate.result")[0]["text"] == "6", "the returned frame still answers"
    assert [e["text"] for e in out.logs] == ["start", "-1"], "the output so far was flushed before the pause"
    assert out.result.exit_code == 1
    (err,) = [e for e in out.errors if not e["handled"]]
    assert err["errorType"] == "ValueError" and err["rid"] == p["rid"] and "ValueError: too big: 3" in err["traceback"]


def test_raised_mode_pauses_at_every_first_sighting_and_again_at_the_top(run):
    out = run(RAISES, config={"debug": True, "stopOnEntry": False, "breakOnException": "raised"}, on_tracer=attach(Scripted()))
    ps = pauses(out)
    assert [(p["line"], p["exception"]["uncaught"]) for p in ps] == [(10, False), (4, False), (4, True)]
    assert [p["reason"] for p in ps] == ["exception"] * 3 and {p["exception"]["type"] for p in ps} == {"ValueError"}
    assert [s["name"] for s in ps[0]["stack"]] == ["parse", "<module>"], "the handled one pauses where the C call raised"
    assert "invalid literal for int()" in ps[0]["exception"]["message"]
    assert [e["action"] for e in results(out, "debug.resumed")] == ["continue"] * 3
    assert out.result.exit_code == 1


def test_off_never_pauses_on_an_exception(run):
    out = run(RAISES, config={"debug": True, "stopOnEntry": False, "breakOnException": "off"}, on_tracer=attach(Scripted()))
    assert pauses(out) == [] and out.result.exit_code == 1
    assert [e["errorType"] for e in out.errors if not e["handled"]] == ["ValueError"]


def test_stop_iteration_and_system_exit_never_pause(run):
    out = run(GENERATOR, config={"debug": True, "stopOnEntry": False, "breakOnException": "raised"}, on_tracer=attach(Scripted()))
    assert pauses(out) == [], "a generator ending and sys.exit are not exceptions the user wants to stop at"
    assert out.result.exit_code == 3 and [e["text"] for e in out.logs] == ["1", "2"]


def test_the_exceptions_action_changes_the_mode_in_flight(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    switch = Scripted([{"type": "debug", "id": "x", "action": "exceptions", "mode": "uncaught"}, CONTINUE])
    out = run(RAISES, config={"breakOnException": "off"}, on_tracer=attach(switch, breakpoints=[{"path": path, "line": 15}]))
    ps = pauses(out)
    assert [(p["reason"], p["line"]) for p in ps] == [("breakpoint", 15), ("exception", 4)], "off until the switch, then the top pause"
    assert results(out, "debug.result")[0] == {"type": "debug.result", "id": "x", "ok": True, "mode": "uncaught"}
    assert ps[1]["exception"]["uncaught"] is True
    bad = Scripted([{"type": "debug", "id": "y", "action": "exceptions", "mode": "sideways"}, CONTINUE])
    out = run(RAISES, config={"breakOnException": "off"}, on_tracer=attach(bad, breakpoints=[{"path": path, "line": 15}]))
    assert results(out, "debug.error")[0]["message"].startswith("unknown exception mode")
    assert [p["reason"] for p in pauses(out)] == ["breakpoint"], "a rejected mode leaves the run as it was"


def test_evaluate_in_a_paused_frame_runs_a_pure_call(run, tmp_path):
    source = """
    payload = {"items": [1, 2, 3], "name": "box"}


    def show(payload):
        return len(payload["items"])


    print(show(payload))
    """
    asks = [{"type": "evaluate", "id": "e1", "expression": 'len(payload["items"])'}, {"type": "evaluate", "id": "e2", "expression": 'payload["name"].upper()'}, {"type": "evaluate", "id": "e3", "expression": 'payload["items"].append(4)'}, CONTINUE]
    out = run(source, on_tracer=attach(Scripted(asks), breakpoints=[{"path": str(tmp_path / "scratch.py"), "line": 6}]))
    assert [e["text"] for e in results(out, "evaluate.result")] == ["3", "'BOX'"]
    assert "cannot call `payload['items'].append`" in results(out, "evaluate.error")[0]["message"]
    assert out.logs[0]["text"] == "3" and out.result.exit_code == 0


def test_recorded_locals_flushed_at_a_pause_are_not_sent_twice(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    plain = run(LOOP, config={"recordLocals": True})
    out = run(LOOP, config={"recordLocals": True}, on_tracer=attach(Scripted(), breakpoints=[{"path": path, "line": 5}]))
    kinds = [e["type"] for e in out.events]
    assert kinds.index("locals") < kinds.index("debug.paused"), "entries so far go out before the pause"
    entries = [en for e in results(out, "locals") for en in e["entries"]]
    expected = [en for e in results(plain, "locals") for en in e["entries"]]
    assert entries == expected and len(results(out, "locals")) == 2


def test_running_program_refuses_evaluate_and_a_missing_debugger_says_so(run):
    (err,) = [e for e in _collect(lambda emit: handle_request({"type": "debug", "id": "x", "action": "continue"}, None, emit, None, None))]
    assert err["type"] == "debug.error" and "no debugger" in err["message"]
    out = run(LOOP, config={"debug": True}, on_tracer=attach(Scripted([{"type": "debug", "id": "k", "action": "step", "kind": "sideways"}, CONTINUE])))
    assert results(out, "debug.error")[0]["message"].startswith("unknown step kind")


def _collect(fn):
    events: list[dict] = []
    fn(events.append)
    return events


def until(client, kind: str) -> dict:
    """The next message of this kind from the runner."""
    for _ in range(500):
        m = client.recv()
        if m.get("type") == kind:
            return m
    raise AssertionError("no %s arrived" % kind)


def test_exception_pause_over_the_runner(client, tmp_path):
    client.send(type="hello", version="test")
    client.recv()
    scratch = tmp_path / "boom.py"
    scratch.write_text(RAISES, encoding="utf-8")  # the leading blank line keeps the line numbers of the constant
    base = {"file": {"path": str(scratch), "displayName": scratch.name}, "workspaceRoot": str(tmp_path), "cwd": str(tmp_path), "argv": [], "env": {}, "projectFiles": [], "markers": [], "expressionsToEvaluate": {}, "watch": [], "mode": "normal"}
    client.send(type="run", runId="x1", config={"timeoutMs": 20000, "debug": True, "stopOnEntry": False}, **base)
    p = until(client, "debug.paused")
    assert p["reason"] == "exception" and p["line"] == 4 and p["stack"][0]["name"] == "check"
    assert p["exception"] == {"type": "ValueError", "message": "too big: 3", "uncaught": True}
    client.send(type="evaluate", runId="x1", expression="n * 2")
    assert until(client, "evaluated")["text"] == "6"
    client.send(type="debug", runId="x1", action="locals")
    assert [v["name"] for v in until(client, "debug.result")["locals"]] == ["n"]
    eid = client.send(type="debug", runId="x1", action="exceptions", mode="raised")
    assert until(client, "debug.result") == {"type": "debug.result", "id": eid, "ok": True, "mode": "raised"}, "the mode changes while paused too"
    client.send(type="debug", runId="x1", action="continue")
    until(client, "debug.result")
    err = until(client, "error")
    assert err["errorType"] == "ValueError" and err["handled"] is False
    assert until(client, "run.finished")["exitCode"] == 1


def test_debug_over_the_runner(client, tmp_path):
    client.send(type="hello", version="test")
    assert "debug" in client.recv()["capabilities"]
    scratch = tmp_path / "s.py"
    scratch.write_text("import time\ntotal = 0\nfor i in range(3):\n    total += i\nprint(total)\n", encoding="utf-8")

    def until(kind: str) -> dict:
        while True:
            m = client.recv()
            if m.get("type") == kind:
                return m
            assert m.get("type") not in ("run.finished", "error"), "unexpected %r while waiting for %s" % (m, kind)

    base = {"file": {"path": str(scratch), "displayName": scratch.name}, "workspaceRoot": str(tmp_path), "cwd": str(tmp_path), "argv": [], "env": {}, "projectFiles": [], "markers": [], "expressionsToEvaluate": {}, "watch": [], "mode": "normal"}
    client.send(type="run", runId="d1", config={"timeoutMs": 1200, "debug": True}, **base)
    assert until("debug.paused")["reason"] == "start"
    client.send(type="debug", runId="d1", action="breakpoints", set=[{"path": str(scratch), "line": 4}])
    assert until("debug.result")["breakpoints"][0]["resolvedLine"] == 4
    time.sleep(1.5)  # longer than timeoutMs: a paused run is not on the clock
    client.send(type="debug", runId="d1", action="continue")
    until("debug.result")
    p = until("debug.paused")
    assert p["reason"] == "breakpoint" and p["line"] == 4
    client.send(type="evaluate", runId="d1", expression="(i, total)")
    assert until("evaluated")["text"] == "(0, 0)"
    client.send(type="debug", runId="d1", action="locals")
    assert {v["name"] for v in until("debug.result")["locals"]} >= {"i", "total"}
    client.send(type="debug", runId="d1", action="step", kind="over")
    until("debug.result")
    p2 = until("debug.paused")
    assert p2["reason"] == "step" and p2["kind"] == "over" and p2["line"] == 3
    client.send(type="stop", runId="d1")
    fin = until("run.finished")
    assert fin["stopped"] is True and fin["timedOut"] is False
    # a pause requested while the program runs lands at its next statement
    sleeper = tmp_path / "sleeper.py"
    sleeper.write_text("import time\nfor i in range(40):\n    time.sleep(0.05)\n    x = i\nprint(x)\n", encoding="utf-8")
    client.send(type="run", runId="d2", config={"timeoutMs": 20000, "debug": True}, **{**base, "file": {"path": str(sleeper), "displayName": sleeper.name}})
    assert until("debug.paused")["reason"] == "start"
    client.send(type="debug", runId="d2", action="continue")
    until("debug.result")
    time.sleep(0.3)
    client.send(type="debug", runId="d2", action="pause")
    assert until("debug.result")["ok"] is True
    p3 = until("debug.paused")
    assert p3["reason"] == "pause" and p3["line"] in (2, 3, 4)
    client.send(type="evaluate", runId="d2", expression="i")
    assert int(until("evaluated")["text"]) >= 0
    client.send(type="debug", runId="d2", action="continue")
    until("debug.result")
    fin = until("run.finished")
    assert fin["exitCode"] == 0 and fin["stopped"] is False
    # evaluate against the finished run still works after a debug run
    client.send(type="evaluate", runId="d2", expression="x")
    assert until("evaluated")["text"] == "39"
