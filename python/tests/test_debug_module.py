"""``run.module``: a ``python -m`` launch, for a debug session started on a module rather than a file.

What the program sees (``__name__``, ``sys.argv``, ``sys.path[0]``), that the module and its
imports are instrumented so a breakpoint in it pauses, that an uncaught exception ends the run the
way a file launch does, what happens when a request carries both a module and a file, and that a
file launch without ``file.content`` runs what is on disk.
"""

from __future__ import annotations

from tests.test_debug import CONTINUE, Scripted, attach, pauses, results

# A package: `python -m app` runs `app.__main__`, so `app/__init__.py` is imported first.
PACKAGE = {
    "app/__init__.py": """
    VERSION = "1"
    """,
    "app/__main__.py": """
    import sys

    print("name", __name__)
    print("argv0", sys.argv[0])
    print("rest", sys.argv[1:])
    print("path0", sys.path[0])
    print("version", __import__("app").VERSION)
    """,
}

# A top-level module, so nothing is imported before it and it is the run's first file.
SERVER = {
    "server.py": """
    def handle(n):
        doubled = n * 2
        return doubled


    value = handle(21)
    print("value", value)
    """
}

BOOM = {
    "boom.py": """
    def check(n):
        if n > 2:
            raise ValueError("too big: %d" % n)
        return n


    print("start")
    print(check(5))
    """
}

DEBUG = {"debug": True, "record": False, "stopOnEntry": False}


def module_run(run, module, *, config=None, breakpoints=None, batches=(), argv=(), **kw):
    cfg = {**DEBUG, **(config or {})}
    return run("", module=module, config=cfg, request_extra={"argv": list(argv)}, on_tracer=attach(Scripted(*batches), breakpoints=breakpoints), **kw)


def output(out, stream="stdout"):
    return "".join(e["text"] for e in out.of("output") if e["stream"] == stream)


def test_module_launch_runs_as_main_with_argv_and_syspath(run, tmp_path):
    out = module_run(run, "app", files=PACKAGE, argv=["--port", "8000"])
    lines = output(out).splitlines()
    assert lines == [
        "name __main__",
        "argv0 %s" % (tmp_path / "app" / "__main__.py"),
        "rest ['--port', '8000']",
        "path0 %s" % tmp_path,
        "version 1",
    ]
    assert out.result.exit_code == 0
    # the package's `__init__.py` is imported on the way, so both files are instrumented
    assert sorted(e["path"] for e in out.of("file.instrumented")) == [str(tmp_path / "app" / "__init__.py"), str(tmp_path / "app" / "__main__.py")]


def test_module_launch_instruments_the_module_and_honours_a_breakpoint(run, tmp_path):
    path = str(tmp_path / "server.py")
    out = module_run(run, "server", files=SERVER, breakpoints=[{"path": path, "line": 3}], batches=[[{"type": "debug", "id": "l", "action": "locals"}, CONTINUE]])
    (first,) = out.of("file.instrumented")
    assert (first["fileId"], first["path"]) == (1, path)
    (p,) = pauses(out)
    assert (p["reason"], p["line"], p["fileId"]) == ("breakpoint", 3, 1)
    assert p["breakpoint"]["resolvedLine"] == 3 and [s["name"] for s in p["stack"]] == ["handle", "<module>"]
    assert [(v["name"], v["text"]) for v in results(out, "debug.result")[0]["locals"]] == [("n", "21")]
    assert output(out) == "value 42\n" and out.result.exit_code == 0


def test_module_launch_reports_an_uncaught_exception_like_a_file_launch(run, tmp_path):
    out = module_run(run, "boom", files=BOOM, config={"breakOnException": "off"})
    assert out.result.exit_code == 1
    (err,) = out.errors
    assert err["errorType"] == "ValueError" and err["handled"] is False
    assert err["stack"][0]["path"] == str(tmp_path / "boom.py") and err["stack"][0]["function"] == "check"
    assert "ValueError: too big: 5" in err["traceback"]
    assert output(out) == "start\n"


def test_module_and_file_together_is_reported(run, tmp_path):
    scratch = tmp_path / "scratch.py"
    extra = {"file": {"path": str(scratch), "displayName": "scratch.py", "content": 'print("the file ran")\n'}}
    out = run('print("the file ran")\n', module="server", config=DEBUG, files=SERVER, request_extra=extra, on_tracer=attach(Scripted()))
    (warning,) = out.of("runner.error")
    assert warning["message"] == "run.module and run.file are both set; running the module server"
    assert output(out) == "value 42\n", "the module wins"
    assert out.result.exit_code == 0


def test_missing_file_content_is_read_from_disk(run, tmp_path):
    on_disk = 'print("disk")\n'
    entry = {"path": str(tmp_path / "scratch.py"), "displayName": "scratch.py"}
    from_disk = run(on_disk, request_extra={"file": entry})
    assert [e["text"] for e in from_disk.logs] == ["disk"], "no content sent: what is on disk ran"
    buffered = run(on_disk, request_extra={"file": {**entry, "content": 'print("buffer")\n'}})
    assert [e["text"] for e in buffered.logs] == ["buffer"], "content sent: the buffer ran"
