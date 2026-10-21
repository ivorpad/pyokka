"""The summary above a why tree (``why_summary.py``): its three states on the orders program, the validator, the literals.

The orders program (`test/unit/fixtures/shared/`): ana and bo both hold catalog's one TEMPLATE dict, ana's bonus
raises its qty, and charge(bo) bills 2.0. Recorded following objects the summary names the line that changed it
(answer); recorded the default way it says that bo's last value differs from what charge received (signpost);
a value with nothing to compare gets the fallback. The TypeScript twin (`src/shared/whySummary.ts`) gives the
same summaries over the same fixtures (`test/unit/provenance.test.ts`).
"""

from __future__ import annotations

import json
from pathlib import Path

from pyokka_runtime.agent.provenance import provenance
from pyokka_runtime.agent.source import SavedRun
from pyokka_runtime.agent.why_summary import literal_diff, literal_part, parse_literal, sentence_text, summary_lines, validate

from test_provenance import FIXTURES, SHARED_FILES, SHARED_PROGRAM, step_of
from test_walkthrough import saved_run


def orders(tmp_path: Path, exact: bool) -> SavedRun:
    files = {rel: (SHARED_PROGRAM / rel).read_text(encoding="utf-8") for rel in SHARED_FILES[1:]}
    return SavedRun(str(saved_run(tmp_path, (SHARED_PROGRAM / "main.py").read_text(encoding="utf-8"), files=files, config={"exact": True} if exact else None)))


def why(run: SavedRun, file: str, line: int, occurrence: str, name: str) -> dict:
    return provenance(run, step_of(run, file, line, occurrence), name)


def test_following_objects_it_names_the_line_that_changed_the_shared_object(tmp_path):
    tree = why(orders(tmp_path, True), "billing.py", 8, "last", "amount")
    s = tree["summary"]
    assert tree["followObjects"] is True and s["state"] == "answer" and "action" not in s
    assert sentence_text(s["headline"]) == "bo['lines'][0], the same object as line, was changed at #23 promo.py:4 in bulk_bonus: line[\"qty\"] += 1."
    assert [sentence_text(d) for d in s["details"]] == [
        "It is an input of amount, which is 2.0 at #38 billing.py:8.",
        "They share it since #17 catalog.py:5.",
        "order at #34 billing.py:5 is the bo passed at #33 main.py:12.",
    ]
    assert validate(s, tree) == []


def test_a_change_through_the_names_own_path_is_an_answer_too(tmp_path):
    s = why(orders(tmp_path, True), "main.py", 13, "first", "ledger.totals")["summary"]
    assert s["state"] == "answer" and sentence_text(s["headline"]).startswith("ledger.totals was changed at #39 billing.py:9 in charge: ")


def test_without_following_objects_it_signposts_the_value_that_differs(tmp_path):
    tree = why(orders(tmp_path, False), "billing.py", 8, "last", "amount")
    s = tree["summary"]
    assert "followObjects" not in tree and s["state"] == "signpost" and s["action"] == "followObjects"
    assert sentence_text(s["headline"]) == "bo['lines'][0]['qty'] was 1 at #15 main.py:9, and charge received 2 as order['lines'][0]['qty'] at #34 billing.py:5."
    assert sentence_text(s["details"][0]) == "This recording has no change of bo between #15 main.py:9 and the call at #33 main.py:12."
    assert summary_lines(s)[-1] == "  next: record again following objects (--follow-objects)"
    assert validate(s, tree) == []


def test_an_object_with_nothing_to_compare_gets_the_fallback(tmp_path):
    tree = why(orders(tmp_path, False), "main.py", 13, "first", "ledger.totals")
    s = tree["summary"]
    assert s["state"] == "fallback" and s["action"] == "followObjects"
    assert sentence_text(s["headline"]).startswith("ledger is <billing.Ledger object at 0x")
    assert any("shows nothing inside it" in sentence_text(d) for d in s["details"])
    assert validate(s, tree) == []


def test_every_fixture_summary_passes_the_validator():
    for name in ("provenance.json", "shared.json", "shared-default.json"):
        for case in json.loads((FIXTURES / name).read_text(encoding="utf-8"))["cases"]:
            tree = case["result"]
            assert validate(tree.get("summary"), tree) == [], (name, case["name"], case["step"])


def test_the_validator_refuses_what_the_tree_does_not_hold(tmp_path):
    tree = why(orders(tmp_path, False), "billing.py", 8, "last", "amount")
    head = tree["summary"]["headline"]
    value = next(p for p in head if "value" in p)
    place = next(p for p in head if "step" in p)
    assert validate({"headline": [dict(value, value="3")], "details": []}, tree)  # not the recorded part
    assert validate({"headline": [dict(value, path="['lines'][1]['qty']")], "details": []}, tree)  # no such part
    assert validate({"headline": [dict(place, line=place["line"] + 1)], "details": []}, tree)  # not where the step ran
    assert validate({"headline": [{"code": "bo = 3"}], "details": []}, tree)
    assert validate({"headline": [{"name": "nobody"}], "details": []}, tree)


def test_literals_are_compared_only_when_both_are_builtin_and_whole():
    a = "{'customer': 'bo', 'lines': [{'price': 1.0, 'qty': 1, 'sku': 'apple'}]}"
    assert literal_diff(a, a.replace("'qty': 1", "'qty': 2")) == ("['lines'][0]['qty']", "1", "2")
    assert literal_part(a, "['lines'][0]['qty']") == "1" and literal_part(a, "['lines'][1]") is None
    assert literal_diff("[1]", "[1, 2]") == ("", "[1]", "[1, 2]") and literal_diff("1", "1") is None
    for text in ("<ArgumentParser object>", "ArgumentParser(prog='demo')", "{'a': 1…(+3 chars)", "set()", "{'a': 1,"):
        assert parse_literal(text) is None, text
    for text in ("{}", "()", "(1,)", "{1, 2}", "[None, True, -1.5e3, 'it\\'s', \"q\"]"):
        assert parse_literal(text) is not None, text
