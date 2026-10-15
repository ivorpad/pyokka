"""A function value's source in the debugger's variables, for the page's hover."""

from __future__ import annotations

from tests.test_debug import CONTINUE, Scripted, attach, pauses, results
from tests.test_runner import client  # noqa: F401 - the fixture test_debug needs in scope

SOURCE = """
def double(n):
    # twice n
    return n * 2


def apply(fn, builtin, x):
    y = fn(x)
    return builtin([y])


apply(double, len, 3)
"""
# line 9 is `return builtin([y])`: fn is double, builtin is len


def test_a_function_local_carries_its_source_and_a_builtin_none(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    out = run(SOURCE, on_tracer=attach(Scripted([{"type": "debug", "id": "v", "action": "locals"}, CONTINUE]), breakpoints=[{"path": path, "line": 9}]))
    assert [p["line"] for p in pauses(out)] == [9]
    by_name = {v["name"]: v["valueBag"]["data"] for v in results(out, "debug.result")[0]["locals"]}
    fn = by_name["fn"]
    assert fn["type"] == "function"
    assert fn["functionSource"] == "def double(n):\n    # twice n\n    return n * 2\n"
    assert fn["functionLocation"]["line"] == 2 and fn["functionLocation"]["path"].endswith("scratch.py")
    assert "functionSourceCapped" not in fn
    assert "functionSource" not in by_name["builtin"]
