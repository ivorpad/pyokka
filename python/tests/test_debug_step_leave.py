"""A step whose frame exits into code that is not instrumented, with ``config.record: false``.

``on_leave`` hands a pending ``over`` / ``out`` to the nearest instrumented ancestor's scope, which
is the step rule: over is the next statement in the paused scope or one of its ancestors, and a
module body is an ancestor like any other. When there is no such ancestor -- a thread target, a
request handler under a web framework -- there is no scope to hand it to, and the step used to wait
for one that never runs another statement: the program served the next request and the client that
asked for the step never got a stop. Such a step degrades to "the next statement of my code,
wherever it is", as a debugger with "just my code" does.

The entry-pause line is here too: a pause on a ``def`` reports the ``def`` line, so frame 0 of the
stack has to report it as well and not the first body statement the frame is about to run.
"""

from __future__ import annotations

from tests.test_debug import CONTINUE, pauses, results, step
from tests.test_debug_record_off import debug_run

# `sorted` calls `keyfn` once per item, from C, so the frame `keyfn` returns into is `<module>`:
# an ancestor, which takes the step even though a call of `keyfn` runs in between.
CALLBACK_TWICE = """
def keyfn(item):
    label = "k%d" % item
    return (item, label)


order = sorted([2, 1], key=keyfn)
print(order)
"""

# `threading` catches what the target raises and calls `threading.excepthook`, which is the
# program's own `seen`. So the frame the step is armed in unwinds into a library `try` and the next
# statement of the program's code is a call the library makes, not a statement of any caller.
THREAD_RAISE = """
import threading


def worker():
    raise ValueError("boom")


def seen(args):
    name = args.exc_type.__name__
    print("seen", name)


threading.excepthook = seen
t = threading.Thread(target=worker, name="W")
t.start()
t.join()
print("end")
"""


def test_step_over_a_callback_that_returns_to_the_module_waits_for_the_module(run, tmp_path):
    """A module body is an ancestor: the step waits for it, so the rest of `sorted` runs through."""
    path = str(tmp_path / "scratch.py")
    batches = [[step("over")], [{"type": "evaluate", "id": "e", "expression": "order"}, CONTINUE]]
    bps = [{"path": path, "line": 4, "condition": "item == 2"}]
    out = debug_run(run, CALLBACK_TWICE, batches=batches, breakpoints=bps)
    ps = pauses(out)
    assert [(p["line"], p["reason"], p.get("kind")) for p in ps] == [(4, "breakpoint", None), (8, "step", "over")], "the statement after the `sorted` line, not the second `keyfn` call"
    assert (ps[0]["scopeId"], ps[1]["scopeId"]) == (1, 0), "armed in `keyfn`'s first call, landed in the module"
    assert results(out, "evaluate.result")[0]["text"] == "[1, 2]", "`sorted` finished, second `keyfn` call included"
    assert [s["name"] for s in ps[1]["stack"]] == ["<module>"]
    assert out.result.exit_code == 0 and [e["text"] for e in out.of("output")] == ["[1, 2]\n"]


def test_step_over_a_raise_out_of_a_thread_target_lands_in_the_librarys_callback(run):
    config = {"breakOnException": "raised", "stopOnEntry": False}
    out = debug_run(run, THREAD_RAISE, batches=[[step("over")], [CONTINUE], [CONTINUE]], config=config)
    ps = pauses(out)
    assert [(p["line"], p["reason"], p.get("kind")) for p in ps][:2] == [(6, "exception", None), (9, "step", "over")], "the step follows the raise into `threading`'s handler"
    assert ps[0]["thread"]["name"] == "W" and ps[1]["thread"]["name"] == "W"
    assert [s["name"] for s in ps[1]["stack"]][0] == "seen"
    assert ps[1]["stack"][0]["line"] == ps[1]["line"] == 9, "frame 0 of an entry pause reports the `def` line the pause reports"
    assert out.result.exit_code == 0
    assert "".join(e["text"] for e in out.of("output")) == "seen ValueError\nend\n"


def test_step_out_of_a_thread_target_does_not_wait_for_a_scope_that_never_runs(run, tmp_path):
    """Without the degrade this run ends with no second pause at all: the client waits forever."""
    path = str(tmp_path / "scratch.py")
    out = debug_run(run, THREAD_RAISE, batches=[[step("out")], [CONTINUE], [CONTINUE]], breakpoints=[{"path": path, "line": 6}], config={"breakOnException": "off"})
    ps = pauses(out)
    assert [(p["line"], p["reason"], p.get("kind")) for p in ps] == [(6, "breakpoint", None), (9, "step", "out")], "`out` degrades the same way `over` does"
    assert out.result.exit_code == 0


def test_step_over_inside_an_instrumented_caller_still_stops_in_that_caller(run, tmp_path):
    """The degrade only applies when there is no instrumented function frame to hand the step to."""
    path = str(tmp_path / "scratch.py")
    source = "\n".join(["", "def inner(n):", "    a = n + 1", "    return a", "", "", "def outer(n):", "    b = inner(n) + inner(n + 1)", "    return b", "", "", "print(outer(1))", ""])
    out = debug_run(run, source, batches=[[step("over")], [CONTINUE]], breakpoints=[{"path": path, "line": 4, "condition": "n == 1"}])
    ps = pauses(out)
    assert [(p["line"], p["reason"], p.get("kind")) for p in ps] == [(4, "breakpoint", None), (9, "step", "over")], "the step waits for `outer`, not for the second `inner`"
    assert ps[1]["scopeId"] == ps[0]["stack"][1]["scopeId"], "the step landed in the caller it was handed to"
    assert out.result.exit_code == 0 and [e["text"] for e in out.of("output")] == ["5\n"]
