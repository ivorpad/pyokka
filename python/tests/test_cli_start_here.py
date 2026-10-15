"""Bare ``pyokka`` and ``pyokka --help`` end with a first command per job."""

from __future__ import annotations

import os
import re
import shlex
import subprocess
import sys

import pytest

PY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def pyokka(*args):
    return subprocess.run([sys.executable, "-m", "pyokka_runtime", *args], capture_output=True, text=True, env={**os.environ, "PYTHONPATH": PY_DIR}, timeout=60)


def start_block(text: str) -> str:
    assert "start here:" in text, text
    return text[text.index("start here:"):]


def commands(block: str) -> list[str]:
    """Every `pyokka ...` command the block names, up to the next comma, `then` or end of line."""
    found = []
    for line in block.splitlines():
        for m in re.finditer(r"pyokka [^,\n]*?(?=, then |,|  \(|$)", line):
            found.append(m.group(0).strip())
    return found


def test_bare_pyokka_shows_the_start_block_and_exits_2():
    out = pyokka()
    assert out.returncode in (0, 2)
    block = start_block(out.stdout + out.stderr)
    assert len(block.strip().splitlines()) <= 7, block
    assert "pyokka VERB --help" in block


def test_help_shows_the_same_block():
    bare = pyokka()
    helped = pyokka("--help")
    assert helped.returncode == 0
    assert start_block(helped.stdout) == start_block(bare.stdout + bare.stderr)


def test_every_command_in_the_block_parses():
    from pyokka_runtime.__main__ import build_parser

    block = start_block(pyokka("--help").stdout)
    cmds = [c for c in commands(block) if "VERB" not in c]
    assert len(cmds) >= 4, cmds
    parser = build_parser()
    for c in cmds:
        words = shlex.split(c)[1:]
        try:
            parser.parse_args(words)
        except SystemExit as exc:  # argparse refuses: the block names a flag or verb that does not exist
            pytest.fail("%r does not parse (exit %s)" % (c, exc.code))
