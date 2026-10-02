"""`pyokka why`: the provenance tree over the shared fixture program, its rules, the budget, the text form.

The program lives in `test/unit/fixtures/provenance/` (a chain of assignments, a stepped call with a
logged result, a loop, a method mutating state, a `# ?+`, a generator over an opaque constructor,
two calls into helper.py, a builtin call). This file regenerates the run and checks the trees of the
cases below against `provenance.json`; the TypeScript builder (`test/unit/provenance.test.ts`) reads
`provenance-run.json` and the same cases and must produce the same trees. Regenerate both with
PYOKKA_WRITE_FIXTURES=1.
"""

from __future__ import annotations

import io
import json
import os
import textwrap
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from pyokka_runtime.__main__ import main
from pyokka_runtime.agent.provenance import callee_name, provenance
from pyokka_runtime.agent.source import SavedRun
from pyokka_runtime.agent.why_text import conclusion
from pyokka_runtime.agent.source import SavedRun
from pyokka_runtime.bindings import statement_bindings
from pyokka_runtime.protocol import PROVENANCE_DEPTH, PROVENANCE_MAX_DEPTH

from test_walkthrough import FIXTURES, normalize, pyokka, saved_run

PROGRAM = FIXTURES / "provenance"
RUN_JSON = FIXTURES / "provenance-run.json"
CASES_JSON = FIXTURES / "provenance.json"

# (file, line, which step on the line, name, depth)
CASES = [
    ("main.py", 23, "first", "area", PROVENANCE_DEPTH),
    ("main.py", 28, "first", "total", PROVENANCE_DEPTH),
    ("main.py", 29, "first", "label", PROVENANCE_DEPTH),
    ("main.py", 31, "first", "result", PROVENANCE_DEPTH),
    ("main.py", 12, "last", "self.balance", PROVENANCE_DEPTH),
    ("main.py", 25, "last", "amount", PROVENANCE_DEPTH),
    ("main.py", 27, "first", "acct", PROVENANCE_DEPTH),
    ("main.py", 32, "first", "", PROVENANCE_DEPTH),
    ("main.py", 29, "first", "label", 1),
    ("main.py", 30, "first", "count", PROVENANCE_DEPTH),
    ("main.py", 24, "first", "base", PROVENANCE_DEPTH),
    ("main.py", 23, "first", "nothing_here", PROVENANCE_DEPTH),
    ("helper.py", 7, "first", "both", PROVENANCE_DEPTH),
    # the conclusion's rules: a conditional on a recorded name, a plain copy, a `.get` that gave None, a conditional decided by its literal arm
    ("main.py", 34, "first", "preferred", PROVENANCE_DEPTH),
    ("main.py", 35, "first", "copy_of_label", PROVENANCE_DEPTH),
    ("main.py", 37, "first", "missing", PROVENANCE_DEPTH),
    ("main.py", 38, "first", "absent", PROVENANCE_DEPTH),
]


@pytest.fixture
def fixture_run(tmp_path: Path) -> Path:
    return saved_run(tmp_path, (PROGRAM / "main.py").read_text(encoding="utf-8"), files={"helper.py": (PROGRAM / "helper.py").read_text(encoding="utf-8")})


def step_of(run: SavedRun, file: str, line: int, occurrence: str) -> int:
    on = run.trace.steps_on_line(int(run.resolve_file(file)["fileId"]), line)
    assert on, "no step on %s:%d" % (file, line)
    return on[0] if occurrence == "first" else on[-1]


def build_cases(run: SavedRun, root: str) -> list[dict]:
    out = []
    for file, line, occurrence, name, depth in CASES:
        step = step_of(run, file, line, occurrence)
        result = json.loads(normalize(json.dumps(provenance(run, step, name, depth=depth), ensure_ascii=False), root))
        out.append({"file": file, "line": line, "occurrence": occurrence, "name": name, "depth": depth, "step": step, "result": result})
    return out


@pytest.fixture
def cases(fixture_run: Path, tmp_path: Path) -> dict[tuple, dict]:
    """The trees by (name, depth, line)."""
    built = build_cases(SavedRun(str(fixture_run)), str(tmp_path / "proj"))
    return {(c["name"], c["depth"], c["line"]): c for c in built}


def test_fixture_trees_match_the_shared_json(fixture_run: Path, tmp_path: Path):
    run = SavedRun(str(fixture_run))
    root = str(tmp_path / "proj")
    doc = {"bindings": {rel: statement_bindings((PROGRAM / rel).read_text(encoding="utf-8")) for rel in ("main.py", "helper.py")}, "cases": build_cases(run, root)}
    if os.environ.get("PYOKKA_WRITE_FIXTURES"):
        CASES_JSON.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        RUN_JSON.write_text(normalize(fixture_run.read_text(encoding="utf-8"), root) + "\n", encoding="utf-8")
    expected = json.loads(CASES_JSON.read_text(encoding="utf-8"))
    assert [(c["name"], c["step"]) for c in doc["cases"]] == [(c["name"], c["step"]) for c in expected["cases"]]
    for mine, theirs in zip(doc["cases"], expected["cases"]):
        assert mine == theirs, "%s at %s:%d" % (mine["name"], mine["file"], mine["line"])
    assert doc == expected


def names(nodes: list[dict]) -> list[str]:
    return [n["name"] for n in nodes]


def test_root_is_the_change_at_the_step_with_its_log_entry(cases):
    area = cases[("area", PROVENANCE_DEPTH, 23)]
    root = area["result"]["root"]
    assert (area["result"]["name"], area["result"]["step"], area["result"]["depth"], area["result"]["truncated"], area["result"]["recordedLocals"]) == ("area", 6, 5, False, True)
    assert (root["name"], root["text"], root["source"], root["step"], root["file"], root["fileId"], root["line"], root["function"], root["scopeId"]) == ("area", "12", "locals", 6, "/fixture/main.py", 1, 23, "<module>", 0)
    assert root["logId"].startswith("l-")  # the `# ?` value, logged at the callee's last step, belongs to this statement
    assert root["statement"] == "area = scale(width, base)  # ?"
    assert names(root["reads"]) == ["scale", "width", "base"]
    width = root["reads"][1]
    assert (width["text"], width["source"], width["step"], width["line"], width["statement"]) == ("4", "locals", 5, 22, "width = base + 1")
    assert [(r["name"], r["text"], r["step"], r["line"]) for r in width["reads"]] == [("base", "3", 4, 21)]
    assert width["reads"][0]["reads"] == [] and width["reads"][0]["calls"] == [] and width["reads"][0]["opaque"] == []
    assert root["calls"] == [{"name": "scale", "scopeId": 2, "entryStep": 7, "returnStep": 9, "file": "/fixture/main.py", "fileId": 1, "line": 16, "inputs": [{"name": "value", "text": "4"}, {"name": "factor", "text": "3"}], "result": "12"}]
    assert root["opaque"] == []  # scale(width, base) was claimed by the stepped scope


def test_reads_walk_through_the_logged_value_to_the_assignment(cases):
    root = cases[("total", PROVENANCE_DEPTH, 28)]["result"]["root"]
    assert (root["text"], root["source"], root["step"]) == ("35.0", "locals", 23) and root["logId"]
    assert names(root["reads"]) == ["acct", "Account"] and root["reads"][1] == {"name": "Account"}
    acct = root["reads"][0]
    assert (acct["text"], acct["source"], acct["step"], acct["line"], acct["statement"]) == ("Account(owner='ivor', balance=30.0)", "value", 22, 27, "acct  # ?+")
    assert acct["logId"]
    assigned = acct["reads"][0]
    assert (assigned["name"], assigned["text"], assigned["source"], assigned["step"], assigned["line"], assigned["statement"]) == ("acct", "Account(owner='ivor', balance=0.0)", "locals", 10, 24, 'acct = Account("ivor")')
    assert assigned["reads"] == [{"name": "Account"}] and assigned["opaque"] == ['Account("ivor")']
    assert root["calls"] == [] and root["opaque"] == ['sum(a.balance for a in [acct, Account("guest", 5)])', 'Account("guest", 5)']
    assert cases[("total", PROVENANCE_DEPTH, 28)]["result"]["nodes"] == 5


def test_calls_carry_the_walkthrough_inputs_and_result(cases):
    doc = cases[("label", PROVENANCE_DEPTH, 29)]["result"]
    root = doc["root"]
    assert (root["text"], root["source"], root["step"], root["statement"]) == ("'total/35.0'", "locals", 24, "label = helper.describe(total, os.sep)")
    assert root["logId"]
    assert names(root["reads"]) == ["helper", "total", "os"] and root["reads"][0] == {"name": "helper"} and root["reads"][2] == {"name": "os"}
    assert root["calls"] == [{"name": "describe", "scopeId": 5, "entryStep": 25, "returnStep": 27, "file": "/fixture/helper.py", "fileId": 2, "line": 1, "inputs": [{"name": "value", "text": "35.0"}, {"name": "sep", "text": "'/'"}], "result": "'total/35.0'"}]
    assert root["opaque"] == [] and doc["nodes"] == 8
    result = cases[("result", PROVENANCE_DEPTH, 31)]["result"]["root"]
    assert names(result["reads"]) == ["helper", "area", "count"]
    assert result["calls"][0]["name"] == "combine" and result["calls"][0]["inputs"] == [{"name": "a", "text": "12"}, {"name": "b", "text": "10"}] and result["calls"][0]["result"] == "22"
    count = result["reads"][2]
    assert (count["step"], count["statement"], names(count["reads"]), count["opaque"]) == (28, "count = len(label)", ["label"], ["len(label)"])
    assert count["reads"][0]["step"] == 24


def test_a_method_reads_its_parameters_from_the_def_header(cases):
    root = cases[("self.balance", PROVENANCE_DEPTH, 12)]["result"]["root"]
    assert (root["name"], root["text"], root["source"], root["step"], root["function"], root["scopeId"], root["statement"]) == ("self.balance", "30.0", "value", 20, "deposit", 4, "self.balance += amount")
    assert [(r["name"], r["text"], r["step"], r["line"], r["statement"]) for r in root["reads"]] == [
        ("self", "Account(owner='ivor', balance=10.0)", 19, 11, "def deposit(self, amount):"),
        ("amount", "20", 19, 11, "def deposit(self, amount):"),
    ]
    assert all(r["reads"] == [] and r["calls"] == [] and r["opaque"] == [] for r in root["reads"])
    both = cases[("both", PROVENANCE_DEPTH, 7)]["result"]["root"]
    assert (both["text"], both["step"], both["file"], both["function"]) == ("22", 31, "/fixture/helper.py", "combine")
    assert [(r["name"], r["text"], r["step"], r["line"]) for r in both["reads"]] == [("a", "12", 30, 6), ("b", "10", 30, 6)]


def test_loop_variable_the_marker_and_the_statement_itself(cases):
    amount = cases[("amount", PROVENANCE_DEPTH, 25)]["result"]
    assert amount["step"] == 17
    # a loop header's range is the header line, so no ` …`; the iteration step binds the target and reads nothing
    assert (amount["root"]["text"], amount["root"]["source"], amount["root"]["statement"], amount["root"]["reads"], amount["root"]["calls"], amount["root"]["opaque"]) == ("20", "locals", "for amount in (10, 20):", [], [], [])
    acct = cases[("acct", PROVENANCE_DEPTH, 27)]["result"]["root"]
    assert (acct["text"], acct["source"], acct["step"], acct["statement"]) == ("Account(owner='ivor', balance=30.0)", "value", 22, "acct  # ?+")
    assert [(r["name"], r["step"]) for r in acct["reads"]] == [("acct", 10)]
    statement = cases[("", PROVENANCE_DEPTH, 32)]["result"]
    root = statement["root"]
    assert statement["name"] == "" and root["name"] == "" and "text" not in root and "source" not in root
    assert (root["step"], root["statement"], root["opaque"]) == (33, "print(result)", ["print(result)"])
    assert [(r["name"], r["text"], r["step"]) for r in root["reads"]] == [("result", "22", 29)]


def test_read_rule_and_leaf_roots(cases):
    base = cases[("base", PROVENANCE_DEPTH, 24)]["result"]
    assert base["step"] == 10 and (base["root"]["name"], base["root"]["text"], base["root"]["source"], base["root"]["step"], base["root"]["line"]) == ("base", "3", "locals", 4, 21)
    nothing = cases[("nothing_here", PROVENANCE_DEPTH, 23)]["result"]
    assert nothing["root"] == {"name": "nothing_here"} and nothing["nodes"] == 1 and nothing["truncated"] is False


def test_depth_cuts_the_last_level(cases):
    doc = cases[("label", 1, 29)]["result"]
    assert doc["depth"] == 1 and doc["nodes"] == 4
    helper, total, os_ = doc["root"]["reads"]
    assert total["cut"] is True and "reads" not in total and "calls" not in total and total["statement"].startswith("total = sum(")
    assert helper == {"name": "helper"} and os_ == {"name": "os"}  # a leaf has nothing to cut
    assert "cut" not in doc["root"] and doc["root"]["calls"][0]["name"] == "describe"


def test_node_budget_truncates_breadth_first(fixture_run: Path):
    run = SavedRun(str(fixture_run))
    doc = provenance(run, 29, "result", nodes=5)
    assert doc["nodes"] == 5 and doc["truncated"] is True
    helper, area, count = doc["root"]["reads"]
    assert area["cut"] is True and "reads" not in area  # its three reads would take the count past 5
    assert "cut" not in count and count["reads"][0]["cut"] is True  # `label` fits; its reads do not
    assert provenance(run, 24, "label", depth=0)["depth"] == 1 and provenance(run, 24, "label", depth=99)["depth"] == PROVENANCE_MAX_DEPTH
    assert provenance(run, 24, "label", nodes=1)["root"]["cut"] is True


def test_dotted_name_falls_back_to_its_first_segment(fixture_run: Path):
    run = SavedRun(str(fixture_run))
    root = provenance(run, 20, "self.owner")["root"]
    assert (root["name"], root["text"], root["step"]) == ("self", "Account(owner='ivor', balance=10.0)", 19)
    assert provenance(run, 20, "nobody.here")["root"] == {"name": "nobody.here"}
    # a multi-line statement says so; a `# ?` on the line stays, it is source
    assert provenance(run, 24, "label", depth=1)["root"]["reads"][1]["statement"] == 'total = sum(a.balance for a in [acct, Account("guest", 5)])'


def test_callee_name():
    assert callee_name("helper.describe(total, os.sep)") == "describe"
    assert callee_name('Account("guest", 5)') == "Account"
    assert callee_name("sum(a.balance for a in [acct, Account()])") == "sum"
    assert callee_name("obj.items[0](x)") == "items[0]"


def test_text_form_matches_the_reference_renderer(fixture_run: Path):
    code, text = pyokka("why", str(fixture_run), "24", "label")
    assert code == 0
    assert text.splitlines() == [
        "why label at #24",
        "label = 'total/35.0'   #24 main.py:29 <module>   label = helper.describe(total, os.sep)",
        "  ← helper = ?",
        '  ← total = 35.0   #23 main.py:28 <module>   total = sum(a.balance for a in [acct, Account("guest", 5)])',
        "    ← acct = Account(owner='ivor', balance=30.0)   #22 main.py:27 <module>   acct  # ?+",
        "      ← acct = Account(owner='ivor', balance=0.0)   #10 main.py:24 <module>   acct = Account(\"ivor\")",
        "        ← Account = ?",
        '        · Account("ivor")   not stepped',
        "    ← Account = ?",
        '    · sum(a.balance for a in [acct, Account("guest", 5)])   not stepped',
        '    · Account("guest", 5)   not stepped',
        "  ← os = ?",
        "  ↳ describe #25–#27 helper.py:1   in value = 35.0, sep = '/'   out 'total/35.0'",
        "label is 'total/35.0' at #24 (main.py:29). helper.describe(total, os.sep) returned 'total/35.0'.",
    ]
    code, text = pyokka("why", str(fixture_run), "33")
    assert code == 0 and text.splitlines()[:2] == ["why #33", "#33 main.py:32 <module>   print(result)"]
    code, text = pyokka("why", str(fixture_run), "24", "label", "--depth", "1")
    assert code == 0 and text.splitlines()[3].endswith('Account("guest", 5)])  …')


# -- the conclusion: the answer in words ---------------------------------------------------------------------------

def _root(**over) -> dict:
    node = {"name": "label", "text": "'total/35.0'", "step": 24, "file": "/w/main.py", "line": 29, "statement": "label = helper.describe(total, os.sep)", "reads": [], "calls": [], "opaque": []}
    node.update(over)
    return node


def _read(name: str, text: str, step: int, line: int = 12) -> dict:
    return {"name": name, "text": text, "step": step, "file": "/w/main.py", "line": line}


def test_conclusion_states_the_value_then_one_cause_per_rule():
    tree = lambda **over: {"root": _root(**over)}  # noqa: E731
    # 2: a conditional expression on a recorded name, the arm from its truthiness
    assert conclusion(tree(name="preferred", statement="preferred = label if flag else None", reads=[_read("label", "'total/35.0'", 20), _read("flag", "True", 23)])) == "preferred is 'total/35.0' at #24 (main.py:29). The if arm ran: flag is True."
    assert conclusion(tree(name="preferred", text="None", statement="preferred = label if flag else None", reads=[_read("flag", "False", 23)])) == "preferred is None at #24 (main.py:29). The else arm ran: flag is False."
    # 2: a compound test decided by the literal arm, with the reads it names
    assert conclusion(tree(name="absent", text="None", statement="absent = label if count > 50 else None", reads=[_read("count", "10", 22), _read("label", "'x'", 21)])) == "absent is None at #24 (main.py:29). The else arm ran: count > 50 was false, since count is 10."
    # 3: a stepped call with its return, and the first None or empty argument
    calls = [{"name": "describe", "result": "'total/35.0'", "inputs": [{"name": "value", "text": "35.0"}, {"name": "sep", "text": "''"}]}]
    assert conclusion(tree(calls=calls)) == "label is 'total/35.0' at #24 (main.py:29). helper.describe(total, os.sep) returned 'total/35.0' with sep = ''."
    # 4: a plain copy of one recorded read
    assert conclusion(tree(name="copy_of_label", statement="copy_of_label = label", reads=[_read("label", "'total/35.0'", 20, 12)])) == "copy_of_label is 'total/35.0' at #24 (main.py:29). It copies label, which has been 'total/35.0' since #20 (main.py:12)."
    # 5: a lookup that gave None from a recorded container, the key count when the repr is whole
    assert conclusion(tree(name="missing", text="None", statement='missing = settings.get("colour")', reads=[_read("settings", "{'theme': 'dark', 'size': 3}", 20)])) == 'missing is None at #24 (main.py:29). settings.get("colour") is None: the key is not in settings (2 keys).'
    assert conclusion(tree(name="missing", text="None", statement="missing = table[key]", reads=[_read("table", "{'a': 1, …}", 20), _read("key", "'z'", 19)])) == "missing is None at #24 (main.py:29). table[key] is None: the key is not in table."
    # 6: otherwise the recorded reads, three at most
    assert conclusion(tree(name="total", text="35.0", statement="total = sum(a.balance for a in xs) + b + c + d", reads=[_read("xs", "[1, 2]", 20), _read("b", "1", 19), _read("c", "2", 18), _read("d", "3", 17)])) == "total is 35.0 at #24 (main.py:29). It reads xs = [1, 2], b = 1, c = 2."
    # 1 alone when the statement recorded nothing else; long values are cut like the panel cuts them
    assert conclusion(tree(name="base", text="3", statement="base = 3")) == "base is 3 at #24 (main.py:29)."
    assert conclusion(tree(text="'" + "x" * 80 + "'", statement="label = build()")) == "label is '" + "x" * 58 + "… at #24 (main.py:29)."


def test_conclusion_says_nothing_without_a_recorded_value():
    assert conclusion({"root": {"name": "size", "step": 13, "statement": "size = len(n)", "reads": [{"name": "n", "text": "2", "step": 6}]}}) == ""
    assert conclusion({"root": {"name": "nothing"}}) == ""
    assert conclusion({"root": {"name": "", "text": "1", "step": 3, "statement": "x = 1"}}) == ""


def test_fixture_conclusions(cases):
    got = {key: c["result"]["conclusion"] for key, c in cases.items()}
    assert got[("label", PROVENANCE_DEPTH, 29)] == "label is 'total/35.0' at #24 (main.py:29). helper.describe(total, os.sep) returned 'total/35.0'."
    assert got[("area", PROVENANCE_DEPTH, 23)] == "area is 12 at #6 (main.py:23). scale(width, base) returned 12."
    assert got[("total", PROVENANCE_DEPTH, 28)] == "total is 35.0 at #23 (main.py:28). It reads acct = Account(owner='ivor', balance=30.0)."
    assert got[("preferred", PROVENANCE_DEPTH, 34)] == "preferred is 'total/35.0' at #%d (main.py:34). The if arm ran: flag is True." % cases[("preferred", PROVENANCE_DEPTH, 34)]["step"]
    assert got[("copy_of_label", PROVENANCE_DEPTH, 35)] == "copy_of_label is 'total/35.0' at #%d (main.py:35). It copies label, which has been 'total/35.0' since #24 (main.py:29)." % cases[("copy_of_label", PROVENANCE_DEPTH, 35)]["step"]
    assert got[("missing", PROVENANCE_DEPTH, 37)] == 'missing is None at #%d (main.py:37). settings.get("colour") is None: the key is not in settings (2 keys).' % cases[("missing", PROVENANCE_DEPTH, 37)]["step"]
    assert got[("absent", PROVENANCE_DEPTH, 38)] == "absent is None at #%d (main.py:38). The else arm ran: count > 50 was false, since count is 10." % cases[("absent", PROVENANCE_DEPTH, 38)]["step"]
    assert got[("nothing_here", PROVENANCE_DEPTH, 23)] == "" and got[("", PROVENANCE_DEPTH, 32)] == ""


def test_why_prints_the_conclusion_as_its_last_line(fixture_run: Path):
    code, text = pyokka("why", str(fixture_run), "24", "label")
    assert code == 0
    lines = text.rstrip("\n").split("\n")
    assert lines[0] == "why label at #24"
    assert lines[-1] == "label is 'total/35.0' at #24 (main.py:29). helper.describe(total, os.sep) returned 'total/35.0'."
    code, text = pyokka("why", str(fixture_run), "24", "label", "--json")
    assert code == 0 and json.loads(text)["conclusion"] == lines[-1]


# -- in-place mutation of a container ------------------------------------------------------------

ACCUMULATOR = """
scores = {}
for name, points in (("a", 1), ("b", 2), ("a", 4)):
    scores[name] = scores.get(name, 0) + points
print(scores)
"""


def test_a_rebind_inside_a_dict_is_reported_as_same_object_not_unchanged(tmp_path: Path):
    """`d[k] = v` on a key that already exists keeps both id(d) and len(d).

    The change marker in `tracer._record_locals` is exactly that pair, so the third pass, which
    re-binds "a" rather than adding a key, records no change and `var` shows the value from
    before the statement. That is a real limit of the recording, and the text has to say what was
    actually observed: the same object, not an unchanged value. Two agents reading a run were
    misled by the old wording, which asserted something about the program that was false.

    Making it exact needs the instrumenter to tell the tracer which names a statement assigns.
    Scanning every local's contents at every step instead costs about 2.3x on a locals-heavy
    loop, measured, which is why it is not done here.
    """
    program = tmp_path / "acc.py"
    program.write_text(textwrap.dedent(ACCUMULATOR).lstrip(), encoding="utf-8")
    saved = tmp_path / "run.json"
    buf = io.StringIO()
    with redirect_stdout(buf):
        assert main(["run", str(program), "--save", str(saved)]) == 0
    run = SavedRun(str(saved))

    changes = run.var("scores")["changes"]
    assert [c["text"] for c in changes] == ["{}", "{'a': 1}", "{'a': 1, 'b': 2}", "{'a': 1, 'b': 2}"]
    assert [bool(c.get("unchanged")) for c in changes] == [False, False, False, True]

    out = io.StringIO()
    with redirect_stdout(out):
        assert main(["var", str(saved), "scores"]) == 0
    text = out.getvalue()
    assert "(same object)" in text, "the label states what was observed"
    assert "(unchanged)" not in text, "and never claims the value did not change, because it did"
