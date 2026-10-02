"""`pyokka walkthrough`: the moment list over the shared fixture run, its text form, windows, the cap, `--all`.

The fixture program lives in `test/unit/fixtures/walkthrough/` (nested calls, a loop, every `if`
arm, a match, a print, a library callback, a handled and an uncaught exception). This file
regenerates the run and checks the moments against `walkthrough-moments.json`; the TypeScript
builder (`test/unit/walkthrough.test.ts`) reads `walkthrough-run.json` and must produce the same
list. Regenerate both with PYOKKA_WRITE_FIXTURES=1.
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import textwrap
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from pyokka_runtime.__main__ import main
from pyokka_runtime.agent.decisions import file_map
from pyokka_runtime.agent.live import SESSIONS_ENV
from pyokka_runtime.agent.source import SavedRun
from pyokka_runtime.agent.walkthrough import CAP, walkthrough

from conftest import ROOT, run_source

FIXTURES = ROOT / "test" / "unit" / "fixtures"
PROGRAM = FIXTURES / "walkthrough"
RUN_JSON = FIXTURES / "walkthrough-run.json"
MOMENTS_JSON = FIXTURES / "walkthrough-moments.json"
FIXTURE_ROOT = "/fixture"


def pyokka(*args: str) -> tuple[int, str]:
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = main([str(a) for a in args])
    return code, buf.getvalue()


def saved_run(tmp_path: Path, source: str, *, name: str = "main.py", files: dict[str, str] | None = None, config: dict | None = None, duration_ms: float = 12.0) -> Path:
    """Run in-process (the `run` fixture's machinery) and write a `run.json` like `pyokka run --save` does."""
    proj = tmp_path / "proj"
    proj.mkdir(exist_ok=True)
    out = run_source(source, proj, name=name, files=files, config={"recordLocals": True, "autoLog": True, **(config or {})})
    files_meta = [{"fileId": e["fileId"], "path": e["path"], "sha256": None} for e in out.events if e.get("type") == "file.instrumented"]
    meta = {"runtimeVersion": "0.0.1", "python": "3.x", "runId": "t", "file": out.path, "workspaceRoot": str(proj), "argv": [], "config": {"recordLocals": True, "autoLog": True, "libraryCode": bool((config or {}).get("libraryCode"))}, "started": "2026-09-11T00:00:00+00:00", "durationMs": duration_ms, "exitCode": out.result.exit_code, "stepCount": out.result.step_count, "files": files_meta}
    path = tmp_path / "run.json"
    path.write_text(json.dumps({"meta": meta, "events": out.events}), encoding="utf-8")
    return path


def normalize(text: str, root: str) -> str:
    return re.sub(r"0x[0-9a-f]+", "0x0", text.replace(root, FIXTURE_ROOT))


@pytest.fixture
def fixture_run(tmp_path: Path) -> Path:
    files = {rel: (PROGRAM / rel).read_text(encoding="utf-8") for rel in ("helper.py", "venv/site-packages/libq/__init__.py")}
    return saved_run(tmp_path, (PROGRAM / "main.py").read_text(encoding="utf-8"), files=files, config={"libraryCode": True})


def test_fixture_moments_match_the_shared_json(fixture_run: Path, tmp_path: Path):
    run = SavedRun(str(fixture_run))
    result = walkthrough(run)
    root = str(tmp_path / "proj")
    moments = json.loads(normalize(json.dumps(result["moments"], ensure_ascii=False), root))
    if os.environ.get("PYOKKA_WRITE_FIXTURES"):
        MOMENTS_JSON.write_text(json.dumps(moments, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        RUN_JSON.write_text(normalize(fixture_run.read_text(encoding="utf-8"), root) + "\n", encoding="utf-8")
    expected = json.loads(MOMENTS_JSON.read_text(encoding="utf-8"))
    assert [m["text"] for m in moments] == [m["text"] for m in expected]
    assert moments == expected


def test_fixture_covers_every_kind_in_order(fixture_run: Path):
    doc = walkthrough(SavedRun(str(fixture_run)))
    texts = [m["text"] for m in doc["moments"]]
    kinds = [m["kind"] for m in doc["moments"]]
    assert kinds[0] == "start" and kinds[-1] == "end" and texts[0] == "module main.py starts"
    assert "module helper.py runs" in texts
    assert texts.index("for i in range(3) ran 3 times") < texts.index("call 1 of 3 to double from <module>") < texts.index("call 3 of 3 to double from <module>")
    assert "for j in [] ran 0 times" in texts and "while k < 2 ran 2 times" in texts
    assert "if total > 100 and k > 0 took False" in texts and "elif total > 5 took True" in texts
    assert "match total took case _" in texts
    assert "call to Counter.__init__ from <module>" in texts and "call to Counter.bump from <module>" in texts
    lib = next(m for m in doc["moments"] if m["text"].startswith("call to run (libq)"))
    assert lib["text"] == "call to run (libq) from <module>, 1 nested call" and lib["kind"] == "call"
    tool = next(m for m in doc["moments"] if m["kind"] == "tool")
    assert tool["text"] == "libq calls back into <lambda> (run)" and tool["step"] == tool["entryStep"]
    assert "prints hello bob 6" in texts
    handled = next(m for m in doc["moments"] if m["kind"] == "error" and "handled" in m["text"])
    assert handled["text"] == "raised ValueError: too small: 6, handled at main.py:49"
    assert texts[-2] == "raised ValueError: too small: 6 uncaught" and texts[-1] == "run ends with exit code 1 after 12 ms"
    # values: parameters in, returns out, the deciding value of a call that raised
    greet = next(m for m in doc["moments"] if m["text"] == "call to greet from <module>")
    assert greet["values"] == [{"role": "in", "name": "name", "text": "'bob'"}, {"role": "out", "name": "return", "text": "'hello bob'"}]
    last_fail = [m for m in doc["moments"] if m["text"] == "call to fail from <module>"][-1]  # numbered per call site: two sites, no numbers
    assert last_fail["values"] == [{"role": "in", "name": "n", "text": "6"}, {"role": "out", "name": "raised", "text": "ValueError: too small: 6"}]
    assert all(m["gloss"] is None and m["durationMs"] is None for m in doc["moments"])
    assert [m["id"] for m in doc["moments"]] == ["m%d" % i for i in range(len(doc["moments"]))]
    assert doc["count"] > 40 and doc["total"] == doc["shown"] == len(doc["moments"]) and doc["capped"] is False


def test_text_rendering_is_one_line_per_moment(fixture_run: Path):
    code, text = pyokka("walkthrough", str(fixture_run))
    assert code == 0
    lines = text.splitlines()
    assert lines[0].startswith("%d moments over " % len(walkthrough(SavedRun(str(fixture_run)))["moments"]))
    assert lines[1] == "#0  module main.py starts"
    assert "      in name = 'bob'" in lines and "      out return = 'hello bob'" in lines
    assert all(len(l) <= 100 for l in lines)
    assert not any("rangeBase" in l or "rid" in l.split() for l in lines)
    code, out = pyokka("walkthrough", str(fixture_run), "--json")
    doc = json.loads(out)
    assert code == 0 and doc["moments"][0]["location"]["fileId"] == 1


def test_windows_and_scope_filter(fixture_run: Path):
    doc = walkthrough(SavedRun(str(fixture_run)), scope="fail")
    assert {m["text"] for m in doc["moments"]} >= {"call to fail from <module>", "if n > 100 took False", "raised ValueError: too small: 6 uncaught"}
    assert all(m["text"] != "module main.py starts" for m in doc["moments"])
    full = walkthrough(SavedRun(str(fixture_run)))
    greet = next(m for m in full["moments"] if m["text"] == "call to greet from <module>")
    win = walkthrough(SavedRun(str(fixture_run)), start=greet["step"], end=greet["endStep"])
    assert [m["text"] for m in win["moments"]][:2] == ["call to greet from <module>", "msg = 'hello bob'"] and win["shown"] < full["shown"]
    code, text = pyokka("walkthrough", str(fixture_run), "--from", str(greet["step"]), "--to", str(greet["endStep"]))
    assert code == 0 and text.splitlines()[0].endswith("(showing %d)" % win["shown"])
    by_file = walkthrough(SavedRun(str(fixture_run)), file="helper.py")
    assert by_file["moments"] and all(m["location"]["file"].endswith("helper.py") for m in by_file["moments"])


def test_all_lists_every_library_call(fixture_run: Path):
    merged = walkthrough(SavedRun(str(fixture_run)))
    every = walkthrough(SavedRun(str(fixture_run)), all_scopes=True)
    assert every["total"] == merged["total"] + 1  # helper(1) inside run() gets its own moment
    assert "call to helper (libq) from run" in [m["text"] for m in every["moments"]]
    assert "call to run (libq) from <module>" in [m["text"] for m in every["moments"]]


def test_cap_collapses_repeated_calls_then_values(tmp_path: Path):
    src = """
    def f(i):
        v = i + 1
        return v
    for i in range(300):
        r = f(i)
    """
    path = saved_run(tmp_path, src)
    doc = walkthrough(SavedRun(str(path)))
    assert doc["total"] > CAP and doc["capped"] is True and doc["shown"] <= CAP
    calls = [m for m in doc["moments"] if m["kind"] == "call"]
    assert len(calls) == 1 and calls[0]["more"] == 299 and calls[0]["text"] == "call 1 of 300 to f from <module>"
    code, text = pyokka("walkthrough", str(path))
    assert code == 0 and "      ≡ 299 more calls like this" in text
    win = walkthrough(SavedRun(str(path)), start=0, end=50)
    assert win["capped"] is False and len([m for m in win["moments"] if m["kind"] == "call"]) > 1


def test_deciding_value_and_print_to_stderr(tmp_path: Path):
    src = """
    import sys
    x = 3
    if x > 2:  # ?
        print("big", file=sys.stderr)
    """
    doc = walkthrough(SavedRun(str(saved_run(tmp_path, src))))
    dec = next(m for m in doc["moments"] if m["kind"] == "decision")
    assert dec["text"] == "if x > 2 took True" and dec["values"] == [{"role": "took", "name": "x > 2", "text": "True"}]
    assert "prints to stderr big" in [m["text"] for m in doc["moments"]]


def test_file_map_shapes():
    src = textwrap.dedent("""
    class A:
        class B:
            def m(self):
                if x:
                    pass
                elif (y and
                      z):
                    return 1
                for a in b:
                    while c:
                        pass
                match p:
                    case 1 | 2:
                        pass
                    case _:
                        pass
    def top():
        return 2
    """)
    fm = file_map(src)
    assert fm["qualnames"] == {4: "A.B.m", 18: "top"}
    assert fm["decisions"][5] == {"kind": "if", "label": "if", "line": 5, "text": "x", "body": [6, 6], "orelse": [7, 9]}  # the elif header through the end of the chain
    assert fm["decisions"][7] == {"kind": "if", "label": "elif", "line": 7, "text": "y and z", "body": [9, 9], "orelse": [0, 0]}
    assert file_map("if a:\n    b = 1\nelse:\n    c = 2\n    d = 3\n")["decisions"][1]["orelse"] == [4, 5]
    assert fm["decisions"][13] == {"kind": "match", "line": 13, "text": "p", "arms": [{"text": "1 | 2", "body": [15, 15]}, {"text": "_", "body": [17, 17]}]}
    assert fm["loops"][10] == {"kind": "for", "line": 10, "text": "a in b", "end": 12} and fm["loops"][11]["kind"] == "while"
    assert fm["returns"] == {9, 19} and fm["functions"][18] == {"name": "top", "line": 18, "end": 19}
    assert file_map("def (") == {"decisions": {}, "loops": {}, "returns": set(), "qualnames": {}, "functions": {}}


def test_live_walkthrough_sends_the_request(monkeypatch):
    from pyokka_runtime.agent.live import LiveRun

    sent: list[dict] = []

    class FakeLink:
        def send_raw(self, msg):
            pass

        def call(self, msg):
            sent.append(msg)
            return {"id": 1, "ok": True, "count": 5, "total": 1, "shown": 1, "moments": []}

        def close(self):
            pass

    monkeypatch.setattr("pyokka_runtime.agent.live.SocketLink", lambda *a, **k: FakeLink())
    live = LiveRun({"socket": "/tmp/x.sock", "token": "t", "file": "/ws/a.py", "workspace": "/ws"})
    out = live.walkthrough(scope="f", start=2, end=9, all_scopes=True)
    assert sent == [{"type": "walkthrough", "scope": "f", "from": 2, "to": 9, "all": True}] and out["count"] == 5


def test_stale_and_missing_runs(tmp_path: Path, capsys, monkeypatch):
    monkeypatch.setenv(SESSIONS_ENV, str(tmp_path / "sessions"))  # whatever VS Code windows this machine has open, none is live here
    code, _ = pyokka("walkthrough", str(tmp_path / "missing.json"))
    assert code == 2 and "no saved run" in capsys.readouterr().err
    code, _ = pyokka("narrate", "--live")
    err = capsys.readouterr().err
    assert code == 2 and ("narrate writes the glosses into a saved run" in err or "no live session" in err)
