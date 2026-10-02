"""`--live`: discovery of bridge descriptors, the token handshake, every command's request and rendering, `watch`."""

from __future__ import annotations

import io
import json
import os
import socket
import sys
import tempfile
import threading
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from pyokka_runtime.__main__ import main
from pyokka_runtime.agent.live import SESSIONS_ENV, list_sessions, pick_session
from pyokka_runtime.redact import REDACTED

WORKSPACE = "/ws/proj"
FILE = WORKSPACE + "/demo.py"
DEAD_PID = 4_194_303  # above macOS's and Linux's pid ranges


def slice_at(step: int, **over) -> dict:
    """A context slice as the bridge sends it (no firstStep/lastStep/totalLines/flags)."""
    out = {
        "step": step,
        "count": 40,
        "location": {"file": FILE, "line": 11, "col": 0, "function": "<module>", "fileId": 1},
        "stale": False,
        "stack": [{"file": FILE, "line": 11, "function": "<module>", "step": step}],
        "block": {"file": FILE, "function": "<module>", "scopeId": 0, "lines": [{"line": 9, "text": "pyokka = {'is_awesome': True}", "step": 2}, {"line": 11, "text": "print(pyokka)", "step": step, "current": True}]},
        "values": [{"line": 11, "context": None, "text": "{'is_awesome': True, 'api_key': 'sk-abcdefghijklmnopqrstuvwxyz'}", "step": step, "hit": 1, "runtimeKey": "7"}],
        "coverage": {"notRun": [32]},
        "moves": {"into": step + 1, "over": step + 1, "out": 39, "back": step - 1, "backOver": step - 1, "backOut": None},
        "errors": [{"file": FILE, "line": 95, "type": "ValueError", "message": "Kaboom", "step": 39}],
    }
    out.update(over)
    return out


def paused_at(step: int, reason: str, line: int = 11, **extra) -> dict:
    """A PausedInfo as the bridge sends it (see "Debugging over the bridge")."""
    return {"step": step, "rid": 7, "fileId": 1, "file": FILE, "line": line, "scopeId": 0, "depth": 0, "reason": reason, "stack": [{"scopeId": 0, "name": "<module>", "rid": 0, "depth": 0}], **extra}


LOCALS = [{"name": "total", "text": "3"}, {"name": "payload", "text": "None"}]
OUTPUT = {"text": "start\nloading 1\nloading 2\n", "truncated": False}  # what the program printed so far, as every stop carries it


class FakeBridge:
    """A thread speaking the bridge protocol on a Unix socket; replies are canned per request type."""

    def __init__(self, token: str = "t0ken", events: list[dict] | None = None) -> None:
        self.dir = tempfile.mkdtemp(prefix="pyokka-fb")  # short: AF_UNIX paths are capped at 104 bytes on macOS
        self.socket_path = os.path.join(self.dir, "b.sock")
        self.token = token
        self.events = events or []
        self.requests: list[dict] = []
        self.tokens: list = []
        self.stale = False
        self.nav = {"active": False, "step": None, "count": 40}
        self.debug: dict | None = None  # {"active", "paused", "frontier"} once a debug run exists
        self.output = dict(OUTPUT)  # the program's output so far, carried by every stop reply
        self.breakpoints: list[dict] = []
        self.exceptions = "uncaught"  # where an exception pauses the run; `break` sets and reports it
        self.watches: list[dict] = []
        self.finish_next = False  # the next `continue` or frontier step ends the run
        self.canned: dict[str, dict] = {}  # request type -> reply body, for verbs a test adds (`recording`)
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(self.socket_path)
        self.listener.listen(4)
        self.listener.settimeout(0.2)
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def descriptor(self, *, pid: int | None = None, file: str = FILE, workspace: str = WORKSPACE, started: str = "2026-09-10T10:00:00Z", token: str | None = None) -> dict:
        return {"socket": self.socket_path, "token": token if token is not None else self.token, "pid": pid if pid is not None else os.getpid(), "workspace": workspace, "file": file, "displayName": os.path.basename(file), "runtimeVersion": "0.0.1", "started": started}

    def close(self) -> None:
        self.stop.set()
        self.thread.join(2)
        self.listener.close()
        for name in os.listdir(self.dir):
            os.unlink(os.path.join(self.dir, name))
        os.rmdir(self.dir)

    def _serve(self) -> None:
        while not self.stop.is_set():
            try:
                conn, _ = self.listener.accept()
            except socket.timeout:
                continue
            threading.Thread(target=self._client, args=(conn,), daemon=True).start()

    def _client(self, conn: socket.socket) -> None:
        reader = conn.makefile("rb")
        writer = conn.makefile("wb")
        try:
            first = json.loads(reader.readline())
            self.tokens.append(first.get("token"))
            if first.get("token") != self.token:
                return
            for raw in reader:
                if not raw.strip():
                    continue
                req = json.loads(raw)
                self.requests.append(req)
                reply = self.reply(req)
                writer.write((json.dumps({"id": req.get("id"), **reply}) + "\n").encode())
                writer.flush()
                if req.get("type") == "watch":
                    for ev in self.events:
                        writer.write((json.dumps(ev) + "\n").encode())
                    writer.flush()
                    return  # EOF after the events
        except (OSError, ValueError):
            pass
        finally:
            for f in (writer, reader):
                try:
                    f.close()
                except OSError:
                    pass
            conn.close()

    # -- debugging -------------------------------------------------------------------------------------------
    def _paused(self) -> dict | None:
        return self.debug.get("paused") if self.debug and self.debug.get("active") else None

    def _stop(self, step: int, reason: str, **extra) -> dict:
        info = paused_at(step, reason, **extra)
        self.debug = {"active": True, "paused": info, "frontier": step, "exceptions": self.exceptions}
        self.nav = {"active": True, "step": step, "count": 40}
        return {"ok": True, **slice_at(step, stale=self.stale), "paused": info, "locals": [dict(v) for v in LOCALS], "output": dict(self.output)}

    def _start(self, req: dict) -> dict:
        """``debug`` / ``restart``: the first statement when asked or when nothing can break, else the first breakpoint."""
        if not req.get("stopOnEntry") and self.breakpoints:
            bp = self.breakpoints[0]
            return self._stop(3, "breakpoint", line=bp["line"], breakpoint=dict(bp))
        return self._stop(0, "start")

    def _finish(self) -> dict:
        self.debug = {"active": False, "paused": None, "frontier": None}
        return {"ok": True, "finished": {"exitCode": 0, "stepCount": 40, "durationMs": 12.5}}

    @staticmethod
    def _bp(spec: dict) -> dict:
        out = {"file": spec.get("file"), "line": spec.get("line")}
        if spec.get("condition"):
            out["condition"] = spec["condition"]
        if spec.get("file") == "demo.py":  # only the session's file is instrumented in this fake
            out.update(rid=70 + int(spec["line"]), fileId=1, resolvedLine=spec["line"])
        return out

    def reply(self, req: dict) -> dict:
        t = req.get("type")
        if t in self.canned:
            return {"ok": True, **self.canned[t]}
        if t == "state":
            out = {"ok": True, "runId": "r1", "running": False, "finished": True, "stale": self.stale, "nav": dict(self.nav), "displayName": "demo.py", "file": FILE}
            if self.nav["active"]:
                out["location"] = {"file": FILE, "line": 11, "col": 0, "function": "<module>", "fileId": 1}
            if self.debug is not None:
                out["debug"] = dict(self.debug)
            return out
        if t == "debug":
            return self._start(req)
        if t == "restart":
            return self._start(req)
        if t == "stop":
            if not (self.debug and self.debug.get("active")):
                return {"ok": True, "stopped": False, "hint": "no debug run is in flight; `debug --live` starts one"}
            self.debug = None
            return {"ok": True, "stopped": True, "runId": "r-1", "finished": {"exitCode": None, "stepCount": 12, "durationMs": 40}}
        if t in ("continue", "pause"):
            if self._paused() is None and not (self.debug and self.debug.get("active")):
                return {"ok": False, "error": "no debug run in progress", "hint": "`pyokka debug --live` starts one"}
            if t == "pause":
                return self._stop(7, "pause")
            if self.finish_next:
                return self._finish()
            if self.breakpoints:
                bp = self.breakpoints[0]
                return self._stop(12, "breakpoint", line=bp["line"], breakpoint=dict(bp))
            return self._stop(12, "pause")
        if t == "break":
            if req.get("set") is not None:
                self.breakpoints = [self._bp(b) for b in req["set"]]
            for b in req.get("add") or []:
                self.breakpoints.append(self._bp(b))
            for r in req.get("remove") or []:
                self.breakpoints = [b for b in self.breakpoints if not (b["file"] == r.get("file") and b["line"] == r.get("line"))]
            if req.get("exceptions"):
                self.exceptions = req["exceptions"]
            return {"ok": True, "breakpoints": [dict(b) for b in self.breakpoints], "exceptions": self.exceptions}
        if t == "watches":
            for w in req.get("add") or []:
                if w.get("breakWhen"):
                    self.watches.append({"id": "w%d" % (1 + sum(1 for x in self.watches if x.get("breakWhen"))), "exp": w.get("exp"), "breakWhen": w.get("breakWhen")})
                else:  # a displayed watch expression: the panel's id scheme, its value at the current step
                    self.watches.append({"id": "w-fake-%d" % len(self.watches), "exp": w.get("exp"), "kind": "display", "text": "3"})
            for wid in req.get("remove") or []:
                self.watches = [w for w in self.watches if w["id"] != wid]
            return {"ok": True, "watches": [dict(w) for w in self.watches]}
        if t == "locals":
            if self._paused() is None:
                return {"ok": False, "error": "the program is not paused", "hint": "`pyokka debug --live` starts it paused; `break` and `pause` stop it"}
            out = [dict(v) for v in LOCALS]
            if req.get("valueBag"):
                for v in out:
                    v["valueBag"] = {"data": {"id": "v:%s" % v["name"], "type": "any", "value": v["text"]}}
            return {"ok": True, "locals": out}
        if t == "step":
            if self._paused() is not None and req.get("kind") in ("into", "over", "out") and req.get("to") is None:
                if self.finish_next:
                    return self._finish()
                return self._stop(int(self.debug["frontier"]) + 1, "step", kind=req["kind"])
            if req.get("to") is not None:
                if req["to"] > 39:
                    return {"ok": False, "error": "step %d is out of range" % req["to"], "hint": "steps are 0..39"}
                self.nav = {"active": True, "step": req["to"], "count": 40}
            else:
                cur = self.nav["step"] if self.nav["active"] else 0
                self.nav = {"active": True, "step": cur + 1, "count": 40}
            return {"ok": True, **slice_at(self.nav["step"], stale=self.stale)}
        if t == "context":
            paused = self._paused()
            if paused is not None and req.get("line") is None and req.get("step") in (None, self.debug["frontier"]):
                return {"ok": True, **slice_at(self.debug["frontier"], stale=self.stale), "paused": paused, "locals": [dict(v) for v in LOCALS], "output": dict(self.output)}
            step = req.get("step", 5 if req.get("line") is not None else (self.nav["step"] or 0))
            return {"ok": True, **slice_at(step, stale=self.stale)}
        if t == "values":
            if req.get("file") == "nope.py":
                return {"ok": False, "error": "file not part of the run: nope.py", "hint": "files of the run: " + FILE}
            return {"ok": True, "values": [{"line": req["line"], "text": "3", "context": "x", "step": 4, "hit": 1, "runtimeKey": "1"}, {"line": req["line"], "text": "4", "context": "x", "step": 8, "hit": 2, "runtimeKey": "1"}]}
        if t == "var":
            if not req.get("name"):
                return {"ok": False, "error": "var needs name", "hint": "send {name}"}
            return {"ok": True, "name": req["name"], "total": 2, "truncated": False, "recordedLocals": True, "changes": [
                {"step": 14, "file": None, "fileId": 1, "line": 85, "function": "<module>", "scopeId": 0, "name": req["name"], "text": "Rectangle(50, 20)", "source": "locals", "reads": [{"name": "Rectangle", "text": "<class 'Rectangle'>", "step": 3}]},
                {"step": 20, "file": FILE, "fileId": 1, "line": 90, "function": "<module>", "scopeId": 0, "name": req["name"] + ".area()", "text": "1000", "source": "value", "logId": "l-9"},
            ]}
        if t == "why":
            if req.get("step") is None:
                return {"ok": False, "error": "why needs step", "hint": "send {step}"}
            name = req.get("name") or ""
            return {"ok": True, "name": name, "step": req["step"], "depth": req.get("depth", 5), "nodes": 3, "truncated": False, "recordedLocals": True, "root": {
                "name": name, "text": "1000", "source": "value", "logId": "l-9", "step": req["step"], "file": None, "fileId": 1, "line": 90, "function": "<module>", "scopeId": 0, "statement": "area = rect1.area()",
                "reads": [{"name": "rect1", "text": "Rectangle(50, 20)", "source": "locals", "step": 14, "file": FILE, "fileId": 1, "line": 85, "function": "<module>", "scopeId": 0, "statement": "rect1 = Rectangle(50, 20)", "reads": [{"name": "Rectangle"}], "calls": [], "opaque": ["Rectangle(50, 20)"]}],
                "calls": [{"name": "area", "scopeId": 3, "entryStep": 22, "returnStep": 24, "file": None, "fileId": 1, "line": 40, "inputs": [], "result": "1000"}],
                "opaque": []}}
        if t == "eval":
            if "(" in req.get("expression", ""):
                return {"ok": False, "error": "not evaluable: %s" % req["expression"], "hint": "calls and unknown names are refused"}
            return {"ok": True, "text": "True", "valueBag": {"data": {"id": "v:1", "type": "bool", "value": "True"}}}
        if t == "expand":
            return {"ok": True, "node": {"id": req["valueId"], "type": "dict", "value": "{...}", "props": [{"name": "is_awesome", "value": "True"}]}}
        if t in ("watch", "unwatch", "select"):
            return {"ok": True}
        if t == "http":
            return {
                "ok": True, "runId": "r1", "running": False, "count": 2, "truncated": False,
                "totals": {"requests": 2, "bytes": 6812, "ms": 1836, "misses": 1, "missAttempts": 1},
                "finished": {"mode": "replay", "requests": 2, "recorded": 0, "served": 1, "misses": 1, "file": WORKSPACE + "/.pyokka/replay/3f2a9c1e5b7d0246.jsonl", "exists": True, "recordedAt": "2026-09-11T10:12:03Z", "entries": 3},
                "requests": [
                    {"n": 1, "client": "httpx", "method": "POST", "url": "https://api.openai.com/v1/responses", "name": "responses", "status": 200, "reason": "OK", "bytes": 6812, "ms": 2, "recordedMs": 1834, "source": "replayed", "step": 12, "location": {"file": FILE, "line": 16, "col": 0, "fileId": 1}},
                    {"n": 2, "client": "httpx", "method": "GET", "url": "https://api.openai.com/v1/models?api_key", "name": "models", "status": None, "reason": None, "bytes": None, "ms": 1834, "recordedMs": None, "source": "miss", "step": 20, "location": None},
                ],
            }
        return {"ok": False, "error": "unknown request %r" % t, "hint": "type is one of state, step, context"}


@pytest.fixture
def sessions(tmp_path: Path, monkeypatch) -> Path:
    d = tmp_path / "sessions"
    d.mkdir()
    monkeypatch.setenv(SESSIONS_ENV, str(d))
    monkeypatch.chdir(tmp_path)  # never inside a workspace
    return d


@pytest.fixture
def bridge(sessions: Path):
    b = FakeBridge()
    write_descriptor(sessions, "1", b.descriptor())
    try:
        yield b
    finally:
        b.close()


def write_descriptor(sessions: Path, suffix: str, descriptor: dict) -> Path:
    path = sessions / ("%d-%s.json" % (os.getpid(), suffix))
    path.write_text(json.dumps(descriptor), encoding="utf-8")
    return path


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


# -- discovery ---------------------------------------------------------------------------------------------

def test_no_session_says_what_to_do(sessions: Path, capsys):
    code, _ = pyokka("state", "--live")
    err = capsys.readouterr().err
    assert code == 2 and "error: no live session" in err and "pyokka.agentAccess" in err and "saved run" in err
    code, out = pyokka("context", "--live", "--line", "demo.py:11", "--json")
    assert code == 2 and json.loads(out)["error"] == "no live session"


def test_discovery_skips_dead_pids_and_unreadable_files(sessions: Path, bridge: FakeBridge):
    (sessions / "1-dead.json").write_text(json.dumps(bridge.descriptor(pid=DEAD_PID, file="/ws/other/a.py")), encoding="utf-8")
    (sessions / "2-garbage.json").write_text("{not json", encoding="utf-8")
    (sessions / "3-partial.json").write_text(json.dumps({"socket": bridge.socket_path}), encoding="utf-8")
    (sessions / "4-other.sock").write_text("", encoding="utf-8")
    found = list_sessions()
    assert [d["file"] for d in found] == [FILE]
    assert found[0]["descriptor"] == str(sessions / ("%d-1.json" % os.getpid()))
    assert list_sessions("/nonexistent/dir") == []


def test_picking_a_session(sessions: Path, bridge: FakeBridge, tmp_path: Path):
    other = bridge.descriptor(file="/ws/other/tool.py", workspace="/ws/other", started="2026-09-10T11:00:00Z")
    other["descriptor"] = "/x/2.json"
    mine = bridge.descriptor()
    mine["descriptor"] = "/x/1.json"
    both = [other, mine]
    assert pick_session(both, session="demo.py") is mine
    assert pick_session(both, session="tool.py") is other
    assert pick_session(both, session="/x/1.json") is mine
    assert pick_session(both, file_hint="demo.py") is mine
    assert pick_session(both, file_hint="proj/demo.py") is mine
    assert pick_session(both, cwd="/ws/other/sub") is other  # a file of the run that is not the main file falls back to the cwd
    assert pick_session(both, file_hint="helper.py", cwd="/ws/other/sub") is other
    assert pick_session([mine], cwd="/elsewhere") is mine
    with pytest.raises(Exception) as info:
        pick_session(both, cwd="/elsewhere")
    assert "2 live sessions; say which" in str(info.value) and "--session NAME" in info.value.hint and "demo.py (pid" in info.value.hint
    with pytest.raises(Exception) as info:
        pick_session(both, session="nope.py")
    assert "no live session for nope.py" in str(info.value) and "tool.py" in info.value.hint
    twin = dict(mine, descriptor="/x/3.json")
    with pytest.raises(Exception) as info:
        pick_session([mine, twin], session="demo.py")
    assert "2 live sessions match demo.py" in str(info.value) and "/x/3.json" in info.value.hint
    # the command's file picks the session: `--line` of context and values, `--file` of story
    write_descriptor(sessions, "2", bridge.descriptor(file="/ws/other/tool.py", workspace="/ws/other"))
    code, out = pyokka("values", "--live", "--line", "tool.py:3")
    assert code == 0 and out.startswith("2 values on tool.py:3\n")
    code, _ = pyokka("state", "--live")
    assert code == 2
    doc = pyokka_json("state", "--live", "--session", "tool.py")
    assert doc["live"]["descriptor"].endswith("-2.json")
    doc = pyokka_json("state", "--session", "demo.py")  # --session implies --live
    assert doc["live"]["descriptor"].endswith("-1.json")


# -- handshake ---------------------------------------------------------------------------------------------------

def test_token_handshake_and_rejection(sessions: Path, bridge: FakeBridge, capsys):
    doc = pyokka_json("state", "--live")
    assert bridge.tokens == ["t0ken"] and [r["type"] for r in bridge.requests] == ["state"]
    assert doc["runId"] == "r1" and doc["file"] == FILE and doc["nav"] == {"active": False, "step": None, "count": 40}
    assert doc["live"]["pid"] == os.getpid() and doc["live"]["workspace"] == WORKSPACE
    write_descriptor(sessions, "1", bridge.descriptor(token="wrong"))
    code, _ = pyokka("state", "--live")
    err = capsys.readouterr().err
    assert code == 2 and bridge.tokens[-1] == "wrong" and "stopped answering" in err and "bad token" in err


def test_dead_socket(sessions: Path, bridge: FakeBridge, capsys):
    d = bridge.descriptor()
    d["socket"] = os.path.join(bridge.dir, "gone.sock")
    write_descriptor(sessions, "1", d)
    code, _ = pyokka("state", "--live")
    err = capsys.readouterr().err
    assert code == 2 and "cannot connect to the live session demo.py" in err and "pyokka.agentAccess" in err


# -- commands ------------------------------------------------------------------------------------------------------

def test_state_text(sessions: Path, bridge: FakeBridge):
    code, text = pyokka("state", "--live")
    assert code == 0
    assert text == "demo.py: 40 steps, live in VS Code (pid %d)\nTime Machine inactive: `step --live --into` starts it at the first step, `step --live --to N` jumps\n" % os.getpid()
    bridge.nav = {"active": True, "step": 7, "count": 40}
    bridge.stale = True
    code, text = pyokka("state", "--live")
    assert text == "stale: demo.py changed since the run\ndemo.py: 40 steps, live in VS Code (pid %d), stale\nTime Machine at step 7/40  demo.py:11  <module>\n" % os.getpid()


def test_step_moves_and_renders_the_slice(sessions: Path, bridge: FakeBridge):
    doc = pyokka_json("step", "--live", "--into")
    assert bridge.requests[-1] == {"id": 1, "type": "step", "kind": "into"}
    assert doc["step"] == 1 and "from" not in doc and doc["block"]["firstStep"] == 1  # the smallest step among the block's lines (line 9 has 2, the current line 1)
    assert doc["values"][0]["file"] == FILE and doc["values"][0]["text"] == "{'is_awesome': True, 'api_key': 'sk-abcdefghijklmnopqrstuvwxyz'}"  # the fake did not redact; the CLI does on the way out
    doc = pyokka_json("step", "--live", "5", "--over", "--scope")
    assert [(r["type"], r.get("to"), r.get("kind"), r.get("scope")) for r in bridge.requests[-2:]] == [("step", 5, None, None), ("step", None, "over", True)]
    assert doc["from"] == 5 and doc["step"] == 6
    doc = pyokka_json("step", "--live", "--to", "9")
    assert bridge.requests[-1] == {"id": 1, "type": "step", "to": 9} and doc["step"] == 9
    for flag, kind in (("--out", "out"), ("--back", "back"), ("--back-over", "backOver"), ("--back-out", "backOut")):
        pyokka_json("step", "--live", flag)
        assert bridge.requests[-1]["kind"] == kind
    code, text = pyokka("step", "--live", "--into")
    assert code == 0
    lines = text.splitlines()
    # 9 + four kind moves + this one: the fake advances one step per move
    assert lines[0].startswith("step 14/40  demo.py:11  <module>") and lines[1] == "block <module>  demo.py  from step 2"
    assert " 9  pyokka = {'is_awesome': True}   #2" in lines[2] and lines[3].strip() == "…" and lines[4].startswith(">11  print(pyokka)   #14")
    assert "  #14 demo.py:11  {'is_awesome': True, 'api_key': '%s'}" % REDACTED in text and "sk-abc" not in text
    assert "not run: 32" in text and "errors:\n  #39 demo.py:95 ValueError: Kaboom" in text
    assert "moves: into 15 · over 15 · out 39 · back 13 · back-over 13 · back-out —" in text


def test_step_errors_carry_the_bridge_hint(sessions: Path, bridge: FakeBridge, capsys):
    code, _ = pyokka("step", "--live", "--to", "400")
    err = capsys.readouterr().err
    assert code == 2 and "error: step 400 is out of range\nsteps are 0..39\n" == err
    code, _ = pyokka("step", "--live", "run.json", "--into")
    err = capsys.readouterr().err
    assert code == 2 and "--live reads the open VS Code session, not run.json" in err


def test_an_older_extension_is_named_not_its_unknown_request(sessions: Path, bridge: FakeBridge, capsys):
    """An extension older than the CLI answers `unknown request "recording"` (origin --live asks for the run)."""
    want = "the VS Code extension is older than this CLI (no recording request): install the vsix built from this checkout and run Developer: Reload Window"
    code, out = pyokka("origin", "--live", "3", "--json")
    assert code == 2 and json.loads(out)["error"] == want, out
    code, _ = pyokka("origin", "--live", "3")
    err = capsys.readouterr().err
    assert code == 2 and err.startswith("error: " + want + "\n") and "type is one of" not in err
    # the host's own spelling quotes the type with double quotes
    from pyokka_runtime.agent.live import OLD_EXTENSION
    assert OLD_EXTENSION.match('unknown request "recording"').group(1) == "recording"
    assert OLD_EXTENSION.match("step 400 is out of range") is None


def test_context_values_eval_expand(sessions: Path, bridge: FakeBridge, capsys):
    doc = pyokka_json("context", "--live", "--line", "demo.py:11")
    assert bridge.requests[-1] == {"id": 1, "type": "context", "file": "demo.py", "line": 11} and doc["step"] == 5
    pyokka_json("context", "--live", "12", "--scope")
    assert bridge.requests[-1] == {"id": 1, "type": "context", "step": 12, "scope": True}
    pyokka_json("context", "--live")  # the current step
    assert bridge.requests[-1] == {"id": 1, "type": "context"}
    code, text = pyokka("context", "--live", "--line", "demo.py:11")
    assert code == 0 and text.startswith("step 5/40  demo.py:11  <module>\nblock <module>  demo.py  from step 2\n") and "'is_awesome': True" in text

    code, text = pyokka("values", "--live", "--line", "demo.py:7")
    assert bridge.requests[-1] == {"id": 1, "type": "values", "file": "demo.py", "line": 7}
    assert (code, text) == (0, "2 values on demo.py:7\n  #4 hit 1  x = 3\n  #8 hit 2  x = 4\n")
    code, _ = pyokka("values", "--live", "--line", "nope.py:1")
    assert code == 2 and "not part of the run" in capsys.readouterr().err

    code, text = pyokka("eval", "--live", "pyokka['is_awesome']")
    assert bridge.requests[-1] == {"id": 1, "type": "eval", "expression": "pyokka['is_awesome']"}
    assert (code, text) == (0, "pyokka['is_awesome'] = True\n")
    doc = pyokka_json("eval", "--live", "pyokka")
    assert doc["valueBag"]["data"]["id"] == "v:1"
    code, _ = pyokka("eval", "--live", "rect1.area()")
    assert code == 2 and "not evaluable" in capsys.readouterr().err

    code, text = pyokka("expand", "--live", "v:1", "--path", "is_awesome")
    assert bridge.requests[-1] == {"id": 1, "type": "expand", "valueId": "v:1", "queryPath": ["is_awesome"]}
    assert (code, text) == (0, "dict {...}\n  is_awesome: True\n")


def test_var_asks_the_bridge_and_renders_like_a_saved_run(sessions: Path, bridge: FakeBridge, capsys):
    doc = pyokka_json("var", "--live", "rect1", "--file", "demo.py", "--scope", "<module>", "--limit", "5")
    assert bridge.requests[-1] == {"id": 1, "type": "var", "name": "rect1", "limit": 5, "file": "demo.py", "scope": "<module>"}
    assert doc["total"] == 2 and doc["changes"][0]["file"] == FILE  # the session's file fills in where the bridge sent none
    code, text = pyokka("var", "--live", "rect1")
    assert bridge.requests[-1] == {"id": 1, "type": "var", "name": "rect1", "limit": 200}
    assert (code, text) == (0, "2 changes of rect1\n  #14 demo.py:85  <module>  rect1 = Rectangle(50, 20)   ← Rectangle = <class 'Rectangle'>\n  #20 demo.py:90  <module>  rect1.area() = 1000\n")
    code, _ = pyokka("var", "--live", "")
    assert code == 2 and "var needs name" in capsys.readouterr().err


def test_why_asks_the_bridge_and_renders_like_a_saved_run(sessions: Path, bridge: FakeBridge, capsys):
    doc = pyokka_json("why", "--live", "21", "total", "--depth", "3")
    assert bridge.requests[-1] == {"id": 1, "type": "why", "step": 21, "name": "total", "depth": 3}
    # the session's file fills in where the bridge sent none: nodes with a step and calls, never a leaf
    assert doc["root"]["file"] == FILE and doc["root"]["calls"][0]["file"] == FILE and doc["root"]["reads"][0]["reads"][0] == {"name": "Rectangle"}
    pyokka_json("why", "--live", "21")
    assert bridge.requests[-1] == {"id": 1, "type": "why", "step": 21, "name": "", "depth": 5}
    # no step: the Time Machine's
    bridge.nav = {"active": True, "step": 7, "count": 40}
    code, text = pyokka("why", "--live", "total")
    assert [(r["type"], r.get("step"), r.get("name")) for r in bridge.requests[-2:]] == [("state", None, None), ("why", 7, "total")]
    assert code == 0 and text.splitlines() == [
        "why total at #7",
        "total = 1000   #7 demo.py:90 <module>   area = rect1.area()",
        "  ← rect1 = Rectangle(50, 20)   #14 demo.py:85 <module>   rect1 = Rectangle(50, 20)",
        "    ← Rectangle = ?",
        "    · Rectangle(50, 20)   not stepped",
        "  ↳ area #22–#24 demo.py:40   out 1000",
    ]
    bridge.nav = {"active": False, "step": None, "count": 40}
    code, _ = pyokka("why", "--live")
    err = capsys.readouterr().err
    assert code == 2 and "the Time Machine is not active" in err and "why --live 21 total" in err
    code, _ = pyokka("why", "--live", "run.json", "21", "total")
    assert code == 2 and "--live reads the open VS Code session, not run.json" in capsys.readouterr().err


def test_steps_are_built_from_context_requests(sessions: Path, bridge: FakeBridge, capsys):
    code, text = pyokka("steps", "--live", "--from", "38", "--count", "5")
    assert code == 0
    assert [(r["type"], r.get("step")) for r in bridge.requests] == [("state", None), ("context", 38), ("context", 39)]
    assert text == "steps 38.. of 40\n#38     demo.py:11  <module>  depth 0\n#39     demo.py:11  <module>  depth 0\n"
    code, _ = pyokka("steps", "--live", "--line", "demo.py:11")
    err = capsys.readouterr().err
    assert code == 2 and "steps --line needs the trace" in err and "context --live --line demo.py:11" in err


def test_http_asks_the_bridge_and_renders_the_table(sessions: Path, bridge: FakeBridge):
    doc = pyokka_json("http", "--live")
    assert bridge.requests[-1] == {"id": 1, "type": "http"}
    assert doc["count"] == 2 and doc["requests"][1]["source"] == "miss" and doc["finished"]["mode"] == "replay"
    code, text = pyokka("http", "--live")
    assert code == 0
    assert text.splitlines() == [
        "2 requests · 6.8 kB · 1.8 s · replayed from 3f2a….jsonl (2026-09-11 10:12Z), 1 missing (1 attempt)",
        "#1  POST  200  responses  demo.py:16  6.8 kB  2 ms  replayed  https://api.openai.com/v1/responses",
        "#2  GET  MISS  models  —  —  1.8 s  miss  https://api.openai.com/v1/models?api_key",
    ]


def test_story_find_release_are_refused_with_the_saved_run_command(sessions: Path, bridge: FakeBridge, capsys):
    code, _ = pyokka("story", "--live", "--file", "demo.py")
    err = capsys.readouterr().err
    assert code == 2 and "story needs the whole trace" in err and "`pyokka run demo.py --save run.json`" in err and "story run.json --file demo.py" in err
    code, _ = pyokka("find", "--live", "Kaboom")
    err = capsys.readouterr().err
    assert code == 2 and "find needs the whole trace" in err and "find run.json 'Kaboom'" in err
    code, _ = pyokka("release", "--live")
    assert code == 2 and "kept runner" in capsys.readouterr().err
    assert bridge.requests == []  # refused before any request


def test_stale_reply_is_reported_first(sessions: Path, bridge: FakeBridge):
    bridge.stale = True
    code, text = pyokka("context", "--live", "--line", "demo.py:11")
    assert code == 0 and text.startswith("stale: demo.py changed since the run\nstep 5/40")
    assert pyokka_json("context", "--live", "3")["stale"] is True


# -- watch ---------------------------------------------------------------------------------------------------------

def test_watch_prints_one_line_per_event_until_eof(sessions: Path):
    events = [
        {"event": "step", "step": 12, "location": {"file": FILE, "line": 85, "col": 0, "function": "<module>", "fileId": 1}, "values": [{"line": 85, "context": "rect1", "text": "<Rectangle 50x20>", "step": 12, "hit": 1, "runtimeKey": "3"}, {"line": 85, "context": "token", "text": "sk-abcdefghijklmnopqrstuvwxyz", "step": 12, "hit": 1, "runtimeKey": "4"}]},
        {"event": "rerun", "runId": "r2"},
        {"event": "stopped"},
    ]
    b = FakeBridge(events=events)
    write_descriptor(sessions, "1", b.descriptor())
    try:
        code, text = pyokka("watch", "--live")
        assert code == 0
        assert text == "step 12  demo.py:85  <module>   values: rect1 = <Rectangle 50x20>, token = %s\nrerun\nstopped\n" % REDACTED
        assert [r["type"] for r in b.requests] == ["watch"]
        code, text = pyokka("watch", "--live", "--json")
        assert code == 0 and [json.loads(l)["event"] for l in text.splitlines()] == ["step", "rerun", "stopped"]
    finally:
        b.close()


def test_watch_needs_live(tmp_path: Path, capsys):
    (tmp_path / "run.json").write_text('{"meta": {"file": "x.py"}, "events": []}', encoding="utf-8")
    code, _ = pyokka("watch", str(tmp_path / "run.json"))
    assert code == 2 and "needs --live" in capsys.readouterr().err


# -- debugging -----------------------------------------------------------------------------------------------------

def test_debug_starts_paused_and_prints_the_stop(sessions: Path, bridge: FakeBridge):
    code, text = pyokka("debug", "--live")
    assert bridge.requests[-1] == {"id": 1, "type": "debug"}
    assert code == 0 and text.startswith("paused at demo.py:11 (start)\nstep 0/40  demo.py:11  <module>\nblock <module>  demo.py  from step 0\n")
    assert "moves: into 1" in text
    doc = pyokka_json("debug", "--live")
    assert doc["paused"]["reason"] == "start" and doc["paused"]["step"] == 0 and doc["block"]["firstStep"] == 0 and doc["stack"]


def test_stop_ends_the_debug_run_and_says_when_there_is_nothing_to_stop(sessions: Path, bridge: FakeBridge):
    code, text = pyokka("stop", "--live")
    assert bridge.requests[-1] == {"id": 1, "type": "stop"}
    assert (code, text) == (0, "nothing to stop: no debug run is in flight; `debug --live` starts one\n")
    pyokka_json("debug", "--live")
    code, text = pyokka("stop", "--live")
    assert (code, text) == (0, "stopped: exit None, 12 steps\n")
    pyokka_json("debug", "--live")
    doc = pyokka_json("stop", "--live")
    assert doc == {"stopped": True, "runId": "r-1", "finished": {"exitCode": None, "stepCount": 12, "durationMs": 40}}
    assert pyokka_json("state", "--live").get("debug") is None, "the fake drops the debug state with the run"


def test_restart_prints_the_first_stop_of_the_new_run(sessions: Path, bridge: FakeBridge):
    pyokka_json("debug", "--live")
    pyokka_json("break", "--live", "demo.py:11")
    code, text = pyokka("restart", "--live")
    assert bridge.requests[-1] == {"id": 1, "type": "restart"}
    assert code == 0 and text.startswith("paused at demo.py:11 (breakpoint)\nstep 3/40  demo.py:11  <module>\n")
    doc = pyokka_json("restart", "--live")
    assert doc["paused"]["reason"] == "breakpoint" and doc["step"] == 3


def test_stop_on_entry_is_sent_only_when_asked(sessions: Path, bridge: FakeBridge):
    pyokka_json("debug", "--live")
    assert bridge.requests[-1] == {"id": 1, "type": "debug"}, "no --stop-on-entry: no stopOnEntry key"
    pyokka_json("break", "--live", "demo.py:11")
    doc = pyokka_json("debug", "--live", "--stop-on-entry")
    assert bridge.requests[-1] == {"id": 1, "type": "debug", "stopOnEntry": True}
    assert doc["paused"]["reason"] == "start" and doc["paused"]["step"] == 0, "the breakpoint is set, but the run still pauses before the first statement"
    doc = pyokka_json("restart", "--live", "--stop-on-entry")
    assert bridge.requests[-1] == {"id": 1, "type": "restart", "stopOnEntry": True}
    assert doc["paused"]["reason"] == "start"


def test_break_adds_lists_and_removes(sessions: Path, bridge: FakeBridge, capsys):
    code, text = pyokka("break", "--live", "demo.py:11", "helper.py:3", "--when", "x > 1")
    assert bridge.requests[-1] == {"id": 1, "type": "break", "add": [{"file": "demo.py", "line": 11, "condition": "x > 1"}, {"file": "helper.py", "line": 3, "condition": "x > 1"}]}
    assert (code, text) == (0, "2 breakpoints\n  demo.py:11  if x > 1  -> resolved line 11\n  helper.py:3  if x > 1  (not resolved yet)\nexceptions: uncaught\n")
    code, text = pyokka("break", "--live")
    assert bridge.requests[-1] == {"id": 1, "type": "break", "list": True} and code == 0 and text.startswith("2 breakpoints\n")
    code, text = pyokka("break", "--live", "--remove", "helper.py:3")
    assert bridge.requests[-1] == {"id": 1, "type": "break", "remove": [{"file": "helper.py", "line": 3}]}
    assert (code, text) == (0, "1 breakpoint\n  demo.py:11  if x > 1  -> resolved line 11\nexceptions: uncaught\n")
    doc = pyokka_json("break", "--live", "--remove", "demo.py:11", "--json")
    assert doc["breakpoints"] == []
    code, text = pyokka("break", "--live", "--list")
    assert code == 0 and text.startswith("no breakpoints;")
    code, _ = pyokka("break", "--live", "--when", "x > 1")
    assert code == 2 and "--when needs a FILE:LINE" in capsys.readouterr().err
    code, _ = pyokka("break", "--live", "demo.py")
    err = capsys.readouterr().err
    assert code == 2 and "break wants FILE:LINE" in err and "`break --live agent.py:16`" in err


def test_break_sets_where_an_exception_pauses_and_a_stop_names_it(sessions: Path, bridge: FakeBridge):
    code, text = pyokka("break", "--live", "--on-exception", "raised")
    assert bridge.requests[-1] == {"id": 1, "type": "break", "exceptions": "raised"}
    assert (code, text) == (0, "no breakpoints; `break --live FILE:LINE [--when EXPR]` adds one\nexceptions: raised\n")
    doc = pyokka_json("break", "--live")
    assert bridge.requests[-1] == {"id": 1, "type": "break", "list": True} and doc["exceptions"] == "raised"
    # the stop names what was raised instead of the bare reason
    raised = {"type": "ValueError", "message": "too big: 3", "uncaught": True}
    bridge.debug = {"active": True, "paused": paused_at(6, "exception", line=6, exception=raised), "frontier": 6, "exceptions": "raised"}
    code, text = pyokka("state", "--live")
    assert code == 0 and text.splitlines()[-1] == "debug: paused at demo.py:6 (uncaught ValueError: too big: 3)"
    bridge.debug["paused"] = paused_at(6, "exception", line=6, exception={**raised, "uncaught": False})
    _, text = pyokka("state", "--live")
    assert text.splitlines()[-1] == "debug: paused at demo.py:6 (raised ValueError: too big: 3)"


def test_continue_prints_the_next_stop_then_finished(sessions: Path, bridge: FakeBridge, capsys):
    code, _ = pyokka("continue", "--live")
    assert code == 2 and "no debug run in progress" in capsys.readouterr().err
    pyokka_json("debug", "--live")
    pyokka_json("break", "--live", "demo.py:11")
    code, text = pyokka("continue", "--live")
    assert bridge.requests[-1] == {"id": 1, "type": "continue"}
    assert code == 0 and text.startswith("paused at demo.py:11 (breakpoint)\nstep 12/40  demo.py:11  <module>\n")
    doc = pyokka_json("continue", "--live")
    assert doc["paused"]["breakpoint"]["resolvedLine"] == 11 and doc["step"] == 12
    bridge.finish_next = True
    code, text = pyokka("continue", "--live")
    assert (code, text) == (0, "finished: exit 0, 40 steps\n")
    code, _ = pyokka("continue", "--live")  # the run is over: nothing to resume
    assert code == 2 and "no debug run in progress" in capsys.readouterr().err


def test_a_debug_verb_answered_by_the_recording_session_names_the_session_it_reached(sessions: Path, bridge: FakeBridge, capsys):
    """Only a run session is open, so a debug verb is served by the other product.

    The host answers about the session that took the request and cannot know a different kind was
    wanted, so the reply alone reads as "the debugger is broken" rather than "you are talking to
    the wrong session". Reading `~/.pyokka/sessions` by hand was the only way to tell.
    """
    code, _ = pyokka("continue", "--live")
    err = capsys.readouterr().err
    assert code == 2
    assert "no debug run in progress" in err  # the host's own message, unchanged
    assert "no debug session here: this is the run session on demo.py" in err
    assert "`pyokka debug FILE` starts one" in err


def test_a_command_that_succeeds_on_a_substituted_session_says_nothing(sessions: Path, bridge: FakeBridge, capsys):
    # serving a debug verb from a recording session is usually right, so the note is for failures only
    pyokka_json("debug", "--live")
    code, text = pyokka("locals", "--live")
    assert code == 0
    assert "no debug session here" not in text + capsys.readouterr().err


def test_pause_and_locals(sessions: Path, bridge: FakeBridge, capsys):
    code, _ = pyokka("locals", "--live")
    assert code == 2 and "not paused" in capsys.readouterr().err
    pyokka_json("debug", "--live")
    code, text = pyokka("pause", "--live")
    assert bridge.requests[-1] == {"id": 1, "type": "pause"} and code == 0 and text.startswith("paused at demo.py:11 (pause)\nstep 7/40")
    code, text = pyokka("locals", "--live")
    assert bridge.requests[-1] == {"id": 1, "type": "locals"} and (code, text) == (0, "total = 3\npayload = None\n")
    doc = pyokka_json("locals", "--live")
    assert bridge.requests[-1] == {"id": 1, "type": "locals", "valueBag": True} and doc["locals"][0]["valueBag"]["data"]["id"] == "v:total"


def test_watches_add_list_and_remove(sessions: Path, bridge: FakeBridge):
    code, text = pyokka("watches", "--live", "--add", "payload is None", "--break-when", "true")
    assert bridge.requests[-1] == {"id": 1, "type": "watches", "add": [{"exp": "payload is None", "breakWhen": "true"}]}
    assert (code, text) == (0, "1 watch\n  w1  payload is None  break when true\n")
    code, text = pyokka("watches", "--live", "--add", "total")
    assert bridge.requests[-1]["add"] == [{"exp": "total"}], "no --break-when: a displayed watch expression"
    assert text == "2 watches\n  w1  payload is None  break when true\n  w-fake-1  total  = 3\n"
    code, text = pyokka("watches", "--live")
    assert bridge.requests[-1] == {"id": 1, "type": "watches", "list": True} and code == 0
    doc = pyokka_json("watches", "--live", "--remove", "w1", "--remove", "w-fake-1")
    assert bridge.requests[-1] == {"id": 1, "type": "watches", "remove": ["w1", "w-fake-1"]} and doc["watches"] == []
    code, text = pyokka("watches", "--live", "--list")
    assert text.startswith("no watches;")


def test_step_and_context_at_the_frontier(sessions: Path, bridge: FakeBridge):
    pyokka_json("debug", "--live")
    code, text = pyokka("step", "--live", "--over")
    assert bridge.requests[-1] == {"id": 1, "type": "step", "kind": "over"}
    assert code == 0 and text.startswith("paused at demo.py:11 (step over)\nstep 1/40")
    code, text = pyokka("context", "--live")
    assert bridge.requests[-1] == {"id": 1, "type": "context"}
    assert code == 0 and text.startswith("paused at demo.py:11 (step over)\nstep 1/40")
    assert "\nlocals:\n  total = 3\n  payload = None\noutput (last 3 lines):\n  start\n  loading 1\n  loading 2\nnot run: 32\n" in text
    doc = pyokka_json("context", "--live", "1")
    assert doc["paused"]["kind"] == "over" and [v["name"] for v in doc["locals"]] == ["total", "payload"]
    assert doc["output"] == OUTPUT
    doc = pyokka_json("context", "--live", "0")  # behind the frontier: a plain slice
    assert "paused" not in doc and "locals" not in doc and "output" not in doc
    bridge.finish_next = True
    code, text = pyokka("step", "--live", "--into")
    assert (code, text) == (0, "finished: exit 0, 40 steps\n")


def test_a_stop_carries_the_frame_and_the_output_so_far(sessions: Path, bridge: FakeBridge):
    bridge.output = {"text": "".join("line %d\n" % n for n in range(1, 31)), "truncated": True}
    doc = pyokka_json("debug", "--live")
    assert [v["name"] for v in doc["locals"]] == ["total", "payload"], "the frame comes with the stop"
    assert doc["output"]["truncated"] is True
    _, text = pyokka("continue", "--live")
    body = text.split("locals:\n", 1)[1]
    assert body.startswith("  total = 3\n  payload = None\noutput (last 20 lines):\n  line 11\n")
    assert "\n  line 30\n" in body and "line 10" not in body, "the last 20 lines, in order"
    _, wide = pyokka("context", "--live", "--scope")
    assert "output (last 30 lines):\n  line 1\n" in wide, "--scope lifts the cap to 200"
    bridge.output = {"text": "", "truncated": False}
    _, quiet = pyokka("continue", "--live")
    assert "output" not in quiet, "nothing printed, nothing to print"


def test_state_shows_the_debug_line(sessions: Path, bridge: FakeBridge):
    pyokka_json("debug", "--live")
    code, text = pyokka("state", "--live")
    assert code == 0 and text.splitlines()[-1] == "debug: paused at demo.py:11 (start)"
    bridge.debug = {"active": True, "paused": None, "frontier": None}
    code, text = pyokka("state", "--live")
    assert text.splitlines()[-1].startswith("debug: running")
    bridge.debug = {"active": False, "paused": None, "frontier": None}
    code, text = pyokka("state", "--live")
    assert len(text.splitlines()) == 2
    assert pyokka_json("state", "--live")["debug"]["active"] is False


def test_watch_prints_pauses_and_the_end(sessions: Path):
    where = lambda line: {"file": FILE, "line": line, "col": 0, "function": "<module>", "fileId": 1}  # noqa: E731
    events = [
        {"event": "paused", "step": 12, "location": where(12), "reason": "breakpoint", "breakpoint": {"file": "demo.py", "line": 12, "condition": "x > 1"}, "values": [{"line": 12, "context": "x", "text": "2", "step": 12, "hit": 1, "runtimeKey": "3"}]},
        {"event": "resumed"},
        {"event": "paused", "step": 20, "location": where(20), "reason": "step", "kind": "over", "values": []},
        {"event": "paused", "step": 30, "location": where(30), "reason": "watch", "watch": {"id": "w1", "exp": "payload is None", "text": "True"}},
        {"event": "paused", "step": 31, "location": where(31), "reason": "breakpoint", "breakpoint": {"file": "demo.py", "line": 31, "condition": "nope > 1"}, "conditionError": "NameError: name 'nope' is not defined"},
        {"event": "paused", "step": 32, "location": where(6), "reason": "exception", "exception": {"type": "ValueError", "message": "too big: 3", "uncaught": True}},
        {"event": "finished", "exitCode": 0},
    ]
    b = FakeBridge(events=events)
    write_descriptor(sessions, "1", b.descriptor())
    try:
        code, text = pyokka("watch", "--live")
        assert code == 0 and text.splitlines() == [
            "paused at demo.py:12 (breakpoint if x > 1)   values: x = 2",
            "resumed",
            "paused at demo.py:20 (step over)",
            "paused at demo.py:30 (watch payload is None: True)",
            "paused at demo.py:31 (breakpoint if nope > 1, condition failed: NameError: name 'nope' is not defined)",
            "paused at demo.py:6 (uncaught ValueError: too big: 3)",
            "finished: exit 0",
        ]
    finally:
        b.close()


# -- shell: one process, one connection, many commands ---------------------------------------------------------------

def shell(monkeypatch, lines: str, *args: str) -> int:
    """`pyokka shell` over a stdin of `lines`; stdout and stderr stay with capsys."""
    monkeypatch.setattr(sys, "stdin", io.StringIO(lines))
    return main(["shell", *args])


def test_shell_answers_line_by_line_over_one_connection(sessions: Path, bridge: FakeBridge, monkeypatch, capsys):
    code = shell(monkeypatch, "state\n\n# the comment and the blank line above are skipped\ndebug --stop-on-entry\nlocals\nbogus --x\nwatch\nstop\nexit\nstate\n", "--live", "--session", "demo.py")
    cap = capsys.readouterr()
    assert code == 0
    assert bridge.tokens == ["t0ken"], "one token handshake for the whole shell"
    assert [r["type"] for r in bridge.requests] == ["state", "debug", "locals", "stop"], "`exit` stopped the shell before the last line"
    assert bridge.requests[1] == {"id": 2, "type": "debug", "stopOnEntry": True}, "one connection, so the request ids count up"
    results = cap.out.split("\n\n")
    assert results[-1] == "" and len(results) == 5, "four results, a blank line after each"
    assert results[0] == "demo.py: 40 steps, live in VS Code (pid %d)\nTime Machine inactive: `step --live --into` starts it at the first step, `step --live --to N` jumps" % os.getpid()
    assert results[1].startswith("paused at demo.py:11 (start)\nstep 0/40  demo.py:11  <module>\n")
    assert results[2] == "total = 3\npayload = None"
    assert results[3] == "stopped: exit None, 12 steps"
    errors = cap.err.splitlines()
    assert "error: argument command: invalid choice: 'bogus'" in errors[0] and errors[1].startswith("one command per line")
    assert errors[2] == "error: watch streams every stop until Ctrl-C, so it would block the shell"
    assert errors[3] == "run `pyokka watch --live` in another terminal"
    assert len(errors) == 4, "the two bad lines wrote to stderr and the shell went on"


def test_shell_json_prints_one_line_per_result(sessions: Path, bridge: FakeBridge, monkeypatch, capsys):
    code = shell(monkeypatch, "state\ndebug --stop-on-entry\nlocals\ncontext run.json\nexit\n", "--live", "--session", "demo.py", "--json")
    cap = capsys.readouterr()
    assert (code, cap.err) == (0, "")
    docs = [json.loads(l) for l in cap.out.splitlines() if l.strip()]
    assert len(docs) == 4, "one JSON line per result, errors included"
    assert docs[0]["file"] == FILE and docs[0]["nav"] == {"active": False, "step": None, "count": 40}
    assert bridge.requests[1] == {"id": 2, "type": "debug", "stopOnEntry": True}
    assert docs[1]["step"] == 0 and docs[1]["paused"]["reason"] == "start" and docs[1]["paused"]["step"] == 0
    assert bridge.requests[2] == {"id": 3, "type": "locals", "valueBag": True}, "--json on the shell asks for the value bags, as the one-shot does"
    assert [v["name"] for v in docs[2]["locals"]] == ["total", "payload"]
    assert docs[3]["ok"] is False and docs[3]["error"] == "the shell reads the live session, not run.json"
    assert "reads the saved run in its own process" in docs[3]["hint"]


def test_shell_implies_live(sessions: Path, bridge: FakeBridge, monkeypatch, capsys):
    code = shell(monkeypatch, "state\n", "--session", "demo.py")  # no --live, and EOF instead of `exit`
    cap = capsys.readouterr()
    assert (code, cap.err) == (0, "")
    assert cap.out.startswith("demo.py: 40 steps, live in VS Code") and cap.out.endswith("\n\n")
    assert [r["type"] for r in bridge.requests] == ["state"]


# -- history: a live pause as a checkpoint -------------------------------------------------------------------

def history_live(tmp_path: Path, *args: str) -> dict:
    out = tmp_path / "history.json"
    code, text = pyokka("history", "--live", *args, "--out", str(out))
    assert code == 0, text
    return json.loads(out.read_text(encoding="utf-8"))


def test_history_turns_a_live_pause_into_a_checkpoint(sessions: Path, bridge: FakeBridge, tmp_path: Path):
    pyokka_json("debug", "--live")
    data = history_live(tmp_path, "--pause")
    card = data["steps"][0]
    assert card["kind"] == "live pause" and card["tag"] == "LIVE PAUSE" and card["id"] == "pause-1"
    assert card["values"] == "total = 3\npayload = None", "the frame, not a recorded step's values"
    assert card["reason"] == "start" and card["output"].endswith("loading 2")
    assert card["chain"] == [], "a record:false session recorded nothing behind the pause"
    assert card["verify"] == "pyokka context --live --json"
    assert data["meta"]["mode"] == "live session" and data["meta"]["run"] == "--live"
    assert data["meta"]["paused"] == "demo.py:11"


def test_history_reads_a_pause_without_moving_it(sessions: Path, bridge: FakeBridge, tmp_path: Path):
    pyokka_json("debug", "--live")
    seen_before = len(bridge.requests)
    history_live(tmp_path, "--pause")
    asked = {r["type"] for r in bridge.requests[seen_before:]}
    assert asked <= {"state", "context", "walkthrough", "graph", "exceptions", "http", "var", "why"}
    assert not asked & {"step", "continue", "pause", "debug", "restart", "stop", "exec", "break", "watches"}


def test_history_falls_back_to_the_block_the_bridge_sent(sessions: Path, bridge: FakeBridge, tmp_path: Path):
    """The session's file is in the window's workspace, not on this filesystem: use what arrived."""
    pyokka_json("debug", "--live")
    data = history_live(tmp_path, "--pause")
    rows = data["files"]["demo.py"]
    assert rows[10] == "print(pyokka)" and rows[8] == "pyokka = {'is_awesome': True}"
    card = data["steps"][0]
    assert card["start"] <= card["focus"] <= card["end"] and 11 in card["bright"]


def test_history_refuses_when_nothing_is_paused(sessions: Path, bridge: FakeBridge, tmp_path: Path):
    code, out = pyokka("history", "--live", "--pause", "--out", str(tmp_path / "h.json"), "--json")
    doc = json.loads(out)
    assert code == 2 and doc["error"] == "no debug pause to capture"
    assert "pyokka break --live FILE:LINE" in doc["hint"]


def test_history_needs_a_checkpoint_to_build(sessions: Path, bridge: FakeBridge, tmp_path: Path):
    code, out = pyokka("history", "--live", "--out", str(tmp_path / "h.json"), "--json")
    assert code == 2 and "no checkpoints" in json.loads(out)["error"]
