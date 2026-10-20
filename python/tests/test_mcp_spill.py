"""A tool result over the limit goes to a file: the reply keeps its first lines, two marker lines and its last lines,
``next:`` among them, or a small JSON object for a JSON answer. The file holds the whole text, under the Pyokka home,
else the system temp directory; with neither, the text comes back whole with a note.

conftest gives each test its own ``PYOKKA_HOME``, so the files land under ``tmp_path``. A result is made long by
standing in for the tool's call (``call_review``, ``session_state``), since the case that made the limit was a review
``start`` of 65,050 characters (2026-10-19).
"""

from __future__ import annotations

import json
import os
import re
import shlex
import stat
import tempfile
from pathlib import Path

import pytest

from pyokka_runtime.agent import mcp_session, mcp_spill
from pyokka_runtime.agent.mcp import call_tool, handle
from pyokka_runtime.agent.review import tool as review_tool

NEXT = 'next: continue in the debugger to the next item (pyokka continue --live; MCP pyokka_debug {"action": "continue"}), then review stop --say TEXT at the pause'
START = {"action": "start", "base": "HEAD~1"}


def start_text(lines: int = 300) -> str:
    """A review ``start`` answer of ``lines`` lines: the header, the summary, the view, the agenda, edge candidates, then ``next:``."""
    out = [
        "review shop-1a2b3c4 · stops · stops 0/58 shown · findings 0 · tries 0",
        "shop: 1a2b3c4 → working tree at 9f8e7d6, entry main.py, review directory /tmp/review",
        "742 changed lines in 12 Python files; 58 items on the agenda, one breakpoint each, in the changed functions of 9 files",
        "view: VS Code debug session on main.py, paused on entry at main.py:1; 58 breakpoints on the changed lines",
        "stops (58):",
    ]
    i = 0
    while len(out) < lines - 1:
        i += 1
        if i <= 58:
            out.append("  %d. change  shopkit/module_%02d.py:%d price_%d  changed lines %d-%d  (pending)" % (i, i, 10 * i, i, 10 * i, 10 * i + 4))
        else:
            e = i - 58
            out.append("  E%d [boundary] shopkit/module_%02d.py:%d price_%d: `total > %d`: try a value at the boundary and one on each side" % (e, e % 58, 10 * e, e, e))
    out.append(NEXT)
    return "\n".join(out) + "\n"


@pytest.fixture
def review_answers(monkeypatch):
    """``pyokka_review`` answers what the test sets, the way ``call_review`` returns it: ``text`` and ``is_error``."""
    answer = {"text": "", "is_error": False}
    monkeypatch.setattr(review_tool, "call_review", lambda arguments: (answer["text"], answer["is_error"]))
    return answer


@pytest.fixture
def read_only(tmp_path):
    """Makes directories nobody may write in, writable again at teardown; skipped as root, which writes through the mode."""
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        pytest.skip("root writes through a read-only mode")
    made: list[Path] = []

    def make(name: str) -> Path:
        d = tmp_path / name
        d.mkdir()
        d.chmod(0o500)
        made.append(d)
        return d

    yield make
    for d in made:
        d.chmod(0o700)


def spilled_dir() -> Path:
    return Path(os.environ["PYOKKA_HOME"]) / "tool-results"


def reply(res: dict) -> str:
    return res["content"][0]["text"]


def last_line(text: str) -> str:
    return text.rstrip("\n").split("\n")[-1]


def test_a_result_under_the_limit_comes_back_untouched_and_writes_no_file(review_answers):
    text = review_answers["text"] = start_text(20)
    assert len(text) < mcp_spill.MAX_CHARS
    assert call_tool("pyokka_review", START) == {"content": [{"type": "text", "text": text}], "isError": False}
    assert not spilled_dir().exists()


def test_a_300_line_result_keeps_its_head_and_tail_inline_and_the_file_holds_it_all(review_answers):
    text = review_answers["text"] = start_text(300)
    res = handle({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "pyokka_review", "arguments": START}})["result"]
    shown = reply(res)
    assert res["isError"] is False and len(shown) <= mcp_spill.MAX_CHARS < len(text)
    (path,) = spilled_dir().iterdir()
    assert re.fullmatch(r"\d{8}-\d{6}-pyokka_review-start\.txt", path.name)
    assert path.read_text(encoding="utf-8") == text and stat.S_IMODE(path.stat().st_mode) == 0o600
    whole, lines = text.rstrip("\n").split("\n"), shown.rstrip("\n").split("\n")
    m = next(i for i, line in enumerate(lines) if line.startswith("[… "))
    left, total, first, last = map(int, re.match(r"\[… (\d+) of (\d+) lines left out \((\d+) to (\d+)\);", lines[m]).groups())
    # the marker counts the file's lines, and the lines around it are the file's first and last ones verbatim
    assert total == len(whole) == 300 and left == last - first + 1
    assert lines[:m] == whole[: first - 1] and lines[m + 2 :] == whole[last:]
    assert "the whole result, %s characters, is in %s]" % (format(len(text), ","), path) in lines[m]
    assert lines[m + 1] == "[read them with sed -n '%d,%dp' %s or your file tool]" % (first, last, shlex.quote(str(path)))
    # a start keeps its header, summary, view and first agenda items, and its last line, next:
    assert lines[3].startswith("view: ") and lines[4] == "stops (58):" and sum(". change  " in line for line in lines[:m]) >= 20
    assert lines[-1] == NEXT and m <= mcp_spill.HEAD_LINES and len(lines) - m - 2 <= mcp_spill.TAIL_LINES


def test_pyokka_mcp_max_chars_moves_the_limit_and_a_bad_value_keeps_the_default(review_answers, monkeypatch):
    text = review_answers["text"] = start_text(40)
    assert 2000 < len(text) < mcp_spill.MAX_CHARS
    monkeypatch.setenv("PYOKKA_MCP_MAX_CHARS", "2000")
    shown = reply(call_tool("pyokka_review", START))
    assert len(shown) <= 2000 and "lines left out" in shown and last_line(shown) == NEXT and len(list(spilled_dir().iterdir())) == 1
    text = review_answers["text"] = start_text(300)
    monkeypatch.setenv("PYOKKA_MCP_MAX_CHARS", "100000")
    assert reply(call_tool("pyokka_review", START)) == text
    for bad in ("8k", "0", "-5", " "):
        monkeypatch.setenv("PYOKKA_MCP_MAX_CHARS", bad)
        assert mcp_spill.max_chars() == mcp_spill.MAX_CHARS


def test_an_unwritable_home_falls_back_to_the_system_temp_directory(review_answers, monkeypatch, tmp_path, read_only):
    monkeypatch.setattr(mcp_spill, "pyokka_home", lambda: str(read_only("ro-home") / "home"))
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()
    text = review_answers["text"] = start_text(300)
    shown = reply(call_tool("pyokka_review", START))
    (path,) = (tmp_path / "tmp" / "pyokka-tool-results").iterdir()
    assert path.read_text(encoding="utf-8") == text and str(path) in shown and last_line(shown) == NEXT
    assert not (tmp_path / "ro-home" / "home").exists()


def test_with_no_directory_to_write_the_whole_text_comes_back_with_one_note_line(review_answers, monkeypatch, tmp_path, read_only):
    monkeypatch.setattr(mcp_spill, "pyokka_home", lambda: str(read_only("ro-home") / "home"))
    monkeypatch.setattr(tempfile, "tempdir", str(read_only("ro-tmp")))
    text = review_answers["text"] = start_text(300)
    shown = reply(call_tool("pyokka_review", START))
    *body, note = shown.rstrip("\n").split("\n")
    assert "\n".join(body) + "\n" == text and shown.endswith("\n")
    assert note.startswith("[this result is %s characters, over the 8,000 kept inline (PYOKKA_MCP_MAX_CHARS), but " % format(len(text), ","))
    assert str(tmp_path / "ro-home" / "home" / "tool-results") in note and str(tmp_path / "ro-tmp" / "pyokka-tool-results") in note


def test_writing_one_deletes_the_oldest_beyond_200_and_only_spilled_files(review_answers):
    d = spilled_dir()
    d.mkdir(parents=True)
    old = ["20200101-%06d-pyokka_map-walkthrough.txt" % i for i in range(201)]
    for name in old:
        (d / name).write_text("old\n", encoding="utf-8")
    (d / "notes.md").write_text("the person's own\n", encoding="utf-8")
    review_answers["text"] = start_text(300)
    shown = reply(call_tool("pyokka_review", START))
    names = {p.name for p in d.iterdir()}
    (new,) = [n for n in names if "pyokka_review-start" in n]
    assert str(d / new) in shown and len(names) == mcp_spill.KEEP_FILES + 1
    assert not {old[0], old[1]} & names and set(old[2:]) <= names and "notes.md" in names


def test_an_error_over_the_limit_spills_and_stays_an_error(review_answers):
    review_answers["text"], review_answers["is_error"] = start_text(300), True
    res = call_tool("pyokka_review", {"action": "stop", "n": 1, "say": "x"})
    assert res["isError"] is True and "lines left out" in reply(res) and last_line(reply(res)) == NEXT
    assert re.fullmatch(r"\d{8}-\d{6}-pyokka_review-stop\.txt", next(spilled_dir().iterdir()).name)


def test_a_json_answer_over_the_limit_comes_back_as_a_small_json_object(review_answers, monkeypatch):
    sessions = {"sessions": [{"file": "/work/app_%03d.py" % i, "kind": "debug", "recording": False, "workspace": "/work"} for i in range(150)]}
    monkeypatch.setattr(mcp_session, "session_state", lambda arguments: sessions)
    res = call_tool("pyokka_session", {})
    doc = json.loads(reply(res))
    whole = Path(doc["path"]).read_text(encoding="utf-8")
    assert res["isError"] is False and set(doc) == {"spilled", "path", "characters", "lines", "head", "read"} and doc["spilled"] is True
    assert json.loads(whole) == sessions and doc["characters"] == len(whole) and doc["lines"] == whole.count("\n")
    shown = doc["head"].count("\n")
    assert whole.startswith(doc["head"]) and 0 < len(doc["head"]) <= mcp_spill.MAX_CHARS // 4 and len(reply(res)) < mcp_spill.MAX_CHARS
    assert doc["read"] == "sed -n '%d,%dp' %s or your file tool" % (shown + 1, doc["lines"], shlex.quote(doc["path"]))
    # json: true on another tool makes a JSON answer too
    review_answers["text"] = whole
    doc = json.loads(reply(call_tool("pyokka_review", {"action": "state", "json": True})))
    assert doc["spilled"] is True and Path(doc["path"]).read_text(encoding="utf-8") == whole
    # an error raised before any answer is text whatever json says, so it spills as text
    monkeypatch.setenv("PYOKKA_MCP_MAX_CHARS", "20")
    assert reply(call_tool("pyokka_map", {"json": True})).startswith("[… 2 of 2 lines left out (1 to 2); ")


def test_spilled_files_never_collide_and_an_action_cannot_leave_the_directory(tmp_path):
    stem = "20261020-101010-pyokka_review-start"
    first, second = mcp_spill.write_new(str(tmp_path), stem, "one\n"), mcp_spill.write_new(str(tmp_path), stem, "two\n")
    assert (Path(first).name, Path(second).name) == (stem + ".txt", stem + "-2.txt")
    assert (Path(first).read_text(encoding="utf-8"), Path(second).read_text(encoding="utf-8")) == ("one\n", "two\n")
    assert re.fullmatch(r"\d{8}-\d{6}-pyokka_page-etc_passwd", mcp_spill.file_stem("pyokka_page", {"action": "../../etc/passwd"}))


def test_a_failure_inside_the_spill_returns_the_text_whole(review_answers, monkeypatch, capsys):
    def broken(directory, stem, text):
        raise RuntimeError("the disk answered nonsense")

    monkeypatch.setattr(mcp_spill, "write_new", broken)
    text = review_answers["text"] = start_text(300)
    assert call_tool("pyokka_review", START) == {"content": [{"type": "text", "text": text}], "isError": False}
    assert "RuntimeError: the disk answered nonsense" in capsys.readouterr().err
