"""The review's sweep: ranked anomalies over the diff, exception and coverage reports, with the prototype's rules and noise filters."""

from __future__ import annotations

from pyokka_runtime.agent.review.sweep import Anomaly, coarse, number_of, render_sweep, sweep, sweep_rows, words_of
from tests.test_review_plan import Shop, shop  # noqa: F401  (the module-scoped recordings)

HEAD = "runs/head.json"


def test_shop_sweep_lists_the_raise_the_type_change_and_the_unreached_lines(shop: Shop):
    rows = sweep(shop.diff, shop.exceptions_a, shop.exceptions_b, shop.coverage_b, shop.changed, shop.pr_words, HEAD)
    assert all(isinstance(r, Anomaly) and len(r) == 9 for r in rows)
    assert [r.rank for r in rows] == sorted(r.rank for r in rows)
    raises = [r for r in rows if r.kind == "raise"]
    assert len(raises) == 1  # seen by `exceptions` and as a diff fact: listed once
    rank, kind, text, step_b, file, line, function, fact_a, fact_b = raises[0]
    assert (rank, file, line, function, step_b, fact_a) == (0, "shopkit/pricing.py", 12, "subtotal", 197, None)
    assert fact_b.startswith("TypeError: unsupported operand")
    assert text == "shopkit/pricing.py:12 subtotal TypeError: unsupported operand type(s) for +: 'int' and 'str' (caught at pricing.py:13, 1×)  step 197  → pyokka context runs/head.json 197 ; pyokka origin runs/head.json 197"
    types = [r for r in rows if r.kind == "type"]
    assert [(r.file, r.line, r.step_b, r.fact_a, r.fact_b) for r in types] == [("shopkit/orders.py", 30, 120, "1249.0", "'1,249.00'"), ("shopkit/orders.py", 30, 124, "1249.0", "'1,249.00'")]
    assert types[0].text == "shopkit/orders.py:30 parse_orders unit_price: float → str (1249.0 → '1,249.00')  a#116 b#120  UNCLAIMED  → pyokka context runs/head.json 120"
    unreached = [r for r in rows if r.kind == "unreached"]
    assert [(r.file, r.line, r.step_b, r.text) for r in unreached] == [
        ("shopkit/discounts.py", 8, None, "shopkit/discounts.py:8 changed line never ran  → pyokka coverage runs/head.json --file discounts.py"),
        ("shopkit/report.py", 44, None, "shopkit/report.py:44-48 changed lines never ran  → pyokka coverage runs/head.json --file report.py"),
    ]
    assert not any("test_" in r.file for r in rows)
    assert not any("(value not recorded)" in r.text for r in rows)
    assert [r.kind for r in rows] == ["raise", "type", "type", "print", "unreached", "unreached", "branch", "loop", "branch"] + ["value"] * 7


def test_the_listing_has_the_prototype_shape(shop: Shop):
    rows = sweep_rows(shop.diff, shop.exceptions_a, shop.exceptions_b, shop.coverage_b, shop.changed, shop.pr_words, HEAD)
    lines = render_sweep(rows, shop.diff, shop.changed)
    assert lines[0] == "sweep: 161 statements compared (119 same, 7 edited, 31 added, 4 removed), 34 differ; 16 anomalies: branch 2, loop 1, print 1, raise 1, type 2, unreached 2, value 7"
    assert lines[1] == "changed lines in the PR: config.py (3), discounts.py (18), invoices.py (2), money.py (12), pricing.py (5), report.py (12), test_discounts.py (20), test_money.py (9), test_report.py (9)"
    assert lines[2].startswith(" 1. [raise] shopkit/pricing.py:12 subtotal TypeError")
    assert lines[8] == " 7. [branch] shopkit/discounts.py:6 loyalty_rate False (only in head), 5 hits  b#173  → pyokka context runs/head.json 173"


# -- the rules, on hand-made reports -------------------------------------------------------------------------

def _diff(statements: list[dict]) -> dict:
    return {"a": {"count": 10, "exitCode": 0}, "b": {"count": 12, "exitCode": 0}, "matching": {"same": 1, "edited": 1, "added": 0, "removed": 0}, "total": len(statements), "statements": statements}


def _stmt(file: str, line: int, fn: str, facts: list[dict], **over) -> dict:
    return {"file": file, "fileA": file, "fileB": file, "lineA": line, "lineB": line, "function": fn, "status": "same", "facts": facts, **over}


def _fact(kind: str, name: str | None, a: tuple | None, b: tuple | None) -> dict:
    return {"kind": kind, "name": name, "a": {"text": a[0], "step": a[1]} if a else None, "b": {"text": b[0], "step": b[1]} if b else None}


EMPTY = {"rows": []}
NO_COVERAGE = {"files": []}


def run_sweep(statements: list[dict], *, pr: str = "", exc_a: dict = EMPTY, exc_b: dict = EMPTY, cov: dict = NO_COVERAGE, changed: dict | None = None) -> list[Anomaly]:
    return sweep(_diff(statements), exc_a, exc_b, cov, changed or {}, words_of(pr), HEAD)


def test_type_drift_across_edited_statements_is_found_by_name():
    # the base assigned `entry_id = int(...)` (removed), head assigns `entry_id = key` (added): no fact pairs, so the names are compared
    removed = _stmt("ledger/journal.py", 54, "parse_journal", [_fact("value", "entry_id", ("101", 240), None), _fact("value", "entry_id", ("102", 260), None)], status="removed", lineB=None)
    added = _stmt("ledger/journal.py", 62, "parse_journal", [_fact("value", "entry_id", None, ("'101'", 371)), _fact("value", "entry_id", None, ("'102'", 390))], status="added", lineA=None)
    rows = run_sweep([removed, added], pr="parse_journal groups the rows")
    assert len(rows) == 1
    r = rows[0]
    assert (r.rank, r.kind, r.file, r.line, r.function, r.step_b, r.fact_a, r.fact_b) == (1, "type", "ledger/journal.py", 62, "parse_journal", 371, "101", "'101'")
    assert r.text == "ledger/journal.py:62 parse_journal entry_id: int → str (101 → '101') across the edited statements (2 values each side)  claimed  → pyokka context runs/head.json 371"
    # the same drift between int and float is numeric: ranked last
    numeric = run_sweep([_stmt("m.py", 1, "f", [_fact("value", "n", ("1", 1), None)], status="removed"), _stmt("m.py", 2, "f", [_fact("value", "n", None, ("1.5", 3))], status="added")])
    assert [(r.rank, r.kind) for r in numeric] == [(6, "type")]
    # one side only, or the same type on both sides, is not drift
    assert run_sweep([_stmt("m.py", 2, "f", [_fact("value", "n", None, ("'x'", 3))], status="added")]) == []
    assert run_sweep([_stmt("m.py", 1, "f", [_fact("value", "n", ("'a'", 1), None)], status="removed"), _stmt("m.py", 2, "f", [_fact("value", "n", None, ("'b'", 3))], status="added")]) == []


def test_sign_flips_are_grouped_per_statement_with_a_hit_count():
    facts = [_fact("value", "balance", ("Decimal('-7160.00')", 2531), ("Decimal('7160.00')", 2428)), _fact("value", "balance", ("-5", 2600), ("5", 2500)), _fact("value", "balance", ("-7.5", 2700), ("7.5", 2600)), _fact("value", "balance", ("3", 2800), ("3", 2700))]
    rows = run_sweep([_stmt("ledger/balances.py", 33, "account_balances", facts)], pr="account_balances keeps the side")
    assert len(rows) == 1
    r = rows[0]
    assert (r.rank, r.kind, r.step_b, r.fact_a, r.fact_b) == (2, "sign", 2428, "Decimal('-7160.00')", "Decimal('7160.00')")
    assert r.text == "ledger/balances.py:33 account_balances balance: Decimal('-7160.00') → Decimal('7160.00') (same magnitude, opposite sign; 3 hits)  a#2531 b#2428  claimed  → pyokka context runs/head.json 2428"
    # a zero never flips, and a different magnitude is a value change (reported only in an unnamed function)
    assert run_sweep([_stmt("m.py", 1, "f", [_fact("value", "x", ("0", 1), ("0", 2))])], pr="") == []
    other = run_sweep([_stmt("m.py", 1, "f", [_fact("value", "x", ("-5", 1), ("6", 2))])], pr="")
    assert [(r.kind, r.rank) for r in other] == [("value", 5)]


def test_none_print_and_raise_rules():
    rows = run_sweep([
        _stmt("m.py", 3, "f", [_fact("value", "total", ("12", 4), ("None", 5))]),
        _stmt("m.py", 4, "f", [_fact("value", "ratio", None, ("nan", 6))], status="added"),
        _stmt("m.py", 5, "f", [_fact("print", None, ("a", 7), ("b", 8))]),
        _stmt("m.py", 6, "f", [_fact("error", None, None, ("ValueError: bad", 9))]),
    ], pr="f is named here")
    # a None replacing a value is a type change first (the prototype's rule order); `none` is for a None or nan that only head has
    assert [(r.rank, r.kind, r.step_b, r.fact_b) for r in rows] == [(0, "raise", 9, "ValueError: bad"), (1, "type", 5, "None"), (2, "none", 6, "nan"), (3, "print", 8, "b")]
    assert rows[0].text == "m.py:6 f ValueError: bad  b#9  → pyokka context runs/head.json 9"
    assert rows[1].text == "m.py:3 f total: int → None (12 → None)  a#4 b#5  claimed  → pyokka context runs/head.json 5"
    assert rows[2].text == "m.py:4 f ratio = nan (only in head)  b#6  claimed  → pyokka context runs/head.json 6"


def test_a_raise_the_exceptions_report_lists_is_not_repeated_from_the_diff():
    exc_b = {"rows": [{"kind": "caught", "errorType": "ValueError", "message": "bad", "count": 2, "step": 9, "raisedAt": {"file": "/repo/pkg/m.py", "line": 6, "function": "f"}, "handledAt": {"file": "/repo/pkg/m.py", "line": 8, "function": "f"}}]}
    cov = {"files": [{"file": "pkg/m.py", "path": "/repo/pkg/m.py", "notRun": [], "partial": []}]}
    rows = run_sweep([_stmt("pkg/m.py", 6, "f", [_fact("error", None, None, ("ValueError: bad", 9))])], exc_b=exc_b, cov=cov)
    assert len(rows) == 1
    assert rows[0].text == "pkg/m.py:6 f ValueError: bad (caught at m.py:8, 2×)  step 9  → pyokka context runs/head.json 9 ; pyokka origin runs/head.json 9"
    # a raise base also had is no anomaly
    assert run_sweep([], exc_a=exc_b, exc_b=exc_b, cov=cov) == []


def test_branches_loops_and_values_count_only_in_functions_the_pr_does_not_name():
    stmts = [
        _stmt("m.py", 2, "quiet", [_fact("branch", None, None, ("False", 10)), _fact("branch", None, None, ("False", 20)), _fact("loop", None, ("2 times", 3), ("3 times", 11))]),
        _stmt("m.py", 9, "quiet", [_fact("value", "x", ("1", 5), ("2", 12))]),
    ]
    unnamed = run_sweep(stmts, pr="the PR talks about other things")
    assert [(r.rank, r.kind, r.step_b, r.text.split("  →")[0]) for r in unnamed] == [
        (4, "branch", 10, "m.py:2 quiet False (only in head), 2 hits  b#10"),
        (4, "loop", 11, "m.py:2 quiet 2 times → 3 times, 1 hit  a#3 b#11"),
        (5, "value", 12, "m.py:9 quiet x: 1 → 2  a#5 b#12"),
    ]
    named = run_sweep(stmts, pr="quiet() now loops once more")
    assert [(r.kind, r.text.split("  →")[0]) for r in named] == [("loop", "m.py:2 quiet 2 times → 3 times, 1 hit  a#3 b#11")]  # a changed decision is listed even in a named function; only-in-head and value changes are not


def test_unrecorded_values_are_skipped():
    rows = run_sweep([_stmt("m.py", 1, "f", [_fact("value", "re", None, ("(value not recorded)", 9)), _fact("value", "k", ("(value not recorded)", 1), ("'x'", 2)), _fact("value", "k", ("'y'", 3), ("(value not recorded)", 4))])])
    assert rows == []


def test_unreached_spans_collapse_skip_tests_and_partial_lines_follow():
    cov = {"files": [
        {"file": "pkg/m.py", "path": "/repo/pkg/m.py", "notRun": [3, 4, 5, 9, 30], "partial": [12]},
        {"file": "tests/test_m.py", "path": "/repo/tests/test_m.py", "notRun": [2], "partial": []},
        {"file": "pkg/other.py", "path": "/repo/pkg/other.py", "notRun": [7], "partial": []},
    ]}
    changed = {"pkg/m.py": {3, 4, 5, 9, 12, 13}, "tests/test_m.py": {2}}
    rows = run_sweep([], cov=cov, changed=changed)
    assert [(r.rank, r.kind, r.file, r.line, r.text) for r in rows] == [
        (3, "unreached", "pkg/m.py", 3, "pkg/m.py:3-5 changed lines never ran  → pyokka coverage runs/head.json --file m.py"),
        (3, "unreached", "pkg/m.py", 9, "pkg/m.py:9 changed line never ran  → pyokka coverage runs/head.json --file m.py"),
        (4, "partial", "pkg/m.py", 12, "pkg/m.py:12 changed line ran in part (a branch arm never taken)  → pyokka coverage runs/head.json --file m.py"),
    ]


def test_coarse_types_and_numbers():
    assert [coarse(t) for t in ("None", "True", "nan", "-inf", "42", "-1.5e3", "'a'", '"b"', "[1]", "(1,)", "{}", "<function f at 0x1>", "<bound method A.f of <A>>", "<A object at 0x1>", "Decimal('1.00')", "Order(customer='Ben')", "...")] == [
        "None", "bool", "nan", "nan", "int", "float", "str", "str", "list", "tuple", "dict/set", "function", "function", "object", "Decimal", "Order", "other",
    ]
    assert coarse(None) is None and coarse("(value not recorded)") is None
    assert number_of("Decimal('-7160.00')") == -7160.0 and number_of("Fraction('3')") == 3.0 and number_of(" 12 ") == 12.0 and number_of("-0.5") == -0.5
    assert number_of("'12'") is None and number_of("Decimal('a')") is None and number_of(None) is None
    assert words_of("parse_money accepts the export's quoted prices; by_kind moved") == {"parse_money", "accepts", "the", "export", "s", "quoted", "prices", "by_kind", "moved"}
