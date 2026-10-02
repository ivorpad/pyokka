"""Tracer behaviour: logs, coverage states, trace quads, scopes, watches, locals, prints."""

from __future__ import annotations

import os

from pyokka_runtime.protocol import COV_COVERED, COV_IGNORED, COV_NOT_RUN, COV_PARTIAL, FLAG_LOG, FLAG_SCOPE_ENTRY, decode_steps
from pyokka_runtime.trace import Trace


def test_value_logs_for_assignment_return_for_and_identifier(run):
    out = run(
        """
        def f(v):
            return v * 2  # ?
        total = f(2)  # ?
        total
        for i in range(2):  # ?
            pass
        name = "abc"  # ? $.upper()
        """
    )
    assert [e["text"] for e in out.logs_at(3)] == ["4"]
    assert out.logs_at(3)[0]["context"] == "v * 2"
    assert [e["text"] for e in out.logs_at(4)] == ["4"]
    assert out.logs_at(4)[0]["context"] == "total"
    ident = out.logs_at(5)[0]
    assert ident["kind"] == "value" and ident["context"] == "total" and ident["valueBag"]["data"]["value"] == "4"
    assert [e["text"] for e in out.logs_at(6)] == ["0", "1"]
    assert [e["hit"] for e in out.logs_at(6)] == [1, 2]
    dollar = out.logs_at(8)[0]
    assert dollar["text"] == "'ABC'"
    assert all(e["runtimeKey"] == str(e["rid"]) for e in out.logs)


def test_print_attribution_and_file_passthrough(run, tmp_path):
    out = run(
        """
        import sys, io
        print("hello", 42)
        print({"a": 1})
        print("err", file=sys.stderr)
        buf = io.StringIO()
        print("captured", file=buf)
        buf.getvalue()  # ?
        p = print
        p("aliased")
        sys.stdout.write("raw\\n")
        """
    )
    l3, l4, l5 = out.logs_at(3)[0], out.logs_at(4)[0], out.logs_at(5)[0]
    assert l3["kind"] == "log" and l3["text"] == "hello 42" and l3["valueBag"]["data"]["type"] == "tuple"
    assert l4["valueBag"]["data"]["type"] == "dict" and l4["text"] == "{'a': 1}"
    assert l5["context"] == "stderr"
    assert out.logs_at(7) == []  # file=StringIO passes through untouched
    assert out.logs_at(8)[0]["text"] == "'captured\\n'"
    aliased = [e for e in out.logs if e["text"] == "aliased"]
    assert aliased and aliased[0]["rid"] == out.rid_at(10)  # builtins.print fallback attributes to the current step
    raw = [e for e in out.of("output") if e["text"] == "raw\n"]
    assert raw and raw[0]["stream"] == "stdout" and "step" in raw[0]


def test_coverage_states_including_partial_and_ignored(run):
    out = run(
        """
        a = True and False
        b = False and True
        c = 1 if a else 2
        d = [i for i in range(0) if i]
        if b:
            never = 1
        e = 2  # pragma: no cover
        """
    )
    assert out.state_at(2) == COV_COVERED
    assert out.state_at(3) == COV_PARTIAL
    assert out.state_at(4) == COV_PARTIAL  # `1 if a` branch never taken
    assert out.state_at(5) == COV_PARTIAL  # elt/ifs never evaluated
    assert out.state_at(6) == COV_COVERED
    assert out.state_at(7) == COV_NOT_RUN
    f = out.file()
    ignored = [rid for rid in range(len(f["ranges"])) if f["ranges"][rid][0] == 8]
    assert all(out.coverage["states"][r] == COV_IGNORED for r in ignored)
    assert out.coverage["hits"][out.rid_at(2)] == 1


def test_trace_quads_scopes_for_nested_calls_and_recursion(run):
    out = run(
        """
        def fact(n):
            if n <= 1:
                return 1
            return n * fact(n - 1)
        def outer():
            return fact(3)
        r = outer()
        done = 1
        """
    )
    steps = out.steps
    scopes = out.trace["scopes"]
    # def statements are coverage-only, so the first step is the first call site (`r = outer()`)
    assert steps[0] == (out.rid_at(8), 0, 0, 0)
    assert out.coverage["hits"][out.rid_at(2)] == 1
    assert [s["name"] for s in scopes] == ["<module>", "outer", "fact", "fact", "fact"]
    assert [s["depth"] for s in scopes] == [0, 1, 2, 3, 4]
    assert [s["parent"] for s in scopes] == [-1, 0, 1, 2, 3]
    entries = [s for s in steps if s[3] & FLAG_SCOPE_ENTRY]
    assert len(entries) == 4
    assert entries[0][0] == out.rid_at(6)  # `def outer` header rid is the entry step
    # every step's depth equals its scope's depth; scopes' first/last bound their steps
    depth_of = {s["scopeId"]: s["depth"] for s in scopes}
    for i, (rid, sid, depth, flags) in enumerate(steps):
        assert depth == depth_of[sid]
        assert scopes[sid]["first"] <= i <= scopes[sid]["last"]
    # after returning from all calls, the module continues at depth 0
    assert steps[-1][1] == 0 and steps[-1][2] == 0
    assert out.finished["stepCount"] == len(steps)


def test_class_body_statements_are_coverage_only(run):
    out = run(
        """
        from dataclasses import dataclass
        first = 1
        @dataclass
        class Account:
            owner: str
            balance: float = 0.0
            def deposit(self, amount):
                self.balance += amount
                return self.balance
        acct = Account("x")
        acct.deposit(2)
        """
    )
    steps = out.steps
    f = out.file(1)
    lines = [f["ranges"][rid - f["rangeBase"]][0] for rid, *_ in steps]
    # (the fixture source starts with a blank line, so `import` is line 2)
    # fields of the class body (lines 6-7) execute at definition time but produce no steps,
    # so the module goes from `first = 1` straight to `acct = Account("x")`
    assert lines[:3] == [2, 3, 11]
    assert 6 not in lines and 7 not in lines
    # ...while the method body is stepped when called
    assert 9 in lines and 10 in lines
    # the fields still count as covered
    assert out.coverage["states"][out.rid_at(6)] == COV_COVERED
    assert out.coverage["states"][out.rid_at(7)] == COV_COVERED


LIB_FILES = {"venv/site-packages/libdemo/__init__.py": "try:\n    import _nothere_  # optional dependency\nexcept ImportError:\n    pass\n# ? a stray magic-looking comment in a library\n\n\ndef twice(x):\n    doubled = x * 2\n    return doubled\n"}
LIB_SOURCE = """
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'venv', 'site-packages'))
import libdemo
r = libdemo.twice(21)
"""


def test_library_code_is_opaque_by_default(run):
    out = run(LIB_SOURCE, files=LIB_FILES)
    assert [s["name"] for s in out.trace["scopes"]] == ["<module>"]
    assert len(out.of("file.instrumented")) == 1
    assert out.logs == [] or all(e["fileId"] == 1 for e in out.logs)


def test_library_code_is_stepped_when_enabled(run):
    out = run(LIB_SOURCE, files=LIB_FILES, config={"libraryCode": True})
    files = out.of("file.instrumented")
    assert len(files) == 2 and files[1]["path"].endswith(os.path.join("libdemo", "__init__.py"))
    # the library module body is coverage-only (no scope of its own); the called function is stepped
    assert [s["name"] for s in out.trace["scopes"]] == ["<module>", "twice"]
    assert "instrumentedSource" in files[0] and "instrumentedSource" not in files[1]
    # `os` and `sys` are stdlib: never instrumented even with the option on
    assert all("site-packages" in f["path"] or f["fileId"] == 1 for f in files)
    # a library's caught exceptions and its `# ?`-looking comments are not reported
    assert files[1]["magic"] == []
    assert not [e for e in out.errors if e["handled"]]
    assert not [e for e in out.logs if e["kind"] == "system"]


def test_library_packages_narrow_the_option(run):
    out = run(LIB_SOURCE, files=LIB_FILES, config={"libraryCode": True, "libraryPackages": ["other*"]})
    assert [s["name"] for s in out.trace["scopes"]] == ["<module>"]
    out = run(LIB_SOURCE, files=LIB_FILES, config={"libraryCode": True, "libraryPackages": ["libdemo"]})
    assert [s["name"] for s in out.trace["scopes"]] == ["<module>", "twice"]


def test_generators_and_async_keep_scope_ids(run):
    out = run(
        """
        import asyncio
        def gen():
            for i in range(2):
                yield i
        acc = []
        for v in gen():
            acc.append(v)
        async def work(x):
            await asyncio.sleep(0)
            return x + 1
        async def main():
            return await asyncio.gather(work(1), work(2))
        res = asyncio.run(main())
        res
        """
    )
    scopes = out.trace["scopes"]
    names = [s["name"] for s in scopes]
    assert names.count("gen") == 1 and names.count("work") == 2 and names.count("main") == 1
    gen_scope = next(s["scopeId"] for s in scopes if s["name"] == "gen")
    gen_steps = [i for i, s in enumerate(out.steps) if s[1] == gen_scope]
    module_steps_between = [i for i, s in enumerate(out.steps) if s[1] == 0 and gen_steps[0] < i < gen_steps[-1]]
    assert module_steps_between, "consumer steps interleave with generator steps"
    assert all(out.steps[i][2] == 1 for i in gen_steps)
    assert out.logs_at(15)[0]["text"] == "[2, 3]"


def test_gathered_coroutines_have_module_parents(run):
    out = run(
        """
        import asyncio
        async def fetch(name):
            await asyncio.sleep(0)
            return name
        async def turn(i):
            a = await fetch("a%d" % i)
            b = await fetch("b%d" % i)
            return a + b
        async def main():
            one = await turn(1)
            both = await asyncio.gather(turn(2), turn(3))
            print(one, both)
        asyncio.run(main())
        """
    )
    scopes = out.trace["scopes"]
    by_name = {}
    for s in scopes:
        by_name.setdefault(s["name"], []).append(s)
    main = by_name["main"][0]
    turns = by_name["turn"]
    assert len(turns) == 3 and len(by_name["fetch"]) == 6
    # main is a task run by the event loop: parent module. turn(1) is awaited directly by main;
    # turn(2) and turn(3) are tasks gathered by the loop, so their parent is the module too.
    assert (main["parent"], main["depth"]) == (0, 1)
    assert [(t["parent"], t["depth"]) for t in turns] == [(main["scopeId"], 2), (0, 1), (0, 1)]
    # every fetch is awaited by its turn, whichever task was running last
    for f in by_name["fetch"]:
        parent = scopes[f["parent"]]
        assert parent["name"] == "turn" and f["depth"] == parent["depth"] + 1
    assert max(s["depth"] for s in scopes) == 3
    # the gathered tasks interleave: turn(3) starts before turn(2) is done
    assert turns[2]["first"] < turns[1]["last"]
    t3 = turns[2]["scopeId"]
    # step over on `both = await asyncio.gather(...)` lands on `print(one, both)`
    f = out.file()
    trace = Trace(decode_steps(out.trace["steps"]), scopes, lambda rid: (1, f["ranges"][rid - f["rangeBase"]]))
    gather_step = next(i for i, s in enumerate(out.steps) if s[0] == out.rid_at(12))
    landed = trace.step_over(gather_step)
    assert out.steps[landed][0] == out.rid_at(13)
    assert [fr.function for fr in trace.call_stack(landed)] == ["main", "<module>"]
    # inside turn(3) the stack is turn <- module: nothing of turn(2) in it
    inside_t3 = next(i for i, s in enumerate(out.steps) if s[1] == t3 and not s[3] & FLAG_SCOPE_ENTRY)
    assert [fr.function for fr in trace.call_stack(inside_t3)] == ["turn", "<module>"]
    assert trace.step_out(inside_t3) < 0 or out.steps[trace.step_out(inside_t3)][1] == 0


def test_log_flags_and_limits(run):
    out = run(
        """
        for i in range(5):
            i  # ?
        """,
        config={"logLimit": 3, "maxConsoleMessages": 100},
    )
    values = out.logs_at(3, "value")
    assert [e["text"] for e in values] == ["0", "1", "2"]
    system = [e for e in out.logs if e["kind"] == "system"]
    assert system and "log limit" in system[0]["text"]
    flagged = [s for s in out.steps if s[3] & FLAG_LOG]
    assert len(flagged) >= 3


def test_time_magic_and_time_events(run):
    out = run(
        """
        def slow():
            return sum(range(1000))
        for _ in range(3):
            slow()  # ?.
        x = slow()  # ?.+
        """
    )
    times = out.logs_at(5, "time")
    assert len(times) == 3 and times[-1]["time"]["n"] == 3 and times[0]["text"].endswith("ms")
    assert times[0]["runtimeKey"].startswith("t:")
    events = {e["rid"]: e for e in out.of("time")}
    assert events[out.rid_at(4 + 1)]["n"] == 3
    l6 = out.logs_at(6)
    assert {e["kind"] for e in l6} == {"time", "value"}
    assert [e for e in l6 if e["kind"] == "value"][0]["text"] == "499500"


def test_watch_evaluation_at_step_with_prefetch(run):
    src = """
    x = 1
    def f(a):
        b = a * 2
        return b
    y = f(x)
    z = y + 1
    """
    first = run(src)
    step_b = next(i for i, s in enumerate(first.steps) if s[0] == first.rid_at(4))
    out = run(src, watch=[{"id": "w1", "exp": "a + b"}, {"id": "w2", "exp": "missing_name"}], trace_context={"step": step_b, "prefetch": 2})
    watches = out.of("watch")
    assert {w["step"] for w in watches} == {step_b, step_b + 1}
    w1 = [w for w in watches if w["watchId"] == "w1"]
    assert w1[0].get("error", "").startswith("UnboundLocalError") or w1[0].get("error", "").startswith("NameError")  # b not yet assigned at its own step
    assert w1[1]["valueBag"]["data"]["value"] == "3"
    assert all("NameError" in w["error"] for w in watches if w["watchId"] == "w2")


def test_record_locals(run):
    out = run(
        """
        def f():
            a = 1
            a += 1
            b = [1]
            b.append(2)
            return a
        f()
        """,
        config={"recordLocals": True},
    )
    entries = [e for ev in out.of("locals") for e in ev["entries"]]
    changes = [(c["name"], c["text"]) for e in entries for c in e["changes"]]
    assert ("a", "1") in changes and ("a", "2") in changes
    assert ("b", "[1]") in changes and ("b", "[1, 2]") in changes


def test_auto_log_and_inline_config(run):
    out = run(
        """
        {"autoLog": True}
        x = 1
        x + 1
        """
    )
    assert out.file()["ranges"]  # inline dict removed, nothing logged for it
    kinds = [e["kind"] for e in out.logs]
    assert kinds == []  # inline config is returned, not applied by the runtime (host merges it)
    out2 = run("x = 1\nx + 1\n", config={"autoLog": True})
    assert [e["kind"] for e in out2.logs] == ["autoLog", "autoLog"]


def test_logpoint_markers_at_runtime(run):
    src = """
    def f(a, b=2):
        return a + b
    x = f(1)
    y = x + 1
    """
    markers = [
        {"id": "lp1", "kind": "logpoint", "range": [2, 0, 2, 0]},
        {"id": "lp2", "kind": "logpoint", "range": [5, 0, 5, 0], "logMessage": "x is {x}"},
        {"id": "lp3", "kind": "logpoint", "range": [5, 0, 5, 0], "logMessage": "{x}"},
        {"id": "lp4", "kind": "logpoint", "range": [5, 0, 5, 0]},
        {"id": "m5", "kind": "value", "range": [5, 4, 5, 9], "exp": "x * 100", "changeId": "c5"},
    ]
    out = run(src, markers=markers)
    params = [e for e in out.logs if e["markerId"] == "lp1"]
    assert [(e["context"], e["text"]) for e in params] == [("a", "1"), ("b", "2")]
    assert [e["text"] for e in out.logs if e["markerId"] == "lp2"] == ["'x is 3'"]
    assert [e["valueBag"]["data"]["value"] for e in out.logs if e["markerId"] == "lp3"] == ["3"]
    assert [e["text"] for e in out.logs if e["markerId"] == "lp4"] == ["4"]
    m5 = [e for e in out.logs if e["markerId"] == "m5"][0]
    assert m5["text"] == "300" and m5["changeId"] == "c5" and m5["kind"] == "value"


def test_awaitables_logged_by_live_comments(run):
    out = run(
        """
        import asyncio
        async def fetch():
            await asyncio.sleep(0)
            return "data"
        fetch()  # ?
        async def main():
            t = asyncio.ensure_future(fetch())
            t  # ?
            await t
        asyncio.run(main())
        """
    )
    assert [e["text"] for e in out.logs_at(6)] == ["'data'"]
    assert [e["text"] for e in out.logs_at(9)] == ["'data'"]


def test_project_import_is_instrumented_with_own_scope(run):
    out = run(
        """
        import helper
        v = helper.twice(2)
        v
        """,
        files={"helper.py": "def twice(x):\n    return x * 2\nCONST = 1\n"},
    )
    files = out.of("file.instrumented")
    assert len(files) == 2
    helper = files[1]
    assert helper["path"].endswith("helper.py") and helper["rangeBase"] == len(files[0]["ranges"])
    assert out.logs_at(4)[0]["text"] == "4"
    scopes = out.trace["scopes"]
    assert [s["name"] for s in scopes][:2] == ["<module>", "<module>"]
    assert scopes[1]["depth"] == 1 and scopes[1]["rid"] == helper["rangeBase"]
    twice = next(s for s in scopes if s["name"] == "twice")
    assert twice["depth"] == 1
    cov = {c["fileId"]: c for c in out.of("coverage")}
    assert cov[2]["states"].count(COV_COVERED) >= 3


def test_hook_failure_becomes_system_log_not_crash(run, monkeypatch):
    from pyokka_runtime import logs

    def broken(self, *a, **k):
        raise RuntimeError("synthetic")

    monkeypatch.setattr(logs.LogMixin, "log_value", broken)
    out = run("x = 1  # ?\ny = 2\n")
    assert out.finished["exitCode"] == 0
    assert any(e["kind"] == "system" and "synthetic" in e["text"] for e in out.logs)
    assert out.state_at(2) == COV_COVERED


def test_max_trace_steps_truncates(run):
    out = run("for i in range(100):\n    x = i\n", config={"maxTraceSteps": 20})
    assert out.trace["truncated"] is True
    assert len(out.steps) == 20
    assert out.finished["stepCount"] == 201


def test_syntax_error_in_scratch_file(run):
    out = run("def (:\n")
    err = out.errors[0]
    assert err["errorType"] == "SyntaxError" and err["handled"] is False and err["stack"][0]["line"] == 1
    assert out.coverage["states"][0] == 3
