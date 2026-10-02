"""``exec``: running a statement in the paused frame, and the write reaching the program.

Both interpreter branches are covered. The venv is 3.12, so the ``PyFrame_LocalsToFast`` push is
what these tests exercise directly; the PEP 667 write-through proxy is exercised by driving a real
runner under a 3.13+ interpreter, and the branch selection itself is checked under 3.12 by forcing
``dbgexec._WRITE_THROUGH`` both ways.
"""

from __future__ import annotations

import platform
import shutil
import sys
from pathlib import Path

import pytest

from pyokka_runtime import dbgexec
from pyokka_runtime.control import ControlChannel, handle_request
from tests.test_debug import CONTINUE, Client, Scripted, attach, client, pauses, results  # noqa: F401 - `client` is the fixture
from tests.test_debug_record_off import debug_run

# `add([1, 2])` is 3; an exec of `total = 100` at the `return` makes it 100.
TOTALS = """
def add(items):
    total = 0
    for n in items:
        total += n
    return total


print(add([1, 2]))
"""

MODULE_LEVEL = """
name = "box"
label = name + "!"
print(label)
"""

POP = """
def take(items):
    kept = len(items)
    print(items, kept)


take(["a", "last"])
"""

CALLER = """
def inner(x):
    y = x + 1
    return y


def outer(n):
    label = "outer"
    got = inner(n)
    return "%s:%d" % (label, got)


print(outer(2))
"""

# `fresh` is not a local of `add`, so it has no slot: it lives in the frame's locals mapping, which
# is what `locals()`, `evaluate` and the `locals` action read.
FRESH = """
def add(items):
    total = 0
    for n in items:
        total += n
    print("fresh" in locals(), total)


add([1, 2])
"""

TWO_STOPS = """
def add(items):
    total = 0
    for n in items:
        total += n
    return total


first = add([1, 2])
second = add([3, 4])
print(first, second)
"""

INTERPRETERS = ("python3.13 on PATH", "/opt/homebrew/bin/python3.13", "/opt/homebrew/bin/python3.14")


def ex(rid: str, source: str, **extra) -> dict:
    return {"type": "exec", "id": rid, "source": source, **extra}


def replies(out) -> dict:
    """Every typed reply of the run, by request id."""
    kinds = ("exec.result", "exec.error", "evaluate.result", "evaluate.error", "debug.result", "debug.error")
    return {e["id"]: e for kind in kinds for e in results(out, kind)}


def output_of(out) -> str:
    return "".join(e["text"] for e in out.of("output") if e["stream"] == "stdout")


def stops(client, kind: str, seen: list | None = None) -> dict:
    """The next message of this kind from a runner, keeping the ones passed on the way."""
    for _ in range(500):
        m = client.recv()
        if seen is not None:
            seen.append(m)
        if m.get("type") == kind:
            return m
    raise AssertionError("no %s arrived" % kind)


def newer_interpreter() -> str | None:
    """A 3.13+ interpreter to run the write-through branch under, else ``None``."""
    for exe in (shutil.which("python3.13"), "/opt/homebrew/bin/python3.13", "/opt/homebrew/bin/python3.14"):
        if exe and Path(exe).exists():
            return exe
    return sys.executable if sys.version_info >= (3, 13) else None


def test_exec_assigns_in_the_paused_frame_and_the_program_sees_it(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    out = debug_run(run, TOTALS, batches=[[ex("e", "total = 100"), CONTINUE]], breakpoints=[{"path": path, "line": 6}])
    assert replies(out)["e"] == {"type": "exec.result", "id": "e", "text": "", "modified": True}
    assert output_of(out) == "100\n", "the write reached the frame's own local, not only a snapshot"
    assert out.result.exit_code == 0


def test_exec_serves_a_recording_pause_too(run, tmp_path):
    """A `record: true` debug session gets `exec` from the same control channel."""
    path = str(tmp_path / "scratch.py")
    batch = [ex("e", "total = 100"), {"type": "debug", "id": "vars", "action": "locals"}, CONTINUE]
    out = run(TOTALS, config={"debug": True, "stopOnEntry": False}, on_tracer=attach(Scripted(batch), breakpoints=[{"path": path, "line": 6}]))
    got = replies(out)
    assert got["e"] == {"type": "exec.result", "id": "e", "text": "", "modified": True}
    assert got["vars"]["modified"] is True
    assert pauses(out)[0].get("modified") is None, "the stop that served the exec went out before it"
    assert [e["text"] for e in out.logs if e["kind"] == "log"] == ["100"], "a recording run logs the print"
    assert out.of("trace"), "the recording is untouched"


def test_exec_calling_the_breakpointed_function_does_not_pause_again(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    batch = [ex("call", "add([5, 6])"), ex("read", "total"), CONTINUE]
    out = debug_run(run, TOTALS, batches=[batch], breakpoints=[{"path": path, "line": 6}])
    got = replies(out)
    assert got["call"]["text"] == "11", "the call ran the breakpointed function to completion"
    assert got["read"]["text"] == "3", "and left the paused frame's own `total` alone"
    assert len(pauses(out)) == 1, "nothing that runs inside a pause may pause again"
    assert output_of(out) == "3\n"


def test_exec_at_module_level_writes_the_globals(run, tmp_path, monkeypatch):
    monkeypatch.setattr(dbgexec, "_locals_to_fast", lambda frame: pytest.fail("module level needs no ctypes"))
    path = str(tmp_path / "scratch.py")
    out = debug_run(run, MODULE_LEVEL, batches=[[ex("e", "name = 'tin'"), CONTINUE]], breakpoints=[{"path": path, "line": 3}])
    assert replies(out)["e"]["text"] == ""
    assert output_of(out) == "tin!\n", "the module dict is the frame's globals, so the assignment is already in place"


def test_exec_reports_the_value_of_an_expression_statement(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    batch = [
        ex("num", "1 + 2"),
        ex("block", "x = 2\nx * 3"),
        ex("call", "items.pop()"),
        ex("stmt", "kept = 9"),
        ex("empty", "  "),
        ex("block2", "import json\ndel items[0]\njson.dumps(items)"),
        CONTINUE,
    ]
    out = debug_run(run, POP, batches=[batch], breakpoints=[{"path": path, "line": 3}])
    got = replies(out)
    assert got["num"]["text"] == "3" and got["num"]["valueBag"]["data"]["value"] == "3"
    assert got["num"]["valueBag"]["data"]["id"].startswith(got["num"]["valueBag"]["runtimeKey"]), "`expand` can open it"
    assert got["block"]["text"] == "6", "the statements before the expression run in the same namespaces"
    assert got["call"]["text"] == "'last'", "a REPL shows what the last expression returned"
    assert (got["stmt"]["text"], "valueBag" in got["stmt"]) == ("", False), "a statement has no value to show"
    assert (got["empty"]["text"], "valueBag" in got["empty"]) == ("", False), "nothing at all is a block with no value"
    assert got["block2"]["text"] == "'[]'", "an import and a `del` are statements like any other"
    assert output_of(out) == "[] 0\n", "`items.pop()` and the `del` really ran, and `kept` was computed after them"


def test_exec_reports_an_exception_and_stays_paused(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    batch = [
        ex("boom", "1/0"),
        ex("key", "{'a': 1}['b']"),
        ex("half", "total = 50\nitems.missing()"),
        {"type": "evaluate", "id": "after", "expression": "total"},
        CONTINUE,
    ]
    out = debug_run(run, POP, batches=[batch], breakpoints=[{"path": path, "line": 3}])
    got = replies(out)
    assert got["boom"]["type"] == "exec.result", "a raise is not a failed request: the session stays paused"
    assert got["boom"]["exception"]["type"] == "ZeroDivisionError" and got["boom"]["exception"]["message"] == "division by zero"
    assert got["boom"]["exception"]["traceback"].startswith("Traceback (most recent call last):")
    assert "<pyokka-exec>" in got["boom"]["exception"]["traceback"] and "dbgexec" not in got["boom"]["exception"]["traceback"]
    assert (got["boom"]["text"], got["boom"]["modified"]) == ("", True)
    assert got["key"]["exception"]["type"] == "KeyError" and got["key"]["exception"]["message"] == "'b'"
    assert got["half"]["exception"]["type"] == "AttributeError"
    assert got["after"]["text"] == "50", "what ran before the raise is still written"
    assert len(pauses(out)) == 1 and output_of(out) == "['a', 'last'] 2\n", "the one pause served every request and then resumed"


def test_exec_sets_modified_on_every_attempt(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    batches = [
        [{"type": "debug", "id": "before", "action": "locals"}, ex("boom", "1/0"), CONTINUE],
        [{"type": "debug", "id": "after", "action": "locals"}, CONTINUE],
    ]
    out = debug_run(run, TWO_STOPS, batches=batches, breakpoints=[{"path": path, "line": 6}])
    first, second = pauses(out)
    got = replies(out)
    assert "modified" not in first and "modified" not in got["before"], "nothing has written yet"
    assert got["boom"]["modified"] is True, "a failing statement may already have written"
    assert second["modified"] is True, "it rides on every later stop"
    assert got["after"]["modified"] is True, "and on the locals reply, because they are no longer only the program's"
    assert output_of(out) == "3 7\n"


def test_exec_is_refused_while_running_and_after_the_run(run, tmp_path):
    sent: list[dict] = []
    channel = ControlChannel(-1, sent.append)
    channel._while_running(ex(1, "x = 1"))
    assert sent == [{"type": "exec.error", "id": 1, "message": "the program is running; pause it first"}]
    sent.clear()
    handle_request(ex(2, "x = 1"), None, sent.append, None, None)
    assert sent == [{"type": "exec.error", "id": 2, "message": "the run has ended; there is no frame to execute in"}]
    # the reader thread keeps serving what needs no frame while the program runs
    sent.clear()
    channel._while_running({"type": "debug", "id": 3, "action": "pause"})
    assert sent[0]["type"] == "debug.error", "no debugger on this bare channel, but it was served, not refused"


def test_exec_is_refused_over_the_runner_unless_the_run_is_paused(client, tmp_path):
    client.send(type="hello", version="test")
    assert "exec" in client.recv()["capabilities"]
    scratch = tmp_path / "s.py"
    scratch.write_text("import time\nfor i in range(30):\n    time.sleep(0.05)\n    x = i\nprint(x)\n", encoding="utf-8")
    base = {"file": {"path": str(scratch), "displayName": scratch.name}, "workspaceRoot": str(tmp_path), "cwd": str(tmp_path), "argv": [], "env": {}, "projectFiles": [], "markers": [], "expressionsToEvaluate": {}, "watch": [], "mode": "normal"}
    client.send(type="exec", runId="none", source="x = 1")
    assert client.recv()["message"] == "the run has ended; there is no frame to execute in", "no run at all"
    client.send(type="run", runId="e1", config={"timeoutMs": 20000, "debug": True, "record": False, "stopOnEntry": False}, **base)
    stops(client, "ok")
    client.send(type="exec", runId="e1", source="x = 1")
    assert stops(client, "error")["message"] == "the program is running; pause it first"
    fin = stops(client, "run.finished")
    assert fin["exitCode"] == 0
    client.send(type="exec", runId="e1", source="x = 1")
    assert stops(client, "error")["message"] == "the run has ended; there is no frame to execute in", "a finished child has no frame"
    client.send(type="evaluate", runId="e1", expression="x")
    assert stops(client, "evaluated")["text"] == "29", "reading the finished run still works"


def test_exec_creates_a_new_name_visible_to_evaluate_and_locals(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    batch = [
        ex("new", "fresh = 7"),
        {"type": "evaluate", "id": "read", "expression": "fresh + 1"},
        {"type": "debug", "id": "vars", "action": "locals"},
        CONTINUE,
    ]
    out = debug_run(run, FRESH, batches=[batch], breakpoints=[{"path": path, "line": 6}])
    got = replies(out)
    assert got["read"]["text"] == "8"
    assert ("fresh", "7") in [(v["name"], v["text"]) for v in got["vars"]["locals"]]
    assert output_of(out) == "True 3\n", "the name is in the frame's locals mapping; the compiled code has no slot for it"


def test_exec_frame_id_targets_a_caller_frame(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    batch = [ex("up", "label = 'caller'", frameId=1), ex("gone", "label = 'nope'", frameId=9), CONTINUE]
    out = debug_run(run, CALLER, batches=[batch], breakpoints=[{"path": path, "line": 4}])
    (p,) = pauses(out)
    assert [s["name"] for s in p["stack"]] == ["inner", "outer", "<module>"]
    got = replies(out)
    assert got["up"]["text"] == "" and got["up"]["modified"] is True
    assert got["gone"] == {"type": "exec.error", "id": "gone", "message": "LookupError: no frame 9 in this pause"}
    assert output_of(out) == "caller:3\n", "frameId 1 wrote in the caller, which read it back after the return"


def test_exec_write_back_picks_the_branch_by_version(run, tmp_path, monkeypatch):
    path = str(tmp_path / "scratch.py")
    pushed: list[str] = []
    monkeypatch.setattr(dbgexec, "_locals_to_fast", lambda frame: pushed.append(frame.f_code.co_name))
    # With the push mocked away the write survives only where `f_locals` writes through by itself,
    # so under 3.12 the frame keeps its own value and under 3.13+ it takes the new one.
    kept = "3" if sys.version_info < (3, 13) else "100"
    batch = [ex("e", "total = 100"), {"type": "evaluate", "id": "v", "expression": "total"}, CONTINUE]

    monkeypatch.setattr(dbgexec, "_WRITE_THROUGH", False)
    old = debug_run(run, TOTALS, batches=[batch], breakpoints=[{"path": path, "line": 6}])
    assert pushed == ["add"], "the 3.12 branch pushes the paused frame's locals back with ctypes"
    assert replies(old)["v"]["text"] == kept and output_of(old) == kept + "\n"

    monkeypatch.setattr(dbgexec, "_WRITE_THROUGH", True)
    new = debug_run(run, TOTALS, batches=[batch], breakpoints=[{"path": path, "line": 6}])
    assert pushed == ["add"], "the write-through branch calls no ctypes at all"
    assert replies(new)["v"]["text"] == kept and output_of(new) == kept + "\n"


def test_exec_without_ctypes_is_refused_before_anything_runs(run, tmp_path, monkeypatch):
    path = str(tmp_path / "scratch.py")
    monkeypatch.setattr(dbgexec, "_WRITE_THROUGH", False)
    monkeypatch.setitem(sys.modules, "ctypes", None)
    out = debug_run(run, TOTALS, batches=[[ex("e", "total = 100"), CONTINUE]], breakpoints=[{"path": path, "line": 6}])
    assert replies(out)["e"] == {"type": "exec.error", "id": "e", "message": "cannot write to a frame on Python 3.12 without ctypes"}
    assert output_of(out) == "3\n", "an exec whose write cannot land does not half-run"


def test_exec_on_the_other_interpreter_branch(tmp_path):
    exe = newer_interpreter()
    if exe is None:
        pytest.skip("no 3.13+ interpreter (looked for %s, and this one is %s)" % (", ".join(INTERPRETERS), platform.python_version()))
    scratch = tmp_path / "s.py"
    scratch.write_text(TOTALS.lstrip("\n"), encoding="utf-8")
    client = Client(executable=exe)
    try:
        client.send(type="hello", version="test")
        ready = client.recv()
        assert tuple(int(n) for n in ready["pythonVersion"].split(".")[:2]) >= (3, 13), "the point of this test is the PEP 667 branch"
        assert "exec" in ready["capabilities"]
        base = {"file": {"path": str(scratch), "displayName": scratch.name}, "workspaceRoot": str(tmp_path), "cwd": str(tmp_path), "argv": [], "env": {}, "projectFiles": [], "markers": [], "expressionsToEvaluate": {}, "watch": [], "mode": "normal"}
        client.send(type="run", runId="w1", config={"timeoutMs": 30000, "debug": True, "record": False, "stopOnEntry": False}, breakpoints=[{"path": str(scratch), "line": 5}], **base)
        paused = stops(client, "debug.paused")
        assert (paused["reason"], paused["line"]) == ("breakpoint", 5)
        client.send(type="exec", runId="w1", source="total = 100")
        assert stops(client, "executed") == {"type": "executed", "id": 3, "text": "", "modified": True}
        client.send(type="exec", runId="w1", source="fresh = 7")
        stops(client, "executed")
        client.send(type="evaluate", runId="w1", expression="fresh + total")
        assert stops(client, "evaluated")["text"] == "107", "a new name and a written local, both in the proxy"
        client.send(type="debug", runId="w1", action="locals")
        assert stops(client, "debug.result")["modified"] is True
        client.send(type="debug", runId="w1", action="continue")
        seen: list[dict] = []
        assert stops(client, "run.finished", seen)["exitCode"] == 0
        assert "".join(e["text"] for e in seen if e.get("type") == "output") == "100\n", "the proxy wrote straight into the frame"
    finally:
        client.close()
