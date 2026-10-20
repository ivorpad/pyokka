"""``pyokka review ...`` through the CLI: the parser, the header first and ``next:`` last, a refusal on stderr
with exit 2, ``--json``, the current review when ``--dir`` is left out, and the shell's refusal.

The repository, the started review and the fakes come from ``test_review_actions.py``.
"""

from __future__ import annotations

import io
import json
import re
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import pytest

from pyokka_runtime.__main__ import main
from pyokka_runtime.agent.review.state import Review
from pyokka_runtime.agent.shell import _prepare, build_parser
from pyokka_runtime.agent.source import AgentError
from tests.test_review_actions import TYPE_ERROR, fakes, fresh, shop, shown_both, started  # noqa: F401  pytest fixtures


def pyokka(*args: object) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = main([str(a) for a in args])
    return code, out.getvalue(), err.getvalue()


def test_start_prints_the_header_first_and_next_last_and_sets_the_current_review(shop, tmp_path, fakes, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setenv("PYOKKA_HOME", str(home))
    code, out, err = pyokka("review", "start", "--base", shop.base, "--repo", shop.repo, "--full")
    assert code == 0 and err == "", err
    lines = out.rstrip("\n").split("\n")
    assert re.match(r"^review shop-[0-9a-f]{7} · stops · stops 0/2 shown · findings 0 · tries 0$", lines[0])
    assert lines[-1] == "next: review stop 1 --say TEXT"
    directory = home / "reviews" / ("shop-" + shop.base[:7])
    assert directory.is_dir() and (home / "reviews" / "current").read_text().strip() == str(directory)
    assert "review directory %s" % directory in lines[1]
    code, out, err = pyokka("review", "state")  # no --dir: the current review
    assert code == 0 and out.split("\n")[0] == lines[0] and out.rstrip("\n").endswith("next: review stop 1 --say TEXT")


def test_a_refusal_goes_to_stderr_with_exit_2_and_an_answer_to_stdout(started, tmp_path, fakes):
    r = fresh(started, tmp_path)
    code, out, err = pyokka("review", "stop", "1", "--say", "looks fine", "--dir", r.dir)
    assert code == 2 and out == ""
    lines = err.rstrip("\n").split("\n")
    assert lines[0].startswith("review shop-") and lines[1] == "refused: --say names none of the stop's values" and lines[-1] == "next: review stop 1 --say TEXT"
    assert any(l.strip().startswith("lines = [Line(") for l in lines)
    step = Review.load(str(r.dir)).stop(1)["step_b"]
    code, out, err = pyokka("review", "stop", "1", "--say", "step %d: %s, caught one line below" % (step, TYPE_ERROR), "--surface", "chat", "--dir", r.dir)
    assert code == 0 and err == ""
    lines = out.rstrip("\n").split("\n")
    assert "stops 1/2 shown" in lines[0] and lines[-1] == "next: wait for the person; when they say next, review stop 2 --say TEXT --go-on"
    assert any(l.startswith("step %d/" % step) for l in lines) and any(l.startswith("say: step %d" % step) for l in lines)
    # the next stop waits for the person: refused without --go-on, shown with it
    code, out, err = pyokka("review", "stop", "2", "--say", "unit_price = '1,249.00'", "--surface", "chat", "--dir", r.dir)
    assert code == 2 and "refused: the person has not spoken since stop 1; pass --go-on only after they said next, or answer them with ask/try/look" in err
    code, out, err = pyokka("review", "skip", "2", "--why", "they want the fix, not the walk", "--dir", r.dir)
    assert code == 0 and out.split("\n")[1].startswith("skipped 2. type  shopkit/orders.py:30") and out.rstrip("\n").endswith("next: review finding add --file F --line L --severity blocker|major|minor --title T --step N --repro ID|CMD --fix TEXT")
    code, out, err = pyokka("review", "look", "--expr", "len(lines)", "--dir", r.dir)
    lines = out.rstrip("\n").split("\n")
    assert code == 0 and lines[1].startswith("look len(lines)  at step %d  shopkit/pricing.py:12 subtotal" % step) and lines[-1] == "next: wait for the person"
    assert lines[2].startswith("not evaluated: the recorded text of lines is not a literal") and any(l.strip().startswith("lines = [Line(sku='MON-27'") for l in lines)


def test_json_prints_the_raw_shapes(started, tmp_path, fakes):
    r = fresh(started, tmp_path)
    code, out, err = pyokka("review", "--json", "state", "--dir", r.dir)
    doc = json.loads(out)
    assert code == 0 and doc["kind"] == "review" and doc["header"].startswith("review shop-") and doc["next"] == "review stop 1 --say TEXT"
    assert doc["plan"]["stops"][0]["n"] == 1 and doc["phase"] == "stops"
    code, out, err = pyokka("review", "--json", "stop", "7", "--say", "x", "--dir", r.dir)
    doc = json.loads(out)
    assert code == 2 and err == "" and doc["ok"] is False and doc["error"] == "stop 7 is not in the plan" and doc["next"] == "review stop 1 --say TEXT"
    code, out, err = pyokka("review", "state", "--dir", r.dir, "--json")  # after the action too, where an agent types it
    assert code == 0 and json.loads(out)["kind"] == "review"


def test_view_takes_the_surface_as_a_word_the_way_the_hints_say_it(tmp_path, monkeypatch):
    monkeypatch.setenv("PYOKKA_HOME", str(tmp_path / "home"))
    code, out, err = pyokka("review", "view", "vscode", "--dir", str(tmp_path / "nowhere"))
    assert code == 2 and "refused: no review in %s" % (tmp_path / "nowhere") in err, err  # parsed, then refused on the review, not on the word
    with pytest.raises(SystemExit):  # a word that is no surface is the parser's refusal, before any review is read
        pyokka("review", "view", "elsewhere", "--dir", str(tmp_path / "nowhere"))


def test_without_an_action_or_a_review(tmp_path, monkeypatch):
    monkeypatch.setenv("PYOKKA_HOME", str(tmp_path / "home"))
    code, out, err = pyokka("review")
    assert code == 2 and err.split("\n")[1] == "refused: review needs an action"
    code, out, err = pyokka("review", "state")
    assert code == 2 and "refused: no review to continue" in err and err.rstrip("\n").endswith("next: review start --base REF")
    code, out, err = pyokka("review", "stop", "1", "--say", "x", "--dir", str(tmp_path / "nowhere"))
    assert code == 2 and "refused: no review in %s" % (tmp_path / "nowhere") in err


def test_finding_try_fix_and_report_words(started, tmp_path, fakes):
    r = fresh(started, tmp_path)
    shown_both(r)
    code, out, err = pyokka("review", "finding", "add", "--file", "shopkit/money.py", "--line", "14", "--severity", "blocker", "--title", "t", "--dir", r.dir)
    assert code == 2 and "refused: finding add needs --repro, --fix" in err and err.rstrip("\n").endswith("next: review finding add --file F --line L --severity blocker|major|minor --title T --step N --repro ID|CMD --fix TEXT")
    code, out, err = pyokka("review", "try", "--expr", "2 + 2", "--title", "arithmetic", "--dir", r.dir)
    lines = out.rstrip("\n").split("\n")
    assert code == 0 and "tries 1" in lines[0] and lines[1].startswith("  t1  arithmetic  surface: headless") and "    result: 4" in lines
    assert lines[-2] == "a finding built on it: --repro t1" and lines[-1] == "next: wait for the person"
    code, out, err = pyokka("review", "fix", "--patch", str(tmp_path / "none.diff"), "--dir", r.dir)
    assert code == 2 and "refused: nothing to fix yet: no finding" in err
    code, out, err = pyokka("review", "report", "--dir", r.dir)
    assert code == 0 and "## Findings" in out and "No findings." in out and out.rstrip("\n").endswith("next: review state")
    assert (Path(r.dir) / "report.md").exists()


def test_the_parser_takes_several_paths_for_only_and_several_numbers_for_skip():
    from pyokka_runtime.__main__ import build_parser as cli_parser

    args = cli_parser().parse_args(["review", "start", "--base", "B", "--only", "a", "b"])
    assert args.only == ["a", "b"] and args.args == []
    args = cli_parser().parse_args(["review", "start", "--base", "B", "--only", "a", "--only", "b/*.py", "--", "x"])
    assert args.only == ["a", "b/*.py"] and args.args == ["x"]  # the flag repeats, and the program's arguments still come after --
    assert cli_parser().parse_args(["review", "start", "--base", "B"]).only is None
    args = cli_parser().parse_args(["review", "skip", "3", "4", "5", "--why", "x"])
    assert args.ns == [3, 4, 5] and args.why == "x"
    assert cli_parser().parse_args(["review", "skip", "2", "--why", "x"]).ns == [2]


def test_review_is_refused_inside_the_shell():
    with pytest.raises(AgentError, match="review keeps its own state"):
        _prepare(build_parser(), ["review", "state"], False)
