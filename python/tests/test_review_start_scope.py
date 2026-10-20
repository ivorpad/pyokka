"""Fewer round trips before the first stop of a review in the debugger: ``start`` names the interpreter and the debug
session, ``--only`` narrows the agenda before it is numbered, ``skip`` takes several numbers in one call, and
``close`` and ``report`` take the review's breakpoints out of VS Code.

The Codex smoke test of 2026-10-19 (a langchain range, two IPv6 functions under review) read a Makefile and a
pyproject to guess the interpreter, called ``pyokka_session`` twice for the session file, and made 56 single
``skip`` calls after ``start`` planned 58 items. The shop repository and the faked debugger come from
``test_review_debugger.py``; an interpreter here is a shell script that prints a version, as in
``test_recording_limits.py``.
"""

from __future__ import annotations

import stat
import sys
from pathlib import Path

import pytest

from pyokka_runtime.agent.review.debugger import plan_items
from pyokka_runtime.agent.review.render import text as render_text
from pyokka_runtime.agent.review.scope import inside_any, only_paths
from pyokka_runtime.agent.review.state import Review
from tests.test_review_actions import git
from tests.test_review_debugger import items_of, pause_at, refusal, run, start, world  # noqa: F401  pytest fixtures

shell_only = pytest.mark.skipif(sys.platform == "win32", reason="a shell-script interpreter")
NEAREST = "(the .venv nearest the entry; --python overrides)"


def fake_python(path: Path, version: str = "3.12.1") -> Path:
    """An interpreter that answers ``probe`` with ``version``; the faked debugger never runs it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\necho %s\n" % version, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


@pytest.fixture
def plain_env(monkeypatch):
    """No interpreter named by the environment: ``uv run`` exports VIRTUAL_ENV, which ``interpreter.choose`` takes first."""
    monkeypatch.delenv("VIRTUAL_ENV", raising=False)
    monkeypatch.delenv("PYOKKA_PYTHON", raising=False)


def lines_of(answer: dict) -> list[str]:
    return render_text(answer).rstrip("\n").split("\n")


def unfiltered(world) -> dict:
    """The plan ``start`` would make without ``--only``, to compare a narrowed one against."""
    return plan_items(str(world.repo), git(world.repo, "diff", world.base, "--no-ext-diff", "--no-color"))


# -- the interpreter and the session in start's answer ----------------------------------------------------------------

@shell_only
def test_start_names_the_venv_nearest_the_entry_and_the_session(world, plain_env):
    root = fake_python(world.repo / ".venv" / "bin" / "python")
    near = fake_python(world.repo / "tests" / ".venv" / "bin" / "python")
    answer, review = start(world, test="tests/test_pricing.py::test_subtotal")  # the entry of FILE::NAME is FILE
    lines = lines_of(answer)
    assert lines[2] == "python: %s 3.12.1 %s" % (near, NEAREST), lines[:4]  # right under the head line
    assert review.data["python"] == str(near) and world.launches[-1]["python"] == str(near)
    assert "session: %s" % world.fake.descriptor["descriptor"] in lines
    answer, review = start(world)  # main.py at the root: the root's .venv is the nearest
    assert "python: %s 3.12.1 %s" % (root, NEAREST) in lines_of(answer) and review.data["python"] == str(root)


@shell_only
def test_python_then_pyokka_python_then_virtual_env_win_over_the_venv(world, plain_env, monkeypatch, tmp_path):
    fake_python(world.repo / ".venv" / "bin" / "python")
    given = fake_python(tmp_path / "given" / "bin" / "python", "3.12.2")
    answer, review = start(world, python=str(given))
    assert "python: %s 3.12.2 (--python)" % given in lines_of(answer) and review.data["python"] == str(given)
    named = fake_python(tmp_path / "named" / "python", "3.12.3")
    monkeypatch.setenv("PYOKKA_PYTHON", str(named))
    answer, _ = start(world)
    assert "python: %s 3.12.3 ($PYOKKA_PYTHON)" % named in lines_of(answer)
    monkeypatch.delenv("PYOKKA_PYTHON")
    active = fake_python(tmp_path / "active" / "bin" / "python", "3.12.4").parent.parent
    monkeypatch.setenv("VIRTUAL_ENV", str(active))
    answer, _ = start(world)  # an activated venv is the person's choice too: interpreter.choose's order is kept
    assert "python: %s 3.12.4 ($VIRTUAL_ENV)" % (active / "bin" / "python") in lines_of(answer)


def test_start_falls_back_to_pyokkas_own_when_no_venv_is_found(world, plain_env):
    own = "python: %s %d.%d.%d (pyokka's own; no --python, $PYOKKA_PYTHON, $VIRTUAL_ENV or .venv found)" % (sys.executable, *sys.version_info[:3])
    answer, review = start(world)
    assert lines_of(answer)[2] == own and review.data["python"] == sys.executable
    answer, review = start(world, surface="chat")  # the recorded review names it in the same place
    assert review.data["mode"] == "recording" and lines_of(answer)[2] == own


def test_state_and_view_name_the_session_while_it_is_up(world):
    start(world)
    session = "session: %s" % world.fake.descriptor["descriptor"]
    assert lines_of(run("state", dir=str(world.dir)))[1] == session
    world.fake.gone = True
    assert session not in lines_of(run("state", dir=str(world.dir)))
    world.fake.gone = False
    assert session in lines_of(run("view", dir=str(world.dir), surface="vscode"))


# -- --only --------------------------------------------------------------------------------------------------------

def test_only_keeps_the_items_inside_and_sets_the_rest_aside_before_numbering(world):
    full = unfiltered(world)
    keep = ("shopkit/discounts.py", "shopkit/pricing.py")
    answer, review = start(world, only=["shopkit/discounts.py", "./shopkit/pr*.py"])
    assert [(s["n"], s["file"], s["function"]) for s in review.stops] == [(i, s["file"], s["function"]) for i, s in enumerate((s for s in full["stops"] if s["file"] in keep), 1)]
    left = [a for a in review.plan["aside"] if a.get("reason") == "outside --only"]
    assert [(a["file"], a["function"]) for a in left] == [(s["file"], s["function"]) for s in full["stops"] if s["file"] not in keep] and left
    assert all("n" not in a for a in left)
    edges = review.plan["edges"]
    assert [(e["id"], e["file"], e["line"]) for e in edges] == [("E%d" % i, e["file"], e["line"]) for i, e in enumerate((e for e in full["edges"] if e["file"] in keep), 1)]
    assert [e["file"] for e in review.plan["aside_edges"]] == [e["file"] for e in full["edges"] if e["file"] not in keep]
    assert len(world.fake.added) == len(review.stops)  # breakpoints for the agenda alone
    text = render_text(answer)
    assert "%d items on the agenda" % len(review.stops) in text
    assert "%d items and %d edge candidates left out: their files are outside --only shopkit/discounts.py, shopkit/pr*.py." % (len(left), len(review.plan["aside_edges"])) in text
    assert "only: shopkit/discounts.py, shopkit/pr*.py; outside them, set aside with no breakpoint: %d items (%s:%s" % (len(left), left[0]["file"], left[0]["line"]) in text
    assert "set aside, no breakpoint (%d):" % len(full["aside"]) in text  # the plan's own aside, module-level and test-file changes, as before
    assert "only: shopkit/discounts.py, shopkit/pr*.py;" in render_text(run("state", dir=str(world.dir)))
    view = render_text(run("view", dir=str(world.dir), surface="vscode"))
    assert "only: shopkit/discounts.py, shopkit/pr*.py;" in view and len(world.fake.added) == 2 * len(review.stops)


def test_a_path_is_a_file_a_directory_or_a_glob_relative_to_the_repository(tmp_path):
    f = "libs/core/langchain_core/_security/_policy.py"
    assert inside_any(f, [f]) and inside_any(f, ["libs/core"]) and inside_any(f, ["libs/core/"]) and inside_any(f, ["."])
    assert inside_any(f, ["libs/*/langchain_core"]) and inside_any(f, ["libs/core/langchain_core/_security/_p*.py"])  # a glob names directories too
    assert not inside_any(f, ["libs/cor"]) and not inside_any(f, ["libs/core/langchain_core/_security/_pol"]) and not inside_any(f, ["*.txt"])
    repo = tmp_path / "repo"
    (repo / "libs" / "core").mkdir(parents=True)
    assert only_paths({"only": ["./libs/core/", str(repo / "libs" / "core" / "x.py"), "libs/core", "  "]}, str(repo)) == ["libs/core", "libs/core/x.py"]
    assert only_paths({"only": "libs"}, str(repo)) == ["libs"] and only_paths({}, str(repo)) == []


def test_only_that_leaves_no_item_is_refused_before_the_last_review_changes(world):
    _, first = start(world)
    exc = refusal("start", base=world.base, repo=str(world.repo), dir=str(world.dir), only=["tests", "docs/nothing"])
    assert "--only tests, docs/nothing leaves no item" in exc.why and "the agenda's files: shopkit/discounts.py" in exc.text
    assert exc.next_command == "review start --base REF --only PATH"
    assert Review.load(str(world.dir)).data == first.data and len(world.launches) == 1


def test_a_path_that_matches_no_changed_file_is_noted(world):
    answer, review = start(world, only=["shopkit/pricing.py", "shopkit/pricng.py"])
    assert "note: --only shopkit/pricng.py matched no changed file" in lines_of(answer)
    assert [s["file"] for s in review.stops] == ["shopkit/pricing.py"]


def test_only_on_a_recorded_review_is_refused_before_anything_runs(world):
    for fields in ({"full": True}, {"surface": "chat"}):
        exc = refusal("start", base=world.base, repo=str(world.repo), dir=str(world.dir), only=["shopkit"], **fields)
        assert "--only narrows the agenda of a review in the debugger" in exc.why
    assert not world.dir.exists() and not world.launches


# -- skip N [N …] --------------------------------------------------------------------------------------------------

def test_skip_takes_several_numbers_and_removes_their_breakpoints_in_one_call(world):
    _, review = start(world)
    calls: list[dict] = []
    real = world.fake.breakpoints
    world.fake.breakpoints = lambda **kw: (calls.append(kw), real(**kw))[1]
    two, four = review.stop(2), review.stop(4)
    lines = lines_of(run("skip", dir=str(world.dir), ns=[2, 4, 2], why="not in this sitting"))
    assert lines[1].startswith("skipped 2. change  %s:%d %s" % (two["file"], two["line"], two["function"])) and lines[1].endswith("; its breakpoint is removed")
    assert lines[2].startswith("skipped 4. change  %s:%d %s" % (four["file"], four["line"], four["function"])) and lines[2].endswith("; its breakpoint is removed")
    assert lines[3] == "why: not in this sitting" and lines[4] == "remaining: %s" % ", ".join(str(n) for n in review.remaining() if n not in (2, 4))
    assert lines[5] == "session: %s" % world.fake.descriptor["descriptor"]
    assert [c.get("remove") for c in calls] == [[{"file": str(world.repo / two["file"]), "line": two["line"]}, {"file": str(world.repo / four["file"]), "line": four["line"]}]]
    after = Review.load(str(world.dir))
    assert [s["n"] for s in after.skipped] == [2, 4] and [e["n"] for e in after.conversation if e["kind"] == "skip"] == [2, 4]
    run("skip", dir=str(world.dir), n=1, ns=[3], why="the person said so")  # MCP may send both
    assert [s["n"] for s in Review.load(str(world.dir)).skipped] == [2, 4, 3, 1]


def test_one_bad_number_refuses_the_whole_skip_before_anything_changes(world):
    _, review = start(world)
    pause_at(world, items_of(review)[0], {"total": "0.0"})
    run("stop", dir=str(world.dir), say="total is 0.0")
    before, removed = Review.load(str(world.dir)).data, list(world.fake.removed)
    assert refusal("skip", dir=str(world.dir), ns=[2, 99, 98], why="x").why == "items 99, 98 are not in the plan; nothing was skipped"
    assert refusal("skip", dir=str(world.dir), ns=[2, 1], why="x").why == "item 1 was shown already; nothing was skipped"
    exc = refusal("skip", dir=str(world.dir), ns=[2, 3])
    assert exc.why == "skip 2 3 needs --why TEXT, the reason the person gave" and exc.next_command == "review skip 2 3 --why TEXT"
    assert Review.load(str(world.dir)).data == before and world.fake.removed == removed
    # one number is refused in the words it always was
    assert refusal("skip", dir=str(world.dir), ns=[99], why="x").why == "item 99 is not in the plan"
    assert refusal("skip", dir=str(world.dir), n=1, why="x").why == "item 1 was shown already; nothing to skip"
    assert refusal("skip", dir=str(world.dir), ns=[]).why == "skip wants N, the item's number in the plan"


# -- close and report ------------------------------------------------------------------------------------------------

def test_close_takes_every_agenda_breakpoint_out_while_the_session_answers(world):
    _, review = start(world)
    first, second = items_of(review)[:2]
    pause_at(world, first, {"total": "0.0"})
    run("stop", dir=str(world.dir), say="total is 0.0")
    run("skip", dir=str(world.dir), ns=[second["n"]], why="a rename")
    # an uncaught exception outside every item becomes an item of its own, on a line the review set no breakpoint on
    world.fake.paused = {"file": str(world.repo / "main.py"), "line": 9, "reason": "exception", "function": "load"}
    world.fake.locals_ = {"text": "'$1,249.00'"}
    run("stop", dir=str(world.dir), say="text is '$1,249.00' with the comma still in", go_on=True)
    world.fake.removed.clear()
    lines = lines_of(run("close", dir=str(world.dir)))
    changes = [s for s in Review.load(str(world.dir)).stops if s["kind"] == "change"]
    assert world.fake.removed == [{"file": str(world.repo / s["file"]), "line": s["line"]} for s in changes]  # shown, skipped and remaining alike
    assert {"file": str(world.repo / "main.py"), "line": 9} not in world.fake.removed
    assert lines[1] == "breakpoints: removed the review's %d from VS Code, one per item on the agenda; the debug session stays open" % len(changes)
    # a session that is gone is left alone, silently
    world.fake.gone = True
    world.fake.removed.clear()
    lines = lines_of(run("close", dir=str(world.dir)))
    assert world.fake.removed == [] and lines[1].startswith("nothing to close")


def test_report_takes_the_reviews_breakpoints_out_too(world):
    _, review = start(world)
    world.fake.removed.clear()
    answer = run("report", dir=str(world.dir))
    assert len(world.fake.removed) == len(items_of(review)) and answer["lines"][-1].startswith("breakpoints: removed the review's %d " % len(items_of(review)))
