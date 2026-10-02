"""The `pyokka` commands over a saved run: run --save, story, steps, step, context, values, find, eval, --keep, http.

`test_http_table_over_a_saved_run` also writes the shared fixtures `test/unit/fixtures/http-table-run.json`
(the saved run, normalised) and `http-table.json` (the table built from it) under PYOKKA_WRITE_FIXTURES=1;
the TypeScript builder (`test/unit/httpTable.test.ts`) must produce the same table from the same run.
"""

from __future__ import annotations

import io
import json
import os
import re
import subprocess
import sys
import textwrap
import time
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from pyokka_runtime.__main__ import main
from pyokka_runtime.agent.source import SavedRun
from pyokka_runtime.redact import REDACTED
from tests.http_record_support import LocalServer

PY_DIR = Path(__file__).resolve().parents[1]
FIXTURES = PY_DIR.parent / "test" / "unit" / "fixtures"
HTTP_TABLE_RUN = FIXTURES / "http-table-run.json"
HTTP_TABLE = FIXTURES / "http-table.json"
FIXTURE_ROOT = "/fixture"
FIXTURE_HASH = "3f2a9c1e5b7d0246"

MAIN = """
import helper

def greet(name):
    # says hello
    msg = "hello " + name
    return msg

total = 0
for i in range(3):
    total += helper.double(i)
print(greet("bob"), total)
secret = "sk-abcdefghijklmnopqrstuvwxyz012345"
result = helper.fail(total)
"""
HELPER = """
def double(x):
    y = x * 2
    return y

def fail(n):
    if n > 100:
        return n
    raise ValueError("too small: %d" % n)
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
def project(tmp_path: Path) -> Path:
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "main.py").write_text(textwrap.dedent(MAIN).lstrip(), encoding="utf-8")
    (proj / "helper.py").write_text(textwrap.dedent(HELPER).lstrip(), encoding="utf-8")
    return proj


@pytest.fixture
def saved(project: Path) -> Path:
    out = project.parent / "run.json"
    code, text = pyokka("run", str(project / "main.py"), "--save", str(out))
    assert code == 1  # the program raised
    assert "saved %s: 28 steps, 2 files, exit 1" % out in text and "ValueError: too small: 6" in text
    return out


def test_save_writes_meta_and_redacts(saved: Path, project: Path):
    raw = saved.read_text(encoding="utf-8")
    assert "sk-abcdefghijklmnopqrstuvwxyz012345" not in raw and REDACTED in raw
    doc = json.loads(raw)
    meta = doc["meta"]
    for key in ("runtimeVersion", "python", "file", "workspaceRoot", "argv", "config", "started", "durationMs", "files"):
        assert key in meta, key
    assert meta["file"] == str(project / "main.py") and meta["config"]["libraryCode"] is False and meta["exitCode"] == 1
    assert [f["fileId"] for f in meta["files"]] == [1, 2] and all(len(f["sha256"]) == 64 for f in meta["files"])
    assert "keep" not in meta
    kinds = {e["type"] for e in doc["events"]}
    assert {"run.started", "file.instrumented", "coverage", "trace", "locals", "error", "run.finished"} <= kinds
    # `run --json` is still the plain event stream (in a subprocess: it executes the file in-process)
    proc = subprocess.run([sys.executable, "-m", "pyokka_runtime", "run", str(project / "main.py"), "--json"], capture_output=True, text=True, cwd=PY_DIR)
    assert proc.returncode == 0 and proc.stdout.splitlines()[0].startswith('{"type":"run.started"')


def test_save_records_the_http_mode(project: Path):
    out = project.parent / "http-off.json"
    code, text = pyokka("run", str(project / "main.py"), "--save", str(out), "--http", "off")
    assert code == 1 and "saved %s" % out in text
    meta = json.loads(out.read_text(encoding="utf-8"))["meta"]
    assert meta["config"]["http"] == "off" and meta["config"]["httpObserve"] is True
    with pytest.raises(SystemExit) as exc:
        pyokka("run", str(project / "main.py"), "--save", str(out), "--http", "bogus")
    assert exc.value.code == 2


HTTP_PROGRAM = """
import http.client
import json
import sys
import urllib.request

BASE = "http://127.0.0.1:" + sys.argv[1]
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def get(path):
    with opener.open(BASE + path) as r:
        return r.status, r.read()


def post(path, payload):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    with opener.open(req) as r:
        return r.status, json.loads(r.read())


status, body = get("/json")
echoed = post("/echo", {"q": "hello"})
conn = http.client.HTTPConnection("127.0.0.1", int(sys.argv[1]))
conn.request("GET", "/json?key=abc&v=1")  # the query values never reach a row
missing = conn.getresponse().status
conn.close()
print(status, echoed, missing)
"""


def normalise_http_run(doc: dict, *, root: str, port: int) -> dict:
    """The saved run with everything machine- or run-specific pinned: paths under /fixture, the port 0, fixed times and ids."""
    text = json.dumps(doc, ensure_ascii=False)
    for r in {root, os.path.realpath(root)}:
        text = text.replace(r, FIXTURE_ROOT)
    text = text.replace("127.0.0.1:%d" % port, "127.0.0.1:0")
    text = re.sub(r"0x[0-9a-f]+", "0x0", text)
    text = re.sub(r"[0-9a-f]{16}\.jsonl", FIXTURE_HASH + ".jsonl", text)
    out = json.loads(text)
    out["meta"].update(runtimeVersion="0.0.1", python="3.x", executable=FIXTURE_ROOT + "/bin/python", runId="cli-fixture", argv=["0"], started="2026-09-11T10:12:00+00:00", durationMs=12.0)
    for ev in out["events"]:
        ev["runId"] = "cli-fixture"
        if ev["type"] == "run.started":
            ev["pid"] = 4242
        elif ev["type"] == "http.exchange":
            ev["ms"] = 10 * ev["n"]
        elif ev["type"] == "run.finished":
            ev["durationMs"] = 12.0
            ev["http"]["recordedAt"] = "2026-09-11T10:12:03Z"
        elif ev["type"] == "file.instrumented" and "instrumentMs" in ev:
            ev["instrumentMs"] = 1.0
    return out


def test_http_table_over_a_saved_run(tmp_path: Path):
    server = LocalServer()
    proj = tmp_path / "proj"
    proj.mkdir()
    main_py = proj / "main.py"
    main_py.write_text(HTTP_PROGRAM.lstrip(), encoding="utf-8")
    out = tmp_path / "run.json"
    try:
        code, text = pyokka("run", str(main_py), "--save", str(out), "--http", "record", str(server.port))
    finally:
        server.stop()
    assert code == 0 and "exit 0" in text and server.hits == 3
    # the text form: a header with the totals and the recording, one line per request with the statement that made it
    code, text = pyokka("http", str(out))
    lines = text.splitlines()
    assert code == 0 and len(lines) == 4
    assert re.fullmatch(r"3 requests · 46 B · \d+ ms · recorded to [0-9a-f]{4}….jsonl \(\d{4}-\d\d-\d\d \d\d:\d\dZ\)", lines[0]), lines[0]
    assert re.fullmatch(r"#1  GET  200  json  main\.py:11  18 B  \d+ ms  recorded  http://127\.0\.0\.1:%d/json" % server.port, lines[1]), lines[1]
    assert re.fullmatch(r"#2  POST  200  echo  main\.py:17  24 B  \d+ ms  recorded  http://127\.0\.0\.1:%d/echo" % server.port, lines[2]), lines[2]
    assert re.fullmatch(r"#3  GET  404  json  main\.py:24  4 B  \d+ ms  recorded  http://127\.0\.0\.1:%d/json\?key&v" % server.port, lines[3]), lines[3]
    # the table
    doc = pyokka_json("http", str(out))
    meta = json.loads(out.read_text(encoding="utf-8"))["meta"]
    assert meta["config"] == {"timeoutMs": 0, "libraryCode": False, "recordLocals": True, "autoLog": False, "http": "record", "httpObserve": True}
    assert (doc["runId"], doc["running"], doc["count"], doc["truncated"]) == (meta["runId"], False, 3, False)
    reqs = doc["requests"]
    assert [(r["n"], r["client"], r["method"], r["status"], r["reason"], r["name"], r["bytes"], r["source"], r["recordedMs"]) for r in reqs] == [
        (1, "http.client", "GET", 200, "OK", "json", 18, "recorded", None),
        (2, "http.client", "POST", 200, "OK", "echo", 24, "recorded", None),
        (3, "http.client", "GET", 404, "Not Found", "json", 4, "recorded", None),
    ]
    assert reqs[0]["location"] == {"file": str(main_py), "line": 11, "col": 4, "fileId": 1}  # the `with opener.open(...)` inside get()
    assert reqs[1]["location"]["line"] == 17 and reqs[2]["location"] == {"file": str(main_py), "line": 24, "col": 0, "fileId": 1}  # conn.request(...) at module level
    assert reqs[2]["url"] == "http://127.0.0.1:%d/json?key&v" % server.port and all(r["step"] >= 0 for r in reqs)
    assert doc["totals"] == {"requests": 3, "bytes": 46, "ms": sum(r["ms"] for r in reqs), "misses": 0, "missAttempts": 0}
    fin = doc["finished"]
    assert (fin["mode"], fin["requests"], fin["recorded"], fin["served"], fin["misses"], fin["exists"], fin["entries"]) == ("record", 3, 3, 0, 0, True, 3)
    assert fin["file"] == str(proj / ".pyokka" / "replay" / os.path.basename(fin["file"])) and fin["recordedAt"].endswith("Z")
    # the shared fixtures: the normalised run, and the table the Python builder makes of it
    normalised = normalise_http_run(json.loads(out.read_text(encoding="utf-8")), root=str(proj), port=server.port)
    fixture_run = tmp_path / "http-table-run.json"
    fixture_run.write_text(json.dumps(normalised, ensure_ascii=False) + "\n", encoding="utf-8")
    table = SavedRun(str(fixture_run)).http()
    assert table["requests"][0]["location"]["file"] == FIXTURE_ROOT + "/main.py" and table["finished"]["file"] == "%s/.pyokka/replay/%s.jsonl" % (FIXTURE_ROOT, FIXTURE_HASH)
    if os.environ.get("PYOKKA_WRITE_FIXTURES"):
        HTTP_TABLE_RUN.write_text(fixture_run.read_text(encoding="utf-8"), encoding="utf-8")
        HTTP_TABLE.write_text(json.dumps(table, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    assert table == json.loads(HTTP_TABLE.read_text(encoding="utf-8"))
    assert SavedRun(str(HTTP_TABLE_RUN)).http() == table  # the committed run and table agree


GATHER_PROGRAM = """
import asyncio, sys
import httpx, slowlib
PORT = int(sys.argv[1])
async def fetch(client, i):
    url = "http://127.0.0.1:%d/echo" % PORT
    return await slowlib.post(client, url, json={"i": i})
async def main():
    async with httpx.AsyncClient() as client:
        return await asyncio.gather(*(fetch(client, i) for i in range(3)))
asyncio.run(main())
"""
# unrecorded (--exclude), like litellm: it yields to the other tasks before the request goes out
SLOWLIB = """
import asyncio
async def post(client, url, **kw):
    await asyncio.sleep(0.01)
    return await client.post(url, **kw)
"""


def test_http_gathered_requests_carry_the_step_of_the_task_that_issued_each(tmp_path: Path):
    """Three requests awaited by one gather: each row names the `return await client.post(...)` step of its own task, not the last one reached."""
    server = LocalServer()
    main_py = tmp_path / "main.py"
    main_py.write_text(GATHER_PROGRAM.lstrip(), encoding="utf-8")
    (tmp_path / "slowlib.py").write_text(SLOWLIB.lstrip(), encoding="utf-8")
    out = tmp_path / "run.json"
    try:
        code, text = pyokka("run", str(main_py), "--save", str(out), "--http", "record", "--exclude", "slowlib", "--", str(server.port))
    finally:
        server.stop()
    assert code == 0 and server.hits == 3, text
    reqs = pyokka_json("http", str(out))["requests"]
    issued = [s["step"] for s in pyokka_json("steps", str(out), "--line", "%s:6" % main_py)["steps"]]
    assert len(issued) == 3 and len(set(issued)) == 3, issued
    assert all(r["location"]["line"] == 6 for r in reqs)
    assert sorted(r["step"] for r in reqs) == sorted(issued)


def test_story_text_and_filters(saved: Path):
    code, text = pyokka("story", str(saved))
    assert code == 0
    assert text.startswith("28 steps, 12 blocks\n")
    assert "## greet  main.py:3  steps 20–22" in text
    assert " 3  def greet(name):   #20\n 4      # says hello\n 5      msg = \"hello \" + name   #21\n" in text
    assert "«redacted»" in text and "sk-abc" not in text
    assert "rangeBase" not in text and "rid" not in text
    code, text = pyokka("story", str(saved), "--file", "helper.py")
    assert code == 0 and "main.py:" not in text and "## double  helper.py:1  steps 6–8" in text
    code, text = pyokka("story", str(saved), "--scope", "fail")
    assert code == 0 and text.startswith("28 steps, 12 blocks, 1 matching\n") and "raise ValueError" in text and "   …\n" in text  # line 7 did not run: a gap
    doc = pyokka_json("story", str(saved), "--line", "main.py:10")
    assert doc["shown"] == 3 and doc["matched"] == 3 and doc["total"] == 12 and all(b["function"] == "<module>" for b in doc["blocks"])
    assert doc["blocks"][0]["lines"][-1] == {"line": 10, "text": "    total += helper.double(i)", "step": 5}
    code, text = pyokka("story", str(saved), "--file", "nope.py")
    assert code == 2


def test_story_limit_caps_the_listed_lines(saved: Path):
    code, text = pyokka("story", str(saved))
    assert code == 0 and "(showing" not in text and "more blocks" not in text
    code, text = pyokka("story", str(saved), "--limit", "12")
    assert code == 0
    assert text.startswith("28 steps, 12 blocks (showing 5)\n")
    assert text.rstrip().endswith("… 7 more blocks; narrow with --file F, --scope NAME or --line F:L, or raise --limit")
    doc = pyokka_json("story", str(saved), "--limit", "12")
    assert doc["shown"] == 5 and doc["matched"] == 12 and doc["truncated"] is True
    assert sum(len(b["lines"]) for b in doc["blocks"]) <= 12
    # the first block is always listed, however small the limit
    doc = pyokka_json("story", str(saved), "--limit", "1")
    assert doc["shown"] == 1 and doc["truncated"] is True
    # the limit narrows a filtered listing too
    doc = pyokka_json("story", str(saved), "--file", "helper.py", "--limit", "3")
    assert doc["matched"] == 5 and doc["shown"] == 1 and all(b["file"].endswith("helper.py") for b in doc["blocks"])


def test_steps_listing(saved: Path):
    code, text = pyokka("steps", str(saved), "--from", "4", "--count", "3")
    assert code == 0
    assert text.splitlines() == ["steps 4.. of 28", "#4      main.py:9  <module>  depth 0", "#5      main.py:10  <module>  depth 0", "#6      helper.py:1  double  depth 1 [entry]", "next: --from 7"]
    doc = pyokka_json("steps", str(saved), "--line", "main.py:10")
    assert [s["step"] for s in doc["steps"]] == [5, 10, 15] and doc["total"] == 3


def test_step_into_lands_in_the_callee_with_values(saved: Path, project: Path):
    doc = pyokka_json("step", str(saved), "5", "--into")
    assert doc["step"] == 6 and doc["from"] == 5 and doc["count"] == 28
    assert doc["location"] == {"file": str(project / "helper.py"), "line": 1, "col": 0, "function": "double", "fileId": 2}
    assert [(f["function"], f["line"], f["step"]) for f in doc["stack"]] == [("double", 1, 6), ("<module>", 10, 5)]
    assert [(l["line"], l["step"]) for l in doc["block"]["lines"]] == [(1, 6), (2, 7), (3, 8)] and doc["block"]["lines"][0]["current"] is True
    assert {(v["context"], v["text"], v["step"]) for v in doc["values"]} == {("x", "0", 7), ("y", "0", 8)}
    assert doc["moves"] == {"into": 7, "over": 7, "out": 9, "back": 5, "backOver": 5, "backOut": 5}
    assert doc["stale"] is False and doc["errors"] == [] and doc["coverage"] == {"notRun": []}
    code, text = pyokka("step", str(saved), "5", "--into")
    assert code == 0
    assert "step 6/28  helper.py:1  double [entry]" in text
    assert "stack: double helper.py:1 #6 ← <module> main.py:10 #5" in text
    assert ">1  def double(x):   #6" in text and "  #7 helper.py:2  x = 0" in text
    assert "moves: into 7 · over 7 · out 9 · back 5 · back-over 5 · back-out 5" in text


def test_step_over_out_back_and_to(saved: Path):
    assert pyokka_json("step", str(saved), "5", "--over")["step"] == 9
    assert pyokka_json("step", str(saved), "7", "--out")["step"] == 9
    assert pyokka_json("step", str(saved), "7", "--back")["step"] == 6
    assert pyokka_json("step", str(saved), "9", "--back-over")["step"] == 5
    assert pyokka_json("step", str(saved), "7", "--back-out")["step"] == 5
    assert pyokka_json("step", str(saved), "0", "--to", "27")["step"] == 27


def test_context_at_the_error_step(saved: Path, capsys):
    doc = pyokka_json("context", str(saved), "--line", "helper.py:8")
    assert doc["step"] == 27 and doc["location"]["function"] == "fail"
    assert doc["errors"] == [{"line": 8, "type": "ValueError", "message": "too small: 6", "step": 27, "handled": False}]
    assert doc["coverage"] == {"notRun": [7]}
    assert doc["moves"]["into"] is None and doc["moves"]["back"] == 26
    code, text = pyokka("context", str(saved), "27")
    assert "not run: 7" in text and "errors:\n  #27 helper.py:8 ValueError: too small: 6" in text and "moves: into — · over — · out — · back 26" in text
    doc = pyokka_json("context", str(saved), "--line", "helper.py:8", "--scope")
    assert doc["block"]["capped"] is False and doc["valuesCapped"] is False


def test_errors_say_what_to_do_next(saved: Path, capsys):
    code, _ = pyokka("step", str(saved), "5000", "--into")
    err = capsys.readouterr().err
    assert code == 2 and "step 5000 is past the recorded 28 steps" in err and "use `steps` or `find`" in err
    code, _ = pyokka("step", str(saved), "27", "--into")
    err = capsys.readouterr().err
    assert code == 2 and "cannot step into from step 27: the end of the run" in err and "possible moves: back, backOver, backOut" in err
    code, _ = pyokka("context", str(saved), "--line", "main.py:2")
    err = capsys.readouterr().err
    assert code == 2 and "no step on main.py:2" in err and "lines of main.py that ran near it: 1, 3, 5, 6" in err
    code, out = pyokka("eval", str(saved), "total", "--json")
    doc = json.loads(out)
    assert code == 2 and doc["ok"] is False and "--keep" in doc["hint"]
    code, _ = pyokka("story", str(saved.parent / "missing.json"))
    assert code == 2 and "no saved run" in capsys.readouterr().err


def test_values_and_find(saved: Path):
    doc = pyokka_json("values", str(saved), "--line", "helper.py:2")
    assert [(v["context"], v["text"], v["step"]) for v in doc["values"]] == [("x", "0", 7), ("x", "1", 12), ("x", "2", 17)]
    code, text = pyokka("values", str(saved), "--line", "helper.py:2")
    assert text.startswith("3 values on helper.py:2\n  #7  x = 0\n")
    doc = pyokka_json("find", str(saved), "too small")
    kinds = {(h["kind"], h["line"], h["step"]) for h in doc["hits"]}
    assert ("error", 8, 27) in kinds and ("line", 8, 27) in kinds
    code, text = pyokka("find", str(saved), "total")
    assert code == 0 and text.startswith("7 hits for 'total'") and "#14 main.py:9  total = 2" in text and "#24 main.py:13  result = helper.fail(total)" in text
    # the source line holding the literal is found, but nothing that leaves the process shows it
    code, text = pyokka("find", str(saved), "sk-abcdefghijklmnopqrstuvwxyz012345")
    assert code == 0 and text == "1 hits for '%s'\n  #23 main.py:12  secret = \"%s\"\n" % (REDACTED, REDACTED)


def test_var_lists_every_change_with_its_statement(saved: Path, project: Path):
    # a locals change is attributed to the statement that made it; loop iterations own their binding
    doc = pyokka_json("var", str(saved), "total")
    assert doc["name"] == "total" and doc["total"] == 4 and doc["truncated"] is False and doc["recordedLocals"] is True
    rows = [(r["step"], r["line"], r["function"], r.get("text"), r["source"], r.get("unchanged", False)) for r in doc["changes"]]
    assert rows == [(2, 8, "<module>", "0", "locals", False), (5, 10, "<module>", "0", "assign", True), (10, 10, "<module>", "2", "locals", False), (15, 10, "<module>", "6", "locals", False)]
    assert all(r["file"] == str(project / "main.py") and r["fileId"] == 1 and r["scopeId"] == 0 for r in doc["changes"])
    # `total += helper.double(i)` read total, helper and i: their values as of that step, one level back
    reads = doc["changes"][2]["reads"]
    assert [(r["name"], r.get("text"), r.get("step")) for r in reads] == [("total", "0", 2), ("helper", None, None), ("i", "1", 9)]
    doc = pyokka_json("var", str(saved), "i")
    assert [(r["step"], r["text"]) for r in doc["changes"]] == [(4, "0"), (9, "1"), (14, "2")]  # the loop-start step is not an assignment
    # parameters are bound at the def line by the call that entered
    doc = pyokka_json("var", str(saved), "x")
    assert [(r["step"], r["line"], r["function"], r["text"]) for r in doc["changes"]] == [(6, 1, "double", "0"), (11, 1, "double", "1"), (16, 1, "double", "2")]
    doc = pyokka_json("var", str(saved), "y", "--file", "helper.py", "--scope", "double")
    assert [(r["step"], r["line"], r["text"], [(x["name"], x["text"]) for x in r["reads"]]) for r in doc["changes"]] == [(7, 2, "0", [("x", "0")]), (12, 2, "2", [("x", "1")]), (17, 2, "4", [("x", "2")])]
    assert pyokka_json("var", str(saved), "y", "--limit", "1") == {**pyokka_json("var", str(saved), "y", "--limit", "1"), "total": 3, "truncated": True}
    # the text form: one line per change, the statement's reads after an arrow, redacted like everything else
    code, text = pyokka("var", str(saved), "total")
    assert code == 0
    assert text.splitlines() == [
        "4 changes of total",
        "  #2 main.py:8  <module>  total = 0",
        "  #5 main.py:10  <module>  total = 0  (same object)   ← total = 0, helper = ?, i = 0",
        "  #10 main.py:10  <module>  total = 2   ← total = 0, helper = ?, i = 1",
        "  #15 main.py:10  <module>  total = 6   ← total = 2, helper = ?, i = 2",
    ]
    code, text = pyokka("var", str(saved), "secret")
    assert code == 0 and "sk-abc" not in text and "secret = '%s'" % REDACTED in text
    code, text = pyokka("var", str(saved), "nothing")
    assert code == 0 and text.startswith("0 changes of nothing\nnothing recorded for nothing")
    code, text = pyokka("var", str(saved), "x", "--file", "nope.py")
    assert code == 2


def test_why_walks_back_from_a_value(saved: Path, project: Path):
    doc = pyokka_json("why", str(saved), "10", "total")
    assert (doc["name"], doc["step"], doc["depth"], doc["nodes"], doc["truncated"], doc["recordedLocals"], doc["stale"]) == ("total", 10, 5, 4, False, True, False)
    root = doc["root"]
    assert {k: root[k] for k in ("name", "text", "source", "step", "file", "fileId", "line", "function", "scopeId", "statement")} == {"name": "total", "text": "2", "source": "locals", "step": 10, "file": str(project / "main.py"), "fileId": 1, "line": 10, "function": "<module>", "scopeId": 0, "statement": "total += helper.double(i)"}
    assert "logId" not in root  # nothing logged the value: no marker, no Auto Log
    assert [(r["name"], r.get("text"), r.get("step")) for r in root["reads"]] == [("total", "0", 2), ("helper", None, None), ("i", "1", 9)]
    assert root["reads"][0]["reads"] == [] and root["reads"][1] == {"name": "helper"}
    assert root["reads"][2]["statement"] == "for i in range(3):" and root["reads"][2]["opaque"] == ["range(3)"]
    call = root["calls"][0]
    assert {k: call[k] for k in ("name", "entryStep", "returnStep", "file", "fileId", "line", "inputs", "result")} == {"name": "double", "entryStep": 11, "returnStep": 13, "file": str(project / "helper.py"), "fileId": 2, "line": 1, "inputs": [{"name": "x", "text": "1"}], "result": "2"}
    assert call["scopeId"] == pyokka_json("context", str(saved), "11")["block"]["scopeId"] and root["opaque"] == []
    code, text = pyokka("why", str(saved), "10", "total")
    assert code == 0
    assert text.splitlines() == [
        "why total at #10",
        "total = 2   #10 main.py:10 <module>   total += helper.double(i)",
        "  ← total = 0   #2 main.py:8 <module>   total = 0",
        "  ← helper = ?",
        "  ← i = 1   #9 main.py:9 <module>   for i in range(3):",
        "    · range(3)   not stepped",
        "  ↳ double #11–#13 helper.py:1   in x = 1   out 2",
        "total is 2 at #10 (main.py:10). helper.double(i) returned 2.",
    ]
    # --depth 1: the reads keep their location and statement, marked cut
    doc = pyokka_json("why", str(saved), "10", "total", "--depth", "1")
    assert doc["depth"] == 1 and doc["root"]["reads"][0]["cut"] is True and "reads" not in doc["root"]["reads"][0] and "cut" not in doc["root"]["reads"][1]
    code, text = pyokka("why", str(saved), "10", "total", "--depth", "1")
    assert code == 0 and text.splitlines()[2] == "  ← total = 0   #2 main.py:8 <module>   total = 0  …"
    # no name: the statement itself, with the call it made
    code, text = pyokka("why", str(saved), "19")
    assert code == 0 and text.splitlines()[:2] == ["why #19", '#19 main.py:11 <module>   print(greet("bob"), total)']
    assert "  ↳ greet #20–#22 main.py:3   in name = 'bob'   out 'hello bob'" in text.splitlines() and '  · print(greet("bob"), total)   not stepped' in text.splitlines()
    # an assign row without a recorded value, and a redacted one
    code, text = pyokka("why", str(saved), "5", "total")
    assert code == 0 and text.splitlines()[1] == "total = 0  (same object)   #5 main.py:10 <module>   total += helper.double(i)"
    code, text = pyokka("why", str(saved), "23", "secret")
    assert code == 0 and "sk-abc" not in text and text.splitlines()[1].startswith("secret = '%s'   #23 main.py:12" % REDACTED)


def test_why_errors_say_what_to_do_next(saved: Path, capsys):
    code, _ = pyokka("why", str(saved), "5000", "total")
    err = capsys.readouterr().err
    assert code == 2 and "step 5000 is past the recorded 28 steps" in err and "use `steps` or `find`" in err
    code, _ = pyokka("why", str(saved))
    err = capsys.readouterr().err
    assert code == 2 and "why needs STEP" in err and "var run.json label" in err
    code, _ = pyokka("why", str(saved), "total", "10")
    err = capsys.readouterr().err
    assert code == 2 and "STEP must be a step number, got 'total'" in err
    code, _ = pyokka("why")
    err = capsys.readouterr().err
    assert code == 2 and "why needs a saved run, or --live" in err
    code, out = pyokka("why", str(saved.parent / "missing.json"), "10", "total", "--json")
    assert code == 2 and json.loads(out)["error"].startswith("no saved run")


def test_stale_files_are_reported_first(saved: Path, project: Path):
    (project / "helper.py").write_text((project / "helper.py").read_text() + "\n# edited\n", encoding="utf-8")
    code, text = pyokka("story", str(saved), "--file", "main.py")
    assert code == 0 and text.splitlines()[0] == "stale: %s changed since the run" % (project / "helper.py")
    doc = pyokka_json("context", str(saved), "6")
    assert doc["stale"] is True and doc["staleFiles"] == [str(project / "helper.py")]


def test_keep_serves_eval_and_expand(project: Path):
    out = project.parent / "kept.json"
    code, text = pyokka("run", str(project / "main.py"), "--save", str(out), "--keep")
    assert code == 1 and "kept: pid" in text
    meta = json.loads(out.read_text())["meta"]
    keep = meta["keep"]
    assert isinstance(keep["pid"], int) and os.path.exists(keep["socket"])
    try:
        code, text = pyokka("eval", str(out), "total * 2")
        assert (code, text) == (0, "total * 2 = 12\n")
        code, text = pyokka("eval", str(out), "secret")
        assert code == 0 and text == "secret = '%s'\n" % REDACTED
        doc = pyokka_json("eval", str(out), "helper")
        assert doc["text"].startswith("<module 'helper'") and doc["valueBag"]["data"]["type"] == "module"
        code, text = pyokka("eval", str(out), "helper.double(1)", "--json")
        assert code == 2 and "only names" in json.loads(text)["error"]
        doc = pyokka_json("expand", str(out), "e:1", "--path", "e:1")
        assert doc["node"]["type"] in ("number", "int")
        code, text = pyokka("state", str(out))
        assert code == 0 and "kept runner: pid %d" % keep["pid"] in text
    finally:
        code, text = pyokka("release", str(out))
    assert code == 0 and "released" in text
    for _ in range(100):
        if not os.path.exists(keep["socket"]):
            break
        time.sleep(0.05)
    assert not os.path.exists(keep["socket"])
    code, _ = pyokka("eval", str(out), "total")
    assert code == 2


LIB = {
    "venv/site-packages/libq/__init__.py": """
    CONST = 1
    def helper(x):
        y = x + CONST
        return y
    built = helper(1)
    """
}
SRC = """
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'venv', 'site-packages'))
import libq
r = libq.helper(10)
print(r)
"""


def test_library_step_into_lands_in_the_library_function(tmp_path: Path):
    proj = tmp_path / "proj"
    for rel, content in LIB.items():
        p = proj / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(textwrap.dedent(content).lstrip(), encoding="utf-8")
    (proj / "scratch.py").write_text(textwrap.dedent(SRC).lstrip(), encoding="utf-8")
    out = tmp_path / "lib-run.json"
    code, text = pyokka("run", str(proj / "scratch.py"), "--save", str(out), "--library-code")
    assert code == 0 and "2 files" in text
    meta = json.loads(out.read_text())["meta"]
    assert meta["config"]["libraryCode"] is True and meta["files"][1]["path"].endswith("libq/__init__.py")
    call = pyokka_json("steps", str(out), "--line", "scratch.py:4")["steps"][0]["step"]
    doc = pyokka_json("step", str(out), str(call), "--into")
    assert doc["location"]["file"].endswith(os.path.join("libq", "__init__.py")) and doc["location"]["function"] == "helper" and doc["location"]["line"] == 2
    assert ("x", "10") in {(v["context"], v["text"]) for v in doc["values"]}
    assert [l["line"] for l in doc["block"]["lines"]] == [2, 3, 4]
    code, text = pyokka("step", str(out), str(call), "--into")
    assert code == 0
    assert "libq/__init__.py:2  helper [entry]" in text and "x = 10" in text and "y = 11" in text
    # the library's import-time execution (helper(1)) is coverage only: no step of it in the story
    code, text = pyokka("story", str(out), "--file", "__init__.py")
    assert code == 0 and text.splitlines()[0] == "8 steps, 3 blocks, 1 matching" and "## helper  libq/__init__.py:2  steps 4–6" in text


def test_cache_command_reports_and_clears(tmp_path, monkeypatch):
    directory = tmp_path / "pk-cache"
    monkeypatch.setenv("PYOKKA_CACHE_DIR", str(directory))
    code, out = pyokka("cache")
    assert (code, out) == (0, "%s: 0 entries, 0 B\n" % directory)
    directory.mkdir()
    (directory / ("a" * 40 + ".bin")).write_bytes(b"x" * 1200)
    (directory / ("b" * 40 + ".bin")).write_bytes(b"y" * 300)
    (directory / "keep.txt").write_text("not an entry")
    assert pyokka_json("cache") == {"dir": str(directory), "entries": 2, "bytes": 1500}
    code, out = pyokka("cache")
    assert (code, out) == (0, "%s: 2 entries, 1.5 kB\n" % directory)
    code, out = pyokka("cache", "--clear")
    assert (code, out) == (0, "removed 2 entries (1.5 kB) from %s\n" % directory)
    assert sorted(p.name for p in directory.iterdir()) == ["keep.txt"]
    assert pyokka_json("cache", "--clear") == {"dir": str(directory), "removed": 0, "bytes": 0, "failed": 0}
    monkeypatch.setenv("PYOKKA_CACHE_DIR", "")
    code, out = pyokka("cache", "--clear")
    assert (code, out) == (0, "library cache off (PYOKKA_CACHE_DIR is empty); nothing to clear\n")
    assert pyokka_json("cache") == {"dir": None, "entries": 0, "bytes": 0}


def test_debugging_commands_need_a_live_session(capsys):
    for args in (("debug",), ("continue",), ("pause",), ("stop",), ("restart",), ("locals",), ("break", "demo.py:3"), ("watches", "--add", "x")):
        code, _ = pyokka(*args)
        err = capsys.readouterr().err
        assert code == 2 and "drives the open VS Code session, not a saved run" in err and "debugging needs a live session (`--live`)" in err, args
    code, out = pyokka("debug", "--json")
    assert code == 2 and json.loads(out)["hint"] == "debugging needs a live session (`--live`)"


def test_help_lists_the_debugging_commands(capsys):
    with pytest.raises(SystemExit) as info:
        main(["--help"])
    assert info.value.code == 0
    out = capsys.readouterr().out
    for name in ("debug", "continue", "pause", "stop", "restart", "break", "watches", "locals", "shell"):
        assert name in out


def test_values_on_an_assignment_line_names_var(saved: Path):
    """An assignment logs nothing, so the obvious line to ask about answers with nothing.

    Two agents reading a run asked `values --line` on the accumulator line, got "0 values" and a
    hint that named neither of the commands that would have answered them. The hint now names
    `var` for the name the line assigns.
    """
    code, text = pyokka("values", str(saved), "--line", "main.py:10")
    assert code == 0
    assert text.splitlines()[0].startswith("0 values on main.py:10")
    assert "`var total` lists every change of it" in text


def test_at_resolves_against_the_invocation_directory_not_the_launch_cwd(project: Path, monkeypatch):
    """`--at pkg/run.py:28` from the parent of `pkg` means `pkg/run.py`, not `pkg/pkg/run.py`.

    `--at` used to travel as typed and was resolved at the other end against the launch cwd,
    which defaults to the program's own directory (`src/debug/debugUri.ts`). The doubled path
    never resolved to a line, and nothing said so: the run paused on some other breakpoint and
    looked like it had worked. These live here rather than beside the other `--at` cases in
    test_agent_debug.py only because that file is held by another session.
    """
    from pyokka_runtime.agent.debug_start import at_text, resolve_at

    monkeypatch.chdir(project.parent)
    rel = "%s/main.py" % project.name
    assert resolve_at("%s:12" % rel) == {"file": str(project / "main.py"), "line": 12}
    assert at_text(resolve_at("%s:12" % rel)) == "%s:12" % (project / "main.py")
    # from inside the package the same line is named without the directory, and reaches the same file
    monkeypatch.chdir(project)
    assert resolve_at("main.py:12") == {"file": str(project / "main.py"), "line": 12}
    # a function name is resolved by the runtime, so it is carried through untouched
    assert resolve_at("Ranker.rank") == {"function": "Ranker.rank"}
    assert at_text({"function": "rrf"}) == "rrf"


def test_at_refuses_a_file_that_is_not_there(project: Path, monkeypatch):
    """The doubled path of the case above, given directly: refused before anything starts."""
    from pyokka_runtime.agent.source import AgentError
    from pyokka_runtime.agent.debug_start import resolve_at

    monkeypatch.chdir(project.parent)
    with pytest.raises(AgentError) as info:
        resolve_at("%s/%s/main.py:12" % (project.name, project.name))
    assert "--at names no file" in str(info.value)
    assert "resolved from the directory you ran `pyokka` in" in info.value.hint
    assert "`--at main.py:12`" in info.value.hint, "the hint names the file it could not find"
    # and that hint is real advice: a bare name is not a path, so it travels as typed and the host
    # matches it against the files of the run. That is how a file outside the invocation directory
    # is named, and `pyokka debug /abs/app.py --at app.py:12` from anywhere depends on it.
    assert resolve_at("main.py:12") == {"file": "main.py", "line": 12}, "a bare name that is not here is still a name"


def test_debug_at_a_missing_file_fails_before_the_window_is_asked(project: Path, monkeypatch):
    """`pyokka debug FILE --at ...` validates `--at` before it opens anything."""
    monkeypatch.chdir(project.parent)
    monkeypatch.setenv("PYOKKA_CODE", "/bin/false")
    code, out = pyokka("debug", str(project / "main.py"), "--at", "nope/main.py:12", "--json")
    assert code == 2
    assert json.loads(out)["error"] == "--at names no file: nope/main.py"


def test_stale_names_the_reason_when_the_reply_carries_one():
    """A debug stop says whether the source shown is the editor's or the file on disk.

    Both conditions used to print "changed since the run", which says nothing about what to do
    with the block underneath it. A reader who saw it on a run they had just started read it as
    noise and skipped it, and the block they went on to read was their own unsaved buffer, not
    the code that was running (handoffs/2026-09-15-debugger-streaming-output.md, item 6).
    """
    from pyokka_runtime.agent.render import _stale_lines

    unsaved = _stale_lines({"staleFiles": ["run.py"], "staleReason": "unsaved"}, None)
    assert unsaved == ["stale: run.py has unsaved edits; the source below is the editor's, not the code that is running"]
    disk = _stale_lines({"staleFiles": ["run.py"], "staleReason": "disk"}, None)
    assert disk == ["stale: run.py changed on disk since the run started; the source below is not the code that ran"]
    # a saved run has no reason to give, and "changed since the run" is exactly right for it
    assert _stale_lines({"staleFiles": ["run.py"]}, None) == ["stale: run.py changed since the run"]
    assert _stale_lines({"staleFiles": []}, None) == []
