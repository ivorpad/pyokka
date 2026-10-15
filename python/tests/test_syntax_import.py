"""A SyntaxError in an imported module names that module's file and line."""

from __future__ import annotations

import json
import os
import subprocess
import sys

PY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(PY_DIR, "tests", "fixtures", "port", "syntax_import")
MAIN = os.path.join(FIXTURE, "main.py")
BAD = os.path.join(FIXTURE, "bad.py")


def run(*extra):
    return subprocess.run([sys.executable, "-m", "pyokka_runtime", "run", MAIN, *extra], capture_output=True, text=True, cwd=FIXTURE, env={**os.environ, "PYTHONPATH": PY_DIR}, timeout=60)


def uncaught(out):
    events = [json.loads(l) for l in out.stdout.splitlines() if l.startswith("{")]
    errors = [e for e in events if e.get("type") == "error" and not e.get("handled")]
    return [e for e in errors if e["stack"] and e["stack"][-1].get("path") == MAIN]


def test_the_import_error_stack_starts_in_the_bad_module():
    (err,) = uncaught(run("--json"))
    top = err["stack"][0]
    assert top["path"] == BAD, err["stack"]
    assert top["line"] == 2
    assert top["function"] == "<module>"
    assert not any("pyokka_runtime" in f["path"] for f in err["stack"]), err["stack"]


def test_the_message_is_the_compilers_once():
    (err,) = uncaught(run("--json"))
    assert err["errorType"] == "SyntaxError"
    assert err["message"] == "'(' was never closed"


def test_the_traceback_names_the_file_and_line():
    (err,) = uncaught(run("--json"))
    assert 'File "%s", line 2' % BAD in err["traceback"], err["traceback"]


def test_run_prints_bad_py_2():
    out = run()
    lines = [l for l in out.stdout.splitlines() if l.startswith("[error")]
    assert any("bad.py:2" in l for l in lines), out.stdout


def test_save_prints_bad_py_2(tmp_path):
    out = run("--save", str(tmp_path / "run.json"))
    assert "bad.py:2" in out.stdout, out.stdout
