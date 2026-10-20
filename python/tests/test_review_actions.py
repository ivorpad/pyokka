"""Review mode's actions over the shop fixture (``fixtures/review/shop_base``, ``shop_head``): the planted PR.

``start`` records both trees for real (two runs of ``main.py``) and goes through the real diff,
exceptions and coverage code; the plan, the surfaces and the Scratchpad runner (stream A2's
``plan``, ``surfaces``, ``tryrun``) are replaced by fakes injected into ``sys.modules``, so these
tests pin the state machine, the refusals and the file layout and not the sweep's rules. The
fake plan is the contract's expected plan for shop, its steps taken from the real head recording.
``test_review_cli.py`` and ``test_review_mcp.py`` import the fixtures from here.
"""

from __future__ import annotations

import difflib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from pyokka_runtime.agent.review import actions, patching
from pyokka_runtime.agent.review.render import text as render_text
from pyokka_runtime.agent.review.state import FINDING_ADD, Refusal, Review, tree_hash
from pyokka_runtime.agent.source import SavedRun

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "review"
TYPE_ERROR = "TypeError: unsupported operand type(s) for +: 'int' and 'str'"
BOUNDARY_TRY = "from shopkit.config import DEFAULT\nfrom shopkit.discounts import spend_tier_rate\nresult = spend_tier_rate(500.0, DEFAULT)\n"


# -- the repository and the fakes --------------------------------------------------------------------------------------

def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def make_repo(root: Path) -> tuple[Path, str]:
    """``shop_base`` committed, then ``shop_head`` committed over it: ``(repo, base sha)``."""
    repo = root / "shop"
    skip = shutil.ignore_patterns("__pycache__", "*.pyc", ".pyokka")  # bytecode another test run left in the fixture tree
    shutil.copytree(FIXTURES / "shop_base", repo, ignore=skip)
    git(repo, "init", "-q", "-b", "main")
    for key, value in (("user.email", "review@example.com"), ("user.name", "Review Test"), ("commit.gpgsign", "false")):
        git(repo, "config", key, value)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "base: the October report")
    base = git(repo, "rev-parse", "HEAD")
    shutil.copytree(FIXTURES / "shop_head", repo, dirs_exist_ok=True, ignore=skip)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "PR #1: spend tiers, the new export format, a report that survives bad rows")
    return repo, base


def fake_build_plan(base_run, head_run, diff_json, exceptions_a, exceptions_b, coverage_b, diff_text, pr_text, repo):
    """The contract's plan for shop: a raise stop at pricing.py:12, a type stop at orders.py:30, discounts.py:8 unreached, two edges."""
    assert isinstance(base_run, SavedRun) and isinstance(head_run, SavedRun)
    assert diff_json["statements"] and diff_json["matching"]["same"] > 50
    assert exceptions_a["total"] == 0 and exceptions_b["total"] == 1
    assert any(f["file"].endswith("shopkit/discounts.py") and 8 in f["notRun"] for f in coverage_b["files"])
    assert "shopkit/pricing.py" in diff_text and pr_text.startswith("# PR #1")
    assert os.path.isdir(repo)
    raised = exceptions_b["rows"][0]
    typed = next(c for c in head_run.var("unit_price")["changes"] if str(c.get("text") or "").startswith("'"))
    stops = [
        {"kind": "raise", "file": "shopkit/pricing.py", "line": 12, "function": "subtotal", "fact": "%s (caught at pricing.py:13, 1×)" % TYPE_ERROR, "step_a": None, "step_b": raised["step"], "a": None, "b": TYPE_ERROR, "name": "TypeError", "values": [], "locals": []},
        {"kind": "type", "file": "shopkit/orders.py", "line": 30, "function": "parse_orders", "fact": "unit_price: float → str (1249.0 → '1,249.00')", "step_a": None, "step_b": typed["step"], "a": "1249.0", "b": "'1,249.00'", "name": "unit_price", "values": ["'1,249.00'", "'1,249.00'"], "locals": [{"name": "charged", "text": "'1,249.00'", "step": typed["step"] - 1, "line": 29}, {"name": "unit_price", "text": "'1,249.00'", "step": typed["step"], "line": 30}]},
    ]
    return {
        "summary": {"text": "2 anomalies: 1 new raise, 1 type change; exit code 0 on both.", "differing": diff_json["total"]},
        "stops": stops,
        "unreached": [{"file": "shopkit/discounts.py", "lines": "8", "start": 8, "end": 8, "text": "return settings.platinum_rate"}],
        "edges": [
            {"id": "E1", "kind": "boundary", "file": "shopkit/discounts.py", "line": 16, "function": "spend_tier_rate", "what": "`spend > threshold`: call spend_tier_rate with spend equal to threshold", "rank": 0},
            {"id": "E2", "kind": "attribute", "file": "shopkit/discounts.py", "line": 8, "function": "loyalty_rate", "what": "`settings.platinum_rate`: no class in the project defines `platinum_rate`", "rank": 0},
        ],
        "anomalies": ["pricing.py:12 raise", "orders.py:30 type", "discounts.py:8 unreached"],
    }


class FakeSurfaces:
    """``detect`` and ``move_to`` that remember their calls; ``chat`` unless a test sets ``answer``."""

    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.answer: dict | None = None

    def detect(self, port, session):
        self.calls.append(("detect", port, session))
        return "chat"

    def move_to(self, stop, say, surface, port, session, head_json):
        self.calls.append(("move_to", stop, say, surface, port, session, head_json))
        if self.answer is not None:
            return dict(self.answer)
        return {"surface": "chat", "moved": False, "note": "nothing to move"}


def fake_run_try(code, inputs, mocks, repo, page_port, **_):
    """The reproduction in a fresh interpreter with the head tree on sys.path; ``result`` printed last."""
    program = "import sys\nsys.path.insert(0, %r)\n%s\n%s\nprint('__RESULT__', repr(result) if 'result' in dir() else None)\n" % (str(repo), inputs or "", code)
    done = subprocess.run([sys.executable, "-c", program], cwd=str(repo), capture_output=True, text=True, timeout=60, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
    result = None
    output = []
    for line in done.stdout.splitlines():
        if line.startswith("__RESULT__ "):
            result = line[len("__RESULT__ "):]
        else:
            output.append(line)
    error = done.stderr.strip().splitlines()[-1] if done.returncode else None
    return {"result": None if result == "None" else result, "values": [], "output": "\n".join(output), "error": error, "surface": "headless"}


def install_fakes(mp: pytest.MonkeyPatch) -> FakeSurfaces:
    surfaces = FakeSurfaces()
    mp.setitem(sys.modules, "pyokka_runtime.agent.review.plan", SimpleNamespace(build_plan=fake_build_plan))
    mp.setitem(sys.modules, "pyokka_runtime.agent.review.surfaces", surfaces)
    mp.setitem(sys.modules, "pyokka_runtime.agent.review.tryrun", SimpleNamespace(run_try=fake_run_try))
    return surfaces


@pytest.fixture
def fakes(monkeypatch) -> FakeSurfaces:
    return install_fakes(monkeypatch)


@pytest.fixture(scope="module")
def shop(tmp_path_factory) -> SimpleNamespace:
    repo, base = make_repo(tmp_path_factory.mktemp("shop-repo"))
    return SimpleNamespace(repo=repo, base=base)


@pytest.fixture(scope="module")
def started(shop, tmp_path_factory) -> SimpleNamespace:
    """One ``start`` for the module: two recordings, the real comparison, the fake plan."""
    home = tmp_path_factory.mktemp("home")
    directory = tmp_path_factory.mktemp("reviews") / "shop-review"
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("PYOKKA_HOME", str(home))
        install_fakes(mp)
        answer = actions.run({"action": "start", "base": shop.base, "repo": str(shop.repo), "dir": str(directory), "full": True})
    return SimpleNamespace(dir=directory, answer=answer, home=home, repo=shop.repo, base=shop.base)


def fresh(started: SimpleNamespace, tmp_path: Path, name: str = "review", copy_repo: bool = False) -> SimpleNamespace:
    """A copy of the started review to mutate; with ``copy_repo`` a copy of the repository too."""
    directory = tmp_path / name
    shutil.copytree(started.dir, directory)
    repo = started.repo
    if copy_repo:
        repo = tmp_path / "repo-copy"
        shutil.copytree(started.repo, repo)
    data = json.loads((directory / "review.json").read_text())
    data["dir"] = str(directory)
    data["repo"] = str(repo)
    (directory / "review.json").write_text(json.dumps(data))
    return SimpleNamespace(dir=directory, repo=repo, base=started.base)


def run(action: str, **fields):
    return actions.run({"action": action, **fields})


def refusal(action: str, **fields) -> Refusal:
    with pytest.raises(Refusal) as info:
        actions.run({"action": action, **fields})
    exc = info.value
    lines = exc.text.split("\n")
    assert lines[0].startswith("review ") and lines[1].startswith("refused: ") and lines[-1].startswith("next: "), exc.text
    return exc


def run_or_step(review: SimpleNamespace, spec: str) -> int:
    """The step `ask FILE:LINE` lands on, read from head.json the way the action reads it."""
    file, _, line = spec.rpartition(":")
    return actions.first_step_on(SavedRun(str(review.dir / "head.json")), file, int(line))[0]


def shown_both(review: SimpleNamespace) -> None:
    """Both stops shown the way a conversation goes: the second only after the person said next (--go-on)."""
    plan = Review.load(str(review.dir)).stops
    run("stop", dir=str(review.dir), n=1, say="the sum raises at step %d: %s" % (plan[0]["step_b"], TYPE_ERROR), surface="chat")
    run("stop", dir=str(review.dir), n=2, say="unit_price is the text '1,249.00' where base had the float 1249.0", surface="chat", go_on=True)


def comma_patch(repo: Path) -> str:
    """The fix: parse_money strips thousands separators before the match; a unified diff against head."""
    old = (repo / "shopkit" / "money.py").read_text().splitlines(keepends=True)
    new = [l.replace(".lstrip(_SYMBOLS).strip()", '.lstrip(_SYMBOLS).replace(",", "").strip()') for l in old]
    assert new != old
    return "".join(difflib.unified_diff(old, new, "a/shopkit/money.py", "b/shopkit/money.py"))


# -- start ---------------------------------------------------------------------------------------------------------

def test_start_records_both_trees_compares_them_and_writes_the_state(started):
    answer = started.answer
    lines = render_text(answer).rstrip("\n").split("\n")
    assert re.match(r"^review shop-[0-9a-f]{7} · stops · stops 0/2 shown · findings 0 · tries 0$", lines[0]), lines[0]
    assert lines[-1] == "next: review stop 1 --say TEXT"
    assert "2 anomalies: 1 new raise, 1 type change" in "\n".join(lines)
    assert any(l.startswith("stops (2):") for l in lines)
    assert any("1. raise  shopkit/pricing.py:12 subtotal" in l for l in lines)
    assert any("shopkit/discounts.py:8 changed line never ran" in l for l in lines)
    assert any(l.strip().startswith("E1 [boundary] shopkit/discounts.py:16 spend_tier_rate:") for l in lines)
    d = started.dir
    for name in ("review.json", "base.json", "head.json", "base", "tries"):
        assert (d / name).exists(), name
    assert '.replace(",", "")' in (d / "base" / "shopkit" / "money.py").read_text()  # the base tree, not head
    assert not (started.repo / "shopkit" / "__pycache__").exists()  # recording leaves nothing in the repo
    state = json.loads((d / "review.json").read_text())
    assert set(state) >= {"id", "repo", "base", "head", "entry", "test", "dir", "created", "phase", "tree_hash", "plan", "shown", "asked", "tries", "findings", "fix", "summary"}
    assert state["phase"] == "stops" and state["entry"] == "main.py" and state["base"] == started.base and state["test"] is None
    assert re.fullmatch(r"[0-9a-f]{64}", state["tree_hash"])
    assert [s["n"] for s in state["plan"]["stops"]] == [1, 2] and [e["id"] for e in state["plan"]["edges"]] == ["E1", "E2"]
    assert (started.home / "reviews" / "current").read_text().strip() == str(d)
    head = SavedRun(str(d / "head.json"))
    assert head.meta["cwd"] == str(started.repo) and head.exceptions()["total"] == 1


def test_start_refuses_a_bad_ref_a_dir_inside_the_repo_and_a_tree_without_git(shop, tmp_path, fakes):
    exc = refusal("start", base="no-such-ref", repo=str(shop.repo), dir=str(tmp_path / "r"))
    assert "cannot resolve 'no-such-ref'" in exc.why and exc.next_command == "review start --base REF"
    exc = refusal("start", base=shop.base, repo=str(shop.repo), dir=str(shop.repo / "review"))
    assert "inside the repository" in exc.why
    plain = tmp_path / "plain"
    plain.mkdir()
    (plain / "main.py").write_text("print(1)\n")
    assert "not a git checkout" in refusal("start", base="HEAD", repo=str(plain), dir=str(tmp_path / "r2")).why
    assert "needs --base" in refusal("start", repo=str(shop.repo), dir=str(tmp_path / "r3")).why


def test_start_reviews_an_uncommitted_entry_and_refuses_a_missing_one(started, tmp_path, fakes, monkeypatch):
    """Head is the working tree as it stands: an edited, uncommitted main.py is reviewed as it is, and tree_hash pins it."""
    r = fresh(started, tmp_path, copy_repo=True)
    main = Path(r.repo) / "main.py"
    main.write_text(main.read_text() + "# edited in the working tree, not committed\n")
    assert git(Path(r.repo), "status", "--porcelain", "--", "main.py").strip().startswith("M ")
    monkeypatch.setenv("PYOKKA_HOME", str(tmp_path / "home"))
    answer = run("start", base=r.base, repo=str(r.repo), dir=str(tmp_path / "r"), surface="chat")
    lines = render_text(answer).rstrip("\n").split("\n")
    assert lines[0].startswith("review repo-copy-") and lines[-1] == "next: review stop 1 --say TEXT", lines
    state = json.loads((tmp_path / "r" / "review.json").read_text())
    assert state["entry"] == "main.py" and state["tree_hash"] == tree_hash(str(r.repo))
    assert "# edited in the working tree" in git(Path(r.repo), "diff", r.base, "--", "main.py")  # the change is part of what the review compares
    exc = refusal("start", base=r.base, repo=str(r.repo), entry="other.py", dir=str(tmp_path / "r2"))
    assert "no file" in exc.why


# -- stop and ask ----------------------------------------------------------------------------------------------------

def test_stop_refuses_off_plan_empty_and_unnamed_say(started, tmp_path, fakes):
    r = fresh(started, tmp_path)
    exc = refusal("stop", dir=str(r.dir), n=9, say="whatever")
    assert exc.why == "stop 9 is not in the plan" and any("1. raise" in d for d in exc.details) and "review ask FILE:LINE" in exc.details[-1]
    assert exc.next_command == "review stop 1 --say TEXT"
    exc = refusal("stop", dir=str(r.dir), n=1, say="   ")
    assert exc.why.startswith("--say is empty")
    exc = refusal("stop", dir=str(r.dir), n=1, say="subtotal looks fine to me")
    assert exc.why == "--say names none of the stop's values"
    assert any(d.strip().startswith("lines = [Line(sku='MON-27'") for d in exc.details), exc.details  # the locals at step_b, from head.json
    assert any(d.startswith("fact: ") for d in exc.details) and any(d.startswith("or the step number: ") for d in exc.details)
    assert Review.load(str(r.dir)).shown == [] and fakes.calls == []  # nothing moved, nothing marked


def test_stop_prints_the_context_marks_shown_and_steers_to_the_next(started, tmp_path, fakes):
    r = fresh(started, tmp_path)
    stop1 = Review.load(str(r.dir)).stop(1)
    step = stop1["step_b"]
    answer = run("stop", dir=str(r.dir), n=1, say="at step %d the sum of qty * unit_price raises" % step, surface="chat")
    lines = render_text(answer).rstrip("\n").split("\n")
    assert lines[0].startswith("review shop-") and "stops 1/2 shown" in lines[0]
    assert lines[1].startswith("stop 1/2  raise  shopkit/pricing.py:12 subtotal")
    assert any(l.startswith("step %d/" % step) and "shopkit/pricing.py:12" in l for l in lines)  # as `pyokka context head.json STEP` prints it
    assert any(l.startswith("block subtotal") for l in lines) and any(l.startswith("moves: ") for l in lines)
    assert "say: at step %d the sum of qty * unit_price raises" % step in lines
    assert any(l.startswith("view: chat") for l in lines)
    assert lines[-1] == "next: wait for the person; when they say next, review stop 2 --say TEXT --go-on"
    after = Review.load(str(r.dir))
    assert after.shown == [1] and after.phase == "stops" and after.waiting == 1
    assert after.data["said"][0] == {**after.data["said"][0], "n": 1, "go_on": False} and after.conversation[-1]["kind"] == "stop"
    # the fact's after text names the stop too, quotes optional and whitespace free; --go-on says the person spoke
    answer = run("stop", dir=str(r.dir), n=2, say="Ben's unit_price arrives as 1,249.00, a str, where the base had 1249.0", surface="chat", go_on=True)
    assert "stops 2/2 shown" in answer["header"] and answer["next"] == "wait for the person; when they say next, " + FINDING_ADD
    after = Review.load(str(r.dir))
    assert after.phase == "findings" and after.waiting == 2 and after.data["said"][0]["go_on"] is True and after.data["said"][1]["go_on"] is False
    # showing a stop again is allowed (with --go-on, they have the floor) and keeps the count
    answer = run("stop", dir=str(r.dir), n=1, say="%s is caught at line 13 and subtotal returns 0.0" % TYPE_ERROR, surface="chat", go_on=True)
    assert "stops 2/2 shown" in answer["header"]


def test_stop_moves_the_surface_through_move_to(started, tmp_path, fakes):
    r = fresh(started, tmp_path)
    step = Review.load(str(r.dir)).stop(1)["step_b"]
    fakes.answer = {"surface": "page", "moved": True, "note": "goto %d" % step}
    answer = run("stop", dir=str(r.dir), n=1, say="the raise at step %d" % step, surface="page", port=4790)
    call = next(c for c in fakes.calls if c[0] == "move_to")
    assert call[1]["n"] == 1 and call[2] == "the raise at step %d" % step and call[3] == "page" and call[4] == 4790 and call[5] is None
    assert call[6] == str(r.dir / "head.json")
    assert "view: page moved: goto %d" % step in answer["lines"]
    # a surface that blows up never loses the stop
    fakes.move_to = lambda *a, **k: (_ for _ in ()).throw(OSError("bridge gone"))
    answer = run("stop", dir=str(r.dir), n=2, say="unit_price = '1,249.00'", surface="auto", go_on=True)
    assert any(l.startswith("view: auto (not moved): OSError: bridge gone") for l in answer["lines"])
    assert refusal("stop", dir=str(r.dir), n=1, say="step %d" % step, surface="tv", go_on=True).why == "unknown surface 'tv'"


def test_ask_stops_at_an_unplanned_line_and_records_it(started, tmp_path, fakes):
    r = fresh(started, tmp_path)
    exc = refusal("ask", dir=str(r.dir), line="shopkit/discounts.py:16", say="the loop over the tiers")
    assert exc.why == "--say names none of the stop's values" and any(d.strip().startswith("rate = 0.0") for d in exc.details)
    answer = run("ask", dir=str(r.dir), line="shopkit/discounts.py:16", say="rate starts at 0.0 and only a spend above a threshold raises it", surface="chat")
    lines = answer["lines"]
    assert lines[0].startswith("ask  shopkit/discounts.py:16 spend_tier_rate  b#")
    assert any(l.startswith("step %d/" % answer["step"]) for l in lines)
    asked = Review.load(str(r.dir)).asked
    assert len(asked) == 1 and asked[0]["line"] == 16 and asked[0]["step"] == answer["step"]
    assert answer["next"] == "wait for the person"  # their question; the plan does not move
    assert Review.load(str(r.dir)).remaining() == [1, 2]
    exc = refusal("ask", dir=str(r.dir), line="shopkit/discounts.py:8", say="platinum")
    assert exc.why == "no step on shopkit/discounts.py:8: the line never ran" and "`def loyalty_rate" in exc.details[0]
    # a line that ran only as part of a statement around it: the stop is that statement, and says so
    answer = run("ask", dir=str(r.dir), line="main.py:17", say="main collects the invoices, one per order, at step %d" % run_or_step(r, "main.py:17"), surface="chat")
    assert answer["lines"][1].startswith("line 17 never ran as a statement of its own; the stop is the statement around it, line 16") or answer["lines"][0].startswith("ask  main.py:17")
    assert refusal("ask", dir=str(r.dir), line="discounts.py", say="x").why.startswith("ask wants FILE:LINE")


# -- try and finding -------------------------------------------------------------------------------------------------

def test_try_hands_its_title_to_the_runner(started, tmp_path, fakes, monkeypatch):
    """The page's Scratchpad names the experiment by the try's title; without it the page shows "Untitled experiment"."""
    r = fresh(started, tmp_path)
    seen = {}

    def recording_runner(code, inputs, mocks, repo, page_port, **kw):
        seen.update(kw)
        return fake_run_try(code, inputs, mocks, repo, page_port)

    monkeypatch.setitem(sys.modules, "pyokka_runtime.agent.review.tryrun", SimpleNamespace(run_try=recording_runner))
    answer = run("try", dir=str(r.dir), expr="1 + 1", title="two")
    assert answer["try"]["title"] == "two" and seen.get("title") == "two"


def test_try_keeps_the_run_and_marks_the_edge(started, tmp_path, fakes):
    r = fresh(started, tmp_path)
    code = tmp_path / "boundary.py"
    code.write_text(BOUNDARY_TRY)
    answer = run("try", dir=str(r.dir), code=str(code), edge="E1", title="spend exactly 500")
    t = answer["try"]
    assert t["id"] == "t1" and t["result"] == "0.0" and t["edge"] == "E1" and t["error"] is None
    assert json.loads((r.dir / "tries" / "t1.json").read_text())["code"] == BOUNDARY_TRY
    after = Review.load(str(r.dir))
    assert after.tries[0]["id"] == "t1" and after.plan["edges"][0]["tried"] == "t1"
    assert "tries 1" in answer["header"] and answer["next"] == "wait for the person" and answer["lines"][-1] == "a finding built on it: --repro t1"
    assert any(l.startswith("    result: 0.0") for l in answer["lines"]) and any("spend_tier_rate(500.0, DEFAULT)" in l for l in answer["lines"])
    answer = run("try", dir=str(r.dir), expr="1 / 0")
    assert answer["try"]["id"] == "t2" and "ZeroDivisionError" in answer["try"]["error"]
    assert refusal("try", dir=str(r.dir)).why == "try needs one of --code FILE or --expr EXPR"
    assert refusal("try", dir=str(r.dir), expr="1", edge="E9").why == "no edge candidate E9 in the plan"
    assert "cannot read --code" in refusal("try", dir=str(r.dir), code=str(tmp_path / "missing.py")).why


def test_finding_needs_the_stops_shown_a_step_in_the_file_and_a_reproduction(started, tmp_path, fakes):
    r = fresh(started, tmp_path)
    common = dict(dir=str(r.dir), file="shopkit/money.py", line=14, severity="blocker", title="Ben's price stays text", fix="strip the thousands separator before the match")
    shown_both(r)
    exc = refusal("finding", dir=str(r.dir), file="shopkit/money.py", line=14)
    assert exc.why == "finding add needs --severity, --title, --repro, --fix" and exc.next_command == FINDING_ADD
    head = SavedRun(str(r.dir / "head.json"))
    money_step = head.var("t")["changes"][0]["step"]  # parse_money's first `t = ...`, money.py:11
    raise_step = Review.load(str(r.dir)).stop(1)["step_b"]  # pricing.py:12
    assert "is in shopkit/pricing.py, not in shopkit/money.py" in refusal("finding", **common, step=raise_step, repro="t1").why
    assert "not within 3 lines of shopkit/money.py:40 nor in the same function" in refusal("finding", **{**common, "line": 40}, step=money_step, repro="t1").why
    assert refusal("finding", **common, step=money_step, repro="t9").why == "no try t9 in this review"
    assert refusal("finding", **common, step=money_step, repro="%s -c \"print('x')\"" % sys.executable).why.startswith("a command reproduction needs --expect")
    exc = refusal("finding", **common, step=money_step, repro="%s -c \"print('nothing')\"" % sys.executable, expect="1,249.00")
    assert exc.why == "the command's output does not contain '1,249.00'" and any("nothing" in d for d in exc.details)
    # a try as the reproduction
    run("try", dir=str(r.dir), expr="__import__('shopkit.money', fromlist=['x']).parse_money('\"1,249.00\"')")
    answer = run("finding", **common, step=money_step, repro="t1", expect="'1,249.00'")
    f = answer["finding"]
    assert f["id"] == "f1" and f["repro"] == {"kind": "try", "id": "t1", "result": "'1,249.00'", "error": None, "expect": "'1,249.00'"}
    assert f["step_at"]["file"] == "shopkit/money.py" and f["step_at"]["function"] == "parse_money" and f["step"] == money_step
    assert answer["lines"][0].startswith("  f1 blocker  shopkit/money.py:14  Ben's price stays text  step #%d parse_money" % money_step)
    assert answer["next"] == "review fix --patch FILE.diff" and "findings 1" in answer["header"]
    # a command as the reproduction, and the same place and title replaces f1
    answer = run("finding", **common, step=money_step, repro="%s -c \"print('1,249.00')\"" % sys.executable, expect="1,249.00")
    assert answer["finding"]["id"] == "f1" and answer["finding"]["repro"]["kind"] == "command" and len(Review.load(str(r.dir)).findings) == 1
    answer = run("finding", **{**common, "title": "the fallback hides the failure", "file": "shopkit/pricing.py", "line": 15, "severity": "major"}, step=raise_step, repro="t1")
    assert answer["finding"]["id"] == "f2"  # same function as line 15, 3 lines away: pricing.py:12 is in subtotal


# -- fix and report --------------------------------------------------------------------------------------------------

@pytest.fixture
def reviewed(started, tmp_path, fakes) -> SimpleNamespace:
    """Both stops shown, the boundary tried, one finding with a NAME=VALUE expectation on the fixed run."""
    r = fresh(started, tmp_path, copy_repo=True)
    shown_both(r)
    code = tmp_path / "boundary.py"
    code.write_text(BOUNDARY_TRY)
    run("try", dir=str(r.dir), code=str(code), edge="E1")
    step = SavedRun(str(r.dir / "head.json")).var("t")["changes"][0]["step"]
    run("finding", dir=str(r.dir), file="shopkit/money.py", line=14, severity="blocker", title="Ben's price stays text", step=step, repro="t1", expect="revenue=2955.57", fix="strip the thousands separator")
    r.step = step
    return r


def test_fix_applies_the_patch_to_a_copy_records_it_and_checks_the_expectations(reviewed, tmp_path):
    r = reviewed
    bad = tmp_path / "bad.diff"
    bad.write_text("--- a/shopkit/money.py\n+++ b/shopkit/money.py\n@@ -11,1 +11,1 @@\n-    t = something else entirely\n+    t = text\n")
    exc = refusal("fix", dir=str(r.dir), patch=str(bad))
    assert exc.why.startswith("the patch does not apply to head: shopkit/money.py: hunk @@ -11,1 +11,1 @@ does not apply")
    assert not (r.dir / "fixed").exists()
    patch = tmp_path / "fix.diff"
    patch.write_text(comma_patch(Path(r.repo)))
    answer = run("fix", dir=str(r.dir), patch=str(patch), tests="%s -m unittest -q tests.test_money" % sys.executable)
    lines = answer["lines"]
    assert lines[0].startswith("patch %s applied to %s: 1 file (shopkit/money.py)" % (patch, r.dir / "fixed"))
    assert any(l.startswith("tests: ") and "exit 0 (passed)" in l for l in lines)
    assert any(l.startswith("fixed/main.py recorded to") for l in lines) and "head → fixed:" in lines
    assert any(l.strip().startswith("statements:") for l in lines)
    assert any(l.startswith("PASS revenue = 2955.57") and "[f1]" in l for l in lines), lines
    assert '.replace(",", "")' in (r.dir / "fixed" / "shopkit" / "money.py").read_text()
    assert '.replace(",", "")' not in (Path(r.repo) / "shopkit" / "money.py").read_text()  # the repository is untouched
    assert (r.dir / "fixed.json").exists() and not (r.dir / "fixed" / ".git").exists()
    fx = Review.load(str(r.dir)).data["fix"]
    assert fx["files"] == ["shopkit/money.py"] and fx["tests"]["exit"] == 0 and fx["checks"][0]["passed"] is True
    assert answer["next"] == "review report"
    assert refusal("fix", dir=str(r.dir)).why.startswith("fix needs --patch")


def test_fix_needs_a_finding(started, tmp_path, fakes):
    r = fresh(started, tmp_path)
    shown_both(r)
    exc = refusal("fix", dir=str(r.dir), patch=str(tmp_path / "x.diff"))
    assert exc.why == "nothing to fix yet: no finding" and exc.next_command == FINDING_ADD


def test_report_refuses_a_changed_tree_and_a_reproduction_that_no_longer_holds(reviewed, tmp_path):
    r = reviewed
    marker = tmp_path / "marker.txt"
    marker.write_text("ok\n")
    run("finding", dir=str(r.dir), file="shopkit/money.py", line=11, severity="minor", title="a flaky reproduction", step=r.step, repro="cat %s" % marker, expect="ok", fix="none")
    marker.unlink()
    exc = refusal("report", dir=str(r.dir))
    assert exc.why == "a reproduction no longer reproduces" and exc.details[0].startswith("f2: command `cat ") and "no longer prints 'ok'" in exc.details[0]
    marker.write_text("ok\n")
    (Path(r.repo) / "shopkit" / "report.py").write_text("# touched\n" + (Path(r.repo) / "shopkit" / "report.py").read_text())
    exc = refusal("report", dir=str(r.dir))
    assert exc.why.startswith("the tree at %s changed since start" % r.repo) and exc.next_command == "review start --base %s" % r.base
    (Path(r.repo) / "shopkit" / "report.py").write_text((Path(r.repo) / "shopkit" / "report.py").read_text()[len("# touched\n"):])
    assert "inside the repository" in refusal("report", dir=str(r.dir), out=str(Path(r.repo) / "report.md")).why


def test_report_page_puts_every_stop_shown_on_a_code_history_page(reviewed, tmp_path):
    """--page: one recorded-step checkpoint per stop shown or line asked, the say as its text, base beside head in its note, a finding's severity as its tag."""
    r = reviewed
    before = Review.load(str(r.dir))
    type_stop = before.stop(2)
    run("finding", dir=str(r.dir), file="shopkit/orders.py", line=30, severity="major", title="unit_price stays text", step=type_stop["step_b"], repro="t1", fix="parse the thousands separator")
    page = tmp_path / "out" / "page.json"
    answer = run("report", dir=str(r.dir), out=str(tmp_path / "out" / "review.md"), page=str(page))
    data = json.loads(page.read_text())
    entries = [e for e in before.conversation if e.get("kind") in ("stop", "ask")]
    cards = [c for c in data["steps"] if c["id"].startswith("step-")]
    assert len(cards) == len(entries) == 2
    assert cards[0]["kind"] == "recorded step" and cards[0]["step"] == entries[0]["step"] and cards[0]["text"] == entries[0]["say"]
    assert cards[0]["title"].startswith("Stop 1: raise in subtotal") and cards[0]["verify"].startswith("pyokka context ")
    assert cards[1]["note"].startswith("Base had 1249.0. Head has '1,249.00'.") and cards[1]["tag"] == "FINDING · MAJOR"
    assert any(c["id"].startswith("why-%d-unit_price" % type_stop["step_b"]) for c in data["steps"])
    assert data["heading"].startswith("Review shop-") and data["summary"] and "2 of 2 stops shown" in data["subtitle"]
    assert answer["page"] == str(page) and any(l.startswith("wrote page ") for l in answer["lines"]) and any("render-code-history.cjs" in l for l in answer["lines"])
    tries = [c for c in data["steps"] if c["kind"] == "try"]
    assert [c["id"] for c in tries] == ["t1"] and tries[0]["file"] == "tries/t1.py" and data["files"]["tries/t1.py"] and tries[0]["text"].startswith("Ran in the sandbox. The result is `0.0`.") and tries[0]["note"].startswith("Reproduces f1")
    assert Review.load(str(r.dir)).data["page"]["path"] == str(page)
    assert "inside the repository" in refusal("report", dir=str(r.dir), page=str(Path(r.repo) / "page.json")).why


def test_report_tour_tells_the_stops_as_a_story_of_head(reviewed, tmp_path):
    """--tour: the stops shown are forced candidates of head's tour and their says its prose; a say the tour's check rejects falls back to the fact."""
    r = reviewed
    before = Review.load(str(r.dir))
    entries = [e for e in before.conversation if e.get("kind") in ("stop", "ask")]
    tour = tmp_path / "out" / "tour.json"
    answer = run("report", dir=str(r.dir), out=str(tmp_path / "out" / "review.md"), tour=str(tour))
    doc = json.loads(tour.read_text())
    assert doc["prose"]["stops"] == len(entries) == 2 and len(doc["pick"]) == 2
    picked = [c for c in doc["candidates"] if c["id"] in doc["pick"]]
    assert sorted(c["step"] for c in picked) == sorted(e["step"] for e in entries) and all(c.get("forced") for c in picked)
    by_step = {c["step"]: c for c in picked}
    for e in entries:
        text = by_step[e["step"]]["prose"]["text"]
        assert text == e["say"] or text.startswith("Here `") or text in ("The statement raises here and a handler catches it.", "The value changes type here."), text
    plain = "This tour follows a review of %s: the stops below are where head behaves differently from base." % Path(r.repo).name
    assert doc["intro"] in (before.data["summary"]["text"], plain, "")
    assert answer["tour"] == str(tour) and any(l.startswith("wrote tour ") for l in answer["lines"]) and any("render-tour.cjs" in l for l in answer["lines"])
    assert "inside the repository" in refusal("report", dir=str(r.dir), tour=str(Path(r.repo) / "tour.json")).why




def test_report_reruns_the_reproductions_and_writes_the_markdown(reviewed, tmp_path):
    r = reviewed
    patch = tmp_path / "fix.diff"
    patch.write_text(comma_patch(Path(r.repo)))
    run("fix", dir=str(r.dir), patch=str(patch))
    out = tmp_path / "out" / "review.md"
    answer = run("report", dir=str(r.dir), out=str(out))
    md = out.read_text()
    assert answer["markdown"] == md and answer["header"].split(" · ")[1] == "reported" and answer["next"] == "review state"
    assert md.startswith("# Review shop-") and "## What the change does in behaviour" in md
    assert "### blocker: Ben's price stays text (f1)" in md and "- reproduced: try t1 (result 0.0); at report time: try t1 run again gives the same (result 0.0, error none)" in md
    assert "- fix status: PASS revenue = 2955.57" in md
    assert md.index("## What we looked at together") < md.index("## What the change does in behaviour") < md.index("## Findings")
    together = md.split("## What we looked at together")[1].split("## What the change")[0]
    assert "- stop 1 (raise shopkit/pricing.py:12 subtotal): the sum raises at step" in together and "- stop 2 (type shopkit/orders.py:30 parse_orders): unit_price is the text" in together
    assert together.index("stop 1 (") < together.index("stop 2 (")
    assert "## Edge candidates" in md and "E1 [boundary]" in md and "tried t1: 0.0" in md and "E2 [attribute]" in md and "skipped" in md
    assert "## Unreached changed lines not tried" in md and "shopkit/discounts.py:8 changed line never ran" in md
    assert "## Not verified" in md and "1 edge candidate not tried: E2" in md
    assert Review.load(str(r.dir)).phase == "reported" and Review.load(str(r.dir)).data["report"]["path"] == str(out)
    # new evidence after the report reopens the review; the default report goes to DIR/report.md
    run("try", dir=str(r.dir), expr="2 + 2")
    assert Review.load(str(r.dir)).phase == "findings"
    answer = run("report", dir=str(r.dir))
    assert (r.dir / "report.md").exists() and answer["report"] == str(r.dir / "report.md")


def test_state_lists_the_plan_with_shown_stops_marked(reviewed):
    answer = run("state", dir=str(reviewed.dir))
    lines = answer["lines"]
    assert lines[0] == "stops (2):" and lines[1].endswith("(shown)") and lines[2].endswith("(shown)")
    assert lines[3] == "agenda: shown 1, 2 · skipped none · remaining none · waiting for the person since stop 2"
    assert any(l.startswith("  stop 1 (raise shopkit/pricing.py:12 subtotal): the sum raises at step") for l in lines)
    assert answer["remaining"] == [] and answer["waiting"] == 2
    assert any(l.startswith("  E1 [boundary]") and l.endswith("(tried t1)") for l in lines)
    assert any(l.startswith("tries (1):") for l in lines) and any(l.startswith("findings (1):") for l in lines)
    assert answer["next"] == "review fix --patch FILE.diff" and answer["phase"] == "findings"


def test_the_person_can_end_the_review_at_any_time(started, tmp_path, fakes):
    """The plan is a menu: finding add, fix and report work whatever is left on it, and the report says what stayed."""
    r = fresh(started, tmp_path, copy_repo=True)
    step = SavedRun(str(r.dir / "head.json")).var("t")["changes"][0]["step"]
    run("try", dir=str(r.dir), expr="1 + 1")
    answer = run("finding", dir=str(r.dir), file="shopkit/money.py", line=14, severity="minor", title="filed before any stop", step=step, repro="t1", fix="none")
    assert answer["finding"]["id"] == "f1" and "stops 0/2 shown" in answer["header"]
    answer = run("report", dir=str(r.dir))
    md = answer["markdown"]
    assert "- nothing: no stop was shown and no line asked" in md
    assert "- Not looked at: 1. raise shopkit/pricing.py:12, 2. type shopkit/orders.py:30" in md
    assert Review.load(str(r.dir)).phase == "reported" and answer["next"] == "review stop 1 --say TEXT"  # the agenda stays open
    run("stop", dir=str(r.dir), n=1, say="step %d" % Review.load(str(r.dir)).stop(1)["step_b"], surface="chat")
    md = run("report", dir=str(r.dir))["markdown"]
    assert "- Not looked at: 2. type shopkit/orders.py:30" in md and "- stop 1 (raise shopkit/pricing.py:12 subtotal): step" in md
