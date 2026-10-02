"""What a recording leaves out is said, never dropped (handoffs/2026-10-01-pageindex-friction.md items 1-4).

The step cap (`run --max-steps`), code left out (`--exclude`, `--only`), values cut at
`--max-value-chars`, and the interpreter `run` picks for the program.
"""

from __future__ import annotations

import io
import json
import os
import stat
import sys
import textwrap
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from pyokka_runtime.__main__ import main
from pyokka_runtime.agent import interpreter
from pyokka_runtime.agent.recording import annotate_cut, cut_line
from pyokka_runtime.agent.source import AgentError
from pyokka_runtime.values import VALUE_CHARS_CEILING, value_chars, value_text

from tests.conftest import run_source

MAIN = """
from pkg.heavy import churn

prompt = "x" * 10000
a = churn(300)
b = a + 1
print("done", b)
"""
HEAVY = """
def churn(n):
    total = 0
    for i in range(n):
        total += i
    return total
"""


def pyokka(*args: str) -> tuple[int, str]:
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = main([str(a) for a in args])
    return code, buf.getvalue()


def pyokka_json(*args: str) -> dict:
    code, out = pyokka(*args, "--json")
    doc = json.loads(out)
    assert code == 0, doc
    return doc


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    proj = tmp_path / "proj"
    (proj / "pkg").mkdir(parents=True)
    (proj / ".git").mkdir()  # the .venv search stops here, so a .venv above the temp dir is never picked
    (proj / "main.py").write_text(textwrap.dedent(MAIN).lstrip(), encoding="utf-8")
    (proj / "pkg" / "__init__.py").write_text("", encoding="utf-8")
    (proj / "pkg" / "heavy.py").write_text(textwrap.dedent(HEAVY).lstrip(), encoding="utf-8")
    for var in ("VIRTUAL_ENV", "PYOKKA_PYTHON", "PYOKKA_REEXEC"):
        monkeypatch.delenv(var, raising=False)
    return proj


# -- 1. the step cap ---------------------------------------------------------------------------------------------

def test_a_run_past_max_steps_says_so_everywhere(project: Path):
    run = project / "run.json"
    code, out = pyokka("run", project / "main.py", "--save", run, "--max-steps", "40")
    assert code == 0
    lines = out.splitlines()
    assert lines[0].startswith("python: ")
    assert "40 of " in lines[1] and "steps recorded" in lines[1]
    warning = next(line for line in lines if line.startswith("WARNING: recording truncated at step 40"))
    assert "only the first 40 are recorded" in warning
    assert any(line.strip().startswith("most steps: pkg/heavy.py ") for line in lines)
    assert any("rerun with --exclude pkg/heavy.py" in line for line in lines)

    meta = json.loads(run.read_text())["meta"]
    info = meta["recording"]
    assert info["truncated"] and info["cap"] == 40 and info["kept"] == 40
    assert info["stepsRun"] == meta["stepCount"] > 600  # 300 iterations of a 2-statement loop, and more
    assert info["spentBy"][0]["path"] == "pkg/heavy.py" and info["spentBy"][0]["steps"] > 600
    assert info["exclude"] == "pkg/heavy.py"

    # every verb starts with the note; state too
    for verb in (["state"], ["walkthrough"], ["story"], ["steps"], ["var", "a"], ["context", "3"]):
        code, text = pyokka(verb[0], run, *verb[1:])
        assert code == 0, verb
        first = text.splitlines()[0]
        assert first.startswith("note: truncated recording: steps 0-39 of "), (verb, first)
        assert "(step cap 40)" in first and "rerun with --exclude pkg/heavy.py" in first

    doc = pyokka_json("state", run)
    assert doc["nav"]["count"] == 40
    assert doc["recording"]["truncated"] is True and doc["recording"]["stepsRun"] == info["stepsRun"]
    assert pyokka_json("walkthrough", run)["recording"]["cap"] == 40


def test_a_run_under_the_cap_has_no_note(project: Path):
    run = project / "run.json"
    code, out = pyokka("run", project / "main.py", "--save", run)
    assert code == 0 and "WARNING" not in out
    assert "recording" not in json.loads(run.read_text())["meta"]
    code, text = pyokka("state", run)
    assert not text.startswith("note:")
    assert "recording" not in pyokka_json("state", run)


def test_the_runtime_reports_who_spent_the_steps(tmp_path: Path):
    out = run_source(MAIN, tmp_path, name="main.py", files={"pkg/__init__.py": "", "pkg/heavy.py": HEAVY}, config={"maxTraceSteps": 25})
    trace = out.trace
    assert trace["truncated"] is True and trace["cap"] == 25
    assert trace["stepsRun"] == out.finished["stepCount"] > 25
    assert len(out.steps) == 25
    assert trace["spentBy"][0]["path"].endswith(os.path.join("pkg", "heavy.py"))


# -- 2. leaving code out ---------------------------------------------------------------------------------------------

@pytest.mark.parametrize("pattern", ["pkg.heavy", "pkg", "pkg/*", "pkg/heavy.py", "heavy.py"])
def test_an_excluded_module_runs_unrecorded(project: Path, pattern: str):
    run = project / "run.json"
    code, out = pyokka("run", project / "main.py", "--save", run, "--exclude", pattern)
    assert code == 0 and "WARNING" not in out
    doc = json.loads(run.read_text())
    paths = [e["path"] for e in doc["events"] if e.get("type") == "file.instrumented"]
    assert not any(p.endswith("heavy.py") for p in paths), (pattern, paths)
    assert doc["meta"]["stepCount"] < 10  # the module's statements only: churn's 600 steps ran unrecorded
    assert doc["meta"]["config"]["exclude"] == [pattern]
    printed = " ".join(e.get("text", "") for e in doc["events"] if e.get("type") in ("output", "log"))
    assert "done 44851" in printed  # it ran all the same


def test_only_records_the_named_modules(tmp_path: Path):
    files = {"pkg/__init__.py": "", "pkg/heavy.py": HEAVY, "other.py": "def f():\n    return 1\n"}
    src = "import other\nfrom pkg.heavy import churn\nx = churn(3) + other.f()\n"
    out = run_source(src, tmp_path, name="main.py", files=files, config={"only": ["pkg.*"]})
    paths = [e["path"] for e in out.of("file.instrumented")]
    assert any(p.endswith("heavy.py") for p in paths)
    assert not any(p.endswith("other.py") for p in paths)
    assert any(p.endswith("main.py") for p in paths)  # the program file is always recorded


def test_exclude_wins_over_only(tmp_path: Path):
    files = {"pkg/__init__.py": "", "pkg/heavy.py": HEAVY}
    out = run_source("from pkg.heavy import churn\nx = churn(3)\n", tmp_path, name="main.py", files=files, config={"only": ["pkg"], "exclude": ["pkg.heavy"]})
    assert not any(e["path"].endswith("heavy.py") for e in out.of("file.instrumented"))


# -- 3. values cut at --max-value-chars ----------------------------------------------------------------------------

def test_a_long_value_is_cut_loudly_by_default(project: Path):
    run = project / "run.json"
    assert pyokka("run", project / "main.py", "--save", run)[0] == 0
    code, text = pyokka("var", run, "prompt")
    assert code == 0
    line = next(line for line in text.splitlines() if "prompt = " in line)
    assert line.endswith("chars)") and "…(+9,8" in line
    change = pyokka_json("var", run, "prompt")["changes"][0]
    assert change["truncated"] is True and change["length"] == 10002  # the repr: 10,000 x and two quotes
    # the recording itself carries the fields, not just the CLI's annotation
    entries = [c for e in json.loads(run.read_text())["events"] if e.get("type") == "locals" for x in e["entries"] for c in x["changes"] if c["name"] == "prompt"]
    assert entries[0]["truncated"] is True and entries[0]["length"] == 10002


def test_max_value_chars_zero_keeps_the_whole_value(project: Path):
    run = project / "run.json"
    assert pyokka("run", project / "main.py", "--save", run, "--max-value-chars", "0")[0] == 0
    change = pyokka_json("var", run, "prompt")["changes"][0]
    assert change["text"] == repr("x" * 10000)
    assert "truncated" not in change
    # the text form still fits a line, and says by how much it cut
    line = next(line for line in pyokka("var", run, "prompt")[1].splitlines() if "prompt = " in line)
    assert line.endswith("chars)") and len(line) < 300


def test_max_value_chars_n_cuts_at_n(project: Path):
    run = project / "run.json"
    assert pyokka("run", project / "main.py", "--save", run, "--max-value-chars", "500")[0] == 0
    change = pyokka_json("var", run, "prompt")["changes"][0]
    assert change["truncated"] is True and change["length"] == 10002
    shown = change["text"][: change["text"].index("…(+")]
    assert 480 <= len(shown) <= 500
    assert change["text"].endswith("…(+%s chars)" % format(10002 - len(shown), ","))


def test_logged_values_carry_the_cut_too(tmp_path: Path):
    src = 'big = "y" * 5000\nbig  # ?\n'
    out = run_source(src, tmp_path, name="main.py", config={"maxValueChars": 300})
    log = next(e for e in out.logs if e.get("context") == "big")
    assert log["truncated"] is True and log["length"] == 5002
    shown = log["text"][: log["text"].index("…(+")]
    assert 280 <= len(shown) <= 300
    assert log["text"].endswith("…(+%s chars)" % format(5002 - len(shown), ","))
    # the expandable value is as long as the inline text asked for
    assert len(log["valueBag"]["data"]["value"]) >= 300


def test_value_text_shapes():
    assert value_text("abc", 120) == ("'abc'", None, False)
    text, length, cut = value_text({"role": "user", "content": "z" * 1000}, 120)
    assert cut and length == len(repr({"role": "user", "content": "z" * 1000}))
    assert text.endswith("chars)")
    items = list(range(100))
    text, length, cut = value_text(items, 120)
    assert cut and length == len(repr(items))

    class Opaque:
        def __repr__(self) -> str:
            return "O" * 400

    text, length, cut = value_text(Opaque(), 120)
    assert cut and length == 400
    assert value_chars(None, 120) == 120 and value_chars(0, 120) == VALUE_CHARS_CEILING
    assert value_chars(10**9, 120) == VALUE_CHARS_CEILING and value_chars(5000, 120) == 5000


def test_cli_line_cuts_add_up():
    recorded = "'" + "a" * 118 + "…(+9,000 chars)"
    line = cut_line(recorded, 60)
    assert len(line) <= 60 + 16 and line.endswith(" chars)")
    shown = line[: line.index("…")]
    assert line.endswith("…(+%s chars)" % format(len(recorded) - len("…(+9,000 chars)") - len(shown) + 9000, ","))
    doc = annotate_cut({"values": [{"text": "'abc'…(+10 chars)"}, {"text": "plain"}]})
    assert doc["values"][0] == {"text": "'abc'…(+10 chars)", "truncated": True, "length": 15}
    assert "truncated" not in doc["values"][1]


# -- 4. the program's interpreter ------------------------------------------------------------------------------------

def _fake_python(path: Path, body: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n" + body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


@pytest.mark.skipif(sys.platform == "win32", reason="a shell-script interpreter")
def test_a_dot_venv_next_to_the_program_runs_it(project: Path):
    # the venv's python is a wrapper around this interpreter that marks the environment, so the
    # program can say which one it ran under
    _fake_python(project / ".venv" / "bin" / "python", 'export FROM_FAKE_VENV=yes\nexec "%s" "$@"\n' % sys.executable)
    (project / "which.py").write_text("import os\nprint('venv:', os.environ.get('FROM_FAKE_VENV'))\n", encoding="utf-8")
    run = project / "run.json"
    code, out = pyokka("run", project / "which.py", "--save", run)
    assert code == 0, out
    first = out.splitlines()[0]
    assert first.startswith("python: %s" % (project / ".venv" / "bin" / "python")) and "(.venv in %s)" % project in first
    doc = json.loads(run.read_text())
    printed = " ".join(e.get("text", "") for e in doc["events"] if e.get("type") in ("output", "log"))
    assert "venv: yes" in printed
    assert doc["meta"]["interpreterSource"] == ".venv in %s" % project


@pytest.mark.skipif(sys.platform == "win32", reason="a shell-script interpreter")
def test_interpreter_order(project: Path, tmp_path: Path):
    venv = project / ".venv"
    _fake_python(venv / "bin" / "python", 'echo 3.12.1\n')
    sub = project / "pkg"
    assert interpreter.choose(str(sub / "heavy.py"), env={}).source == ".venv in %s" % project
    active = tmp_path / "active"
    _fake_python(active / "bin" / "python", 'echo 3.12.1\n')
    assert interpreter.choose(str(project / "main.py"), env={"VIRTUAL_ENV": str(active)}).path == str(active / "bin" / "python")
    named = _fake_python(tmp_path / "named" / "python", 'echo 3.12.1\n')
    chosen = interpreter.choose(str(project / "main.py"), env={"VIRTUAL_ENV": str(active), "PYOKKA_PYTHON": str(named)})
    assert chosen.path == str(named) and chosen.source == "$PYOKKA_PYTHON"
    flag = interpreter.choose(str(project / "main.py"), python=str(active), env={"PYOKKA_PYTHON": str(named)})
    assert flag.path == str(active / "bin" / "python") and flag.source == "--python"
    # nothing found: pyokka's own, and the search stopped at the git root
    (venv / "bin" / "python").unlink()
    own = interpreter.choose(str(project / "main.py"), env={})
    assert own.is_own and own.source.startswith("pyokka's own")


@pytest.mark.skipif(sys.platform == "win32", reason="a shell-script interpreter")
def test_an_old_interpreter_is_refused_by_name(project: Path, tmp_path: Path):
    old = _fake_python(tmp_path / "old" / "python", 'echo 3.11.9\n')
    with pytest.raises(AgentError) as err:
        interpreter.probe(interpreter.choose(str(project / "main.py"), python=str(old), env={}))
    assert "3.11.9" in err.value.message and "3.12 or newer" in err.value.message
    code, _ = pyokka("run", project / "main.py", "--save", project / "run.json", "--python", old)
    assert code == 2


@pytest.mark.skipif(sys.platform == "win32", reason="a shell-script interpreter")
def test_the_in_process_run_starts_again_under_the_venv(project: Path):
    import subprocess

    _fake_python(project / ".venv" / "bin" / "python", 'export FROM_FAKE_VENV=yes\nexec "%s" "$@"\n' % sys.executable)
    (project / "which.py").write_text("import os\nprint('venv:', os.environ.get('FROM_FAKE_VENV'))\n", encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if k not in ("VIRTUAL_ENV", "PYOKKA_PYTHON", "PYOKKA_REEXEC")}
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1])
    done = subprocess.run([sys.executable, "-m", "pyokka_runtime", "run", str(project / "which.py")], capture_output=True, text=True, env=env, timeout=60)
    assert done.returncode == 0, done.stderr
    lines = done.stdout.splitlines()
    assert lines[0].startswith("python: %s" % (project / ".venv" / "bin" / "python")) and "(.venv in %s)" % project in lines[0]
    assert any("venv: yes" in line for line in lines)
