"""The conversation around the agenda: the go-on guard after a stop, the person's questions in between (ask, look,
try), a stop set aside with ``skip``, and ``look`` over the recorded values. The repository, the started review
and the fakes come from ``test_review_actions.py``."""

from __future__ import annotations

from pathlib import Path

from pyokka_runtime.agent.review.state import FINDING_ADD, Review
from pyokka_runtime.agent.source import SavedRun
from tests.test_review_actions import comma_patch, fakes, fresh, refusal, run, shop, started  # noqa: F401  pytest fixtures and helpers


def test_the_next_stop_waits_for_the_person_but_their_questions_do_not(started, tmp_path, fakes):
    r = fresh(started, tmp_path)
    plan = Review.load(str(r.dir)).stops
    run("stop", dir=str(r.dir), n=1, say="the raise at step %d" % plan[0]["step_b"], surface="chat")
    exc = refusal("stop", dir=str(r.dir), n=2, say="unit_price = '1,249.00'", surface="chat")
    assert exc.why == "the person has not spoken since stop 1; pass --go-on only after they said next, or answer them with ask/try/look"
    assert exc.next_command == "wait for the person; when they say next, review stop 2 --say TEXT --go-on"
    assert Review.load(str(r.dir)).shown == [1]
    # ask, look and try answer them meanwhile, each ending with `wait for the person`
    asked = run("ask", dir=str(r.dir), line="shopkit/discounts.py:16", say="rate = 0.0 before the loop", surface="chat")
    looked = run("look", dir=str(r.dir), expr="spend > 1000")
    tried = run("try", dir=str(r.dir), expr="1 + 1")
    assert asked["next"] == looked["next"] == tried["next"] == "wait for the person"
    assert looked["step"] == asked["step"] and looked["value"] in ("True", "False")
    assert [e["kind"] for e in Review.load(str(r.dir)).conversation] == ["stop", "ask", "look", "try"]
    exc = refusal("stop", dir=str(r.dir), n=2, say="unit_price = '1,249.00'", surface="chat")
    assert exc.why.startswith("the person has not spoken since stop 1")
    answer = run("stop", dir=str(r.dir), n=2, say="unit_price = '1,249.00'", surface="chat", go_on=True)
    assert "stops 2/2 shown" in answer["header"] and Review.load(str(r.dir)).data["said"][0]["go_on"] is True


def test_skip_sets_a_stop_aside_and_the_agenda_moves_on(started, tmp_path, fakes):
    r = fresh(started, tmp_path)
    assert refusal("skip", dir=str(r.dir), n=2).why == "skip 2 needs --why TEXT, the reason the person gave"
    assert refusal("skip", dir=str(r.dir), n=9, why="x").why == "stop 9 is not in the plan"
    answer = run("skip", dir=str(r.dir), n=2, why="they know the parse_money change; it is the fix they want")
    assert answer["lines"][0].startswith("skipped 2. type  shopkit/orders.py:30 parse_orders") and answer["remaining"] == [1] and answer["next"] == "review stop 1 --say TEXT"
    step = Review.load(str(r.dir)).stop(1)["step_b"]
    answer = run("stop", dir=str(r.dir), n=1, say="step %d" % step, surface="chat")
    after = Review.load(str(r.dir))
    assert after.phase == "findings" and after.remaining() == [] and after.skipped[0]["n"] == 2 and "stops 1/2 shown" in answer["header"]
    assert answer["next"] == "wait for the person; when they say next, " + FINDING_ADD
    assert refusal("skip", dir=str(r.dir), n=1, why="x").why == "stop 1 was shown already; nothing to skip"
    st = run("state", dir=str(r.dir))
    assert "agenda: shown 1 · skipped 2 · remaining none · waiting for the person since stop 1" in st["lines"]
    assert any("(skipped: they know the parse_money change" in l for l in st["lines"]) and any(l.startswith("  skipped stop 2: they know") for l in st["lines"])
    assert refusal("fix", dir=str(r.dir), patch="x.diff").why == "nothing to fix yet: no finding"  # the agenda is done: skipped counts
    # a skipped stop can still be shown later, once they say so
    answer = run("stop", dir=str(r.dir), n=2, say="unit_price = '1,249.00'", surface="chat", go_on=True)
    assert "stops 2/2 shown" in answer["header"] and Review.load(str(r.dir)).skipped == []


def test_look_answers_from_the_recorded_values_without_moving(started, tmp_path, fakes):
    r = fresh(started, tmp_path)
    assert refusal("look", dir=str(r.dir), expr="len(lines)").why == "no current step: show a stop or ask a line first, or give --step N"
    assert refusal("look", dir=str(r.dir)).why.startswith("look needs --expr EXPR")
    typed = Review.load(str(r.dir)).stop(2)["step_b"]
    answer = run("look", dir=str(r.dir), expr="float(unit_price.replace(',', ''))", step=typed)
    assert answer["value"] == "1249.0" and answer["next"] == "wait for the person"
    assert answer["lines"][0].startswith("look float(unit_price.replace(',', ''))  at step %d  shopkit/orders.py:30 parse_orders" % typed)
    assert answer["lines"][1] == "= 1249.0  (evaluated from the values recorded at this step)"
    answer = run("look", dir=str(r.dir), expr="catalog['MON-27'].price", step=typed)  # catalog's recorded text is a dict of Product(...): not a literal
    assert answer.get("value") is None and "not a literal" in answer["note"] and answer["locals"][0][0] == "catalog" and "recorded values it names:" in answer["lines"]
    answer = run("look", dir=str(r.dir), expr="nothing_here + 1", step=typed)
    assert answer["note"] == "no recorded value for nothing_here at this step" and "it names no recorded value at this step" in answer["lines"][2]
    answer = run("look", dir=str(r.dir), expr="unit_price.upper().count('X') / 0", step=typed)
    assert answer["note"].startswith("ZeroDivisionError")
    assert refusal("look", dir=str(r.dir), expr="unit_price.upper(", step=typed).why.startswith("--expr is not an expression")
    answer = run("look", dir=str(r.dir), expr="print(unit_price)", step=typed)  # not a pure call: pure.py refuses it, reported as a note
    assert answer.get("value") is None and "print" in answer["note"]
    # without --step, the current step is the last stop shown or line asked
    run("stop", dir=str(r.dir), n=2, say="unit_price = '1,249.00'", surface="chat")
    answer = run("look", dir=str(r.dir), expr="charged == unit_price")
    assert answer["step"] == typed and answer["value"] == "True"
    assert Review.load(str(r.dir)).conversation[-1] == {**Review.load(str(r.dir)).conversation[-1], "kind": "look", "expr": "charged == unit_price", "value": "True"}


def test_a_finding_on_a_line_head_never_ran_takes_a_try_instead_of_a_step(started, tmp_path, fakes):
    r = fresh(started, tmp_path)
    code = tmp_path / "platinum.py"
    code.write_text("from shopkit.config import DEFAULT\nfrom shopkit.discounts import loyalty_rate\nresult = loyalty_rate('platinum', DEFAULT)\n")
    tried = run("try", dir=str(r.dir), code=str(code), edge="E2")["try"]
    assert tried["id"] == "t1" and "AttributeError" in tried["error"] and "platinum_rate" in tried["error"]
    common = dict(dir=str(r.dir), file="shopkit/discounts.py", line=8, severity="major", title="the platinum branch raises AttributeError", fix="add platinum_rate to Settings")
    # discounts.py:8 is in the plan's unreached list and the reproduction is a try: no step needed
    answer = run("finding", **common, repro="t1")
    f = answer["finding"]
    assert f["step"] is None and f["unreached"] is True and f["step_at"] is None and f["values"] == [] and f["repro"]["kind"] == "try"
    assert answer["lines"][0] == "  f1 major  shopkit/discounts.py:8  the platinum branch raises AttributeError  never ran in head; reproduced by t1"
    # a command is not tied to the line nobody ran
    import sys

    exc = refusal("finding", **{**common, "title": "with a command"}, repro="%s -c 'print(1)'" % sys.executable, expect="1")
    assert exc.why == "a finding on a line that never ran in head needs a try as its reproduction (--repro tN)"
    # a line that ran still needs its step
    exc = refusal("finding", dir=str(r.dir), file="shopkit/money.py", line=14, severity="minor", title="x", repro="t1", fix="y")
    assert exc.why.startswith("finding add needs --step N, the head step that shows it; shopkit/money.py:14 ran in head (steps #")
    # export_csv's body is not in the fake plan's unreached list, but head's coverage marks it not run and the PR added it: allowed too
    answer = run("finding", dir=str(r.dir), file="shopkit/report.py", line=46, severity="minor", title="export_csv never ran", repro="t1", fix="a test")
    assert answer["finding"]["unreached"] is True and answer["finding"]["id"] == "f2"
    md = run("report", dir=str(r.dir))["markdown"]
    assert "- where: shopkit/discounts.py:8, never ran in head; reproduced by t1" in md and "- values at the step: none; the line never ran in head" in md
    assert "at report time: try t1 run again gives the same" in md


def test_every_action_once_end_to_end(started, tmp_path, fakes):
    """One review the way a person runs it: every action's code path through the `run` the CLI and the tool share."""
    r = fresh(started, tmp_path, copy_repo=True)
    stops = Review.load(str(r.dir)).stops
    assert run("state", dir=str(r.dir))["next"] == "review stop 1 --say TEXT"
    a = run("stop", dir=str(r.dir), n=1, say="step %d" % stops[0]["step_b"], surface="chat")
    assert a["next"] == "wait for the person; when they say next, review stop 2 --say TEXT --go-on"
    a = run("look", dir=str(r.dir), expr="lines")
    assert a["next"] == "wait for the person" and a.get("value") is None and a["locals"][0][0] == "lines"
    assert run("try", dir=str(r.dir), expr="2 * 21")["try"]["result"] == "42"
    code = tmp_path / "t.py"
    code.write_text("result = 'from a file'\n")
    assert run("try", dir=str(r.dir), code=str(code))["try"]["result"] == "'from a file'"
    a = run("try", dir=str(r.dir), code="result = 'inline'", code_is_text=True)  # the MCP tool's code field
    assert a["try"]["result"] == "'inline'" and a["try"]["id"] == "t3"
    assert run("ask", dir=str(r.dir), line="shopkit/discounts.py:16", say="rate = 0.0 to start", surface="chat")["next"] == "wait for the person"
    assert run("skip", dir=str(r.dir), n=2, why="they want the report now")["remaining"] == []
    step = SavedRun(str(r.dir / "head.json")).var("t")["changes"][0]["step"]
    a = run("finding", dir=str(r.dir), file="shopkit/money.py", line=14, severity="blocker", title="the comma", step=step, repro="t1", expect="revenue=2955.57", fix="strip it")
    assert a["finding"]["id"] == "f1" and a["next"] == "review fix --patch FILE.diff"
    patch = tmp_path / "fix.diff"
    patch.write_text(comma_patch(Path(r.repo)))
    a = run("fix", dir=str(r.dir), patch=str(patch))
    assert any(l.startswith("PASS revenue = 2955.57") for l in a["lines"]) and a["next"] == "review report"
    a = run("report", dir=str(r.dir))
    assert a["header"].split(" · ")[1] == "reported" and "- skipped stop 2: they want the report now" in a["markdown"] and "Not looked at" not in a["markdown"]
    a = run("state", dir=str(r.dir))
    assert a["phase"] == "reported" and [e["kind"] for e in a["conversation"]] == ["stop", "look", "try", "try", "try", "ask", "skip"]
    a = run("stop", dir=str(r.dir), n=2, say="unit_price = '1,249.00'", surface="chat", go_on=True)  # the agenda stays open after a report
    assert "stops 2/2 shown" in a["header"] and Review.load(str(r.dir)).skipped == []
