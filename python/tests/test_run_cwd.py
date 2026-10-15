"""``pyokka run FILE --cwd DIR``: the program runs in DIR, with and without --save."""

from __future__ import annotations

import json
import os
import subprocess
import sys

PY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def pyokka(*args, cwd=None):
    return subprocess.run([sys.executable, "-m", "pyokka_runtime", *args], capture_output=True, text=True, cwd=cwd, env={**os.environ, "PYTHONPATH": PY_DIR}, timeout=120)


def script(tmp_path):
    (tmp_path / "app").mkdir()
    (tmp_path / "elsewhere").mkdir()
    path = tmp_path / "app" / "where.py"
    path.write_text("import os\nprint('cwd=' + os.getcwd())\n")
    return path


def test_run_prints_the_given_directory(tmp_path):
    path = script(tmp_path)
    target = os.path.realpath(tmp_path / "elsewhere")
    out = pyokka("run", str(path), "--cwd", str(tmp_path / "elsewhere"))
    assert out.returncode == 0, out.stderr
    assert "cwd=%s" % target in out.stdout, out.stdout


def test_run_without_cwd_stays_in_the_files_directory(tmp_path):
    path = script(tmp_path)
    out = pyokka("run", str(path))
    assert "cwd=%s" % os.path.realpath(tmp_path / "app") in out.stdout, out.stdout


def test_save_runs_in_the_given_directory_and_records_it(tmp_path):
    path = script(tmp_path)
    run = tmp_path / "run.json"
    out = pyokka("run", str(path), "--cwd", "elsewhere", "--save", str(run), cwd=str(tmp_path))
    assert out.returncode == 0, out.stderr
    saved = json.loads(run.read_text())
    texts = "".join(e.get("text", "") for e in saved["events"] if e.get("type") in ("output", "log"))
    assert "cwd=%s" % os.path.realpath(tmp_path / "elsewhere") in texts, texts
    assert os.path.realpath(saved["meta"]["cwd"]) == os.path.realpath(tmp_path / "elsewhere")


def test_a_missing_directory_is_refused(tmp_path):
    path = script(tmp_path)
    out = pyokka("run", str(path), "--cwd", str(tmp_path / "nope"))
    assert out.returncode == 2
    assert "--cwd" in out.stderr and "nope" in out.stderr
