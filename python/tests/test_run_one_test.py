"""``run --test NAME`` records one test's body under its runner; ``debug --test`` launches the same way."""

from __future__ import annotations

import io
import os
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from pyokka_runtime.__main__ import main
from pyokka_runtime.agent.commands import debug_launch
from pyokka_runtime.agent.shell import build_parser

TESTS = """\
import unittest


def total(items):
    return sum(items)


def test_a():
    in_a = total([1, 2])
    assert in_a == 3


def test_b():
    in_b = total([10, 20])
    assert in_b == 30


class Cart(unittest.TestCase):
    def test_total(self):
        in_cart = total([5])
        self.assertEqual(in_cart, 5)

    def test_other(self):
        in_other = total([7])
        self.assertEqual(in_other, 7)
"""


def pyokka(*words: str) -> tuple[int, str]:
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = main(list(words))
    return code, buf.getvalue()


@pytest.fixture
def test_file(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.delenv("PYOKKA_PYTHON", raising=False)  # the runner is this interpreter, which has pytest
    (tmp_path / "test_x.py").write_text(TESTS, encoding="utf-8")
    return tmp_path / "test_x.py"


@pytest.mark.parametrize(("name", "ran", "skipped"), [
    ("test_b", "in_b = total([10, 20])", ["in_a = ", "in_cart = ", "in_other = "]),
    ("Cart.test_total", "in_cart = total([5])", ["in_a = ", "in_b = ", "in_other = "]),
])
def test_only_the_named_tests_body_is_recorded(test_file: Path, name: str, ran: str, skipped: list[str]):
    run = test_file.parent / "run.json"
    code, out = pyokka("run", str(test_file), "--test", name, "--save", str(run), "--python", os.sys.executable)
    assert code == 0, out
    code, story = pyokka("story", str(run))
    assert code == 0, story
    assert ran in story
    for other in skipped:
        assert other not in story, story


def test_debug_test_launches_the_runner_on_the_file(test_file: Path):
    args = build_parser().parse_args(["debug", str(test_file), "--test", "test_b", "--at", "test_b", "--args", "-x"])
    launch = debug_launch(args)
    assert "program" not in launch
    assert launch["module"] == "pytest"
    assert launch["args"][0] == "%s::test_b" % test_file and launch["args"][-1] == "-x"
    assert launch["cwd"] == str(test_file.parent)
    unit = debug_launch(build_parser().parse_args(["debug", str(test_file), "--test", "Cart.test_total"]))
    assert (unit["module"], unit["args"]) == ("unittest", ["test_x.Cart.test_total"])
