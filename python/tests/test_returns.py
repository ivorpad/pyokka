"""Every function exit records its value on the scope (`_pk_r`), read back through `walkthrough`, `graph` and `context`.

The shapes are the ones a real run (PageIndex over litellm) came back without: `return f(...)`
inside `try`, `return await ...`, returns inside `with` and `finally`, plus a generator's
return value and an exception leaving the frame.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pyokka_runtime.agent.source import SavedRun
from test_walkthrough import pyokka

PROGRAM = '''
import asyncio
import contextlib


def helper(x):
    return x * 2


def in_try(x):
    try:
        return helper(x)
    except ValueError:
        return -1


def in_except(x):
    try:
        raise ValueError(x)
    except ValueError:
        return helper(x) + 1


def in_finally(x):
    try:
        y = x + 1
    finally:
        return helper(y)


def finally_wins(x):
    try:
        return helper(x)
    finally:
        return "finally"


def in_with(x):
    with contextlib.nullcontext():
        return helper(x) + 3


def in_loop(items):
    for item in items:
        if item > 1:
            return helper(item)
    return None


async def co(x):
    await asyncio.sleep(0)
    return x + 10


async def await_ret(x):
    return await co(x)


def gen(n):
    yield n
    return n * 100


def drive_gen():
    g = gen(4)
    next(g)
    try:
        next(g)
    except StopIteration as stop:
        return stop.value


def implicit(x):
    x + 1


def outer(x):
    def inner(y):
        return y - 1

    return inner(x) * 3


def raises(x):
    return helper(x) / 0


def caller():
    try:
        raises(1)
    except ZeroDivisionError:
        return "caught"


a = in_try(1)
b = in_except(2)
c = in_finally(3)
d = finally_wins(4)
e = in_with(5)
f = in_loop([0, 1, 2])
g = asyncio.run(await_ret(6))
h = drive_gen()
i = implicit(7)
j = outer(8)
k = caller()
'''

# function -> what its (first) call returned, as `walkthrough` and `graph` print it
RETURNS = {
    "in_try": "2",
    "in_except": "5",
    "in_finally": "8",
    "finally_wins": "'finally'",
    "in_with": "13",
    "in_loop": "4",
    "await_ret": "16",
    "co": "16",
    "drive_gen": "400",
    "gen": "400",
    "inner": "7",
    "outer": "21",
    "caller": "'caught'",
}


@pytest.fixture(params=[False, True], ids=["plain", "auto-log"])
def shapes_run(request, tmp_path: Path) -> Path:
    src = tmp_path / "shapes.py"
    src.write_text(PROGRAM, encoding="utf-8")
    out = tmp_path / "run.json"
    code, text = pyokka("run", str(src), "--save", str(out), *(["--auto-log"] if request.param else []))
    assert code == 0, text
    return out


def calls_by_function(moments: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for m in moments:
        if m["kind"] == "call":
            out.setdefault(m["callee"]["function"], []).append(m)
    return out


def outs(m: dict) -> list[tuple[str, str]]:
    return [(v["name"], v["text"]) for v in m["values"] if v["role"] == "out"]


def test_the_scope_table_holds_every_exit(shapes_run: Path):
    run = SavedRun(str(shapes_run))
    scopes = {}
    for s in run.trace.scopes:
        scopes.setdefault(s["name"], s)
    assert {name: scopes[name].get("returned") for name in RETURNS} == RETURNS
    assert scopes["implicit"]["returned"] is None and "raised" not in scopes["implicit"]  # ran off the end of its body
    assert scopes["raises"]["raised"] == "ZeroDivisionError" and "returned" not in scopes["raises"]
    assert scopes["<module>"].keys().isdisjoint({"returned", "raised"})


def test_walkthrough_gives_each_call_its_own_out(shapes_run: Path):
    code, text = pyokka("walkthrough", str(shapes_run), "--json")
    assert code == 0
    calls = calls_by_function(json.loads(text)["moments"])
    for name, value in RETURNS.items():
        assert outs(calls[name][0]) == [("return", value)], name
    # `return helper(x) + 1` logs after helper's last step; helper keeps its own value
    assert [outs(m) for m in calls["helper"]][:3] == [[("return", "2")], [("return", "4")], [("return", "8")]]
    assert outs(calls["implicit"][0]) == []
    assert outs(calls["raises"][0]) == [("raised", "ZeroDivisionError: division by zero")]


def test_auto_log_values_of_return_lines_are_not_listed_twice(tmp_path: Path):
    src = tmp_path / "shapes.py"
    src.write_text(PROGRAM, encoding="utf-8")
    out = tmp_path / "run.json"
    assert pyokka("run", str(src), "--save", str(out), "--auto-log")[0] == 0
    code, text = pyokka("walkthrough", str(out), "--json")
    values = [m["text"] for m in json.loads(text)["moments"] if m["kind"] == "value"]
    assert not any(v.startswith(("helper(x)", "x * 2 =", "await co(x)", "stop.value", "inner(x) * 3")) for v in values), values
    assert "a = 2" in values and "j = 21" in values


def test_graph_rows_carry_the_return_and_the_raise(shapes_run: Path):
    code, text = pyokka("graph", str(shapes_run), "--json")
    assert code == 0
    nodes = {n["label"]: n for n in json.loads(text)["nodes"] if n["kind"] == "function"}
    for name, value in RETURNS.items():
        rows = [(r["kind"], r["name"], r["text"]) for r in nodes[name]["rows"] if r["kind"] != "in"]
        assert rows == [("out", "return", value)], name
    assert [(r["kind"], r["name"]) for r in nodes["raises"]["rows"] if r["kind"] != "in"] == [("raised", "ZeroDivisionError")]
    assert [r for r in nodes["implicit"]["rows"] if r["kind"] != "in"] == []


def test_context_names_the_return_of_the_block_and_of_each_call(shapes_run: Path):
    run = SavedRun(str(shapes_run))
    trace = run.trace
    first = {}
    for s in trace.scopes:
        first.setdefault(s["name"], int(s["last"]))
    code, text = pyokka("context", str(shapes_run), str(first["in_try"]), "--json")
    doc = json.loads(text)
    assert doc["block"]["function"] == "in_try" and doc["block"]["returned"] == "2"
    assert [(c["function"], c.get("returned")) for c in doc["calls"]] == [("helper", "2")]
    code, text = pyokka("context", str(shapes_run), str(first["await_ret"]))
    lines = text.splitlines()
    assert any(l.startswith("block await_ret ") and l.endswith("returned 16") for l in lines), lines
    assert "calls: co #%d → 16" % next(int(s["first"]) for s in trace.scopes if s["name"] == "co") in lines
    code, text = pyokka("context", str(shapes_run), str(first["caller"]))
    assert any(l.startswith("block caller ") and l.endswith("returned 'caught'") for l in text.splitlines())
    raise_step = next(int(s["first"]) for s in trace.scopes if s["name"] == "raises")
    caller_steps = [i for i in range(trace.count) if trace.scope_id(i) == next(int(s["scopeId"]) for s in trace.scopes if s["name"] == "caller")]
    site = max(i for i in caller_steps if i < raise_step)
    code, text = pyokka("context", str(shapes_run), str(site))
    assert "calls: raises #%d raised ZeroDivisionError" % raise_step in text.splitlines()
    code, text = pyokka("context", str(shapes_run), str(first["implicit"]))
    assert any(l.startswith("block implicit ") and l.endswith("returned None (end of body)") for l in text.splitlines())


def returned(out, name: str) -> list:
    return [s.get("returned", s.get("raised")) for s in out.trace["scopes"] if s["name"] == name]


def test_bare_returns_async_generators_and_lambdas_still_compile_and_run(run):
    """A bare `return` stays bare (an async generator allows no value); lambdas are left as they were."""
    out = run(
        """
        import asyncio
        f = lambda x: x + 1
        def g(x):
            return f(x)
        def bare(x):
            if x:
                return
            x += 1
        async def agen(n):
            for i in range(n):
                if i == 2:
                    return
                yield i
        async def collect():
            return [i async for i in agen(5)]
        print(g(1), bare(True), asyncio.run(collect()))
        """
    )
    assert out.result.exit_code == 0
    assert returned(out, "g") == ["2"] and returned(out, "bare") == ["None"] and returned(out, "collect") == ["[0, 1]"]
    assert returned(out, "agen") == ["None"]


def test_values_texts_and_masking(run, monkeypatch):
    monkeypatch.setenv("SERVICE_API_KEY", "sk-live-0123456789abcdef")
    out = run(
        """
        import os
        class Box:
            def __repr__(self):
                return "Box()"
        def text():
            return "key=" + os.environ["SERVICE_API_KEY"]
        def big():
            return 10 ** 5000
        def nested():
            return {"a": [1, 2], "b": "x" * 300}
        def small():
            return {"a": 1, "b": "two", "c": None}
        def obj():
            return Box()
        values = [text(), big(), nested(), small(), obj()]
        """
    )
    assert out.result.exit_code == 0
    assert "sk-live" not in returned(out, "text")[0]
    assert "digits" in returned(out, "big")[0] and len(returned(out, "big")[0]) <= 120  # reprlib names a huge int
    nested = returned(out, "nested")[0]  # cut like a local: at most 120 characters, then the mark
    assert nested.startswith("{'a': [1, 2], 'b': 'xxx") and nested.endswith("…(+203 chars)") and len(nested[: nested.index("…(+")]) <= 120
    assert returned(out, "small") == ["{'a': 1, 'b': 'two', 'c': None}"] and returned(out, "obj") == ["Box()"]
    assert not out.of("runner.error")


def test_a_finally_that_raises_after_a_return(run):
    """The return value was stored, then the `finally` raised: the frame left by the exception."""
    out = run(
        """
        def f():
            try:
                return 1
            finally:
                raise KeyError("late")
        try:
            f()
        except KeyError:
            pass
        """
    )
    assert out.result.exit_code == 0
    assert returned(out, "f") == ["1"]  # known limit: the stored value wins over the late raise


# -- a long return value is cut like a local: `--max-value-chars`, `…(+N chars)`, truncated/length ------------------

LONG = '''
def prompt(n):
    return "x" * n


def pair():
    return {"a": "y" * 3000}


p = prompt(N)
q = pair()
'''


def long_run(tmp_path: Path, n: int = 10000, *flags: str, name: str = "run.json") -> Path:
    src = tmp_path / ("long%d.py" % n)
    src.write_text(LONG.replace("N", str(n)), encoding="utf-8")
    out = tmp_path / name
    code, text = pyokka("run", str(src), "--save", str(out), *flags)
    assert code == 0, text
    return out


def scope_of(path: Path, name: str) -> dict:
    return next(s for s in SavedRun(str(path)).trace.scopes if s["name"] == name)


def test_a_long_return_is_cut_and_marked_by_default(tmp_path: Path):
    out = long_run(tmp_path)
    s = scope_of(out, "prompt")
    shown = s["returned"][: s["returned"].index("…(+")]
    assert 100 <= len(shown) <= 120 and s["returned"] == "%s…(+%s chars)" % (shown, format(10002 - len(shown), ","))
    assert s["returnedTruncated"] is True and s["returnedLength"] == 10002  # the repr: 10,000 x and two quotes
    d = scope_of(out, "pair")  # a small dict over the limit leaves the fast path and is marked too
    assert d["returned"].endswith("chars)") and d["returnedTruncated"] is True and d["returnedLength"] == len(repr({"a": "y" * 3000}))
    first = {sc["name"]: int(sc["first"]) for sc in SavedRun(str(out)).trace.scopes}
    # walkthrough prints the mark on the `out` row; walkthrough and graph --json say truncated/length
    code, text = pyokka("walkthrough", str(out))
    assert code == 0 and any("out return = 'xxx" in l and l.endswith("chars)") for l in text.splitlines()), text
    calls = calls_by_function(json.loads(pyokka("walkthrough", str(out), "--json")[1])["moments"])
    row = next(v for v in calls["prompt"][0]["values"] if v["role"] == "out")
    assert "…(+" in row["text"] and row["truncated"] is True and row["length"] == 10002
    nodes = {n["label"]: n for n in json.loads(pyokka("graph", str(out), "--json")[1])["nodes"] if n["kind"] == "function"}
    row = next(r for r in nodes["prompt"]["rows"] if r["kind"] == "out")
    assert "…(+" in row["text"] and row["truncated"] is True and row["length"] == 10002
    # context: `block prompt ... returned 'xxx…(+N chars)'` and the caller's `calls:` line
    code, text = pyokka("context", str(out), str(first["prompt"]))
    assert any(l.startswith("block prompt ") and "returned 'xxx" in l and l.endswith("chars)") for l in text.splitlines()), text
    doc = json.loads(pyokka("context", str(out), str(first["prompt"]), "--json")[1])
    assert doc["block"]["returnedTruncated"] is True and doc["block"]["returnedLength"] == 10002
    code, text = pyokka("context", str(out), str(first["prompt"] - 1))
    assert any(l.startswith("calls: prompt #") and l.endswith("chars)") for l in text.splitlines()), text


def test_max_value_chars_applies_to_returns(tmp_path: Path):
    s = scope_of(long_run(tmp_path, 10000, "--max-value-chars", "500"), "prompt")
    shown = s["returned"][: s["returned"].index("…(+")]
    assert 480 <= len(shown) <= 500 and s["returnedLength"] == 10002
    s = scope_of(long_run(tmp_path, 10000, "--max-value-chars", "0", name="whole.json"), "prompt")
    assert s["returned"] == repr("x" * 10000) and "returnedTruncated" not in s and "returnedLength" not in s


def test_max_value_chars_ceiling_cuts_a_return(tmp_path: Path):
    s = scope_of(long_run(tmp_path, 1_200_000, "--max-value-chars", "0"), "prompt")
    assert s["returnedTruncated"] is True and s["returnedLength"] == 1_200_002
    assert s["returned"].endswith("chars)") and len(s["returned"]) < 1_000_100


def test_graph_text_keeps_the_mark_of_a_cut_return(tmp_path: Path):
    code, text = pyokka("graph", str(long_run(tmp_path)))
    line = next(l for l in text.splitlines() if " prompt " in l and " out " in l)
    assert line.endswith("chars)") and "…(+9,9" in line, text


def test_diff_shows_the_cut_mark_of_a_changed_return(tmp_path: Path):
    """Same call, same arguments, a return that differs past the cut: both sides keep their mark."""
    src = tmp_path / "grow.py"
    src.write_text('import pathlib\n\n\ndef prompt():\n    return "x" * int((pathlib.Path(__file__).parent / "n.txt").read_text())\n\n\np = prompt()\n', encoding="utf-8")
    runs = []
    for n in (10000, 10001):
        (tmp_path / "n.txt").write_text(str(n), encoding="utf-8")
        runs.append(tmp_path / ("%d.json" % n))
        assert pyokka("run", str(src), "--save", str(runs[-1]))[0] == 0
    code, text = pyokka("diff", str(runs[0]), str(runs[1]))
    line = next(l for l in text.splitlines() if "prompt() returned" in l)
    assert "…(+9,958 chars) → '" in line and "…(+9,959 chars)" in line, text  # the 60-char cut adds to the recording's
