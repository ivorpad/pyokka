"""examples/demo.py end to end."""

from __future__ import annotations

from conftest import DEMO, run_source
from pyokka_runtime.protocol import COV_COVERED, COV_ERROR_SOURCE, COV_PARTIAL


def test_demo_end_to_end(tmp_path):
    src = DEMO.read_text(encoding="utf-8")
    out = run_source(src, tmp_path, name="demo.py")
    f = out.file()
    assert out.result.exit_code == 1
    # logging section
    assert out.logs_at(11)[0]["kind"] == "log" and "is_awesome" in out.logs_at(11)[0]["text"]
    assert out.logs_at(14)[0]["kind"] == "value" and out.logs_at(14)[0]["context"] == "pyokka"
    assert out.logs_at(20)[0]["context"] == "os.cpu_count()"
    assert out.logs_at(23)[0]["kind"] == "time"
    assert {m["kind"] for m in f["magic"]} == {"value", "time"}
    # coverage
    assert out.state_at(29) == COV_PARTIAL
    assert out.state_at(32) == 0
    assert out.state_at(105) == COV_ERROR_SOURCE
    # the "values as of this step" loop: three passes of `total += n`
    assert out.state_at(97) == COV_COVERED and out.state_at(99) == COV_COVERED
    assert sum(1 for s in out.steps if s[0] == out.rid_at(99)) == 3
    # rectangles logs
    for line in (88, 89, 90):
        log = out.logs_at(line)[0]
        assert log["valueBag"]["data"]["type"] == "dict"
        assert any(p["name"] == "msg" for p in log["valueBag"]["data"]["props"])
    # error at the last line
    err = [e for e in out.errors if not e["handled"]]
    assert len(err) == 1 and err[0]["message"].startswith("Kaboom") and err[0]["rid"] == out.rid_at(105)
    # time machine spine
    names = [s["name"] for s in out.trace["scopes"]]
    assert names[0] == "<module>" and "distance" in names and names.count("__init__") == 6
    assert len(out.steps) == out.result.step_count
