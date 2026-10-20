"""`review start` with no main.py points at the repository's tests, and a test file as --entry is refused (start._entry).

A Codex harness on the 0.5.3 text (2026-10-17): asked to review a tests-only repository in VS Code, one run in three took
`--entry tests/test_money.py`, which runs the file as a program (imports and definitions, no test) and compared two runs
that ran no test; the refusal that found no main.py had said `--entry FILE` first.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from pyokka_runtime.__main__ import build_parser
from pyokka_runtime.agent.review import start as review_start
from pyokka_runtime.agent.review.state import Refusal

CART = "import unittest\n\n\ndef test_free():\n    assert 0 == 0\n\n\nclass Cart(unittest.TestCase):\n    def test_total(self):\n        self.assertEqual(1, 1)\n"
API = "class TestApi:\n    def test_get(self):\n        assert True\n\n    def helper(self):\n        pass\n"


def _repo(tmp_path: Path, files: dict[str, str]) -> tuple[str, str]:
    repo = tmp_path / "repo"
    for rel, text in files.items():
        (repo / rel).parent.mkdir(parents=True, exist_ok=True)
        (repo / rel).write_text(text)
    env = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "HOME": str(tmp_path)}
    for words in (["init", "-q"], ["add", "-A"], ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "base"]):
        subprocess.run(["git", *words], cwd=repo, check=True, capture_output=True, env=env)
    base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True, env=env).stdout.strip()
    return str(repo), base


def test_no_main_py_points_at_the_tests_and_says_what_a_test_file_as_entry_would_run(tmp_path):
    repo, base = _repo(tmp_path, {"tests/test_cart.py": CART, "tests/test_api.py": API, "pkg/lib.py": "X = 1\n"})
    with pytest.raises(Refusal) as caught:
        review_start._entry(repo, None, None, base)
    assert caught.value.why.startswith("no entry: there is no main.py at ")
    assert caught.value.details[0].startswith("give --entry FILE, a program both trees run, or --test FILE::NAME, one test (a test file as --entry runs its imports and definitions, not its tests)")
    assert caught.value.details[0].endswith(": test files here: tests/test_api.py, tests/test_cart.py")
    assert caught.value.next_command == "review start --base REF --test FILE::NAME"


def test_no_main_py_and_no_tests_asks_for_an_entry(tmp_path):
    repo, base = _repo(tmp_path, {"pkg/lib.py": "X = 1\n"})
    with pytest.raises(Refusal) as caught:
        review_start._entry(repo, None, None, base)
    assert "test files here" not in caught.value.details[0] and caught.value.next_command == "review start --base REF --entry FILE"


def test_a_test_file_as_entry_is_refused_with_the_tests_it_defines(tmp_path):
    repo, base = _repo(tmp_path, {"tests/test_cart.py": CART, "tests/test_api.py": API})
    with pytest.raises(Refusal) as caught:
        review_start._entry(repo, "tests/test_cart.py", None, base)
    assert caught.value.why == "tests/test_cart.py is a test file: run as a program it defines its tests and runs none (its imports and definitions only), so both trees would run no test"
    assert caught.value.details == ["give --test tests/test_cart.py::NAME for one of its tests (test_free, Cart.test_total), or --entry a program file both trees run"]
    assert caught.value.next_command == "review start --base REF --test tests/test_cart.py::NAME"
    # a pytest-style class takes the node id form; a unittest class the dotted one
    assert review_start._test_names(os.path.join(repo, "tests/test_api.py")) == ["TestApi::test_get"]
    # the same file with its test named is the test's file, not a program: no refusal
    assert review_start._entry(repo, "tests/test_cart.py", "tests/test_cart.py::Cart.test_total", base) == "tests/test_cart.py"
    assert review_start._entry(repo, None, "tests/test_cart.py::test_free", base) == "tests/test_cart.py"


def test_is_test_file_matches_both_conventions():
    assert review_start._is_test_file("tests/test_x.py") and review_start._is_test_file("pkg/x_test.py")
    assert not review_start._is_test_file("tests/conftest.py") and not review_start._is_test_file("main.py") and not review_start._is_test_file("tests/run_all.py")


def test_the_cli_has_a_view_action():
    args = build_parser().parse_args(["review", "view", "--surface", "page", "--port", "4790"])
    assert (args.action, args.surface, args.port) == ("view", "page", 4790)
    assert build_parser().parse_args(["review", "view"]).surface is None


def test_a_run_that_recorded_nothing_is_refused_with_the_runners_words(tmp_path):
    """The harness case: no pytest in the interpreter, so the test runner ran nothing and both recordings held 0 steps."""
    from types import SimpleNamespace

    empty = tmp_path / "head.json"
    empty.write_text(json.dumps({"meta": {"file": str(tmp_path / "tests" / "test_x.py"), "stepCount": 0, "exitCode": 1, "files": []},
                                 "events": [{"type": "run.started", "seq": 1}, {"type": "runner.error", "message": "cannot run -m pytest: ImportError: No module named pytest", "seq": 2},
                                            {"type": "run.finished", "exitCode": 1, "stepCount": 0, "seq": 3}]}))
    interp = SimpleNamespace(path="/usr/bin/python3")
    with pytest.raises(Refusal) as caught:
        review_start._check_ran(str(empty), "head", "tests/test_x.py::X::test_a", interp)
    assert caught.value.why == "the head run recorded no statement (exit 1): cannot run -m pytest: ImportError: No module named pytest"
    assert caught.value.details == ["the test ran nothing: a runner that is not installed in /usr/bin/python3 is the usual cause; a unittest class runs without pytest as --test FILE::Class.test, or pass --python an interpreter that has pytest"]
    assert caught.value.next_command == "review start --base REF --test FILE::Class.test, or --python P"
    with pytest.raises(Refusal) as caught:
        review_start._check_ran(str(empty), "base", None, interp)
    assert caught.value.why.startswith("the base run recorded no statement (exit 1)") and "the entry ran nothing of the tree" in caught.value.details[0]
    assert caught.value.next_command == "review start --base REF --entry FILE --python P"
    ran = tmp_path / "ran.json"
    ran.write_text(json.dumps({"meta": {"file": str(tmp_path / "main.py"), "stepCount": 12, "exitCode": 0, "files": []}, "events": []}))
    assert review_start._check_ran(str(ran), "head", None, interp) is None  # a run with steps: nothing to refuse
    # a base that ran nothing with no runner error is a tree the change made run: a note, not a refusal
    silent = tmp_path / "base.json"
    silent.write_text(json.dumps({"meta": {"file": str(tmp_path / "main.py"), "stepCount": 0, "exitCode": 1, "files": []}, "events": [{"type": "run.finished", "exitCode": 1, "stepCount": 0, "seq": 1}]}))
    assert review_start._check_ran(str(silent), "base", None, interp) == "note: the base run recorded no statement (exit 1): everything head ran is new since base"
    with pytest.raises(Refusal):
        review_start._check_ran(str(silent), "head", None, interp)  # a head that ran nothing is no review
