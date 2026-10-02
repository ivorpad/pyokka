from __future__ import annotations

import os
import sys
import textwrap
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

from pyokka_runtime import secrets
from pyokka_runtime.execute import Execution, RunSpec, StepStream
from pyokka_runtime.protocol import decode_steps

ROOT = Path(__file__).resolve().parents[2]
DEMO = ROOT / "examples" / "demo.py"


@dataclass
class RunOutput:
    events: list[dict]
    result: Any
    path: str
    execution: Any = None

    def of(self, kind: str) -> list[dict]:
        return [e for e in self.events if e.get("type") == kind]

    @property
    def logs(self) -> list[dict]:
        return self.of("log")

    def logs_at(self, line: int, kind: str | None = None) -> list[dict]:
        ranges = self.file()["ranges"]
        base = self.file()["rangeBase"]
        out = []
        for e in self.logs:
            rng = ranges[e["rid"] - base]
            if rng[0] == line and (kind is None or e["kind"] == kind):
                out.append(e)
        return out

    def file(self, file_id: int = 1) -> dict:
        return next(e for e in self.of("file.instrumented") if e["fileId"] == file_id)

    @property
    def coverage(self) -> dict:
        return self.of("coverage")[0]

    def state_at(self, line: int, file_id: int = 1) -> int:
        """Coverage state of the statement starting on ``line``."""
        f = self.file(file_id)
        cov = next(c for c in self.of("coverage") if c["fileId"] == file_id)
        for rid in f["statements"]:
            if f["ranges"][rid][0] == line:
                return cov["states"][rid]
        raise AssertionError("no statement on line %d" % line)

    def rid_at(self, line: int, file_id: int = 1) -> int:
        f = self.file(file_id)
        for rid in f["statements"]:
            if f["ranges"][rid][0] == line:
                return f["rangeBase"] + rid
        raise AssertionError("no statement on line %d" % line)

    @property
    def trace(self) -> dict:
        return [e for e in self.of("trace") if not e.get("partial")][-1]

    @property
    def steps(self) -> list[tuple[int, int, int, int]]:
        arr = decode_steps(self.trace["steps"])
        return [tuple(arr[i : i + 4]) for i in range(0, len(arr), 4)]

    @property
    def errors(self) -> list[dict]:
        return self.of("error")

    @property
    def finished(self) -> dict:
        return self.of("run.finished")[0]


def run_source(source: str, tmp_path: Path, *, name: str = "scratch.py", config: dict | None = None, markers: list | None = None, mode: str = "normal", watch: list | None = None, trace_context: dict | None = None, expressions: dict | None = None, files: dict[str, str] | None = None, capture_output: bool = True, on_tracer=None, module: str | None = None, request_extra: dict | None = None) -> RunOutput:
    """Run ``source`` in this process and collect its events.

    ``module`` sends a ``run.module`` launch instead of a file (``source`` is still written to disk,
    so a test can keep a scratch file next to the package). ``request_extra`` is merged into the
    request last, which is how a test sends a ``file`` without ``content``, or both at once.
    """
    source = textwrap.dedent(source)
    path = tmp_path / name
    path.write_text(source, encoding="utf-8")
    for rel, content in (files or {}).items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(textwrap.dedent(content), encoding="utf-8")
    events: list[dict] = []
    request = {
        "type": "run",
        "runId": "t",
        "file": {"path": str(path), "displayName": name, "content": source},
        "workspaceRoot": str(tmp_path),
        "cwd": str(tmp_path),
        "argv": [],
        "env": {},
        "projectFiles": [],
        "config": {"timeoutMs": 0, **(config or {})},
        "markers": markers or [],
        "expressionsToEvaluate": expressions or {},
        "watch": watch or [],
        "traceContext": trace_context,
        "mode": mode,
    }
    if module is not None:
        request.pop("file")
        request["module"] = module
    request.update(request_extra or {})
    saved = (sys.argv[:], os.getcwd(), sys.path[:], sys.modules.get("__main__"), sys.stdout, sys.stderr, dict(os.environ))
    project_modules = set(sys.modules)
    # the child's EmitPipe scrubs secrets from every event; mirror it here
    emit = lambda ev: events.append(secrets.current.scrub_event(ev))  # noqa: E731
    execution = Execution(RunSpec.from_request(request), emit)
    if on_tracer is not None:
        execution.on_tracer = on_tracer  # tests attach a scripted debugger control here (test_debug.py)
    if capture_output:
        sys.stdout = StepStream("stdout", emit, lambda: execution.tracer)
        sys.stderr = StepStream("stderr", emit, lambda: execution.tracer)
    try:
        result = execution.run()
        sys.stdout.flush()
        sys.stderr.flush()
    finally:
        sys.argv, cwd, sys.path, main, sys.stdout, sys.stderr, env = saved
        os.chdir(cwd)
        if main is not None:
            sys.modules["__main__"] = main
        os.environ.clear()
        os.environ.update(env)
        for name_ in list(sys.modules):
            if name_ not in project_modules:
                mod = sys.modules[name_]
                if getattr(mod, "__file__", "") and str(getattr(mod, "__file__", "")).startswith(str(tmp_path)):
                    del sys.modules[name_]
    # what `ev_run_finished` builds: the plugins' `after` results first, the runtime's fields over them
    events.append({**result.extra, "type": "run.finished", "exitCode": result.exit_code, "stepCount": result.step_count, "logCount": result.log_count, "profile": result.profile})
    return RunOutput(events, result, str(path), execution)


@pytest.fixture(autouse=True)
def _no_secret_filter_leak():
    """Each ``Execution`` installs a secret filter; tests that serialize directly start from the disabled one."""
    from pyokka_runtime import secrets

    yield
    secrets.current = secrets.SecretFilter(enabled=False)


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path, monkeypatch):
    """Library-file cache entries, session descriptors and the relaunch memory go to per-test directories, never to ~/.pyokka."""
    monkeypatch.setenv("PYOKKA_CACHE_DIR", str(tmp_path / "pyokka-cache"))
    monkeypatch.setenv("PYOKKA_HOME", str(tmp_path / "pyokka-home"))


@pytest.fixture
def run(tmp_path):
    def _run(source: str, **kw):
        return run_source(source, tmp_path, **kw)

    return _run
