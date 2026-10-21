"""The replay prototype, end to end: every case runs replay.py the way a person would.

    python/.venv/bin/python -m pytest prototypes/replay -q
"""

from __future__ import annotations

import json
import os
import random
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
FIXTURES = HERE / "fixtures"
REPLAY = str(HERE / "replay.py")
ENV = {**os.environ, "PYTHONPATH": str(REPO / "python")}

sys.path.insert(0, str(HERE))
sys.path.insert(0, str(REPO / "python"))

from replay import Recording  # noqa: E402


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, *args], capture_output=True, text=True, env=ENV, timeout=120)


def record(tmp_path: Path, program: Path) -> Path:
    out = tmp_path / ("rec-%s.json" % program.stem)
    done = run(REPLAY, "record", str(program), "--out", str(out))
    assert done.returncode == 0, done.stdout + done.stderr
    return out


def first_step_on(rec: Recording, where: str) -> int:
    return next(n for n in range(rec.count) if rec.locate(rec.steps[4 * n], rec.steps[4 * n + 1]).startswith(where + " "))


def test_a_pyokka_run_replays_step_for_step_and_a_later_watch_gets_the_whole_value(tmp_path: Path) -> None:
    saved = tmp_path / "run.json"
    done = run("-m", "pyokka_runtime", "run", str(FIXTURES / "invoices.py"), "--save", str(saved))
    assert done.returncode == 0, done.stdout + done.stderr
    values = tmp_path / "values.json"
    done = run(REPLAY, "replay", str(saved), "--watch", "47:orders", "--values", str(values))
    assert done.returncode == 0, done.stdout + done.stderr
    assert "81 of 81 steps matched, exit code 0 both times" in done.stdout
    # what the recording kept for the same name was cut; the replay's copy is whole
    kept = next(line for line in done.stdout.splitlines() if "the recording kept:" in line)
    assert "…(+" in kept and "{...}" in kept
    hit = json.loads(values.read_text())["watches"][0]["hits"][0]
    customers = {k["value"]: v for k, v in hit["value"]["items"]}
    assert sorted(customers) == ["Ana", "Ben", "Caro", "Dani"]
    ben_items = dict((k["value"], v) for k, v in customers["Ben"]["items"])["items"]["items"]
    price = dict((k["value"], v) for k, v in ben_items[0]["items"])["unit_price"]
    assert price == {"kind": "leaf", "type": "str", "value": "1,299.00"}


def test_recorded_inputs_make_a_random_program_replay_exactly(tmp_path: Path) -> None:
    rec = record(tmp_path, FIXTURES / "invoices_audit.py")
    done = run(REPLAY, "replay", str(rec))
    assert done.returncode == 0, done.stdout + done.stderr
    assert "printed the same 2 lines" in done.stdout  # the second line carries the clock reading
    assert "the random seed and 1 of 1 recorded reads handed back" in done.stdout


def test_a_different_draw_is_caught_at_the_step_it_changes(tmp_path: Path) -> None:
    rec_path = record(tmp_path, FIXTURES / "invoices_audit.py")
    data = json.loads(rec_path.read_text())
    first = random.Random(data["inputs"]["seed"]).random() < 0.5
    data["inputs"]["seed"] = next(s for s in range(1000) if (random.Random(s).random() < 0.5) != first)
    other = tmp_path / "other-seed.json"
    other.write_text(json.dumps(data))
    expected = first_step_on(Recording(str(other)), "invoices_audit.py:52") + 1  # the step after the first `if`
    # with a watch the check runs at every step and stops the program right there
    done = run(REPLAY, "replay", str(other), "--watch", "54:picked")
    assert done.returncode == 1, done.stdout + done.stderr
    assert "the replay went another way at step #%d of" % expected in done.stdout
    assert "ran on to step" not in done.stdout
    # without one the check runs per block of steps, finds the same step and says how far the program got
    done = run(REPLAY, "replay", str(other))
    assert done.returncode == 1
    assert "the replay went another way at step #%d of" % expected in done.stdout
    assert "before it was caught" in done.stdout


def test_a_read_the_recording_never_made_stops_the_program(tmp_path: Path) -> None:
    rec_path = record(tmp_path, FIXTURES / "invoices_audit.py")
    data = json.loads(rec_path.read_text())
    assert [label for label, _ in data["inputs"]["reads"]] == ["time"]
    data["inputs"]["reads"] = []
    rec_path.write_text(json.dumps(data))
    done = run(REPLAY, "replay", str(rec_path))
    assert done.returncode == 1
    assert "the program read time once more than the recorded run did" in done.stdout + done.stderr


def test_an_edited_file_is_refused(tmp_path: Path) -> None:
    program = tmp_path / "invoices.py"
    shutil.copy(FIXTURES / "invoices.py", program)
    rec = record(tmp_path, program)
    program.write_text(program.read_text().replace('"silver": 0.10', '"silver": 0.12'))
    done = run(REPLAY, "replay", str(rec))
    assert done.returncode == 2
    assert "changed since it was recorded" in done.stdout


def test_a_secret_stays_masked_in_the_whole_value(tmp_path: Path) -> None:
    program = tmp_path / "settings.py"
    program.write_text('settings = {"api_key": "sk-live-1234567890abcdef1234", "region": "eu"}\nprint(settings["region"])\n')
    rec = record(tmp_path, program)
    values = tmp_path / "values.json"
    done = run(REPLAY, "replay", str(rec), "--watch", "2:settings", "--values", str(values))
    assert done.returncode == 0, done.stdout + done.stderr
    assert "sk-live-1234567890abcdef1234" not in done.stdout
    assert "sk-live-1234567890abcdef1234" not in values.read_text() and "sk-live" not in rec.read_text()
    hit = json.loads(values.read_text())["watches"][0]["hits"][0]
    fields = {k["value"]: v["value"] for k, v in hit["value"]["items"]}
    assert fields["region"] == "eu" and fields["api_key"] != "sk-live-1234567890abcdef1234"
