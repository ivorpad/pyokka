"""Breakpoint conditions and break-when watches go through the pure evaluator."""

from __future__ import annotations

from tests.test_debug import CONTINUE, LOOP, Scripted, attach, pauses, results
from tests.test_runner import client  # noqa: F401 - the fixture test_debug needs in scope

APPEND = """
lst = []
for i in range(3):
    x = i
print(len(lst))
"""


def watches(*specs):
    return {"type": "debug", "id": "w", "action": "watches", "set": list(specs)}


# -- 1.6: conditions and watches cannot change the program ------------------------------------

def test_a_condition_that_writes_is_refused_and_the_list_stays_empty(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    out = run(APPEND, on_tracer=attach(Scripted(), breakpoints=[{"path": path, "line": 4, "condition": "lst.append(1) or True"}]))
    ps = pauses(out)
    assert ps, "a refused condition pauses and says why"
    assert all("lst.append" in p["conditionError"] or "pure" in p["conditionError"] or "change" in p["conditionError"] for p in ps), [p.get("conditionError") for p in ps]
    assert [e["text"] for e in out.logs] == ["0"], "lst was never appended to"


def test_a_watch_that_writes_is_refused_and_the_list_stays_empty(run):
    out = run(APPEND, config={"debug": True}, on_tracer=attach(Scripted([watches({"id": "a", "exp": "lst.append(1)", "breakWhen": "change"}), CONTINUE])))
    ps = [p for p in pauses(out) if p["reason"] == "watch"]
    assert len(ps) == 1 and ps[0]["watch"]["error"], ps
    assert [e["text"] for e in out.logs] == ["0"], "lst was never appended to"


def test_a_pure_condition_still_works(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    out = run(LOOP, on_tracer=attach(Scripted([{"type": "evaluate", "id": "e", "expression": "i"}, CONTINUE]), breakpoints=[{"path": path, "line": 4, "condition": "len([i]) == 1 and i == 3"}]))
    (p,) = pauses(out)
    assert "conditionError" not in p and results(out, "evaluate.result")[0]["text"] == "3"


def test_a_recorded_watch_that_writes_is_refused_and_the_list_stays_empty(run):
    out = run(APPEND, watch=[{"id": "a", "exp": "lst.append(1)"}, {"id": "n", "exp": "len(lst)"}], trace_context={"step": 0, "prefetch": 20})
    refused = [w for w in out.of("watch") if w["watchId"] == "a"]
    assert refused and all("lst.append" in w.get("error", "") for w in refused), refused
    lengths = {w["valueBag"]["data"]["value"] for w in out.of("watch") if w["watchId"] == "n" and "valueBag" in w}
    assert lengths == {"0"}, lengths
    assert [e["text"] for e in out.logs] == ["0"], "lst was never appended to"
