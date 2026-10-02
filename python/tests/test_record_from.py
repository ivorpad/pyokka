"""``config.recordFrom``: a debug run that records from a pause on (record_from.py).

The run starts with the debugger's hooks, so the code before the pause costs what a ``record:
false`` run costs; at the pause the recording hooks take over and the paused statement is step 0,
inside scopes built for the frames on the stack. Frames entered before the switch keep the
debugger's ids (at or above ``FOREIGN``) and are mapped onto recorded scopes, also the ones the
stack walk could not see: a generator resumed after the switch.
"""

from __future__ import annotations

import time

from pyokka_runtime.protocol import FLAG_SCOPE_ENTRY, RunConfig, decode_steps
from pyokka_runtime.tracer import FOREIGN
from tests.test_debug import CONTINUE, Scripted, attach, pauses, step, until
from tests.test_runner import client  # noqa: F401 - the fixture

NESTED = """
def inner(x):
    y = x + 1
    z = y * 2
    return z


def outer(n):
    label = "outer"
    got = inner(n)
    return got + len(label)


before = 10
result = outer(before)
after = result + 1
print(after)
"""

GEN = """
def gen():
    a = 1
    yield a
    b = a + 1
    yield b


g = gen()
first = next(g)
second = next(g)
print(first, second)
g.close()
"""

LOOP = """
total = 0
for i in range(1_000_000):
    total += i


def mark(t):
    return t


print(mark(total))
"""

TWO_STOPS = """
def early(v):
    w = v + 1
    return w


def late(v):
    q = v * 3
    return q


a = early(1)
b = late(a)
print(b)
"""


def config(**extra):
    return {"debug": True, "stopOnEntry": False, "recordLocals": True, **extra}


def steps_of(trace: dict) -> list[tuple[int, int, int, int]]:
    arr = decode_steps(trace["steps"])
    return [tuple(arr[i : i + 4]) for i in range(0, len(arr), 4)]


def test_config_reads_record_from():
    assert RunConfig.from_dict({"debug": True, "recordFrom": {"function": "inner"}}).record_from == {"function": "inner"}
    assert RunConfig.from_dict({"debug": True, "recordFrom": {"path": "/a.py", "line": "3"}}).record_from == {"path": "/a.py", "line": 3}
    assert RunConfig.from_dict({"debug": True, "recordFrom": "pause"}).records_later
    assert RunConfig.from_dict({"debug": True, "recordFrom": "soon"}).record_from is None
    assert not RunConfig.from_dict({"debug": True, "record": False, "recordFrom": "pause"}).records_later, "a run that records nothing has nothing to start"
    assert not RunConfig.from_dict({"recordFrom": "pause"}).records_later, "a run-all run records from the start"


def test_the_trace_starts_at_the_breakpoint_with_its_ancestors(run):
    seen: list = []
    out = run(NESTED, config=config(recordFrom={"function": "inner"}), on_tracer=attach(Scripted([CONTINUE]), breakpoints=[{"path": "", "line": 0, "function": "inner"}], seen=seen))
    assert out.result.exit_code == 0
    (p,) = pauses(out)
    assert p["reason"] == "breakpoint" and p["step"] == 0 and p.get("recordingStarted") is True
    assert [f["name"] for f in p["stack"]] == ["inner", "outer", "<module>"], "the stack is the recorded scope chain"
    trace = out.trace
    assert trace.get("midRun") is True
    steps = steps_of(trace)
    rid0, scope0, depth0, flags0 = steps[0]
    assert flags0 & FLAG_SCOPE_ENTRY and depth0 == 2, "step 0 is the entry of inner, two levels down"
    scopes = {s["scopeId"]: s for s in trace["scopes"]}
    assert scopes[scope0]["name"] == "inner" and scopes[scopes[scope0]["parent"]]["name"] == "outer" and scopes[scopes[scope0]["parent"]]["parent"] == 0
    lines = [out.file()["ranges"][r - out.file()["rangeBase"]][0] for r, *_ in steps]
    assert lines[1:] == [3, 4, 5, 11, 16, 17], "inner's body, then back in outer and the module: nothing from before the pause"
    assert all(s < FOREIGN for _r, s, _d, _f in steps), "every step names a recorded scope"
    assert {steps[i][1] for i in (1, 2, 3)} == {scope0} and steps[4][1] == scopes[scope0]["parent"] and steps[5][1] == 0
    # values: only after the switch
    logged_lines = {out.file()["ranges"][e["rid"] - out.file()["rangeBase"]][0] for e in out.logs}
    assert 15 not in logged_lines and 17 in logged_lines, "`before = 10` ran before the recording, `after` after it"
    # coverage: the debugger hooks counted hits before the switch, so it covers the whole run
    hit_lines = {out.file()["ranges"][rid][0] for rid, h in enumerate(out.coverage["hits"]) if h}
    assert {3, 15, 16, 17} <= hit_lines and out.state_at(15) == out.state_at(17)
    # locals: the first change of `y` is at inner's second statement; `before` existed already and is not reported as made after
    entries = out.of("locals")
    names = [(c["name"], e["step"]) for ev in entries for e in ev["entries"] for c in e["changes"]]
    assert ("x", 1) in names, "the parameter shows at the first body step, as in any recording"
    assert not any(n == "before" for n, _ in names), "a value from before the switch is not a change the recording saw"


def test_step_over_and_out_after_the_switch(run):
    out = run(NESTED, config=config(recordFrom={"function": "inner"}), on_tracer=attach(Scripted([step("over")], [step("over")], [step("out")], [CONTINUE]), breakpoints=[{"path": "", "line": 0, "function": "inner"}]))
    ps = pauses(out)
    assert [(p["reason"], p["line"]) for p in ps] == [("breakpoint", 2), ("step", 3), ("step", 4), ("step", 11)], "over walks inner's body, out lands back in outer"
    assert ps[-1]["stack"][0]["name"] == "outer"
    assert [p["step"] for p in ps] == [0, 1, 2, 4]


def test_a_generator_resumed_after_the_switch_gets_a_scope(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    out = run(GEN, config=config(recordFrom={"path": path, "line": 11}), on_tracer=attach(Scripted([CONTINUE]), breakpoints=[{"path": path, "line": 11}]))
    assert out.result.exit_code == 0 and [e["text"] for e in out.logs if e["kind"] == "log"][-1:] == ["1 2"]
    (p,) = pauses(out)
    assert p["line"] == 11 and p["step"] == 0
    trace = out.trace
    gens = [s for s in trace["scopes"] if s["name"] == "gen"]
    assert len(gens) == 1 and gens[0]["parent"] == 0, "the generator created before the switch is adopted when it resumes"
    steps = steps_of(trace)
    lines = [out.file()["ranges"][r - out.file()["rangeBase"]][0] for r, *_ in steps]
    assert lines == [11, 5, 6, 12, 13]
    assert steps[1][1] == gens[0]["scopeId"] and gens[0]["first"] == 1


def test_record_from_skips_other_pauses_and_record_then_answers_already(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    record = {"type": "debug", "id": "rec", "action": "record"}
    ctl = Scripted([CONTINUE], [record, CONTINUE])
    # a breakpoint in `early` pauses first; recordFrom points at `late`
    out = run(TWO_STOPS, config=config(recordFrom={"function": "late"}), on_tracer=attach(ctl, breakpoints=[{"path": path, "line": 3}, {"path": "", "line": 0, "function": "late"}]))
    first, second = pauses(out)
    assert first["line"] == 3 and "recordingStarted" not in first, "the first pause is not where recordFrom points: nothing recorded yet"
    assert second["line"] == 7 and second["recordingStarted"] is True and second["step"] == 0, "the entry of late is recordFrom"
    (ack,) = [e for e in out.events if e.get("id") == "rec"]
    assert ack["type"] == "debug.result" and ack["already"] is True and ack["step"] == 0
    lines = [out.file()["ranges"][r - out.file()["rangeBase"]][0] for r, *_ in steps_of(out.trace)]
    assert lines == [7, 8, 9, 14], "late's entry, its body, then the print: early ran unrecorded"


def test_record_action_starts_the_recording_where_the_run_is_paused(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    record = {"type": "debug", "id": "rec", "action": "record"}
    out = run(TWO_STOPS, config=config(recordFrom={"function": "never_defined"}), on_tracer=attach(Scripted([record, CONTINUE]), breakpoints=[{"path": path, "line": 3}]))
    ps = pauses(out)
    assert len(ps) == 2, "the pause is announced again once it is step 0"
    assert "recordingStarted" not in ps[0] and ps[1]["recordingStarted"] is True and ps[1]["step"] == 0 and ps[1]["line"] == 3
    assert [f["name"] for f in ps[1]["stack"]] == ["early", "<module>"]
    (ack,) = [e for e in out.events if e.get("id") == "rec"]
    assert ack["type"] == "debug.result" and ack["step"] == 0
    lines = [out.file()["ranges"][r - out.file()["rangeBase"]][0] for r, *_ in steps_of(out.trace)]
    assert lines == [3, 4, 13, 7, 8, 9, 14], "early's body from the pause on, then the module and late's call"


def test_record_action_refused_without_record_from(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    record = {"type": "debug", "id": "rec", "action": "record"}
    out = run(TWO_STOPS, config={"debug": True, "record": False, "stopOnEntry": False}, on_tracer=attach(Scripted([record, CONTINUE]), breakpoints=[{"path": path, "line": 3}]))
    (err,) = [e for e in out.events if e.get("id") == "rec"]
    assert err["type"] == "debug.error" and "without a recording" in err["message"]
    assert not out.of("trace")


def test_record_from_never_reached_records_nothing(run):
    out = run(TWO_STOPS, config=config(recordFrom={"function": "never_defined"}), on_tracer=attach(Scripted()))
    assert out.result.exit_code == 0 and not out.of("trace") and not out.of("coverage")
    assert [e["kind"] for e in out.logs] == [], "print goes to the program's output, as in a record: false run"


def test_the_loop_before_the_breakpoint_costs_what_a_debugger_run_costs(run):
    """1e6 iterations before the breakpoint: within ~1.2x of ``record: false`` (median of 3 each)."""

    def timed(cfg: dict) -> float:
        started = time.perf_counter()
        out = run(LOOP, config=cfg, on_tracer=attach(Scripted([CONTINUE]), breakpoints=[{"path": "", "line": 0, "function": "mark"}]))
        assert out.result.exit_code == 0
        return time.perf_counter() - started

    off = sorted(timed({"debug": True, "record": False, "stopOnEntry": False}) for _ in range(3))[1]
    later = sorted(timed(config(recordFrom={"function": "mark"})) for _ in range(3))[1]
    assert later < off * 1.35, "record-from %.3fs vs record: false %.3fs" % (later, off)


AWAIT = """
import asyncio


async def one():
    await asyncio.sleep(0)
    return 1


async def two():
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    return 2


async def main():
    results = await asyncio.gather(one(), two())
    return sum(results)


print(asyncio.run(main()))
"""


THREAD = """
import threading

started = threading.Event()
go = threading.Event()


def work():
    started.set()
    go.wait()
    done = 1
    return done


t = threading.Thread(target=work)
t.start()
started.wait()
mark = 2
go.set()
t.join()
print(mark)
"""


def test_a_thread_running_at_the_switch_gets_a_scope(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    out = run(THREAD, config=config(recordFrom={"path": path, "line": 18}), on_tracer=attach(Scripted([CONTINUE]), breakpoints=[{"path": path, "line": 18}]))
    assert out.result.exit_code == 0
    (p,) = pauses(out)
    assert p["line"] == 18 and p["step"] == 0
    works = [s for s in out.trace["scopes"] if s["name"] == "work"]
    assert len(works) == 1 and works[0]["parent"] == 0, "the thread's frame, entered before the switch, is adopted with the module as parent"
    lines = [out.file()["ranges"][r - out.file()["rangeBase"]][0] for r, *_ in steps_of(out.trace)]
    assert 11 in lines and 12 in lines and all(s < FOREIGN for _r, s, _d, _f in steps_of(out.trace))


def test_record_from_over_the_runner(client, tmp_path):
    """The child reads `recordFrom`, pauses unrecorded at an earlier breakpoint, and `record` starts it there."""
    client.send(type="hello", version="test")
    assert "recordFrom" in client.recv()["capabilities"]
    scratch = tmp_path / "two.py"
    scratch.write_text(TWO_STOPS, encoding="utf-8")
    base = {"file": {"path": str(scratch), "displayName": scratch.name}, "workspaceRoot": str(tmp_path), "cwd": str(tmp_path), "argv": [], "env": {}, "projectFiles": [], "markers": [], "expressionsToEvaluate": {}, "watch": [], "mode": "normal"}
    client.send(type="run", runId="r1", config={"timeoutMs": 20000, **config(recordFrom={"function": "late"})}, breakpoints=[{"path": str(scratch), "line": 3}], **base)
    p = until(client, "debug.paused")
    assert p["line"] == 3 and "recordingStarted" not in p and "frameId" in p["stack"][0], "a pause before the recording: the frame-chain stack"
    rid = client.send(type="debug", runId="r1", action="record")
    trace = until(client, "trace")
    assert trace["partial"] is True and trace["midRun"] is True
    again = until(client, "debug.paused")
    assert again["step"] == 0 and again["recordingStarted"] is True and again["line"] == 3
    ack = until(client, "debug.result")
    assert ack["id"] == rid and ack["recording"] is True
    client.send(type="debug", runId="r1", action="continue")
    final = until(client, "run.finished")
    assert final["exitCode"] == 0 and final["stepCount"] == 7


def test_a_module_level_pause_records_in_scope_zero(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    out = run(NESTED, config=config(recordFrom={"path": path, "line": 16}), on_tracer=attach(Scripted([CONTINUE]), breakpoints=[{"path": path, "line": 16}]))
    (p,) = pauses(out)
    assert p["step"] == 0 and p["scopeId"] == 0 and [f["name"] for f in p["stack"]] == ["<module>"]
    assert [s["scopeId"] for s in out.trace["scopes"]] == [0], "nothing on the stack but the module"


def test_coroutines_suspended_at_the_switch_are_adopted(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    # `return 1` in one(): two() is suspended in its first await, entered before the recording began
    out = run(AWAIT, config=config(recordFrom={"path": path, "line": 7}), on_tracer=attach(Scripted([CONTINUE]), breakpoints=[{"path": path, "line": 7}]))
    # the print was looked up before the switch (its argument is the paused call), so it is plain output
    assert out.result.exit_code == 0 and [e["text"] for e in out.of("output")] == ["3\n"]
    (p,) = pauses(out)
    assert [f["name"] for f in p["stack"]][0] == "one"
    names = [s["name"] for s in out.trace["scopes"]]
    assert "two" in names and "main" in names
    assert all(s < FOREIGN for _r, s, _d, _f in steps_of(out.trace))
    assert all(s["parent"] < len(out.trace["scopes"]) for s in out.trace["scopes"])
