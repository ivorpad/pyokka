"""A generator or coroutine under `config.exact`: what it does between its resume and its next statement is kept.

A `yield` (or an `await`) closes the open statement and leaves it open again: what the frame does after the
resume, the rest of `got = yield total` or `v = await fetch(k)`, is that statement's, and a `for` loop's targets
bound after the `yield` that ended its body are the iteration step's. A statement that changed a name both
before and after its yield has two changes at its step, and the later one is what `var` lists.
"""

from __future__ import annotations

from pyokka_runtime.agent.history import History
from pyokka_runtime.agent.source import SavedRun

from test_walkthrough import saved_run

PROGRAM = '''
import asyncio


def gen(limit):
    for i in range(limit):
        yield i * i


def echo():
    total = 0
    while True:
        got = yield total
        total += got


async def fetch(n):
    await asyncio.sleep(0)
    return n + 1


async def run():
    for k in range(2):
        v = await fetch(k)


squares = list(gen(3))
e = echo()
next(e)
e.send(5)
e.send(7)
e.close()
asyncio.run(run())
'''


def texts(path, name: str) -> list[str]:
    """The recorded locals of ``name`` in order (the harness also logs values, which are other rows)."""
    return [str(r["text"]) for r in History(SavedRun(str(path))).rows(name) if r.get("source") == "locals"]


def test_a_resumed_frame_keeps_its_loop_targets_and_sent_values(tmp_path):
    (tmp_path / "exact").mkdir()
    (tmp_path / "snapshot").mkdir()
    exact = saved_run(tmp_path / "exact", PROGRAM, config={"exact": True})
    snapshot = saved_run(tmp_path / "snapshot", PROGRAM)
    assert texts(exact, "i") == ["0", "1", "2"]  # each iteration binds i after the yield that ended the last one
    assert texts(exact, "got") == ["5", "7"]
    assert texts(exact, "k") == ["0", "1"] and texts(exact, "v") == ["1", "2"]
    for name in ("i", "got", "total", "k"):
        assert texts(exact, name) == texts(snapshot, name), name
    assert texts(snapshot, "v") == ["1"]  # no statement of run() follows the last await: a snapshot never sees v = 2


def test_a_change_before_and_after_the_yield_lists_the_value_after(tmp_path):
    program = """
def worker(d):
    while True:
        d["got"] = yield d.pop("seed")
        d["seed"] = d["got"] * 10


state = {"seed": 1}
w = worker(state)
next(w)
w.send(5)
w.close()
"""
    rows = [(r["line"], r["text"]) for r in History(SavedRun(str(saved_run(tmp_path, program, config={"exact": True})))).rows("d") if r.get("source") == "locals"]
    assert rows == [(2, "{'seed': 1}"), (4, "{'got': 5}"), (5, "{'got': 5, 'seed': 50}"), (4, "{'got': 5}")]
