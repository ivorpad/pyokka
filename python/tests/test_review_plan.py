"""`review start`'s plan over the shop fixture: the sweep's anomalies as numbered stops with their values, the unreached lines, the edges.

The two trees under ``tests/fixtures/review`` are the ablation's shop case (base 63650f1, head
8472fb7): the PR drops a ``.replace(",", "")`` in ``parse_money``, so Ben's ``"1,249.00"`` stays
text, ``subtotal`` catches the TypeError and returns 0.0, and the spend tier starts above its
threshold instead of at it. Both are recorded here the way ``start`` records them, and the diff,
exception and coverage reports are built by their module functions, never by a subprocess.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import pytest

from pyokka_runtime.agent.coverage import coverage_report
from pyokka_runtime.agent.diff import Side, diff_sides
from pyokka_runtime.agent.exceptions import exceptions
from pyokka_runtime.agent.review.edges import changed_lines
from pyokka_runtime.agent.review.plan import ask_stop, build_plan, describe, render_plan, stop_line, values_at
from pyokka_runtime.agent.review.sweep import STOP_KINDS, words_of
from pyokka_runtime.agent.save import save_run
from pyokka_runtime.agent.source import AgentError, SavedRun

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "review"
HEAD_TREE = FIXTURES / "shop_head"
BASE_TREE = FIXTURES / "shop_base"


@dataclass
class Shop:
    base: str
    head: str
    diff: dict
    exceptions_a: dict
    exceptions_b: dict
    coverage_b: dict
    diff_text: str
    pr_text: str
    repo: str

    @property
    def changed(self) -> dict[str, set[int]]:
        return changed_lines(self.diff_text)

    @property
    def pr_words(self) -> set[str]:
        return words_of(self.pr_text)

    def plan(self) -> dict:
        return build_plan(self.base, self.head, self.diff, self.exceptions_a, self.exceptions_b, self.coverage_b, self.diff_text, self.pr_text, self.repo)


def record_shop(into: Path) -> Shop:
    """Record both trees into ``into`` (as ``pyokka run main.py --cwd TREE --save`` would) and build the reports ``start`` compares."""
    saved = {k: os.environ.get(k) for k in ("PYOKKA_HOME", "PYOKKA_CACHE_DIR")}
    os.environ["PYOKKA_HOME"] = str(into / "pyokka-home")
    os.environ["PYOKKA_CACHE_DIR"] = str(into / "pyokka-cache")
    try:
        base, head = str(into / "base.json"), str(into / "head.json")
        save_run(str(BASE_TREE / "main.py"), base, cwd=str(BASE_TREE))
        save_run(str(HEAD_TREE / "main.py"), head, cwd=str(HEAD_TREE))
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    # the two trees live at different paths, so `DATA = Path(__file__).parent / "data"` differs by construction: left out as `diff --ignore` would
    diff = diff_sides(Side("a", base, SavedRun(base)), Side("b", head, SavedRun(head)), limit=100_000, ignore=["DATA"])
    return Shop(base, head, diff, exceptions(SavedRun(base)), exceptions(SavedRun(head)), coverage_report(SavedRun(head)), (FIXTURES / "shop.diff").read_text(encoding="utf-8"), (HEAD_TREE / "pr.md").read_text(encoding="utf-8"), str(HEAD_TREE))


@pytest.fixture(scope="module")
def shop(tmp_path_factory: pytest.TempPathFactory) -> Shop:
    return record_shop(tmp_path_factory.mktemp("review-shop"))


def test_the_recordings_and_reports_are_what_start_compares(shop: Shop):
    assert shop.diff["matching"] == {"same": 119, "edited": 7, "added": 31, "removed": 4}
    assert (shop.diff["a"]["exitCode"], shop.diff["b"]["exitCode"]) == (0, 0)
    assert shop.exceptions_a["total"] == 0 and shop.exceptions_b["total"] == 1
    assert [f["file"] for f in shop.coverage_b["files"] if f["notRun"]] == ["shopkit/discounts.py", "shopkit/money.py", "shopkit/report.py"]


def test_the_summary_counts_what_changed_in_behaviour(shop: Shop):
    s = shop.plan()["summary"]
    assert {k: s[k] for k in ("statements", "same", "edited", "added", "removed", "differing")} == {"statements": 161, "same": 119, "edited": 7, "added": 31, "removed": 4, "differing": 34}
    assert (s["exit_a"], s["exit_b"]) == (0, 0)
    assert (s["steps_a"], s["steps_b"]) == (360, 435)
    assert (s["raises"], s["types"], s["signs"], s["prints"], s["unreached"], s["values"], s["branches"]) == (1, 2, 0, 1, 2, 7, 3)
    assert s["sweep"].startswith("sweep: 161 statements compared (119 same, 7 edited, 31 added, 4 removed), 34 differ; 16 anomalies:")
    assert s["text"] == describe(s)  # the paragraph `start` prints
    assert "161 statements compared" in s["text"] and "1 new raise" in s["text"] and "2 type changes" in s["text"] and "exit code 0 on both" in s["text"]


def test_stops_are_anomalies_with_a_head_step_one_per_statement_in_rank_order(shop: Shop):
    stops = shop.plan()["stops"]
    assert [st["n"] for st in stops] == list(range(1, len(stops) + 1))
    assert all(st["kind"] in STOP_KINDS and st["step_b"] is not None for st in stops)
    first, second = stops[0], stops[1]
    assert (first["kind"], first["file"], first["line"], first["function"], first["step_a"], first["step_b"]) == ("raise", "shopkit/pricing.py", 12, "subtotal", None, 197)
    assert first["fact"]["text"].startswith("TypeError: unsupported operand type(s) for +: 'int' and 'str' (caught at pricing.py:13, 1×)")
    assert (first["fact"]["kind"], first["fact"]["name"], first["fact"]["a"]) == ("raise", "TypeError", None) and first["fact"]["b"].startswith("TypeError: unsupported")
    assert (second["kind"], second["file"], second["line"], second["function"], second["step_a"], second["step_b"]) == ("type", "shopkit/orders.py", 30, "parse_orders", 116, 120)
    assert second["fact"] == {"kind": "type", "name": "unit_price", "text": "unit_price: float → str (1249.0 → '1,249.00')", "a": "1249.0", "b": "'1,249.00'"}
    assert second["name"] == "unit_price"
    # the `parse_money` return fact on the same statement folds into this stop: one stop per statement
    assert [(st["file"], st["line"]) for st in stops].count(("shopkit/orders.py", 30)) == 1
    assert [(st["kind"], st["file"], st["line"]) for st in stops[2:]] == [("print", "main.py", 17), ("value", "main.py", 5), ("value", "main.py", 16), ("value", "shopkit/invoices.py", 22), ("value", "shopkit/invoices.py", 21), ("value", "shopkit/invoices.py", 23)]
    discount = stops[5]
    assert (discount["fact"]["text"], discount["step_a"], discount["step_b"]) == ("discount: 127.15 → 0.0", 187, 201)  # the first (ranked) hit of two on that line


def test_a_stop_carries_the_values_context_prints_at_its_head_step(shop: Shop):
    plan = shop.plan()
    second = plan["stops"][1]
    run = SavedRun(shop.head)
    printed = [v["text"] for v in run.context(step=120, scope=True)["values"]]
    assert second["values"] == printed and printed
    assert "'1,249.00'" in second["values"]  # `charged`, the local the statement reads
    assert [v["name"] for v in second["locals"]] == ["row", "orders", "order", "charged"]
    assert all(v["step"] <= 120 for v in second["locals"])
    assert values_at(run, 120) == {"values": second["values"], "locals": second["locals"]}
    raise_stop = plan["stops"][0]
    assert any("unit_price='1,249.00'" in v for v in raise_stop["values"])  # Ben's lines at the raising statement


def test_unreached_lines_and_edge_candidates_sit_beside_the_stops(shop: Shop):
    plan = shop.plan()
    assert [(u["file"], u["span"], u["lines"], u["start"], u["end"]) for u in plan["unreached"]] == [("shopkit/discounts.py", [8, 8], [8], 8, 8), ("shopkit/report.py", [44, 48], [44, 45, 46, 47, 48], 44, 48)]
    assert plan["unreached"][0]["text"] == "shopkit/discounts.py:8 changed line never ran  → pyokka coverage %s --file discounts.py" % shop.head
    edges = plan["edges"]
    assert [e["id"] for e in edges] == ["E%d" % i for i in range(1, len(edges) + 1)]
    assert (edges[0]["kind"], edges[0]["file"], edges[0]["line"], edges[0]["function"]) == ("boundary", "shopkit/discounts.py", 16, "spend_tier_rate")
    assert edges[0]["what"].startswith("`spend > threshold`: call spend_tier_rate with spend equal to threshold")
    assert (edges[1]["kind"], edges[1]["line"]) == ("attribute", 8) and "`settings.platinum_rate`" in edges[1]["what"]
    assert plan["anomalies"][0].startswith("shopkit/pricing.py:12 subtotal TypeError:") and len(plan["anomalies"]) == 16
    assert not any("(value not recorded)" in a for a in plan["anomalies"])


def test_ask_names_an_unplanned_line_by_its_first_head_step(shop: Shop):
    asked = ask_stop(shop.head, "discounts.py", 16)
    assert (asked["kind"], asked["file"], asked["line"], asked["function"], asked["step_a"]) == ("ask", "shopkit/discounts.py", 16, "spend_tier_rate", None)
    assert isinstance(asked["step_b"], int) and asked["values"] and asked["locals"]
    assert any(v["name"] == "threshold" for v in asked["locals"])
    assert asked["exact"] and "note" not in asked
    inside = ask_stop(shop.head, "report.py", 33)  # a continuation line of the statement that starts at 32: the stop is that statement
    assert (inside["line"], inside["function"], inside["asked_line"], inside["exact"]) == (32, "render", 33, False)
    assert inside["note"] == "line 33 never ran as a statement of its own; the stop is the statement around it at line 32 (step %d)" % inside["step_b"]
    with pytest.raises(AgentError, match="no step on shopkit/discounts.py:8") as refused:
        ask_stop(shop.head, "discounts.py", 8)  # the platinum branch never ran, and an `if` header's range is its own line only
    assert refused.value.hint.startswith("neither the line nor a statement around it ran; `pyokka coverage")
    with pytest.raises(AgentError, match="no step on shopkit/report.py:45"):
        ask_stop(shop.head, "report.py", 45)  # export_csv never ran; the module's whole-file statement does not count as "around it"


def test_the_plan_renders_as_the_start_output_lists_it(shop: Shop):
    plan = shop.plan()
    lines = render_plan(plan)
    assert lines[0].startswith("161 statements compared (119 same, 7 edited, 31 added, 4 removed); 34 did something different in head; 360 → 435 steps; anomalies: 1 new raise")
    assert "stops (8):" in lines
    assert stop_line(plan["stops"][0]) == "1. [raise] shopkit/pricing.py:12  subtotal  TypeError: unsupported operand type(s) for +: 'int' and 'str' (caught at pricing.py:13, 1×)  b#197"
    assert stop_line(plan["stops"][1]).endswith("a#116  b#120")
    assert "  shopkit/discounts.py:8" in lines and "  shopkit/report.py:44-48" in lines
    assert any(l.startswith("  E1 [boundary] shopkit/discounts.py:16 spend_tier_rate") for l in lines)
