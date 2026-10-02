"""Exception events, error path coverage, unwinding flags."""

from __future__ import annotations

import pytest

from pyokka_runtime.errors import MAX_HANDLED_EVENTS, MAX_RECORDS
from pyokka_runtime.protocol import COV_COVERED, COV_ERROR_PATH, COV_ERROR_SOURCE, FLAG_ERROR, FLAG_UNWINDING


def test_uncaught_error_marks_source_and_path(run):
    out = run(
        """
        def inner(v):
            return 1 / v
        def outer(v):
            x = 1
            return inner(v)
        outer(0)
        """
    )
    err = [e for e in out.errors if not e["handled"]][0]
    assert err["errorType"] == "ZeroDivisionError" and "division" in err["message"]
    assert err["rid"] == out.rid_at(3)
    assert [f["function"] for f in err["stack"]] == ["inner", "outer", "<module>"]
    assert err["stack"][0]["line"] == 3 and err["stack"][1]["rid"] == out.rid_at(6)
    assert out.state_at(3) == COV_ERROR_SOURCE
    assert out.state_at(6) == COV_ERROR_PATH
    assert out.state_at(7) == COV_ERROR_PATH
    assert out.state_at(5) == COV_COVERED
    steps = out.steps
    assert steps[err["step"]][0] == out.rid_at(3) and steps[err["step"]][3] & FLAG_ERROR
    unwinding = {steps[i][0] for i, s in enumerate(steps) if s[3] & FLAG_UNWINDING}
    assert out.rid_at(6) in unwinding and out.rid_at(7) in unwinding
    assert out.finished["exitCode"] == 1


def test_handled_exception_is_flagged_but_not_error_path(run):
    out = run(
        """
        def risky():
            raise KeyError("k")
        try:
            risky()
        except KeyError:
            handled = True
        after = 1
        """
    )
    handled = [e for e in out.errors if e["handled"]]
    assert len(handled) == 1 and handled[0]["errorType"] == "KeyError" and handled[0]["rid"] == out.rid_at(3)
    assert not [e for e in out.errors if not e["handled"]]
    assert out.state_at(3) == COV_COVERED and out.state_at(5) == COV_COVERED
    assert out.steps[handled[0]["step"]][3] & FLAG_ERROR
    assert out.finished["exitCode"] == 0


def test_error_raised_inside_library_is_attributed_to_calling_statement(run):
    out = run(
        """
        import json
        data = json.loads("{bad")
        """
    )
    err = [e for e in out.errors if not e["handled"]][0]
    assert err["errorType"] == "JSONDecodeError"
    assert err["rid"] == out.rid_at(3)
    assert out.state_at(3) == COV_ERROR_SOURCE
    assert err["stack"][0]["fileId"] == 1 or any(f["fileId"] == 1 for f in err["stack"])


def test_system_exit_is_not_an_error(run):
    out = run("import sys\nsys.exit(3)\n")
    assert out.finished["exitCode"] == 3
    assert out.errors == []


def test_error_in_loop_body_after_many_steps(run):
    out = run(
        """
        acc = 0
        for i in range(50):
            acc += i
        raise RuntimeError("late")
        """
    )
    err = [e for e in out.errors if not e["handled"]][0]
    assert err["step"] == len(out.steps) - 1
    assert out.state_at(5) == COV_ERROR_SOURCE


def test_snaps_mode_keeps_going_after_module_error(run):
    out = run(
        '''
        def add(a, b):
            """{{
            add(1, 2)
            }}"""
            return a + b
        broken = 1 / 0
        tail = 1
        """{{
        x = add(2, 3)
        x * 2
        }}"""
        ''',
        mode="snaps",
    )
    assert [e["text"] for e in out.logs_at(4)] == ["3"]
    assert [e["text"] for e in out.logs_at(10)] == ["5"]
    assert [e["text"] for e in out.logs_at(11)] == ["10"]
    assert out.state_at(7) == COV_ERROR_SOURCE
    assert out.state_at(8) == COV_COVERED
    # the snap guard reports it once, as uncaught; the guard's own except clause is not a handler
    assert [e["handled"] for e in out.errors if e["errorType"] == "ZeroDivisionError"] == [False]
    assert all(e["kind"] == "value" for e in out.logs)


# -- caught exceptions: where they were handled, aggregated per site --------------------------


def caught(out) -> list[dict]:
    return [e for e in out.errors if e["handled"]]


def uncaught(out) -> list[dict]:
    return [e for e in out.errors if not e["handled"]]


def test_caught_exceptions_are_aggregated_per_site(run):
    out = run(
        """
        def lookup(d, k):
            return d[k]
        table = {}
        for i in range(3):
            try:
                v = lookup(table, i)
            except KeyError:
                v = None
        done = 1
        """
    )
    assert not uncaught(out)
    (ev,) = caught(out)
    assert ev["errorType"] == "KeyError" and ev["rid"] == out.rid_at(3) and ev["count"] == 3
    assert ev["handledAt"] == {"fileId": 1, "line": 8, "rid": out.rid_at(6), "function": "<module>", "broad": False}
    assert "traceback" not in ev
    steps = out.steps
    raise_steps = [i for i, s in enumerate(steps) if s[0] == out.rid_at(3)]
    assert len(raise_steps) == 3 and all(steps[i][3] & FLAG_ERROR for i in raise_steps)
    assert ev["step"] == raise_steps[0] and ev["lastStep"] == raise_steps[-1] and ev["lastStep"] > ev["step"]
    assert out.state_at(3) == COV_COVERED and out.state_at(7) == COV_COVERED


def test_caught_exceptions_fold_past_the_record_cap(run):
    n = MAX_RECORDS + 100
    out = run("for i in range(%d):\n    try:\n        {}[i]\n    except KeyError:\n        pass\n" % n)
    (ev,) = caught(out)
    assert ev["count"] == n and ev["rid"] == out.rid_at(3)
    assert ev["handledAt"]["line"] == 4 and ev["handledAt"]["rid"] == out.rid_at(2)
    assert out.steps[ev["step"]][0] == out.rid_at(3) and out.steps[ev["lastStep"]][0] == out.rid_at(3)
    assert ev["lastStep"] == max(i for i, s in enumerate(out.steps) if s[0] == out.rid_at(3))


@pytest.mark.parametrize(
    "clause, broad",
    [("except:", True), ("except Exception as e:", True), ("except (KeyError, Exception):", True), ("except BaseException:", True), ("except ValueError:", False)],
)
def test_handler_broadness(run, clause, broad):
    out = run("try:\n    raise ValueError('v')\n%s\n    pass\n" % clause)
    (ev,) = caught(out)
    assert ev["handledAt"] == {"fileId": 1, "line": 3, "rid": out.rid_at(1), "function": "<module>", "broad": broad}


def test_matching_clause_is_resolved_from_the_next_step(run):
    out = run(
        """
        def pick(kind):
            try:
                raise kind("x")
            except ValueError:
                first = True
            except Exception:
                second = True
        pick(KeyError)
        pick(ValueError)
        """
    )
    key_error, value_error = caught(out)
    assert key_error["errorType"] == "KeyError" and key_error["step"] < value_error["step"]
    assert key_error["handledAt"] == {"fileId": 1, "line": 7, "rid": out.rid_at(3), "function": "pick", "broad": True}
    assert value_error["errorType"] == "ValueError"
    assert value_error["handledAt"] == {"fileId": 1, "line": 5, "rid": out.rid_at(3), "function": "pick", "broad": False}


def test_finally_and_with_cleanup_are_not_handlers(run):
    out = run(
        """
        class Resource:
            def __enter__(self):
                return self
            def __exit__(self, *exc):
                return False
        def work():
            try:
                with Resource():
                    try:
                        raise OSError("disk")
                    finally:
                        cleaned = True
            except Exception:
                recovered = True
        work()
        """
    )
    assert not uncaught(out)
    (ev,) = caught(out)
    assert ev["errorType"] == "OSError" and ev["rid"] == out.rid_at(11) and ev["count"] == 1
    assert ev["handledAt"] == {"fileId": 1, "line": 14, "rid": out.rid_at(8), "function": "work", "broad": True}


@pytest.mark.parametrize("stmt", ["raise", "raise e"])
def test_reraised_exception_is_handled_by_the_outer_clause(run, stmt):
    out = run(
        """
        def inner():
            try:
                raise RuntimeError("boom")
            except RuntimeError as e:
                %s
        try:
            inner()
        except RuntimeError as err:
            outer = err
        """
        % stmt
    )
    assert not uncaught(out)
    (ev,) = caught(out)
    assert ev["rid"] == out.rid_at(4) and ev["count"] == 1
    assert ev["handledAt"] == {"fileId": 1, "line": 9, "rid": out.rid_at(7), "function": "<module>", "broad": False}


def test_raise_from_starts_a_new_record(run):
    out = run(
        """
        def inner():
            try:
                raise KeyError("k")
            except KeyError as e:
                raise ValueError("wrapped") from e
        try:
            inner()
        except ValueError as err:
            outer = err
        """
    )
    key_error, value_error = caught(out)
    assert key_error["errorType"] == "KeyError" and key_error["rid"] == out.rid_at(4)
    assert key_error["handledAt"] == {"fileId": 1, "line": 5, "rid": out.rid_at(3), "function": "inner", "broad": False}
    assert value_error["errorType"] == "ValueError" and value_error["rid"] == out.rid_at(6)
    assert value_error["handledAt"] == {"fileId": 1, "line": 9, "rid": out.rid_at(7), "function": "<module>", "broad": False}


def test_contextlib_suppress_handles_at_the_with_line(run):
    out = run(
        """
        import contextlib
        def peek(items):
            with contextlib.suppress(IndexError):
                return items[3]
            return None
        peek([])
        """
    )
    (ev,) = caught(out)
    assert ev["errorType"] == "IndexError" and ev["rid"] == out.rid_at(5)
    assert ev["handledAt"] == {"fileId": 1, "line": 4, "rid": out.rid_at(4), "function": "peek", "broad": False}


def test_uncaught_exception_is_emitted_once(run):
    out = run(
        """
        def boom():
            raise ValueError("bad")
        def run_it():
            boom()
        run_it()
        """
    )
    (ev,) = out.errors  # the function bodies' finally blocks are not handlers
    assert ev["handled"] is False and "traceback" in ev and ev["rid"] == out.rid_at(3)
    assert "count" not in ev and "handledAt" not in ev


LIB = {
    "venv/site-packages/libq/__init__.py": """
    def fail(x):
        raise TypeError("bad %r" % x)
    def safe():
        try:
            fail(1)
        except TypeError:
            return "ok"
    """
}
LIB_SRC = """
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'venv', 'site-packages'))
import libq
try:
    libq.fail(2)
except TypeError:
    recovered = True
r = libq.safe()
"""


def test_library_exception_caught_by_user_code(run):
    out = run(LIB_SRC, files=LIB, config={"libraryCode": True})
    (ev,) = caught(out)  # `safe` catches its own TypeError: never reported
    assert ev["errorType"] == "TypeError" and ev["fileId"] == 2 and ev["rid"] == out.rid_at(3, 2) and ev["count"] == 1
    assert ev["handledAt"] == {"fileId": 1, "line": 7, "rid": out.rid_at(5), "function": "<module>", "broad": False}
    assert not uncaught(out) and out.finished["exitCode"] == 0


def test_library_exception_without_library_stepping(run):
    out = run(LIB_SRC, files=LIB)
    (ev,) = caught(out)
    assert ev["errorType"] == "TypeError" and ev["fileId"] == 1 and ev["rid"] == out.rid_at(6)
    assert ev["handledAt"] == {"fileId": 1, "line": 7, "rid": out.rid_at(5), "function": "<module>", "broad": False}


def test_library_exception_swallowed_outside_instrumented_code_is_not_reported(run):
    files = {
        "venv/site-packages/libq/__init__.py": """
        class Lazy:
            def __getattr__(self, name):
                raise AttributeError(name)
        def probe():
            return getattr(Lazy(), "missing", None)
        """
    }
    out = run(
        """
        import os, sys
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'venv', 'site-packages'))
        import libq
        probed = libq.probe()
        class Mine:
            def __getattr__(self, name):
                raise AttributeError(name)
        mine = getattr(Mine(), "missing", None)
        """,
        files=files,
        config={"libraryCode": True},
    )
    (ev,) = caught(out)  # the library's own swallow is library-internal noise; the user's stays reported
    assert ev["fileId"] == 1 and ev["rid"] == out.rid_at(8) and ev["count"] == 1 and "handledAt" not in ev
    assert out.file(2)["fileId"] == 2 and not uncaught(out)


def test_exception_caught_outside_instrumented_code(run):
    out = run(
        """
        class Lazy:
            def __getattr__(self, name):
                raise AttributeError(name)
        obj = Lazy()
        found = []
        for _ in range(3):
            found.append(getattr(obj, "x", None))
        """
    )
    (ev,) = caught(out)
    assert ev["errorType"] == "AttributeError" and ev["rid"] == out.rid_at(4) and ev["count"] == 3
    assert "handledAt" not in ev and ev["handled"] is True
    assert out.finished["exitCode"] == 0


def test_caught_exception_groups_are_capped(run):
    sites = 55
    out = run("".join("try:\n    raise ValueError(%d)\nexcept ValueError:\n    pass\n" % i for i in range(sites)))
    events = caught(out)
    assert len(events) == MAX_HANDLED_EVENTS == 50
    assert [e["handledAt"]["line"] for e in events] == [4 * i + 3 for i in range(50)]
    steps = [e["step"] for e in events]
    assert steps == sorted(steps) and all(e["count"] == 1 for e in events)


def test_annotation_protocol_refusals_are_not_exceptions(run):
    """3.14: asking the generated `__annotate__` for the STRING format (pydantic does) raises NotImplementedError, which
    `annotationlib` catches; the runtime must not report it. Older Pythons have no annotation protocol to refuse."""
    pytest.importorskip("annotationlib")
    out = run(
        """
        import annotationlib
        class Point:
            x: int
            y: int = 0
        strings = annotationlib.get_annotations(Point, format=annotationlib.Format.STRING)
        p = Point()
        """
    )
    assert out.errors == [] and out.finished["exitCode"] == 0
