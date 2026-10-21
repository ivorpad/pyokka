"""`pin`, `investigate`, `learn` and `verify` over saved runs.

`cart_unfixed.py` adds where it should multiply (total 14); `cart_fixed.py` multiplies (total 22).
Both are recorded at the same path, the way a fix happens, so `verify` compares a before and an
after of one file.
"""

from __future__ import annotations

import io
import json
import shutil
import subprocess
import sys
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from pyokka_runtime.__main__ import main

PORT = Path(__file__).resolve().parent / "fixtures" / "port"


def pyokka(*args: object) -> tuple[int, str]:
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = main([str(a) for a in args])
    return code, buf.getvalue()


def record(src: Path, app: Path, out: Path, *extra: str) -> Path:
    shutil.copyfile(src, app)
    code, _ = pyokka("run", app, "--save", out, *extra)
    assert code == 0
    return out


@pytest.fixture
def runs(tmp_path: Path) -> dict[str, Path]:
    (tmp_path / ".git").mkdir()
    app = tmp_path / "cart.py"
    before = record(PORT / "cart_unfixed.py", app, tmp_path / "before.json")
    return {"app": app, "before": before}


def pyokka_json(*args: object) -> tuple[int, dict]:
    code, out = pyokka(*args, "--json")
    return code, json.loads(out)


def test_investigate_names_the_assigning_step_and_its_line(tmp_path: Path):
    run = tmp_path / "rrf.json"
    assert pyokka("run", PORT.parents[3] / "examples" / "rrf" / "demo.py", "--save", run)[0] == 0
    code, result = pyokka_json("investigate", run, "--value", "fused_ranking")
    assert code == 0
    change = result["history"]["changes"][-1]
    assert (change["line"], change["function"]) == (124, "main")  # fused_ranking = sorted(
    assert result["selection"]["changeStep"] == change["step"]
    assert result["why"]["step"] == change["step"]
    # the value is visible from the scope's next step, where origin starts its chain
    assert result["step"] == result["selection"]["observedStep"] > change["step"]
    assigned = [l for l in result["origin"]["links"] if l["how"] == "assigned"]
    assert (assigned[0]["step"], assigned[0]["line"]) == (change["step"], 124)
    _, text = pyokka("investigate", run, "--value", "fused_ranking")
    assert "selected: #%d demo.py:124 main" % change["step"] in text


def test_investigate_says_where_a_cut_recording_has_gaps(tmp_path: Path):
    app = tmp_path / "cart.py"
    run = record(PORT / "cart_unfixed.py", app, tmp_path / "cut.json", "--max-steps", "6")
    doc = json.loads(run.read_text())
    doc["events"] = [e for e in doc["events"] if e.get("type") != "run.finished"]
    for e in doc["events"]:
        if e.get("type") == "trace":
            e["midRun"] = True
    for f in doc["meta"]["files"]:
        f.pop("source", None)
    run.write_text(json.dumps(doc))
    code, result = pyokka_json("investigate", run, "--value", "total")
    assert code == 0
    notes = " | ".join(result["notes"])
    assert "truncated at its step cap" in notes
    assert "began partway through execution" in notes
    assert "no run.finished event" in notes
    assert "No recorded source copy of cart.py" in notes


def test_learn_hides_the_value_until_reveal_then_shows_it_and_the_match(runs: dict[str, Path]):
    code, lesson = pyokka_json("learn", runs["before"])
    assert code == 0
    printed = next(c for c in lesson["checkpoints"] if c["kind"] == "print")  # print(total), which printed 14
    hidden_code, hidden = pyokka("learn", runs["before"], "--at", printed["step"], "--prediction", "22")
    assert hidden_code == 0 and "your prediction: 22" in hidden
    assert "recorded:" not in hidden and "match:" not in hidden
    _, hidden_json = pyokka_json("learn", runs["before"], "--at", printed["step"], "--prediction", "22")
    assert "14" not in json.dumps({k: v for k, v in hidden_json.items() if k not in ("notes", "coverage", "checkpoints")})
    _, shown = pyokka("learn", runs["before"], "--at", printed["step"], "--prediction", "22", "--reveal")
    assert "printed = 14" in shown and "match: no recorded value" in shown
    _, right = pyokka_json("learn", runs["before"], "--at", printed["step"], "--prediction", "14", "--reveal")
    assert right["match"]["matched"] and right["match"]["text"] == "14"


def test_verify_passes_on_the_fix_and_fails_without_it(runs: dict[str, Path], tmp_path: Path):
    after = record(PORT / "cart_fixed.py", runs["app"], tmp_path / "after.json")
    code, result = pyokka_json("verify", runs["before"], "--after", after, "--expect", "total=22")
    assert code == 0 and result["verified"]
    assert result["checks"][0]["actual"] == "22"
    unfixed = record(PORT / "cart_unfixed.py", runs["app"], tmp_path / "unfixed.json")
    code, text = pyokka("verify", runs["before"], "--after", unfixed, "--expect", "total=22")
    assert code == 1
    assert "FAIL total = 14" in text and "not verified" in text


def test_verify_without_expect_still_gives_a_verdict(runs: dict[str, Path], tmp_path: Path):
    # the same program again: nothing differs, and the last line says PASS rather than leaving the reader to infer it
    same = record(PORT / "cart_unfixed.py", runs["app"], tmp_path / "same.json")
    code, text = pyokka("verify", runs["before"], "--after", same)
    assert code == 0
    assert text.rstrip().endswith("PASS: no expectations given; the after run has no behaviour difference from the baseline")
    assert "not verified" not in text and "No --expect values given" not in text
    # the fix: the runs differ, so no PASS, a count and the way to a real verdict; the exit code stays 0 (only a failed --expect is 1)
    fixed = record(PORT / "cart_fixed.py", runs["app"], tmp_path / "fixed.json")
    code, result = pyokka_json("verify", runs["before"], "--after", fixed)
    assert code == 0 and not result["verified"] and result["total"] >= 1
    assert result["verdict"] == "no expectations given; the runs differ in %d statements (see above); pass --expect NAME=VALUE for a verdict" % result["total"]
    _, text = pyokka("verify", runs["before"], "--after", fixed)
    assert text.rstrip().endswith(result["verdict"]) and "did something different" in text
    # with an expectation the verdict is the expectation's, as before
    _, checked = pyokka_json("verify", runs["before"], "--after", fixed, "--expect", "total=22")
    assert checked["verified"] and "verdict" not in checked


def test_verify_refuses_an_incomplete_recording(runs: dict[str, Path], tmp_path: Path):
    cut = record(PORT / "cart_fixed.py", runs["app"], tmp_path / "cut.json", "--max-steps", "6")
    code, result = pyokka_json("verify", runs["before"], "--after", cut, "--expect", "total=22")
    assert code == 1 and not result["verified"]
    assert result["checks"][0]["reason"] == "the final value is not supported by a complete recording"


def test_verify_rerun_writes_a_pytest_file_that_passes(runs: dict[str, Path], tmp_path: Path):
    shutil.copyfile(PORT / "cart_fixed.py", runs["app"])
    test_file = tmp_path / "test_cart_regression.py"
    code, result = pyokka_json("verify", runs["before"], "--rerun", "--expect", "total=22", "--test-out", test_file)
    assert code == 0 and result["verified"] and result["test"] == str(test_file)
    ran = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", str(test_file)], cwd=tmp_path, capture_output=True, text=True, timeout=120)
    assert ran.returncode == 0, ran.stdout + ran.stderr
    assert pyokka("verify", runs["before"], "--rerun", "--expect", "total=22", "--test-out", test_file)[0] == 2


def test_pin_copies_the_run_byte_for_byte_and_refuses_to_overwrite(runs: dict[str, Path], tmp_path: Path):
    out = tmp_path / "baseline.json"
    code, text = pyokka("pin", runs["before"], "--out", out)
    assert code == 0 and str(out) in text
    assert out.read_bytes() == runs["before"].read_bytes()
    out.write_bytes(b"kept")
    code, _ = pyokka("pin", runs["before"], "--out", out)
    assert code == 2
    assert out.read_bytes() == b"kept"


def test_verify_says_why_when_the_values_hold_but_the_run_failed(runs: dict[str, Path], tmp_path: Path):
    # the fix plus an error after it: PASS and "not verified" must give the same reason, not "fix the code"
    shutil.copyfile(PORT / "cart_fixed.py", runs["app"])
    with runs["app"].open("a", encoding="utf-8") as f:
        f.write('\nraise ValueError("after the fix")\n')
    pyokka("run", runs["app"], "--save", tmp_path / "failed.json")
    code, text = pyokka("verify", runs["before"], "--after", tmp_path / "failed.json", "--expect", "total=22")
    lines = text.rstrip().splitlines()
    assert code == 1 and lines[-2].startswith("PASS total = 22")
    assert lines[-1].startswith("not verified: every expected value holds, but the run ended with exit code 1 (ValueError: after the fix)")


def test_verify_lists_the_edited_statement_first(tmp_path: Path):
    # a value that differs on every run (the clock) comes before the edit in step order; the edit is listed first
    app = tmp_path / "loop.py"
    app.write_text("import time\nstamp = time.time_ns()\ntotal = 0\nfor n in range(1, 4):\n    total += n\n", encoding="utf-8")
    pyokka("run", app, "--save", tmp_path / "a.json")
    app.write_text(app.read_text(encoding="utf-8").replace("range(1, 4)", "range(1, 5)"), encoding="utf-8")
    pyokka("run", app, "--save", tmp_path / "b.json")
    _, result = pyokka_json("verify", tmp_path / "a.json", "--after", tmp_path / "b.json")
    assert [e["status"] for e in result["statements"]][0] == "edited"
    assert result["firstDifference"]["lineB"] == 2  # still the earliest by step


def test_verify_lists_an_auto_logged_value_once(tmp_path: Path):
    # auto-logged runs (the Time Machine's): the logged value and the variable history's change are one fact
    app = tmp_path / "loop.py"
    app.write_text("total = 0\nfor n in range(1, 4):\n    total += n\n", encoding="utf-8")
    pyokka("run", app, "--save", tmp_path / "a.json", "--auto-log")
    app.write_text(app.read_text(encoding="utf-8").replace("range(1, 4)", "range(1, 5)"), encoding="utf-8")
    pyokka("run", app, "--save", tmp_path / "b.json", "--auto-log")
    _, text = pyokka("verify", tmp_path / "a.json", "--after", tmp_path / "b.json", "--expect", "total=10")
    assert text.count("total = 10   only in b") == 1
