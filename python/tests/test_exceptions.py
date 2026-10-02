"""`pyokka exceptions`: the report over the fixture run, its text form, folding over older runs, `examples/demo.py`, `--live`.

The fixture program lives in `test/unit/fixtures/exceptions/` (a loop raising into a bare `except:`, a
specific handler in a function, a `with` and a `finally` on the way to an `except Exception`, a handler
that re-raises, `contextlib.suppress`, a library raising into user code, `getattr` with a default over a
raising `__getattr__`, an uncaught ZeroDivisionError). This file regenerates the run with library
stepping on and checks the report against `exceptions.json`; the TypeScript builder
(`test/unit/exceptionReport.test.ts`) reads `exceptions-run.json` and must produce the same report.
Regenerate both with PYOKKA_WRITE_FIXTURES=1.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

import pytest

from pyokka_runtime.agent.exceptions import exceptions, render_exceptions, summary
from pyokka_runtime.agent.live import SESSIONS_ENV
from pyokka_runtime.agent.source import SavedRun
from pyokka_runtime.redact import REDACTED

from conftest import DEMO
from test_agent_live import FILE, FakeBridge, write_descriptor
from test_walkthrough import FIXTURES, normalize, pyokka, saved_run

PROGRAM = FIXTURES / "exceptions"
RUN_JSON = FIXTURES / "exceptions-run.json"
REPORT_JSON = FIXTURES / "exceptions.json"
LIBX = "venv/site-packages/libx/__init__.py"
MAIN_SRC = (PROGRAM / "main.py").read_text(encoding="utf-8")
LIBX_SRC = (PROGRAM / LIBX).read_text(encoding="utf-8")
SUMMARY = re.compile(r"^8 exceptions over \d+ steps: 1 uncaught, 7 caught \(10 raises\), 2 by a broad handler$")  # the e2e suite's check


def pyokka_json(*args: str) -> dict:
    code, out = pyokka(*args, "--json")
    doc = json.loads(out)
    assert code == 0, doc
    return doc


def line_of(source: str, text: str) -> int:
    """1-based line of the first source line containing ``text``."""
    for i, line in enumerate(source.split("\n")):
        if text in line:
            return i + 1
    raise AssertionError("no line with %r" % text)


def rid_at(run: SavedRun, file_id: int, line: int) -> int:
    """The global range id of the statement starting on ``line``."""
    f = run.files[file_id]
    for local in f["statements"]:
        if f["ranges"][local][0] == line:
            return int(f["rangeBase"]) + int(local)
    raise AssertionError("no statement on line %d" % line)


def handled(row: dict) -> tuple:
    at = row["handledAt"]
    return at["line"], at["function"], at["broad"]


@pytest.fixture
def fixture_run(tmp_path: Path) -> Path:
    return saved_run(tmp_path, MAIN_SRC, files={LIBX: LIBX_SRC}, config={"libraryCode": True})


def test_fixture_report_matches_the_shared_json(fixture_run: Path, tmp_path: Path):
    result = exceptions(SavedRun(str(fixture_run)))
    root = str(tmp_path / "proj")
    report = json.loads(normalize(json.dumps(result, ensure_ascii=False), root))
    if os.environ.get("PYOKKA_WRITE_FIXTURES"):
        REPORT_JSON.write_text(json.dumps(report, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        RUN_JSON.write_text(normalize(fixture_run.read_text(encoding="utf-8"), root) + "\n", encoding="utf-8")
    expected = json.loads(REPORT_JSON.read_text(encoding="utf-8"))
    assert [(r["kind"], r["errorType"], r["count"]) for r in report["rows"]] == [(r["kind"], r["errorType"], r["count"]) for r in expected["rows"]]
    assert report == expected
    assert report["file"] == "/fixture/main.py" and report["rows"][0]["raisedAt"]["file"] == "/fixture/main.py"


def test_fixture_rows(fixture_run: Path, tmp_path: Path):
    run = SavedRun(str(fixture_run))
    doc = exceptions(run)
    main = str(tmp_path / "proj" / "main.py")
    assert (doc["total"], doc["raises"], doc["uncaught"], doc["caught"], doc["broad"]) == (8, 11, 1, 7, 2)
    assert doc["count"] == run.trace.count > 40 and doc["exitCode"] == 1 and doc["file"] == main
    assert doc["stale"] is False and doc["staleFiles"] == []
    rows = doc["rows"]
    assert [r["id"] for r in rows] == ["x%d" % i for i in range(8)]
    by_type = {r["errorType"]: r for r in rows}
    assert len(by_type) == 8
    # the uncaught one first, then the caught rows in step order
    zero = rows[0]
    assert zero["kind"] == "uncaught" and zero["errorType"] == "ZeroDivisionError" and zero["message"] == "division by zero"
    assert zero["raisedAt"] == {"file": main, "line": line_of(MAIN_SRC, "print(total / (total - total))"), "function": "<module>", "fileId": 1, "rid": zero["raisedAt"]["rid"]}
    assert zero["raisedAt"]["rid"] == rid_at(run, 1, zero["raisedAt"]["line"])
    assert zero["handledAt"] is None and zero["count"] == 1 and zero["lastStep"] == zero["step"] == run.trace.count - 1
    assert all(r["kind"] == "caught" for r in rows[1:])
    steps = [r["step"] for r in rows[1:]]
    assert steps == sorted(steps) and len(set(steps)) == 7
    # the loop: three KeyErrors from lookup into the bare except
    key = by_type["KeyError"]
    assert key["count"] == 3 and key["lastStep"] > key["step"] and key["message"] == "'b'"
    assert key["raisedAt"]["line"] == line_of(MAIN_SRC, "return table[key]") and key["raisedAt"]["function"] == "lookup"
    assert key["raisedAt"]["rid"] == rid_at(run, 1, key["raisedAt"]["line"]) and key["raisedAt"]["fileId"] == 1
    try_line = line_of(MAIN_SRC, "found += lookup(table, key)") - 1
    assert key["handledAt"] == {"file": main, "line": line_of(MAIN_SRC, "except:  # noqa: E722"), "function": "<module>", "fileId": 1, "rid": rid_at(run, 1, try_line), "broad": True}
    # a specific handler in a function (int() raised in C, attributed to the calling statement)
    value = by_type["ValueError"]
    assert value["count"] == 1 and value["raisedAt"]["line"] == line_of(MAIN_SRC, "return int(text)") and value["raisedAt"]["function"] == "parse_amount"
    assert handled(value) == (line_of(MAIN_SRC, "except ValueError as exc:"), "parse_amount", False)
    # through a with and a finally to the outer except Exception
    oserr = by_type["OSError"]
    assert oserr["message"] == "no such file: settings.toml" and oserr["raisedAt"]["line"] == line_of(MAIN_SRC, "raise OSError(") and oserr["raisedAt"]["function"] == "load"
    assert handled(oserr) == (line_of(MAIN_SRC, "except Exception:"), "load", True)
    # the inner handler re-raised: the outer clause caught it
    rt = by_type["RuntimeError"]
    assert rt["count"] == 1 and rt["raisedAt"]["line"] == line_of(MAIN_SRC, 'raise RuntimeError("inner")') and rt["raisedAt"]["function"] == "rethrow"
    assert handled(rt) == (line_of(MAIN_SRC, "except RuntimeError as err:"), "<module>", False)
    # contextlib.suppress swallows at the with line
    idx = by_type["IndexError"]
    assert idx["raisedAt"]["line"] == line_of(MAIN_SRC, "return items[3]") and idx["raisedAt"]["function"] == "third"
    assert handled(idx) == (line_of(MAIN_SRC, "with contextlib.suppress(IndexError):"), "third", False)
    # the library raised into user code (library stepping on: the origin is the library file); its own catch is not listed
    typ = by_type["TypeError"]
    lib_fid = next(fid for fid, f in run.files.items() if str(f["path"]).endswith(LIBX.replace("/", os.sep)))
    assert typ["count"] == 1 and typ["message"] == "nothing to unwrap"
    assert typ["raisedAt"] == {"file": run.file_path(lib_fid), "line": line_of(LIBX_SRC, 'raise TypeError("nothing to unwrap")'), "function": "unwrap", "fileId": lib_fid, "rid": typ["raisedAt"]["rid"]}
    assert typ["raisedAt"]["file"].endswith("libx/__init__.py") and typ["raisedAt"]["rid"] == rid_at(run, lib_fid, typ["raisedAt"]["line"])
    assert handled(typ) == (line_of(MAIN_SRC, "except TypeError:"), "<module>", False) and typ["handledAt"]["fileId"] == 1
    # caught by C code: getattr with a default, twice
    attr = by_type["AttributeError"]
    assert attr["count"] == 2 and attr["lastStep"] > attr["step"] and attr["handledAt"] is None and attr["message"] == "x"
    assert attr["raisedAt"]["line"] == line_of(MAIN_SRC, "raise AttributeError(name)") and attr["raisedAt"]["function"] == "__getattr__"


def test_text_form(fixture_run: Path):
    doc = exceptions(SavedRun(str(fixture_run)))
    code, text = pyokka("exceptions", str(fixture_run))
    assert code == 0
    lines = text.splitlines()
    assert lines[0] == "8 exceptions over %d steps: 1 uncaught, 7 caught (10 raises), 2 by a broad handler" % doc["count"] and SUMMARY.match(lines[0])
    zero = doc["rows"][0]
    assert lines[1:3] == ["#%d  uncaught ZeroDivisionError: division by zero" % zero["step"], "      raised main.py:%d <module>" % zero["raisedAt"]["line"]]
    by_type = {r["errorType"]: r for r in doc["rows"]}
    key = by_type["KeyError"]
    assert "#%d  caught ×3 KeyError: 'b'" % key["step"] in lines
    assert "      raised main.py:%d lookup · caught main.py:%d <module> broad handler · last #%d" % (key["raisedAt"]["line"], key["handledAt"]["line"], key["lastStep"]) in lines
    value = by_type["ValueError"]
    assert "#%d  caught ValueError: invalid literal for int() with base 10: '12x'" % value["step"] in lines
    assert "      raised main.py:%d parse_amount · caught main.py:%d parse_amount" % (value["raisedAt"]["line"], value["handledAt"]["line"]) in lines
    typ = by_type["TypeError"]
    assert "      raised libx/__init__.py:%d unwrap · caught main.py:%d <module>" % (typ["raisedAt"]["line"], typ["handledAt"]["line"]) in lines
    attr = by_type["AttributeError"]
    assert "      raised main.py:%d __getattr__ · caught outside stepped code · last #%d" % (attr["raisedAt"]["line"], attr["lastStep"]) in lines
    assert len(lines) == 1 + 2 * 8 and all(len(l) <= 100 for l in lines)
    assert not any("rangeBase" in l or "rid" in l.split() for l in lines)
    assert pyokka_json("exceptions", str(fixture_run)) == json.loads(json.dumps(doc))


def test_folds_events_of_one_site_and_defaults_older_runs(tmp_path: Path):
    src = """
    def lookup(d, k):
        return d[k]
    for i in range(2):
        try:
            v = lookup({}, i)
        except KeyError:
            v = None
    """
    path = saved_run(tmp_path, src)
    doc = json.loads(path.read_text(encoding="utf-8"))
    (ev,) = [e for e in doc["events"] if e.get("type") == "error"]
    assert ev["count"] == 2 and ev["handledAt"]["broad"] is False
    # an event as runs before the aggregation saved them: no count, no lastStep; an earlier raise of the same site into the same handler
    older = {k: v for k, v in ev.items() if k not in ("count", "lastStep")}
    older.update({"step": ev["step"] - 1, "message": "token=sk-abcdefghijklmnopqrstuvwxyz012345"})
    # the same site caught outside stepped code: its own row
    elsewhere = {k: v for k, v in ev.items() if k not in ("count", "lastStep", "handledAt")}
    elsewhere["step"] = ev["lastStep"] + 1
    # an unknown file and statement
    unknown = {"type": "error", "fileId": 9, "rid": 99999, "step": 1, "message": "  two\n words ", "errorType": "LookupError", "stack": [], "handled": True}
    doc["events"] = [e for e in doc["events"] if e.get("type") != "error"] + [ev, older, elsewhere, unknown]
    path.write_text(json.dumps(doc), encoding="utf-8")
    run = SavedRun(str(path))
    report = exceptions(run)
    assert (report["total"], report["raises"], report["uncaught"], report["caught"], report["broad"]) == (3, 5, 0, 3, 0)
    lookup_error, folded, outside = report["rows"]  # caught rows by step: the unknown one raised at step 1
    assert folded["count"] == 3 and folded["step"] == ev["step"] - 1 and folded["lastStep"] == ev["lastStep"]
    assert folded["message"] == "token=sk-abcdefghijklmnopqrstuvwxyz012345" and folded["raisedAt"]["function"] == "lookup" and folded["handledAt"]["rid"] == ev["handledAt"]["rid"]
    assert lookup_error["step"] == lookup_error["lastStep"] == 1 and lookup_error["count"] == 1 and lookup_error["message"] == "two words"
    assert lookup_error["raisedAt"] == {"file": None, "line": 0, "function": "<module>", "fileId": 9, "rid": 99999} and lookup_error["handledAt"] is None
    assert outside["count"] == 1 and outside["step"] == outside["lastStep"] == ev["lastStep"] + 1 and outside["handledAt"] is None and outside["raisedAt"]["rid"] == ev["rid"]
    assert [r["id"] for r in report["rows"]] == ["x0", "x1", "x2"]
    code, text = pyokka("exceptions", str(path))
    assert code == 0
    lines = text.splitlines()
    assert lines[0] == "3 exceptions over %d steps: 0 uncaught, 3 caught (5 raises)" % run.trace.count
    assert lines[1:3] == ["#1  caught LookupError: two words", "      raised <unknown>:0 <module> · caught outside stepped code"]
    assert lines[3] == "#%d  caught ×3 KeyError: token=%s" % (folded["step"], REDACTED) and "sk-abc" not in text
    assert lines[4] == "      raised main.py:3 lookup · caught main.py:7 <module> · last #%d" % folded["lastStep"]
    assert lines[6] == "      raised main.py:3 lookup · caught outside stepped code"


def test_summary_wording_and_line_bound():
    assert summary({"total": 0, "count": 7}) == "no exceptions over 7 steps"
    one = {"total": 1, "count": 9, "uncaught": 0, "caught": 1, "broad": 0, "rows": [{"kind": "caught", "count": 1}]}
    assert summary(one) == "1 exception over 9 steps: 0 uncaught, 1 caught"
    assert summary({"total": 1, "count": 9, "uncaught": 1, "caught": 0, "broad": 0, "rows": [{"kind": "uncaught", "count": 1}]}) == "1 exception over 9 steps: 1 uncaught, 0 caught"

    class Source:
        def display_path(self, path):
            return os.path.basename(path or "") or "<unknown>"

    long = {"id": "x0", "kind": "caught", "errorType": "KeyError", "message": "y" * 180, "count": 1, "step": 3, "lastStep": 3, "raisedAt": {"file": "/w/main.py", "line": 21, "function": "lookup", "fileId": 1, "rid": 1}, "handledAt": {"file": "/w/main.py", "line": 68, "function": "<module>", "fileId": 1, "rid": 2, "broad": True}}
    lines = render_exceptions({**one, "rows": [long]}, Source(), None)
    assert lines[1].startswith("#3  caught KeyError: yyy") and lines[1].endswith("…") and len(lines[1]) == 100
    assert lines[2] == "      raised main.py:21 lookup · caught main.py:68 <module> broad handler"


def test_demo_reports_only_the_uncaught_value_error(tmp_path: Path):
    path = saved_run(tmp_path, DEMO.read_text(encoding="utf-8"), name="demo.py")
    doc = exceptions(SavedRun(str(path)))
    assert (doc["total"], doc["raises"], doc["uncaught"], doc["caught"], doc["broad"]) == (1, 1, 1, 0, 0) and doc["exitCode"] == 1
    (row,) = doc["rows"]
    assert row["id"] == "x0" and row["kind"] == "uncaught" and row["errorType"] == "ValueError" and row["message"].startswith("Kaboom!") and row["handledAt"] is None
    assert row["raisedAt"]["line"] == line_of(DEMO.read_text(encoding="utf-8"), 'raise ValueError("Kaboom!') and row["raisedAt"]["function"] == "<module>"
    code, text = pyokka("exceptions", str(path))
    assert code == 0 and text.splitlines()[0] == "1 exception over %d steps: 1 uncaught, 0 caught" % doc["count"]


class ExceptionsBridge(FakeBridge):
    """Answers `exceptions` with the host's report shape (`buildExceptionReport`); everything else is the fake's."""

    def reply(self, req: dict) -> dict:
        if req.get("type") == "exceptions":
            rows = [
                {"id": "x0", "kind": "uncaught", "errorType": "ValueError", "message": "Kaboom", "count": 1, "step": 39, "lastStep": 39, "raisedAt": {"file": FILE, "line": 95, "function": "<module>", "fileId": 1, "rid": 60}, "handledAt": None},
                {"id": "x1", "kind": "caught", "errorType": "KeyError", "message": "'b'", "count": 3, "step": 12, "lastStep": 20, "raisedAt": {"file": FILE, "line": 21, "function": "lookup", "fileId": 1, "rid": 12}, "handledAt": {"file": FILE, "line": 68, "function": "<module>", "fileId": 1, "rid": 40, "broad": True}},
            ]
            return {"ok": True, "count": 40, "file": FILE, "exitCode": 1, "stale": self.stale, "staleFiles": [FILE] if self.stale else [], "total": 2, "raises": 4, "uncaught": 1, "caught": 1, "broad": 1, "rows": rows}
        return super().reply(req)


def test_live_command_path(tmp_path: Path, monkeypatch):
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    monkeypatch.setenv(SESSIONS_ENV, str(sessions))
    monkeypatch.chdir(tmp_path)
    bridge = ExceptionsBridge()
    write_descriptor(sessions, "1", bridge.descriptor())
    try:
        doc = pyokka_json("exceptions", "--live")
        assert bridge.requests == [{"id": 1, "type": "exceptions"}]
        assert doc["total"] == 2 and doc["rows"][1]["handledAt"]["broad"] is True and "ok" not in doc and "id" not in doc
        code, text = pyokka("exceptions", "--live")
        assert code == 0
        assert text == "2 exceptions over 40 steps: 1 uncaught, 1 caught (3 raises), 1 by a broad handler\n#39  uncaught ValueError: Kaboom\n      raised demo.py:95 <module>\n#12  caught ×3 KeyError: 'b'\n      raised demo.py:21 lookup · caught demo.py:68 <module> broad handler · last #20\n"
        bridge.stale = True
        code, text = pyokka("exceptions", "--live")
        assert code == 0 and text.startswith("stale: %s changed since the run\n2 exceptions over 40 steps" % FILE)
    finally:
        bridge.close()
    code, _ = pyokka("exceptions", str(tmp_path / "missing.json"))
    assert code == 2
