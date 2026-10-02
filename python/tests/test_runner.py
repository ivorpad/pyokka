"""Runner protocol round trip through a real subprocess."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from pyokka_runtime.protocol import decode_steps

PY_DIR = Path(__file__).resolve().parents[1]


class Client:
    def __init__(self, env=None, drop=(), executable=None):
        """``executable`` runs the runner under another interpreter, for the per-version cases."""
        base = {k: v for k, v in os.environ.items() if k not in drop}
        self.p = subprocess.Popen([executable or sys.executable, "-m", "pyokka_runtime", "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=PY_DIR, env={**base, **(env or {})})
        self.n = 0

    def send(self, **msg):
        self.n += 1
        msg.setdefault("id", self.n)
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()
        return msg["id"]

    def recv(self, timeout=20.0):
        line = self.p.stdout.readline()
        assert line, "runner closed stdout: %s" % self.p.stderr.read()
        return json.loads(line)

    def run(self, path: Path, **overrides):
        req = {
            "type": "run",
            "runId": overrides.pop("runId", "r-%d" % self.n),
            "file": {"path": str(path), "displayName": path.name},
            "workspaceRoot": str(path.parent),
            "cwd": str(path.parent),
            "argv": [],
            "env": {},
            "projectFiles": [],
            "config": {"timeoutMs": 20000},
            "markers": [],
            "expressionsToEvaluate": {},
            "watch": [],
            "mode": "normal",
        }
        req.update(overrides)
        self.send(**req)
        events = []
        while True:
            m = self.recv()
            events.append(m)
            if m.get("type") == "run.finished":
                return events

    def close(self):
        try:
            self.send(type="shutdown")
            self.p.wait(timeout=10)
        finally:
            if self.p.poll() is None:
                self.p.kill()


@pytest.fixture(params=["fork", "spawn"] if hasattr(os, "fork") else ["spawn"])
def client(request):
    # macOS spawns by default; PYOKKA_FORK=1 keeps the fork path under test there too
    c = Client(env={"PYOKKA_SPAWN": "1"} if request.param == "spawn" else {"PYOKKA_SPAWN": "0", "PYOKKA_FORK": "1"}, drop=("PYOKKA_FORK",))
    yield c
    c.close()


def test_hello_run_expand_stop_shutdown(client, tmp_path):
    client.send(type="hello", version="test")
    ready = client.recv()
    assert ready["type"] == "ready" and ready["pythonVersion"].startswith("3.") and "expand" in ready["capabilities"]
    scratch = tmp_path / "s.py"
    scratch.write_text("import sys\ndata = {'k': [1, 2, {'deep': 'x' * 10}]}\ndata\nprint('out')\nsys.stdout.write('raw\\n')\nsys.stderr.write('err\\n')\n", encoding="utf-8")
    events = client.run(scratch, runId="r1")
    kinds = [e["type"] for e in events]
    assert kinds[0] == "ok" and kinds[1] == "run.started" and kinds[-1] == "run.finished"
    assert kinds.index("file.instrumented") < kinds.index("log")
    seqs = [e["seq"] for e in events if "seq" in e]
    assert seqs == list(range(1, len(seqs) + 1))
    assert all(e.get("runId") == "r1" for e in events if "seq" in e)
    logs = [e for e in events if e["type"] == "log"]
    assert [l["text"] for l in logs] == ["{'k': [1, 2, {'deep': 'xxxxxxxxxx'}]}", "out"]
    outputs = {(e["stream"], e["text"]) for e in events if e["type"] == "output"}
    assert ("stdout", "raw\n") in outputs and ("stderr", "err\n") in outputs
    trace = [e for e in events if e["type"] == "trace" and not e.get("partial")][0]
    assert len(decode_steps(trace["steps"])) // 4 == 6
    finished = events[-1]
    assert finished["exitCode"] == 0 and finished["stepCount"] == 6 and finished["timedOut"] is False
    # expand from the still-alive child
    node = logs[0]["valueBag"]["data"]
    deep = node["props"][0]["props"][2]
    client.send(type="expand", runId="r1", valueId=deep["id"], queryPath=deep["queryPath"])
    reply = client.recv()
    assert reply["type"] == "value" and reply["node"]["props"][0]["name"] == "deep"
    client.send(type="expand", runId="r1", valueId="nope", queryPath=["999"])
    assert client.recv()["type"] == "error"
    # evaluate a pure expression against the finished module, no re-run
    client.send(type="evaluate", runId="r1", expression="data['k'][2]['deep'][:3]")
    reply = client.recv()
    assert reply["type"] == "evaluated" and reply["text"] == "'xxx'" and reply["valueBag"]["data"]["value"] == "xxx"
    client.send(type="evaluate", runId="r1", expression="len(data['k'])")
    assert client.recv()["text"] == "3", "a pure call answers"
    client.send(type="evaluate", runId="r1", expression="data['k'].append(1)")
    err = client.recv()
    assert err["type"] == "error" and "cannot call `data['k'].append`" in err["message"]
    client.send(type="evaluate", runId="r1", expression="missing_name")
    assert client.recv()["type"] == "error"
    # shadow: what an edited statement would show, without a run
    client.send(type="shadow", runId="r1", source="print('n =', data['k'][0], data['k'][1])")
    sh = client.recv()
    assert sh["type"] == "evaluated" and sh["kind"] == "log" and sh["text"] == "n = 1 2"
    client.send(type="shadow", runId="r1", source="    total = data['k'][0] + data['k'][1]")
    sh = client.recv()
    assert sh["type"] == "evaluated" and sh["kind"] == "value" and sh["context"] == "total" and sh["text"] == "3"
    client.send(type="shadow", runId="r1", source="data['k'][2]")
    assert client.recv()["text"] == "{'deep': 'xxxxxxxxxx'}"
    client.send(type="shadow", runId="r1", source="print(len(data))")
    assert client.recv()["text"] == "1", "a pure call in an edited statement too"
    client.send(type="shadow", runId="r1", source="print(data['k'].pop())")
    assert client.recv()["type"] == "error"
    client.send(type="shadow", runId="r1", source="if data: pass")
    assert client.recv()["type"] == "error"
    # a second run replaces the child
    events2 = client.run(scratch, runId="r2")
    assert events2[-1]["type"] == "run.finished" and events2[-1]["exitCode"] == 0
    # stop with nothing running is fine
    client.send(type="stop", runId="r2")
    assert client.recv()["type"] == "ok"


def test_timeout_kills_infinite_loop_and_returns_partial_trace(client, tmp_path):
    scratch = tmp_path / "inf.py"
    scratch.write_text("i = 0\nwhile True:\n    i += 1\n", encoding="utf-8")
    t0 = time.time()
    events = client.run(scratch, config={"timeoutMs": 800, "maxTraceSteps": 5000})
    assert time.time() - t0 < 6
    finished = events[-1]
    assert finished["timedOut"] is True and finished["stopped"] is False
    assert not any(e.get("type") == "runner.error" and "killed by" in e.get("message", "") for e in events)  # a kill by the runner is not a crash
    traces = [e for e in events if e["type"] == "trace"]
    assert traces and traces[-1]["truncated"] is True
    assert len(decode_steps(traces[-1]["steps"])) // 4 == 5000
    assert any(e["type"] == "coverage" for e in events)


def test_stop_request_ends_running_child(client, tmp_path):
    scratch = tmp_path / "sleep.py"
    scratch.write_text("import time\nfor i in range(100):\n    time.sleep(0.05)\n", encoding="utf-8")
    req_id = client.send(type="run", runId="r-stop", file={"path": str(scratch), "displayName": "sleep.py"}, workspaceRoot=str(tmp_path), cwd=str(tmp_path), argv=[], env={}, projectFiles=[], config={"timeoutMs": 0}, markers=[], expressionsToEvaluate={}, watch=[], mode="normal")
    assert client.recv()["type"] == "ok"
    time.sleep(0.4)
    client.send(type="stop", runId="r-stop")
    seen = []
    for _ in range(50):
        m = client.recv()
        seen.append(m["type"])
        if m["type"] == "run.finished":
            assert m["stopped"] is True
        if "run.finished" in seen and "ok" in seen:
            break
    assert "run.finished" in seen and "ok" in seen


MODE_VARS = ("PYOKKA_SPAWN", "PYOKKA_FORK")


def child_mode(env=None):
    """`ready.capabilities[0]` ("fork" or "spawn") of a fresh runner started with `env` and neither mode variable inherited."""
    c = Client(env=env, drop=MODE_VARS)
    try:
        c.send(type="hello", version="0.0.1")
        ready = c.recv()
        while ready.get("type") != "ready":
            ready = c.recv()
        return ready["capabilities"][0]
    finally:
        c.close()


def test_default_child_mode_is_spawn_on_macos_and_fork_elsewhere():
    assert child_mode({"PYOKKA_SPAWN": "1"}) == "spawn"
    if sys.platform == "darwin":
        assert child_mode() == "spawn"  # a fork there dies on the second run of anything that touches an Apple framework
        assert child_mode({"PYOKKA_FORK": "1"}) == "fork"
    elif hasattr(os, "fork"):
        assert child_mode() == "fork"


def test_child_killed_by_a_signal_is_reported_not_silent(client, tmp_path):
    scratch = tmp_path / "abort.py"
    scratch.write_text("import os, signal\nprint('before')\nos.kill(os.getpid(), signal.SIGABRT)\n", encoding="utf-8")
    events = client.run(scratch)
    kinds = [e["type"] for e in events]
    assert any(e["type"] in ("log", "output") and "before" in str(e.get("text", "")) for e in events), kinds
    err = next(e for e in events if e["type"] == "runner.error")
    assert err["message"].startswith("run child killed by SIGABRT (exit -6) before it finished"), err
    assert "python directly" in err["detail"] or "PYOKKA_FORK" in err["detail"]
    finished = events[-1]
    assert finished["type"] == "run.finished" and finished["exitCode"] == -6 and finished["stepCount"] == 0
    assert finished["timedOut"] is False and finished["stopped"] is False
    assert kinds.index("runner.error") < kinds.index("run.finished")


@pytest.mark.parametrize("mode", ["fork", "spawn"] if hasattr(os, "fork") else ["spawn"])
def test_second_run_still_answers_evaluate_and_pipes_close_once(mode, tmp_path):
    """Spawn mode closed the dropped child's control pipe by descriptor number and its file object
    closed the number again later, sometimes on the next child's pipe: that child's control channel
    hit EOF, it exited after its run, and `evaluate` answered "no finished run"."""
    c = Client(env={"PYOKKA_SPAWN": "1"} if mode == "spawn" else {"PYOKKA_SPAWN": "0", "PYOKKA_FORK": "1"}, drop=("PYOKKA_FORK",))
    scratch = tmp_path / "twice.py"
    scratch.write_text("total = 1 + 2\nprint(total)\n", encoding="utf-8")
    try:
        for n in (1, 2, 3):
            events = c.run(scratch, runId="r-%d" % n)
            assert events[-1]["type"] == "run.finished" and events[-1]["exitCode"] == 0
            c.send(type="evaluate", runId="r-%d" % n, expression="total * 2")
            reply = c.recv()
            while reply.get("type") not in ("evaluated", "error"):
                reply = c.recv()
            assert reply["type"] == "evaluated" and reply["text"] == "6", reply
    finally:
        c.close()
    stderr = c.p.stderr.read()
    assert "Bad file descriptor" not in stderr, stderr


def test_profile_mode_writes_cpuprofile(client, tmp_path):
    scratch = tmp_path / "prof.py"
    scratch.write_text("def work():\n    return sum(range(10000))\nfor _ in range(20):\n    work()\n", encoding="utf-8")
    events = client.run(scratch, mode="profile")
    finished = events[-1]
    path = finished["profile"]["path"]
    assert path.endswith(".cpuprofile")
    data = json.loads(Path(path).read_text())
    assert data["nodes"][0]["callFrame"]["functionName"] == "(root)"
    assert any(n["callFrame"]["functionName"] == "work" for n in data["nodes"])
    assert len(data["samples"]) == len(data["timeDeltas"])
    os.unlink(path)


def test_plugins_before_and_before_each(client, tmp_path):
    (tmp_path / "pk_plugin.py").write_text("import os\ndef before(cfg):\n    os.environ['PK_BEFORE'] = os.environ.get('PK_BEFORE', '') + 'b'\ndef before_each(cfg):\n    os.environ['PK_EACH'] = os.environ.get('PK_EACH', '') + 'e'\n", encoding="utf-8")
    scratch = tmp_path / "p.py"
    scratch.write_text("import os\nos.environ.get('PK_BEFORE')  # ?\nos.environ.get('PK_EACH')  # ?\n", encoding="utf-8")
    logs = []
    for _ in range(2):
        events = client.run(scratch, config={"plugins": ["pk_plugin"], "timeoutMs": 20000})
        logs = [e["text"] for e in events if e["type"] == "log"]
        assert not [e for e in events if e["type"] == "runner.error"], events
    assert logs[0] == "'b'"  # `before` ran once per runner process, `before_each` once per run
    assert logs[1] == "'e'"


def test_plugin_after_results_merge_into_run_finished(client, tmp_path):
    (tmp_path / "pk_after.py").write_text("def after(cfg):\n    return {'replayed': True, 'http': {'mode': 'replay'}, 'exitCode': 99}\n", encoding="utf-8")
    scratch = tmp_path / "a.py"
    scratch.write_text("x = 1\n", encoding="utf-8")
    events = client.run(scratch, config={"plugins": ["pk_after"], "timeoutMs": 20000, "httpObserve": False})  # the HTTP plugin's own `http` would land over pk_after's
    assert not [e for e in events if e["type"] == "runner.error"], events
    finished = events[-1]
    assert finished["replayed"] is True and finished["http"] == {"mode": "replay"}
    assert finished["exitCode"] == 0  # the runtime's own fields win over a plugin's


def test_plugin_sees_the_current_execution_and_the_runtime_finder(client, tmp_path):
    (tmp_path / "pk_current.py").write_text(
        "import os, sys\nimport pyokka_runtime.execute as ex\n"
        "def before_each(cfg):\n"
        "    os.environ['PK_FILE'] = ex.current.spec.file_path\n"
        "    os.environ['PK_ROOT'] = ex.current.spec.workspace_root\n"
        "    os.environ['PK_FINDER'] = 'yes' if any(type(f).__name__ == '_Finder' for f in sys.meta_path) else 'no'\n"
        "    ex.runner_error('hello from plugin')\n",
        encoding="utf-8",
    )
    scratch = tmp_path / "c.py"
    scratch.write_text("import os\nos.environ['PK_FILE']  # ?\nos.environ['PK_ROOT']  # ?\nos.environ['PK_FINDER']  # ?\n", encoding="utf-8")
    events = client.run(scratch, config={"plugins": ["pk_current"], "timeoutMs": 20000})
    assert [e["text"] for e in events if e["type"] == "log"] == [repr(str(scratch)), repr(str(tmp_path)), "'yes'"]
    assert [e["message"] for e in events if e["type"] == "runner.error"] == ["hello from plugin"]
    assert events[-1]["type"] == "run.finished" and events[-1]["exitCode"] == 0


def test_plugin_failing_in_after_is_reported_and_the_run_still_finishes(client, tmp_path):
    (tmp_path / "pk_boom.py").write_text("def after(cfg):\n    raise RuntimeError('boom')\n", encoding="utf-8")
    scratch = tmp_path / "b.py"
    scratch.write_text("x = 1\n", encoding="utf-8")
    events = client.run(scratch, config={"plugins": ["pk_boom"], "timeoutMs": 20000})
    errors = [e["message"] for e in events if e["type"] == "runner.error"]
    assert errors == ["plugin pk_boom failed in after: RuntimeError: boom"]
    assert events[-1]["type"] == "run.finished" and events[-1]["exitCode"] == 0


def test_plugin_after_runs_for_a_syntax_error_and_in_profile_mode(run, tmp_path):
    import pyokka_runtime.execute as ex

    (tmp_path / "pk_mark.py").write_text("def after(cfg):\n    return {'marked': True}\n", encoding="utf-8")
    out = run("def (:\n", config={"plugins": ["pk_mark"]})
    assert out.finished["exitCode"] == 1 and out.finished["marked"] is True and ex.current is None
    out = run("x = 1\n", config={"plugins": ["pk_mark"]}, mode="profile")
    assert out.finished["marked"] is True and out.finished["profile"]["path"].endswith(".cpuprofile")
    os.unlink(out.finished["profile"]["path"])


def test_run_config_http_loads_the_runtime_plugin_once_and_for_observing():
    from pyokka_runtime.protocol import HTTP_PLUGIN, RunConfig

    cfg = RunConfig.from_dict({"http": "record"})
    assert cfg.http == "record" and cfg.http_observe is True and cfg.plugins == [HTTP_PLUGIN] and "plugins" not in cfg.raw
    cfg = RunConfig.from_dict({"http": "replay", "plugins": ["mine", HTTP_PLUGIN]})
    assert cfg.http == "replay" and cfg.plugins == ["mine", HTTP_PLUGIN]
    cfg = RunConfig.from_dict({"http": "bogus", "plugins": ["mine"]})
    assert cfg.http == "off" and cfg.plugins == ["mine", HTTP_PLUGIN]  # off observes: the plugin loads
    assert RunConfig.from_dict({}).http == "off" and RunConfig.from_dict({}).plugins == [HTTP_PLUGIN]
    assert RunConfig.from_dict(None).http == "off" and RunConfig.from_dict(None).http_observe is True
    cfg = RunConfig.from_dict({"httpObserve": False})
    assert cfg.http_observe is False and cfg.plugins == []  # the clients stay untouched: no plugin at all
    assert RunConfig.from_dict({"http": "record", "httpObserve": False}).plugins == [HTTP_PLUGIN]  # recording needs it whatever httpObserve says


def test_run_finished_puts_plugin_results_under_the_runtime_fields():
    from pyokka_runtime.protocol import ev_run_finished

    ev = ev_run_finished(exit_code=0, duration_ms=1.5, timed_out=False, stopped=False, step_count=3, log_count=1, extra={"replayed": True, "exitCode": 99, "type": "x", "profile": {"path": "p"}})
    assert ev["replayed"] is True and ev["exitCode"] == 0 and ev["type"] == "run.finished" and "profile" not in ev
    assert list(ev)[0] == "type"
    ev = ev_run_finished(exit_code=1, duration_ms=1.5, timed_out=False, stopped=False, step_count=0, log_count=0, profile={"path": "q"}, extra=None)
    assert ev["profile"] == {"path": "q"} and ev["exitCode"] == 1


LIBQ ="CONST = 1\n\n\ndef helper(x):\n    y = x + CONST\n    return y\n\n\nbuilt = helper(1)\n"
LIBQ_MAIN = "import os, sys\nsys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'venv', 'site-packages'))\nimport libq\nr = libq.helper(10)\n"


def test_source_request_serves_library_files_on_demand(client, tmp_path):
    lib = tmp_path / "venv" / "site-packages" / "libq" / "__init__.py"
    lib.parent.mkdir(parents=True)
    lib.write_text(LIBQ, encoding="utf-8")
    scratch = tmp_path / "main.py"
    scratch.write_text(LIBQ_MAIN, encoding="utf-8")
    events = client.run(scratch, runId="r-src", config={"timeoutMs": 20000, "libraryCode": True})
    files = [e for e in events if e["type"] == "file.instrumented"]
    assert len(files) == 2
    assert "instrumentedSource" in files[0] and "instrumentedSource" not in files[1]
    assert files[1]["instrumentMs"] >= 0
    assert not [e for e in events if e["type"] == "runner.error"]
    client.send(type="source", runId="r-src", fileId=2)
    reply = client.recv()
    assert reply["type"] == "source" and reply["fileId"] == 2
    assert "_pk_f(" in reply["instrumentedSource"] and "_pk_c(" in reply["instrumentedSource"]
    client.send(type="source", runId="r-src", fileId=42)
    assert client.recv()["type"] == "error"


class _Sink:
    def __init__(self):
        self.sent = []

    def send(self, msg):
        self.sent.append(msg)


def test_bindings_request_is_stateless(client):
    client.send(type="hello", version="1")
    ready = client.recv()
    assert "bindings" in ready["capabilities"]
    rid = client.send(type="bindings", source="x = 1\nfor i in range(x):\n    y = i\n")
    reply = client.recv()
    assert reply["type"] == "bindings" and reply["id"] == rid
    assert reply["statements"] == [
        {"line": 1, "col": 0, "assigns": ["x"], "reads": []},
        {"line": 2, "col": 0, "assigns": ["i"], "reads": ["x"], "loop": 3, "calls": ["range(x)"]},
        {"line": 3, "col": 4, "assigns": ["y"], "reads": ["i"]},
    ]
    client.send(type="bindings", source="def (:\n")
    err = client.recv()
    assert err["type"] == "error" and err["message"].startswith("SyntaxError")
    client.send(type="bindings")
    assert client.recv()["message"] == "bindings needs source"
    client.send(type="shutdown")
    assert client.recv()["type"] == "ok"


def test_truncated_tail_line_from_a_killed_child_is_dropped():
    from pyokka_runtime.runner import Child

    sink = _Sink()
    child = Child("r", {}, sink)
    child.on_child_line('{"type":"trace","steps":"AAAA', complete=False)
    assert sink.sent == []
    child.on_child_line('{"type":"trace","steps":"AAAA')
    assert sink.sent[-1]["type"] == "runner.error" and "bad event line" in sink.sent[-1]["message"]


def test_instrumentation_time_extends_the_timeout():
    import io

    from pyokka_runtime.runner import Child, Runner

    runner = Runner(io.BytesIO(), io.BytesIO())
    sink = _Sink()
    child = Child("r", {}, sink)
    child.deadline = time.perf_counter() + 0.05
    child.on_child_line('{"type":"file.instrumented","fileId":2,"path":"x","rangeBase":0,"ranges":[],"statements":[],"functions":[],"magic":[],"instrumentMs":5000}')
    assert sink.sent[-1]["type"] == "file.instrumented" and "instrumentMs" in sink.sent[-1]
    runner._on_timeout(child)  # deadline is now 5 s away: re-armed, nothing terminated
    assert child.timed_out is False and child.timer is not None
    child.timer.cancel()
    child.deadline = time.perf_counter() - 1
    child.alive = False  # nothing to signal; terminate just records the timeout
    runner._on_timeout(child)
    assert child.timed_out is True
