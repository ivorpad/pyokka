"""``review stop`` in the debugger prints the change at the pause and the frame's values the changed lines use, evaluating nothing.

The diff's hunks are parsed with both numberings (``hunks.py``) and each agenda item keeps the runs of
removed and added lines that are its own, thirty at most. The stop prints them with ``>`` on the paused
line, then the locals that the changed lines and the paused line name, each text as the runtime
delivered it, then the other locals, and it removes the item's breakpoint as ``skip`` does. The debug
session is ``test_review_debugger``'s ``FakeLive``; nothing here needs VS Code.
"""

from __future__ import annotations

import json
from pathlib import Path

from pyokka_runtime.agent.review.debugger import CONTINUE, plan_items
from pyokka_runtime.agent.review.hunks import CHANGE_LINES, item_hunks, parse_hunks
from pyokka_runtime.agent.review.render import text as render_text
from pyokka_runtime.agent.review.state import Review
from pyokka_runtime.agent.review.stop_context import change_lines, locals_lines, names_on
from tests.test_review_actions import git
from tests.test_review_debugger import items_of, pause_at, run, start, world  # noqa: F401  world is a pytest fixture

TWO_FILES = (
    "diff --git a/pkg/rates.py b/pkg/rates.py\n"
    "index 1111111..2222222 100644\n"
    "--- a/pkg/rates.py\n"
    "+++ b/pkg/rates.py\n"
    "@@ -3,5 +3,6 @@ import os\n"
    " \n"
    " def rate(tier):\n"
    "-    return 0.1\n"
    "+    base = 0.1\n"
    "+    return base\n"
    " \n"
    " \n"
    "@@ -20,4 +21,4 @@ def other():\n"
    "     sql = '''\n"
    "--- the old filter\n"  # a removed SQL comment: `--- ` as a file header would end the hunk here
    "+++ the new filter\n"  # an added one: `+++ ` as a file header would start a file named "the new filter"
    "     SELECT 1\n"
    "     '''\n"
    "diff --git a/pkg/new.py b/pkg/new.py\n"
    "new file mode 100644\n"
    "index 0000000..3333333\n"
    "--- /dev/null\n"
    "+++ b/pkg/new.py\n"
    "@@ -0,0 +1,2 @@\n"
    "+def fresh():\n"
    "+    return 1\n"
    "\\ No newline at end of file\n"
    "diff --git a/pkg/gone.py b/pkg/gone.py\n"
    "deleted file mode 100644\n"
    "index 4444444..0000000\n"
    "--- a/pkg/gone.py\n"
    "+++ /dev/null\n"
    "@@ -1 +0,0 @@\n"
    "-print('bye')\n"
)

SOURCE = """\
def check(self, addr, policy,
          strict=False):
    if addr in self.blocked and policy.on:
        reason = describe(
            addr,
            policy.name,
        )
        return reason
    try:
        value = int(addr)
    except ValueError as exc:
        raise Blocked(exc) from None
    return value
"""


# -- the hunks --------------------------------------------------------------------------------------------------------

def test_hunks_carry_both_numberings_and_a_line_that_looks_like_a_header_stays_in_its_hunk():
    assert parse_hunks(TWO_FILES) == {
        "pkg/rates.py": [
            {"old_start": 3, "new_start": 3, "lines": [[" ", 3, ""], [" ", 4, "def rate(tier):"], ["-", 5, "    return 0.1"], ["+", 5, "    base = 0.1"], ["+", 6, "    return base"], [" ", 7, ""], [" ", 8, ""]]},
            {"old_start": 20, "new_start": 21, "lines": [[" ", 21, "    sql = '''"], ["-", 21, "-- the old filter"], ["+", 22, "++ the new filter"], [" ", 23, "    SELECT 1"], [" ", 24, "    '''"]]},
        ],
        "pkg/new.py": [{"old_start": 0, "new_start": 1, "lines": [["+", 1, "def fresh():"], ["+", 2, "    return 1"]]}],  # the no-newline marker is on neither side
    }, "a deleted file has no hunks: no line of head to stop at"


def test_an_item_keeps_its_own_runs_and_a_long_run_is_cut_with_the_rest_counted():
    hunk = {"old_start": 10, "new_start": 10, "lines": [
        ["-", 10, "    a = 1"], ["+", 10, "    a = 2"],
        [" ", 11, "    b = a"],
        ["-", 12, "    del b"],
        [" ", 12, "    return b"],
        [" ", 13, ""],
        ["+", 14, "def g():"], ["+", 15, "    return 3"],
    ]}
    assert item_hunks([hunk], [[10, 10]]) == ([{"old_start": 10, "new_start": 10, "lines": [["-", 10, "    a = 1"], ["+", 10, "    a = 2"]]}], 0)
    assert item_hunks([hunk], [[14, 15]]) == ([{"old_start": 10, "new_start": 10, "lines": [["+", 14, "def g():"], ["+", 15, "    return 3"]]}], 0), "another function's run in the same hunk is not this item's"
    assert item_hunks([hunk], [[30, 31]]) == ([], 0)
    # a rewritten body: removed lines get a third of the room, so the added lines a pause is on still show
    big = {"old_start": 1, "new_start": 1, "lines": [["-", n, "old %d" % n] for n in range(1, 41)] + [["+", n, "new %d" % n] for n in range(1, 41)]}
    kept, left_out = item_hunks([big], [[1, 40]])
    lines = kept[0]["lines"]
    assert len(lines) == CHANGE_LINES == 30 and left_out == 50
    assert lines[:10] == [["-", n, "old %d" % n] for n in range(1, 11)] and lines[10:] == [["+", n, "new %d" % n] for n in range(1, 21)]


def test_plan_items_store_each_items_removed_and_added_lines(world):
    plan = plan_items(str(world.repo), git(world.repo, "diff", world.base, "--no-ext-diff", "--no-color"))
    items = {it["function"]: it for it in plan["stops"]}
    money = items["parse_money"]
    assert money["hunks"] == [{"old_start": 1, "new_start": 1, "lines": [
        ["-", 6, "def parse_money(text: str) -> float:"],
        ["-", 7, "    \"\"\"The export's price text as a number: '49.90', ' $49.90 ', '\"1,249.00\"'.\"\"\""],
        ["-", 8, "    t = text.strip().strip('\"').lstrip(_SYMBOLS).replace(\",\", \"\").strip()"],
        ["+", 8, "def parse_money(text: str) -> float | str:"],
        ["+", 9, "    \"\"\"The export's price text as a number: '49.90', ' $49.90 ', '\"49.90\"'."],
        ["+", 10, "    Text that is not a number is kept as it is, for the audit log.\"\"\""],
        ["+", 11, "    t = text.strip().strip('\"').lstrip(_SYMBOLS).strip()"],
        ["-", 11, "    return float(t)"],
        ["+", 14, "    return float(t) if _NUMBER.match(t) else t"],
    ]}] and money["hunks_more"] == 0
    # discounts.py's one hunk holds the module docstring, loyalty_rate and spend_tier_rate: each item keeps its own run
    assert [line[1:] for h in items["loyalty_rate"]["hunks"] for line in h["lines"]] == [[6, '    if tier == "platinum":'], [7, "        # invite-only; the rate is set per deployment"], [8, "        return settings.platinum_rate"]]
    assert {line[1] for h in items["spend_tier_rate"]["hunks"] for line in h["lines"]} == set(range(10, 24))
    assert all("hunks" not in a for a in plan["aside"]), "an item set aside has no breakpoint and never stops"


# -- the names the changed lines use ------------------------------------------------------------------------------------

def test_names_on_counts_a_statement_whole_and_a_compound_one_by_its_own_lines():
    assert names_on(SOURCE, {5}) == {"reason", "describe", "addr", "policy"}  # one argument line of a call: the whole statement
    assert names_on(SOURCE, {3}) == {"addr", "self", "policy"}  # an if line: its test, never its body; self.blocked gives self
    assert names_on(SOURCE, {2}) == {"strict"}  # a changed parameter line of the def
    assert names_on(SOURCE, {11}) == {"ValueError", "exc"}
    assert names_on(SOURCE, {9}) == set()
    assert names_on("def broken(:\n", {1}) is None


def test_the_locals_the_changed_lines_use_come_first_under_a_header_that_says_which_lines(tmp_path: Path):
    path = tmp_path / "check.py"
    path.write_text(SOURCE, encoding="utf-8")
    values = [("self", "<Checker>"), ("addr", "'fd00::1'"), ("policy", "Policy()"), ("strict", "False"), ("other", "1")]
    item = {"kind": "change", "spans": [[2, 2]]}
    assert locals_lines(item, str(path), 3, values) == (["values on the changed lines and line 3:", "  self = <Checker>", "  addr = 'fd00::1'", "  policy = Policy()", "  strict = False", "other locals:", "  other = 1"], ["self", "addr", "policy", "strict"])
    assert locals_lines(item, str(path), 2, values)[0][:3] == ["values on the changed lines:", "  strict = False", "other locals:"]
    assert locals_lines({"kind": "change", "spans": [[9, 9]]}, str(path), 9, values) == (["locals:", "  self = <Checker>", "  addr = 'fd00::1'", "  policy = Policy()", "  strict = False", "  other = 1"], []), "no local on those lines: one list, as before"
    assert locals_lines({"kind": "pause", "spans": [[3, 3]]}, str(path), 3, values)[0][0] == "locals:", "a pause outside every item has no changed lines"
    assert locals_lines(item, str(path), 3, []) == (["locals: none in this frame"], [])


def test_change_lines_mark_the_paused_line_and_count_what_was_left_out():
    item = {"hunks": [{"old_start": 9, "new_start": 9, "lines": [["-", 9, "    a = 1"], ["+", 9, "    a = 2"], ["+", 10, "    b = a  "]]}], "hunks_more": 4}
    assert change_lines(item, 10) == ["change:", "  9 -    a = 1", "  9 +    a = 2", ">10 +    b = a", "    … 4 more changed lines"]
    assert change_lines(item, 9)[1:3] == ["  9 -    a = 1", "> 9 +    a = 2"], "the removed line with the same number is base's"
    assert change_lines(item, 12)[1:4] == ["  9 -    a = 1", "  9 +    a = 2", " 10 +    b = a"]
    assert change_lines({}, 3) == [] and change_lines({"hunks": []}, 3) == []


# -- the stop -----------------------------------------------------------------------------------------------------------

def test_stop_prints_the_change_and_the_values_the_changed_lines_use_first(world):
    _, review = start(world)
    item = next(it for it in items_of(review) if it["function"] == "parse_money")
    long_text = "Settings(" + "r" * 190 + ")"  # as long as the runtime lets a local's text be; the stop cut it to 100 before
    pause_at(world, item, {"settings": long_text, "text": "'\"1,249.00\"'"}, step=57)
    answer = run("stop", dir=str(world.dir), n=item["n"], say='text is "1,249.00" with the comma still in')
    lines = render_text(answer).split("\n")
    first = lines.index(next(line for line in lines if line.startswith("stop ")))
    assert len(long_text) == 200 and lines[first:first + 20] == [
        "stop %d/%d  change  shopkit/money.py:11 parse_money  changed lines 8-11, 14; its breakpoint is removed" % (item["n"], len(review.stops)),
        "paused at money.py:11 (breakpoint)  step #57",
        "change:",
        "  6 -def parse_money(text: str) -> float:",
        "  7 -    \"\"\"The export's price text as a number: '49.90', ' $49.90 ', '\"1,249.00\"'.\"\"\"",
        "  8 -    t = text.strip().strip('\"').lstrip(_SYMBOLS).replace(\",\", \"\").strip()",
        "  8 +def parse_money(text: str) -> float | str:",
        "  9 +    \"\"\"The export's price text as a number: '49.90', ' $49.90 ', '\"49.90\"'.",
        " 10 +    Text that is not a number is kept as it is, for the audit log.\"\"\"",
        ">11 +    t = text.strip().strip('\"').lstrip(_SYMBOLS).strip()",
        " 11 -    return float(t)",
        " 14 +    return float(t) if _NUMBER.match(t) else t",
        "values on the changed lines:",
        "  text = '\"1,249.00\"'",
        "other locals:",
        "  settings = " + long_text,
        'say: text is "1,249.00" with the comma still in',
        "view: VS Code, paused there; the person sees it in the editor",
        "next: wait for the person; when they say next, %s --go-on" % CONTINUE,
        "",
    ]
    assert world.fake.removed == [{"file": str(world.repo / "shopkit" / "money.py"), "line": 11}]
    # the payload and the record keep the frame's order and the whole texts; used names the first group
    assert answer["values"] == [{"name": "settings", "text": long_text}, {"name": "text", "text": "'\"1,249.00\"'"}] and answer["used"] == ["text"]
    assert Review.load(str(world.dir)).conversation[-1]["values"] == [["settings", long_text], ["text", "'\"1,249.00\"'"]]
    # a second record of the same pause removes nothing: a breakpoint there now is the person's own
    answer = run("stop", dir=str(world.dir), say="text is still 1,249.00 here", go_on=True)
    assert "its breakpoint is removed" not in render_text(answer) and len(world.fake.removed) == 1


def test_a_review_from_before_the_hunks_stops_without_the_change_section(world):
    _, review = start(world)
    path = world.dir / "review.json"
    state = json.loads(path.read_text(encoding="utf-8"))
    for stop in state["plan"]["stops"]:
        stop.pop("hunks", None)
        stop.pop("hunks_more", None)
    path.write_text(json.dumps(state), encoding="utf-8")
    item = next(it for it in items_of(Review.load(str(world.dir))) if it["function"] == "subtotal")
    pause_at(world, item, {"total": "0.0", "lines": "[Line(sku='MON-27', qty=1, unit_price='1,249.00')]"})
    text = render_text(run("stop", dir=str(world.dir), say="total is 0.0 after the string price"))
    assert "change:" not in text, "no hunks in the plan: nothing to print, nothing to fail on"
    assert "values on the changed lines:\n  lines = [Line(sku='MON-27', qty=1, unit_price='1,249.00')]\nother locals:\n  total = 0.0\nsay: " in text, "the names still come from the spans and the current source"
    assert world.fake.removed == [{"file": str(world.repo / "shopkit" / "pricing.py"), "line": item["line"]}]
    # a pause outside every item: its own item, the locals as one list, and the person's breakpoint left alone
    world.fake.paused = {"file": str(world.repo / "shopkit" / "orders.py"), "line": 30, "reason": "exception", "function": "parse_orders"}
    world.fake.locals_ = {"row": "{'price': '1,249.00'}"}
    text = render_text(run("stop", dir=str(world.dir), say="row is {'price': '1,249.00'}, the price still text", go_on=True))
    assert "\nlocals:\n  row = {'price': '1,249.00'}\nsay: " in text and "change:" not in text and "its breakpoint is removed" not in text
    assert len(world.fake.removed) == 1
