"""Replay through a real runner: the `inputs` a recording run keeps, and a `replay` run that checks every step.

A replay runs the program again to one step of a recording (inputs.py, replay.py): it must number
the steps, record the locals and the logs exactly as the recording did, hand the clock and the
random seed back, stop at the first step that goes another way, and answer with one
`replay.result` whatever the program does with the stop.
"""

from __future__ import annotations

import base64
import json
import random
import re
import sys
from array import array
from pathlib import Path

import pytest

from pyokka_runtime.protocol import decode_steps
from tests.test_runner import Client

ROOT = Path(__file__).resolve().parents[2]
INVOICES = (ROOT / "claude-plugin" / "pyokka-band" / "tests" / "programs" / "invoices.py").read_text(encoding="utf-8")

# invoices.py with a random audit sample and the clock in its report: the recording's inputs decide the run
AUDIT = '''"""Monthly revenue with a random audit sample."""

import random
import time

ORDERS = {"Ana": 101.74, "Ben": 0.0, "Caro": 49.9, "Dani": 57.8}


def pick_audits(names):
    picked = []
    for name in names:
        if random.random() < 0.5:
            picked.append(name)
    return picked


def main():
    audited = pick_audits(ORDERS)
    print(f"audit: {', '.join(audited) or 'none'}, report made at {time.time():.3f}")
    return audited


main()
'''
AUDIT_IF_LINE = 12
AUDIT_PRINT_LINE = 19

CONFIG = {"timeoutMs": 20000, "recordLocals": True}


@pytest.fixture
def runner():
    c = Client()
    c.send(type="hello", version="test")
    assert c.recv()["type"] == "ready"
    yield c
    c.close()


def write(tmp_path: Path, name: str, source: str) -> Path:
    path = tmp_path / name
    path.write_text(source, encoding="utf-8")
    return path


def of(events: list[dict], kind: str) -> list[dict]:
    return [e for e in events if e.get("type") == kind]


def quads(events: list[dict]) -> list[tuple[int, int, int, int]]:
    trace = [e for e in of(events, "trace") if not e.get("partial")][-1]
    arr = decode_steps(trace["steps"])
    return [tuple(arr[i : i + 4]) for i in range(0, len(arr), 4)]


def expect(steps: list[tuple[int, int, int, int]], n: int) -> str:
    pairs = array("i", [x for s in steps[: n + 1] for x in (s[0], s[2])])
    if sys.byteorder == "big":
        pairs.byteswap()
    return base64.b64encode(pairs.tobytes()).decode("ascii")


def line_of(events: list[dict], rid: int) -> int:
    for f in of(events, "file.instrumented"):
        i = rid - f["rangeBase"]
        if 0 <= i < len(f["ranges"]):
            return f["ranges"][i][0]
    raise AssertionError("no file holds rid %d" % rid)


def first_step_on(events: list[dict], line: int) -> int:
    return next(n for n, s in enumerate(quads(events)) if line_of(events, s[0]) == line)


def entries(events: list[dict]) -> list[dict]:
    return [entry for e in of(events, "locals") for entry in e["entries"]]


def change(events: list[dict], name: str, scope_name: str) -> tuple[int, dict]:
    """The first recorded change of ``name`` inside the function ``scope_name``: (step, change)."""
    trace = [e for e in of(events, "trace") if not e.get("partial")][-1]
    scopes = {s["scopeId"]: s["name"] for s in trace["scopes"]}
    for entry in entries(events):
        if scopes.get(entry["scopeId"]) != scope_name:
            continue
        for c in entry["changes"]:
            if c["name"] == name:
                return entry["step"], c
    raise AssertionError("no change of %s in %s" % (name, scope_name))


def replay(runner, path: Path, recorded: list[dict], at: int, expr: str, *, check: tuple[int, str] | None = None, inputs: dict | None = None, run_id: str = "rp", config: dict | None = None) -> list[dict]:
    body: dict = {"expect": expect(quads(recorded), at), "at": {"step": at, "expr": expr}}
    if check is not None:
        body["check"] = {"step": check[0], "name": check[1]}
    if inputs is not None:
        body["inputs"] = inputs
    return runner.run(path, runId=run_id, config=dict(config or CONFIG), replay=body)


def result(events: list[dict]) -> dict:
    results = of(events, "replay.result")
    assert len(results) == 1, results
    assert events[-1]["type"] == "run.finished"
    return results[0]


def props(node: dict) -> dict[str, dict]:
    return {p["name"]: p for p in node.get("props") or []}


def normalized(value: object) -> str:
    return re.sub(r"0x[0-9a-f]+", "0x?", json.dumps(value, sort_keys=True))


def test_a_recording_run_keeps_what_the_program_read_from_outside(runner, tmp_path):
    path = write(tmp_path, "reads.py", "import os, random, time, uuid\nnow = time.time()\nns = time.time_ns()\nraw = os.urandom(4)\nid_ = uuid.uuid4()\ndraw = random.random()\nprint(draw)\n")
    events = runner.run(path, config=dict(CONFIG))
    [inputs] = of(events, "inputs")
    assert inputs["seed"] < 2**52 and "truncated" not in inputs
    labels = [label for label, _ in inputs["reads"]]
    assert labels == ["time", "time_ns", "urandom(4)", "urandom(16)"]
    (_, now), (_, ns), (_, raw), (_, uid) = inputs["reads"]
    assert isinstance(now, float) and isinstance(ns, str) and ns.isdigit() and len(raw) == 8 and len(uid) == 32
    # the shared generator was seeded with the recorded seed, so the seed alone repeats every draw
    printed = next(e["text"] for e in of(events, "log") if e.get("kind") == "log")
    assert float(printed) == random.Random(inputs["seed"]).random()
    assert not of(runner.run(path, config={**CONFIG, "recordInputs": False}), "inputs")


def test_a_replay_reaches_its_step_with_the_full_value_and_the_text_the_recording_kept(runner, tmp_path):
    path = write(tmp_path, "invoices.py", INVOICES)
    recorded = runner.run(path, runId="rec", config=dict(CONFIG))
    k, kept = change(recorded, "orders", "main")
    assert kept.get("truncated") and "…(+" in kept["text"]  # the recorder cut it: the full value is the replay's
    got = result(replay(runner, path, recorded, k, "orders", check=(k, "orders")))
    assert got["status"] == "reached" and got["step"] == k and got["matched"] == k + 1
    assert got["check"] == {"step": k, "text": kept["text"]}
    orders = props(got["value"]["data"])
    assert sorted(orders) == ["Ana", "Ben", "Caro", "Dani"]
    ben = props(props(orders["Ben"])["items"])
    price = props(ben["0"])["unit_price"]
    assert price["type"] == "str" and price["value"] == "1,299.00"


def test_a_replay_records_the_locals_and_logs_the_recording_did_up_to_its_step(runner, tmp_path):
    path = write(tmp_path, "invoices.py", INVOICES)
    config = {**CONFIG, "autoLog": True}  # a value logged at every statement: logs to compare all along the run
    recorded = runner.run(path, runId="rec", config=dict(config))
    n = len(quads(recorded)) - 1  # the last step: every function has recorded its locals and logs by then
    replayed = replay(runner, path, recorded, n, "totals", config=config)
    assert result(replayed)["status"] == "reached"
    before = lambda events: [e for e in entries(events) if e["step"] < n]  # noqa: E731
    assert before(replayed) and normalized(before(replayed)) == normalized(before(recorded))
    logs = lambda events: [(e["rid"], e["kind"], e.get("context"), e["text"]) for e in of(events, "log") if e["step"] < n]  # noqa: E731
    assert len(logs(replayed)) > 20 and normalized(logs(replayed)) == normalized(logs(recorded))
    # nothing of the driver's own: its evaluation leaves no entry and no log at the step it stopped on
    assert not [e for e in entries(replayed) if e["step"] >= n]
    assert not [e for e in of(replayed, "log") if e["step"] >= n]


def test_the_recorded_inputs_make_a_random_program_replay_exactly(runner, tmp_path):
    path = write(tmp_path, "audit.py", AUDIT)
    recorded = runner.run(path, runId="rec", config=dict(CONFIG))
    [inputs] = of(recorded, "inputs")
    assert [label for label, _ in inputs["reads"]] == ["time"]
    last = len(quads(recorded)) - 1
    got = result(replay(runner, path, recorded, last, "audited", inputs={"seed": inputs["seed"], "reads": inputs["reads"]}))
    assert got["status"] == "reached" and got["matched"] == last + 1


def test_another_seed_goes_another_way_at_the_step_after_the_draw(runner, tmp_path):
    path = write(tmp_path, "audit.py", AUDIT)
    recorded = runner.run(path, runId="rec", config=dict(CONFIG))
    [inputs] = of(recorded, "inputs")
    first = random.Random(inputs["seed"]).random() < 0.5
    other = next(s for s in range(1000) if (random.Random(s).random() < 0.5) != first)
    last = len(quads(recorded)) - 1
    got = result(replay(runner, path, recorded, last, "audited", inputs={"seed": other, "reads": inputs["reads"]}))
    step = first_step_on(recorded, AUDIT_IF_LINE) + 1
    assert got["status"] == "diverged" and got["step"] == step and got["matched"] == step
    steps = quads(recorded)
    assert got["expected"] == {"rid": steps[step][0], "depth": steps[step][2]} and got["actual"]["rid"] != steps[step][0]


def test_a_read_the_recording_never_made_stops_the_program_with_status_input(runner, tmp_path):
    path = write(tmp_path, "audit.py", AUDIT)
    recorded = runner.run(path, runId="rec", config=dict(CONFIG))
    [inputs] = of(recorded, "inputs")
    last = len(quads(recorded)) - 1
    got = result(replay(runner, path, recorded, last, "audited", inputs={"seed": inputs["seed"], "reads": []}))
    assert got["status"] == "input" and got["step"] == first_step_on(recorded, AUDIT_PRINT_LINE)
    assert "the program read time once more than the recorded run did (0 reads)" in got["message"]


def test_a_program_that_swallows_the_stop_still_ends_with_one_result(runner, tmp_path):
    source = "total = 0\nfor i in range(3):\n    try:\n        total += i\n    except:\n        total = -1\nprint(total)\n"
    path = write(tmp_path, "swallow.py", source)
    recorded = runner.run(path, runId="rec", config=dict(CONFIG))
    at = first_step_on(recorded, 4)
    replayed = replay(runner, path, recorded, at, "total")
    got = result(replayed)
    assert got["status"] == "reached" and props(got["value"]["data"]) == {} and got["value"]["data"]["value"] == "0"
    # the bare except caught the stop once; the handler's own statement met it again, so the print never ran
    assert not [e for e in of(replayed, "log") if e.get("kind") == "log"]


def test_a_secret_stays_masked_in_the_full_value_and_the_check_text(runner, tmp_path):
    secret = "sk-live-1234567890abcdef1234"
    path = write(tmp_path, "settings.py", 'settings = {"api_key": "%s", "region": "eu"}\nprint(settings["region"])\n' % secret)
    recorded = runner.run(path, runId="rec", config=dict(CONFIG))
    k, kept = change(recorded, "settings", "<module>")
    replayed = replay(runner, path, recorded, k, "settings", check=(k, "settings"))
    got = result(replayed)
    assert got["status"] == "reached" and got["check"]["text"] == kept["text"]
    # the source a run instruments is never redacted (a literal in the code shows); the values are
    assert secret not in json.dumps(got)
    fields = props(got["value"]["data"])
    assert fields["region"]["value"] == "eu" and fields["api_key"].get("secret") is True


def test_a_malformed_or_refused_replay_answers_once_with_an_error(runner, tmp_path):
    path = write(tmp_path, "invoices.py", INVOICES)
    recorded = runner.run(path, runId="rec", config=dict(CONFIG))
    body = {"expect": expect(quads(recorded), 3), "at": {"step": 9, "expr": "orders"}}
    got = result(runner.run(path, runId="bad", config=dict(CONFIG), replay=body))
    assert got["status"] == "error" and "outside the 4 recorded steps" in got["message"]
    body = {"expect": expect(quads(recorded), 3), "at": {"step": 3, "expr": "import os"}}
    got = result(runner.run(path, runId="bad2", config=dict(CONFIG), replay=body))
    assert got["status"] == "error" and got["message"].startswith("import os cannot be evaluated")


def test_the_runtime_takes_out_only_the_hash_seed_the_host_pinned():
    from pyokka_runtime.child import unpin_hash_seed

    pinned = {"PYTHONHASHSEED": "123", "PYOKKA_PINNED_HASHSEED": "123", "PATH": "/bin"}
    unpin_hash_seed(pinned)
    assert pinned == {"PATH": "/bin"}
    # the user's own seed has no mark, and a mark for another seed leaves the user's alone
    users = {"PYTHONHASHSEED": "7"}
    unpin_hash_seed(users)
    assert users == {"PYTHONHASHSEED": "7"}
    other = {"PYTHONHASHSEED": "7", "PYOKKA_PINNED_HASHSEED": "123"}
    unpin_hash_seed(other)
    assert other == {"PYTHONHASHSEED": "7"}


def test_a_request_at_a_pause_runs_off_the_record_and_puts_everything_back():
    from types import SimpleNamespace

    from pyokka_runtime.inputs import Inputs
    from pyokka_runtime.offrecord import off_the_record

    inputs = Inputs("record")
    tracer = SimpleNamespace(quiet=0, inputs=inputs)
    debugger = SimpleNamespace(tracer=tracer, count=[41])
    seen = []

    def serve():
        seen.append((tracer.quiet, inputs.held))
        debugger.count[0] += 7  # the statements of a function the console called
        return {"action": "continue"}

    assert off_the_record(debugger, serve) == {"action": "continue"}
    assert seen == [(1, 1)] and (tracer.quiet, inputs.held, debugger.count) == (0, 0, [41])

    def raises():
        debugger.count[0] += 1
        raise ValueError("the console's own error")

    with pytest.raises(ValueError):
        off_the_record(debugger, raises)
    assert (tracer.quiet, inputs.held, debugger.count) == (0, 0, [41])
    # a run that records no inputs, and a debugger without a count, still run quiet
    assert off_the_record(SimpleNamespace(tracer=SimpleNamespace(quiet=0, inputs=None)), lambda: "served") == "served"
