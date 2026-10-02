"""`pyokka diff`: two runs of a file before and after an edit, compared statement by statement.

The edit below changes a value (`total = qty * unit` gets `+ 50`), which flips a branch
(`if total > LIMIT` takes True for the first order), adds a function and a call to it, and that
call raises a new exception. The added function shifts every later line by 5, so the module's
statements pair by text, not by line number. The file is recorded, rewritten and recorded again
in place, the way an edit happens, so the first run has to be read from the copy it keeps.
"""

from __future__ import annotations

import io
import json
import sys
import textwrap
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from pyokka_runtime.__main__ import main
from pyokka_runtime.agent.diff import edited_lines
from pyokka_runtime.agent.diff_match import compare_hits, pair_statements, parse_statements
from pyokka_runtime.agent.source import SavedRun
from pyokka_runtime.redact import REDACTED
from tests.test_agent_live import FakeBridge, write_descriptor

BEFORE = """
LIMIT = 100


def price(qty, unit):
    total = qty * unit
    if total > LIMIT:
        total = total * 0.9
    return total


def check(order):
    return order["qty"] > 0


orders = [{"qty": 3, "unit": 20}, {"qty": 1, "unit": 50}]
totals = []
for o in orders:
    if check(o):
        totals.append(price(o["qty"], o["unit"]))
print(sum(totals))
"""

AFTER = """
LIMIT = 100


def price(qty, unit):
    total = qty * unit + 50
    if total > LIMIT:
        total = total * 0.9
    return total


def check(order):
    return order["qty"] > 0


def audit(totals):
    if len(totals) > 1:
        raise RuntimeError("audit failed: %d orders" % len(totals))


orders = [{"qty": 3, "unit": 20}, {"qty": 1, "unit": 50}]
totals = []
for o in orders:
    if check(o):
        totals.append(price(o["qty"], o["unit"]))
print(sum(totals))
audit(totals)
"""


def pyokka(*args: str) -> tuple[int, str]:
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = main([str(a) for a in args])
    return code, buf.getvalue()


def record(prog: Path, text: str, out: Path) -> Path:
    prog.write_text(textwrap.dedent(text).lstrip(), encoding="utf-8")
    pyokka("run", str(prog), "--save", str(out))
    return out


@pytest.fixture
def runs(tmp_path: Path) -> tuple[Path, Path]:
    proj = tmp_path / "proj"
    proj.mkdir()
    prog = proj / "shop.py"
    before = record(prog, BEFORE, tmp_path / "before.json")
    after = record(prog, AFTER, tmp_path / "after.json")
    return before, after


def diff_json(*args: str) -> dict:
    code, out = pyokka("diff", *args, "--json")
    assert code == 0, out
    return json.loads(out)


def by_text(doc: dict, text: str) -> dict:
    return next(e for e in doc["statements"] if (e["textB"] or e["textA"]).startswith(text))


def test_a_run_keeps_the_source_that_ran(runs):
    before, _ = runs
    files = json.loads(before.read_text(encoding="utf-8"))["meta"]["files"]
    assert "total = qty * unit\n" in files[0]["source"]  # the file on disk now says `+ 50`


def test_diff_reports_the_value_the_branch_the_call_and_the_exception(runs):
    before, after = runs
    doc = diff_json(str(before), str(after))
    assert doc["matching"] == {"same": 13, "edited": 1, "added": 4, "removed": 0}
    assert (doc["a"]["exitCode"], doc["b"]["exitCode"]) == (0, 1)

    edited = by_text(doc, "total = qty * unit + 50")
    assert (edited["status"], edited["textA"], edited["lineA"], edited["lineB"]) == ("edited", "total = qty * unit", 5, 5)
    assert [(f["name"], f["a"]["text"], f["b"]["text"]) for f in edited["facts"]] == [("total", "60", "110"), ("total", "50", "100")]
    assert doc["firstDifference"] == {"file": "shop.py", "lineA": 5, "lineB": 5, "stepA": edited["facts"][0]["a"]["step"], "stepB": edited["facts"][0]["b"]["step"]}

    branch = by_text(doc, "if total > LIMIT")
    assert branch["status"] == "same"
    assert [(f["kind"], f["a"]["text"], f["b"]["text"]) for f in branch["facts"]] == [("branch", "False", "True")]

    discount = by_text(doc, "total = total * 0.9")
    assert [(f["name"], f["a"], f["b"]["text"]) for f in discount["facts"]] == [("total", None, "99.0")]

    printed = by_text(doc, "print(sum(totals))")
    assert (printed["lineA"], printed["lineB"]) == (20, 25)  # moved by the added function, paired by its text
    assert ("print", "110", "199.0") in [(f["kind"], f["a"]["text"], f["b"]["text"]) for f in printed["facts"] if f["a"] and f["b"]]

    call = by_text(doc, "audit(totals)")
    assert call["status"] == "added"
    [fact] = call["facts"]
    assert fact["kind"] == "call" and fact["a"] is None
    assert fact["b"]["text"] == "audit(totals=[99.0, 100]) raised RuntimeError: audit failed: 2 orders"

    raised = by_text(doc, "raise RuntimeError")
    assert raised["status"] == "added" and raised["function"] == "audit"
    assert raised["facts"][0]["kind"] == "error" and raised["facts"][0]["b"]["text"].startswith("RuntimeError: audit failed: 2 orders")

    # every step a fact names is a step of that side's run
    a_count, b_count = doc["a"]["count"], doc["b"]["count"]
    for e in doc["statements"]:
        for f in e["facts"]:
            assert f["a"] is None or 0 <= f["a"]["step"] < a_count
            assert f["b"] is None or 0 <= f["b"]["step"] < b_count


def test_diff_text_is_one_fact_per_line_with_both_steps(runs):
    before, after = runs
    code, out = pyokka("diff", str(before), str(after))
    assert code == 0
    lines = out.splitlines()
    assert lines[0].startswith("a  %s  shop.py  " % before) and lines[0].endswith("exit 0")
    assert lines[1].startswith("b  %s  shop.py  " % after) and lines[1].endswith("exit 1")
    assert lines[2] == "statements: 13 same, 1 edited, 4 added, 0 removed (matched by file, function and text)"
    assert "exit code 0 → 1" in lines
    assert "shop.py:5  price  edited" in lines
    assert "  - total = qty * unit" in lines and "  + total = qty * unit + 50" in lines
    assert any(l.startswith("  total = 60 → 110   a#") and " b#" in l for l in lines)
    assert any(l.startswith("shop.py:6  price  if total > LIMIT:") for l in lines)
    assert any(l.startswith("  took False → True   a#") for l in lines)
    assert any(l.startswith("shop.py:20→25  <module>  print(sum(totals))") for l in lines)
    assert any(l.startswith("shop.py:26  <module>  audit(totals)  added") for l in lines)
    assert any(l.startswith("  call audit(totals=[99.0, 100]) raised RuntimeError: audit failed: 2 orders   only in b   b#") for l in lines)
    assert any(l.startswith("shop.py:17  audit  raise RuntimeError(") and l.endswith("added") for l in lines)


def test_step_numbers_are_the_ones_step_takes(runs):
    before, after = runs
    doc = diff_json(str(before), str(after))
    fact = by_text(doc, "total = qty * unit + 50")["facts"][0]
    for run, side in ((before, "a"), (after, "b")):
        ctx = json.loads(pyokka("context", str(run), str(fact[side]["step"]), "--json")[1])
        assert ctx["location"]["line"] == 5 and ctx["location"]["function"] == "price"


def test_identical_runs_have_no_difference(tmp_path: Path):
    prog = tmp_path / "same.py"
    a = record(prog, BEFORE, tmp_path / "a.json")
    b = record(prog, BEFORE, tmp_path / "b.json")
    code, out = pyokka("diff", str(a), str(b))
    assert code == 0
    assert out.splitlines()[-1] == "no difference in values, branches, loops, calls, prints or raises"


def test_a_run_without_its_source_says_so(runs):
    before, after = runs
    doc = json.loads(before.read_text(encoding="utf-8"))
    for f in doc["meta"]["files"]:
        f.pop("source", None)  # what a run saved before 2D looks like
    before.write_text(json.dumps(doc), encoding="utf-8")
    code, out = pyokka("diff", str(before), str(after))
    assert code == 0
    assert "note: a: shop.py changed since this run and the run keeps no copy of it" in out


def test_diff_needs_two_runs(runs):
    before, _ = runs
    code, out = pyokka("diff", str(before), "--json")
    assert code == 2
    assert json.loads(out)["error"] == "diff needs two runs, got 1"


def test_pairing_survives_a_line_shift_and_pairs_an_edit_by_position():
    a = parse_statements("x = 1\ny = x + 1\nprint(y)\n")
    b = parse_statements("# new comment\n\nx = 1\ny = x + 2\nz = 3\nprint(y)\n")
    pairs = [(sa.line if sa else None, sb.line if sb else None, status) for sa, sb, status in pair_statements(a, b)[0]]
    assert pairs == [(1, 3, "same"), (2, 4, "edited"), (None, 5, "added"), (3, 6, "same")]


def test_a_memory_address_in_a_repr_is_not_a_difference():
    """Two runs put the same function at different addresses: `<function dataclass at 0x101d…>` against `0x1019…`."""
    a = [{"text": "<function dataclass at 0x101d10720>", "step": 0}]
    b = [{"text": "<function dataclass at 0x101908720>", "step": 0}]
    assert compare_hits(("value", "dataclass"), a, b) == []
    calls_a = [{"text": "ask(graph=<Graph object at 0x108a254f0>)", "step": 3, "returned": "<Answer object at 0x1>", "returnStep": 9}]
    calls_b = [{"text": "ask(graph=<Graph object at 0x10fe00000>)", "step": 3, "returned": "<Answer object at 0x2>", "returnStep": 9}]
    assert compare_hits(("call", "ask"), calls_a, calls_b) == []
    # a change next to the address still shows, with both values as recorded
    c = [{"text": "<Graph object at 0x10fe00000> 2 nodes", "step": 0}]
    d = [{"text": "<Graph object at 0x108a254f0> 3 nodes", "step": 0}]
    assert compare_hits(("value", "g"), c, d) == [{"kind": "value", "name": "g", "a": {"text": c[0]["text"], "step": 0}, "b": {"text": d[0]["text"], "step": 0}}]
    # a hex number that is the data is compared as it is
    assert len(compare_hits(("value", "h"), [{"text": "0x1f", "step": 0}], [{"text": "0x2f", "step": 0}])) == 1


def test_an_edited_statement_prints_the_lines_that_changed():
    """`k=60` became `k=1` on the third line of a four-line call: the first line alone is the same on both sides."""
    a = "scores = rrf(\n        rankings=rankings,\n        k=60,\n    )"
    b = "scores = rrf(\n        rankings=rankings,\n        k=1,\n    )"
    assert edited_lines(a, b) == ["    scores = rrf( …", "  - k=60,", "  + k=1,"]
    # a change on the first line needs no context line
    assert edited_lines("total = qty * unit", "total = qty * unit + 50") == ["  - total = qty * unit", "  + total = qty * unit + 50"]
    # one long line: a window around the first character that differs
    head = "result = compute(" + ", ".join("arg%d=%d" % (i, i) for i in range(30))
    lines = edited_lines(head + ", limit=5)", head + ", limit=7)")
    assert len(lines) == 2 and lines[0].startswith("  - …") and lines[1].startswith("  + …")
    assert "limit=5)" in lines[0] and "limit=7)" in lines[1] and all(len(l) <= 130 for l in lines)


def test_the_diff_text_shows_the_changed_line_of_a_multi_line_statement(tmp_path: Path):
    prog = tmp_path / "rrf.py"
    src = "def rrf(rankings, k):\n    return {d: 1 / (k + r) for d, r in rankings}\n\n\nscores = rrf(\n    rankings=[('A', 1)],\n    k=%d,\n)\nprint(scores)\n"
    a = record(prog, src % 60, tmp_path / "a.json")
    b = record(prog, src % 1, tmp_path / "b.json")
    code, out = pyokka("diff", str(a), str(b))
    lines = out.splitlines()
    i = lines.index("rrf.py:5  <module>  edited")
    assert lines[i + 1:i + 4] == ["    scores = rrf( …", "  - k=60,", "  + k=1,"], lines
    e = by_text(diff_json(str(a), str(b)), "scores = rrf(")
    assert (e["textA"], e["sourceB"]) == ("scores = rrf( …", "scores = rrf(\n    rankings=[('A', 1)],\n    k=1,\n)")


def test_secrets_in_the_kept_source_are_redacted(tmp_path: Path):
    prog = tmp_path / "keys.py"
    out = record(prog, 'secret = "sk-abcdefghijklmnopqrstuvwxyz012345"\nn = len(secret)\n', tmp_path / "k.json")
    raw = out.read_text(encoding="utf-8")
    assert "sk-abcdefghijklmnopqrstuvwxyz012345" not in raw
    assert 'secret = \\"%s\\"' % REDACTED in raw
    code, text = pyokka("diff", str(out), str(out))
    assert code == 0 and "statements: 2 same" in text


# -- --live: the open session is the after --------------------------------------------------------------------

class RunBridge(FakeBridge):
    """A bridge whose recording is a saved run: it answers the three requests `diff` makes."""

    def __init__(self, run: SavedRun) -> None:
        self.run = run
        super().__init__()

    def reply(self, req: dict) -> dict:
        t = req.get("type")
        if t == "state":
            return {"ok": True, **self.run.state()}
        if t == "walkthrough":
            return {"ok": True, **self.run.walkthrough(start=req.get("from"), end=req.get("to"))}
        if t == "var":
            return {"ok": True, **self.run.var(req["name"], limit=int(req.get("limit") or 200))}
        return {"ok": False, "error": "unexpected request %r" % t}


@pytest.fixture
def sessions(tmp_path: Path, monkeypatch) -> Path:
    from pyokka_runtime.agent.live import SESSIONS_ENV

    d = tmp_path / "sessions"
    d.mkdir()
    monkeypatch.setenv(SESSIONS_ENV, str(d))
    monkeypatch.chdir(tmp_path)
    return d


def test_live_stands_in_for_the_after(runs, sessions: Path):
    before, after = runs
    saved_after = SavedRun(str(after))
    bridge = RunBridge(saved_after)
    write_descriptor(sessions, "1", bridge.descriptor(file=str(saved_after.meta["file"]), workspace=str(saved_after.workspace_root)))
    try:
        live = diff_json(str(before), "--live")
    finally:
        bridge.close()
    saved = diff_json(str(before), str(after))
    assert live["b"]["run"] == "--live"
    assert live["matching"] == saved["matching"]
    assert live["statements"] == saved["statements"]
    assert {r["type"] for r in bridge.requests} == {"state", "walkthrough", "var"}


def test_live_takes_one_saved_run(runs, sessions: Path):
    before, after = runs
    code, out = pyokka("diff", str(before), str(after), "--live", "--json")
    assert code == 2
    assert json.loads(out)["error"] == "diff --live takes one saved run, the before; the live session is the after"


def test_shell_diffs_a_saved_run_against_the_session(runs, sessions: Path, monkeypatch, capsys):
    before, after = runs
    saved_after = SavedRun(str(after))
    bridge = RunBridge(saved_after)
    write_descriptor(sessions, "1", bridge.descriptor(file=str(saved_after.meta["file"]), workspace=str(saved_after.workspace_root)))
    monkeypatch.setattr(sys, "stdin", io.StringIO("diff %s\nexit\n" % before))
    try:
        code = main(["shell", "--live"])
    finally:
        bridge.close()
    out = capsys.readouterr().out
    assert code == 0
    assert out.startswith("a  %s  shop.py  " % before)
    assert "b  --live  shop.py  " in out and "  took False → True   a#" in out


def test_a_session_without_locals_compares_what_both_sides_have(tmp_path: Path, sessions: Path):
    """VS Code records locals only with pyokka.timeMachine.recordLocals on (off by default), and
    `pyokka run` records them unless --no-locals: the values a statement assigned and a call's
    arguments exist on one side only, so they are left out instead of reported as changed to ''."""
    prog = tmp_path / "proj" / "shop.py"
    prog.parent.mkdir()
    before = record(prog, BEFORE, tmp_path / "before.json")
    prog.write_text(textwrap.dedent(AFTER).lstrip(), encoding="utf-8")
    after = tmp_path / "after.json"
    pyokka("run", str(prog), "--save", str(after), "--no-locals")
    saved_after = SavedRun(str(after))
    bridge = RunBridge(saved_after)
    write_descriptor(sessions, "1", bridge.descriptor(file=str(saved_after.meta["file"]), workspace=str(saved_after.workspace_root)))
    try:
        doc = diff_json(str(before), "--live")
    finally:
        bridge.close()
    assert doc["notes"] == ["b recorded no locals (the session's pyokka.timeMachine.recordLocals (Record Variable Changes) is off), so assigned values and call arguments are left out; record both with locals to compare them"]
    facts = [f for e in doc["statements"] for f in e["facts"]]
    assert all(f["kind"] != "value" for f in facts)
    assert all(side is None or side["text"] for f in facts for side in (f["a"], f["b"]))
    branch = by_text(doc, "if total > LIMIT")
    assert [(f["a"]["text"], f["b"]["text"]) for f in branch["facts"]] == [("False", "True")]
    call = by_text(doc, "audit(totals)")
    assert call["facts"][0]["b"]["text"] == "audit(…) raised RuntimeError: audit failed: 2 orders"
