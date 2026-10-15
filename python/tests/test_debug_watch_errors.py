"""A break-when watch that raises is reported, not swallowed."""

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


# -- 1.5: a watch that raises is reported, not swallowed ---------------------------------------

def test_a_watch_that_raises_stops_once_with_its_error_and_the_run_goes_on(run):
    out = run(LOOP, config={"debug": True}, on_tracer=attach(Scripted([watches({"id": "z", "exp": "1/0", "breakWhen": "change"}), CONTINUE])))
    ps = pauses(out)[1:]
    assert [p["reason"] for p in ps] == ["watch"], ps
    assert ps[0]["watch"]["id"] == "z"
    assert ps[0]["watch"]["error"].startswith("ZeroDivisionError"), ps[0]["watch"]
    assert out.result.exit_code == 0 and [e["text"] for e in out.logs] == ["10"], "the same failing watch does not stop again; the run finishes"


def test_a_truth_watch_that_raises_is_reported_too(run):
    out = run(LOOP, config={"debug": True}, on_tracer=attach(Scripted([watches({"id": "t", "exp": "total / (i - i)", "breakWhen": "true"}), CONTINUE])))
    ps = [p for p in pauses(out) if p["reason"] == "watch"]
    assert len(ps) == 1 and ps[0]["watch"]["error"].startswith("ZeroDivisionError")


def test_a_name_not_bound_yet_stays_silent(run):
    out = run(LOOP.replace("print(total)", "label = 'done'\nprint(total)"), config={"debug": True}, on_tracer=attach(Scripted([watches({"id": "w3", "exp": "label", "breakWhen": "change"}), CONTINUE])))
    ps = pauses(out)[1:]
    assert [(p["line"], p["watch"].get("error"), p["watch"]["text"]) for p in ps] == [(6, None, "'done'")]


def test_the_cli_names_the_failure():
    from pyokka_runtime.agent.live import stop_reason

    paused = {"reason": "watch", "watch": {"id": "z", "exp": "1/0", "text": "<evaluation failed>", "error": "ZeroDivisionError: division by zero"}}
    assert stop_reason(paused) == "watch 1/0 failed: ZeroDivisionError: division by zero"
