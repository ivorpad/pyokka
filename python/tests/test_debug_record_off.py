"""``config.record: false``: a debugger that records nothing.

What the run emits (and what it must not), the statement counter, the frame-chain stack with real
caller lines, the thread, the step rules built on frame exits instead of a scope table, library
module bodies, and that a bug in the debugger becomes a ``runner.error`` instead of breaking the
program. The last case pins that ``record`` absent still produces exactly today's events.
"""

from __future__ import annotations

import threading
from collections import Counter

from tests.test_debug import CALLS, CONTINUE, RAISES, Scripted, attach, pauses, results, step

RECORDED = ("trace", "coverage", "log", "locals", "time", "watch", "http.exchange")
# `run.started` comes from the runner, which the in-process helper does not use.
ALLOWED = {"run.started", "file.instrumented", "output", "debug.paused", "debug.resumed", "debug.result", "run.finished"}

PRINTS = """
name = "box"
print("start")
for i in range(3):
    print("i", i)
print("end", name)
"""

# `keep` is called from two textwrap frames, so the pause has uninstrumented callers in the middle.
CALLBACK = """
import textwrap


def keep(line):
    return line.strip() != ""


def wrap(text):
    return textwrap.indent(text, "> ", keep)


print(wrap("a\\nb\\n"))
"""

FRAMES = """
def inner(x):
    y = x + 1
    return y


def outer(n):
    label = "outer"
    return inner(n) + len(label)


print(outer(2))
"""

RECURSION = """
def down(n):
    if n == 0:
        return 0
    inner = down(n - 1)
    return inner + n


print(down(4))
"""

AWAIT = """
import asyncio


async def one():
    await asyncio.sleep(0)
    return 1


async def two():
    await asyncio.sleep(0)
    return 2


async def main():
    results = await asyncio.gather(one(), two())
    total = sum(results)
    return total


print(asyncio.run(main()))
"""

# The generator is never exhausted, so its `finally` (and its `_pk_x`) never runs while a step is
# armed on it. The `close()` at the end only keeps the object from outliving the installed hooks.
SUSPENDED = """
def gen():
    yield 1
    yield 2


g = gen()
first = next(g)
after = first + 1
print(after)
g.close()
"""

LIB_FILES = {
    "venv/site-packages/libz/__init__.py": """
    CONST = 1


    def helper(x):
        y = x + CONST
        return y


    built = helper(1)
    """
}
LIB_MAIN = """
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "venv", "site-packages"))
import libz

r = libz.helper(10)
print(r)
"""

# The program of scripts/bench-debug.py. `never_runs` is never called, so a breakpoint on its body
# arms the hook for all 1,000,003 statements and can never hit.
BENCH = """
total = 0
for i in range(500_000):
    total += i
print(total)


def never_runs():
    return 0
"""
BENCH_NEVER_LINE = BENCH.splitlines().index("    return 0") + 1


def debug_run(run, source, *, batches=(), breakpoints=None, config=None, **kw):
    """A ``record: false`` debug run of ``source``, with a scripted control channel."""
    cfg = {"debug": True, "record": False, "stopOnEntry": False, **(config or {})}
    return run(source, config=cfg, on_tracer=attach(Scripted(*batches), breakpoints=breakpoints), **kw)


def test_record_is_only_read_with_debug_and_forces_the_recording_options_off():
    from pyokka_runtime.execute import RunSpec
    from pyokka_runtime.protocol import HTTP_PLUGIN, RunConfig

    debugger = RunConfig.from_dict({"debug": True, "record": False, "http": "record", "httpObserve": True})
    assert debugger.records is False
    assert (debugger.http, debugger.http_observe, debugger.plugins) == ("off", False, []), "the HTTP plugin keeps a row per request"
    run_all = RunConfig.from_dict({"record": False})
    assert run_all.records is True and run_all.plugins == [HTTP_PLUGIN], "record is read only with debug"
    recording = RunConfig.from_dict({"debug": True})
    assert recording.records is True and recording.plugins == [HTTP_PLUGIN]
    spec = RunSpec.from_request({"file": {"path": "/tmp/x.py"}, "mode": "profile", "config": {"debug": True, "record": False}})
    assert spec.mode == "normal", "profile and snaps are recordings of a different shape"


def test_record_off_emits_only_debug_and_output_events(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    out = debug_run(run, PRINTS, batches=[[CONTINUE], [CONTINUE], [CONTINUE]], breakpoints=[{"path": path, "line": 5}])
    kinds = {e["type"] for e in out.events}
    assert kinds <= ALLOWED, "unexpected event types: %s" % sorted(kinds - ALLOWED)
    for kind in RECORDED:
        assert out.of(kind) == [], "%s is a recording and must not be emitted" % kind
    assert len(pauses(out)) == 3 and out.result.exit_code == 0


def test_record_off_emits_the_uncaught_error_with_its_traceback(run):
    out = debug_run(run, RAISES, config={"breakOnException": "off"})
    (err,) = out.errors
    assert err["handled"] is False and err["errorType"] == "ValueError" and err["message"] == "too big: 3"
    assert "ValueError: too big: 3" in err["traceback"] and err["step"] == out.finished["stepCount"]
    assert err["step"] > 0 and err["stack"][0]["function"] == "check"
    assert [e for e in out.errors if e["handled"]] == [], "caught-exception groups are a recording"
    assert out.of("coverage") == [] and out.result.exit_code == 1


def test_record_off_exception_pauses_keep_no_records(run, tmp_path):
    seen: list = []
    raised = run(RAISES, config={"debug": True, "record": False, "stopOnEntry": False, "breakOnException": "raised"}, on_tracer=attach(Scripted(), seen=seen))
    ps = pauses(raised)
    assert [(p["line"], p["exception"]["uncaught"]) for p in ps] == [(10, False), (4, False), (4, True)], "the same sightings a recording run pauses at"
    assert [s["name"] for s in ps[0]["stack"]] == ["parse", "<module>"] and ps[0]["stack"][0]["fileId"] == 1
    tracer = seen[0].tracer
    assert tracer.records == {} and tracer.groups == {}, "nothing is kept per exception"
    assert len(tracer.seen) == 2, "one entry per exception object, so a first sighting stays a first sighting"
    assert raised.result.exit_code == 1 and len(raised.errors) == 1
    # `off` installs no exception monitoring at all; the `exceptions` action switches it on mid-run
    quiet = debug_run(run, RAISES, config={"breakOnException": "off"})
    assert pauses(quiet) == [] and quiet.result.exit_code == 1
    path = str(tmp_path / "scratch.py")
    switch = Scripted([{"type": "debug", "id": "x", "action": "exceptions", "mode": "uncaught"}, CONTINUE])
    later = run(RAISES, config={"debug": True, "record": False, "stopOnEntry": False, "breakOnException": "off"}, on_tracer=attach(switch, breakpoints=[{"path": path, "line": 15}]))
    assert [(p["reason"], p["line"]) for p in pauses(later)] == [("breakpoint", 15), ("exception", 4)], "off until the switch, then the top pause"
    assert results(later, "debug.result")[0] == {"type": "debug.result", "id": "x", "ok": True, "mode": "uncaught"}


def test_record_off_prints_reach_output_not_log(run):
    out = debug_run(run, PRINTS)
    assert out.logs == [], "a print is a real print in debugger mode, never a log"
    text = "".join(e["text"] for e in out.of("output") if e["stream"] == "stdout")
    assert text == "start\ni 0\ni 1\ni 2\nend box\n"
    assert [e["step"] for e in out.of("output")] == sorted(e["step"] for e in out.of("output"))


def test_record_off_pause_carries_the_frame_chain_with_caller_lines(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    out = debug_run(run, CALLBACK, breakpoints=[{"path": path, "line": 6}])
    p = pauses(out)[0]
    stack = p["stack"]
    assert [s["frameId"] for s in stack] == list(range(len(stack)))
    assert (stack[0]["name"], stack[0]["line"], stack[0]["fileId"]) == ("keep", 6, 1)
    # `<module>` is the bottom of the chain and points at the call, not at a `def` line
    assert (stack[-1]["name"], stack[-1]["line"], stack[-1]["fileId"]) == ("<module>", 13, 1)
    assert stack[-1]["rid"] == out.rid_at(13) and "scopeId" in stack[-1]
    middle = [s for s in stack[1:-1] if s["fileId"] == 0]
    assert middle and all("rid" not in s and "scopeId" not in s for s in middle), "textwrap's frames are not instrumented"
    names = [s["name"] for s in stack[1:-1]]
    # `textwrap.indent` builds its lines in a generator up to 3.12 and inlines the loop from 3.13,
    # so the one frame between `keep` and `indent` is there or not depending on the interpreter
    assert names[-2:] == ["indent", "wrap"] and set(names) <= {"prefixed_lines", "indent", "wrap"}
    assert p["depth"] == len(stack) - 1


def test_record_off_frame_id_addresses_a_caller_frame(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    asks = [
        {"type": "debug", "id": "l0", "action": "locals"},
        {"type": "debug", "id": "l1", "action": "locals", "frameId": 1},
        {"type": "debug", "id": "l9", "action": "locals", "frameId": 9},
        {"type": "evaluate", "id": "e1", "expression": "label", "frameId": 1},
        {"type": "evaluate", "id": "e0", "expression": "label"},
        {"type": "evaluate", "id": "e9", "expression": "label", "frameId": 9},
        CONTINUE,
    ]
    out = debug_run(run, FRAMES, batches=[asks], breakpoints=[{"path": path, "line": 4}])
    (p,) = pauses(out)
    assert [s["name"] for s in p["stack"]] == ["inner", "outer", "<module>"]
    replies = {e["id"]: e for e in results(out, "debug.result") + results(out, "debug.error") + results(out, "evaluate.result") + results(out, "evaluate.error")}
    assert [(v["name"], v["text"]) for v in replies["l0"]["locals"]] == [("x", "2"), ("y", "3")]
    assert [(v["name"], v["text"]) for v in replies["l1"]["locals"]] == [("n", "2"), ("label", "'outer'")]
    assert replies["l9"]["message"] == "LookupError: no frame 9 in this pause"
    assert replies["e1"]["text"] == "'outer'", "frameId 1 evaluates in the caller"
    assert "label" in replies["e0"]["message"], "the paused frame has no `label`"
    assert replies["e9"]["message"] == "LookupError: no frame 9 in this pause"
    assert out.result.exit_code == 0 and [e["text"] for e in out.of("output")] == ["8\n"]


def test_record_off_pause_carries_the_thread(run):
    out = debug_run(run, CALLS, config={"stopOnEntry": True})
    (p,) = pauses(out)
    assert p["thread"] == {"name": "MainThread", "ident": threading.get_ident()}


def test_record_off_step_over_and_out_follow_the_frames(run):
    batches = [[step("into")], [step("into")], [{"type": "debug", "id": "l1", "action": "locals"}, step("into")], [{"type": "debug", "id": "l2", "action": "locals"}, step("out")], [step("over")], [CONTINUE]]
    out = debug_run(run, CALLS, batches=batches, config={"stopOnEntry": True})
    # the same sequence test_debug.py::test_step_into_over_and_out_follow_the_time_machine_moves asserts
    assert [(p["line"], p["scopeId"], p["depth"], p["reason"], p.get("kind")) for p in pauses(out)] == [
        (7, 0, 0, "start", None),
        (2, 1, 1, "step", "into"),
        (3, 1, 1, "step", "into"),
        (4, 1, 1, "step", "into"),
        (8, 0, 0, "step", "out"),
        (9, 0, 0, "step", "over"),
    ]
    l1, l2 = results(out, "debug.result")[2], results(out, "debug.result")[4]
    assert [(v["name"], v["text"]) for v in l1["locals"]] == [("x", "1")]
    assert [(v["name"], v["text"]) for v in l2["locals"]] == [("x", "1"), ("y", "2")]
    assert [e["action"] + ("/" + e["kind"] if "kind" in e else "") for e in results(out, "debug.resumed")] == ["step/into", "step/into", "step/into", "step/out", "step/over", "continue"]
    assert out.result.exit_code == 0


def test_record_off_step_over_is_exact_in_recursion(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    asks = [{"type": "evaluate", "id": "e1", "expression": "n"}, step("over")]
    then = [{"type": "evaluate", "id": "e2", "expression": "(n, inner)"}, CONTINUE]
    out = debug_run(run, RECURSION, batches=[asks, then], breakpoints=[{"path": path, "line": 5, "condition": "n == 3"}])
    ps = pauses(out)
    assert [(p["line"], p["reason"]) for p in ps] == [(5, "breakpoint"), (6, "step")]
    assert ps[0]["scopeId"] == ps[1]["scopeId"], "the step stayed in the frame it was armed in"
    assert [e["text"] for e in results(out, "evaluate.result")] == ["3", "(3, 3)"], "down(2) ran through"
    assert out.result.exit_code == 0


def test_record_off_step_over_an_await_lands_after_it(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    out = debug_run(run, AWAIT, batches=[[step("over")], [{"type": "evaluate", "id": "e", "expression": "results"}, CONTINUE]], breakpoints=[{"path": path, "line": 16}])
    ps = pauses(out)
    assert [(p["line"], p["reason"]) for p in ps] == [(16, "breakpoint"), (17, "step")], "no stop inside the gathered coroutines"
    assert ps[0]["scopeId"] == ps[1]["scopeId"]
    assert results(out, "evaluate.result")[0]["text"] == "[1, 2]", "both coroutines ran before the step landed"
    assert out.result.exit_code == 0
    # a frame that never resumes: the step stays armed and the run reaches the next breakpoint
    frozen = debug_run(run, SUSPENDED, batches=[[step("over")], [CONTINUE]], breakpoints=[{"path": path, "line": 3}, {"path": path, "line": 10}])
    ps = pauses(frozen)
    assert [(p["line"], p["reason"]) for p in ps] == [(3, "breakpoint"), (10, "breakpoint")], "a step over a yield nobody resumes never fires"
    assert [e["text"] for e in frozen.of("output")] == ["2\n"]


def test_record_off_breakpoint_inside_a_library_module_body_never_pauses(run, tmp_path):
    body = str(tmp_path / "venv" / "site-packages" / "libz" / "__init__.py")
    quiet = debug_run(run, LIB_MAIN, files=LIB_FILES, config={"libraryCode": True}, breakpoints=[{"path": body, "line": 10}])
    assert pauses(quiet) == [], "a library module's import-time body is not steppable"
    assert quiet.result.exit_code == 0 and [e["text"] for e in quiet.of("output")] == ["11\n"]
    inside = debug_run(run, LIB_MAIN, files=LIB_FILES, config={"libraryCode": True}, breakpoints=[{"path": body, "line": 6}])
    ps = pauses(inside)
    assert [(p["line"], p["fileId"], p["reason"]) for p in ps] == [(6, 2, "breakpoint")], "the library function pauses once, called from stepped code"
    assert inside.result.exit_code == 0


def test_record_off_benchmark_loop_event_count(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    out = debug_run(run, BENCH, breakpoints=[{"path": path, "line": BENCH_NEVER_LINE}])
    assert pauses(out) == [] and out.result.exit_code == 0
    assert out.result.step_count == 1_000_003 and out.finished["stepCount"] == 1_000_003
    assert len(out.events) <= 12, [e["type"] for e in out.events]
    assert [e["text"] for e in out.of("output")] == ["124999750000\n"]


def test_record_off_hook_error_becomes_a_runner_error(run):
    from pyokka_runtime.debugger import Debugger

    class Broken(Debugger):
        def on_step(self, n, rid, scope, bp=None):
            raise RuntimeError("no")

    def on_tracer(tracer):
        tracer.dbg = Broken(tracer, Scripted(), {})

    out = run(PRINTS, config={"debug": True, "record": False}, on_tracer=on_tracer)
    errors = out.of("runner.error")
    assert [e["message"] for e in errors] == ["debugger hook failed in step: RuntimeError: no"], "deduplicated by message"
    assert out.result.exit_code == 0 and pauses(out) == []
    assert "".join(e["text"] for e in out.of("output")) == "start\ni 0\ni 1\ni 2\nend box\n"


def test_record_on_is_unchanged(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    bps = [{"path": path, "line": 5}]
    absent = run(PRINTS, config={"debug": True, "stopOnEntry": False}, on_tracer=attach(Scripted(), breakpoints=bps))
    explicit = run(PRINTS, config={"debug": True, "stopOnEntry": False, "record": True}, on_tracer=attach(Scripted(), breakpoints=bps))
    assert Counter(e["type"] for e in absent.events) == Counter(e["type"] for e in explicit.events)
    assert [e["text"] for e in absent.logs] == [e["text"] for e in explicit.logs]
    for kind in ("trace", "coverage", "log"):
        assert absent.of(kind), "a recording debug run still records %s" % kind
    assert absent.result.step_count == explicit.result.step_count
