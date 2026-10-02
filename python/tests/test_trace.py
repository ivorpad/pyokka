"""The Python trace model against the fixture generated from the TypeScript one."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pyokka_runtime.trace import Trace

FIXTURE = Path(__file__).resolve().parents[2] / "test" / "unit" / "fixtures" / "trace-moves.json"
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))


def _resolve(rid: int):
    # the fixture's convention: every rid is a one-line statement on line `rid` of file 1
    return (1, [rid, 0, rid, 10])


@pytest.mark.parametrize("name", sorted(CASES))
def test_moves_match_the_typescript_model(name):
    case = CASES[name]
    trace = Trace(case["quads"], case["scopes"], _resolve)
    assert trace.count == case["count"]
    for m in case["moves"]:
        i = m["step"]
        got = {
            "step": i,
            "into": trace.step_into(i),
            "back": trace.step_back_into(i),
            "over": trace.step_over(i),
            "backOver": trace.step_back_over(i),
            "out": trace.step_out(i),
            "backOut": trace.step_back_out(i),
            "canStep": trace.can_step(i),
            "echo": trace.echo_steps(i),
            "stack": [{"step": f.step, "scopeId": f.scope_id} for f in trace.call_stack(i)],
        }
        assert got == m, "step %d of %s" % (i, name)
        assert trace.moves(i) == {k: (m[k] if m[k] >= 0 else None) for k in ("into", "over", "out", "back", "backOver", "backOut")}
    for s in case["startStep"]:
        assert trace.start_step(s["fileId"], s["line"]) == s["step"], "startStep %s line %d" % (name, s["line"])


def test_blocks_are_one_per_frame_for_recursion():
    case = CASES["recursion"]
    trace = Trace(case["quads"], case["scopes"], _resolve)
    assert trace.blocks() == [(0, 0, 0), (1, 1, 2), (2, 3, 4), (3, 5, 5), (0, 6, 6)]
    assert trace.block_at(4) == (2, 3, 4)
    assert trace.block_at(99) is None
    assert trace.steps_on_line(1, 2) == [1, 3, 5]


def test_blocks_split_a_loop_into_one_block_per_turn():
    # 1 for p in ps: / 2 print(p) / 3 done -- the header line runs again every turn
    quads = [[1, 0, 0, 0], [2, 0, 0, 0], [1, 0, 0, 0], [2, 0, 0, 0], [1, 0, 0, 0], [3, 0, 0, 0]]
    scopes = [{"scopeId": 0, "rid": 0, "name": "<module>", "parent": -1, "depth": 0, "first": 0, "last": 5}]
    trace = Trace.from_quads(quads, scopes, _resolve)
    assert trace.blocks() == [(0, 0, 1), (0, 2, 3), (0, 4, 5)]
    assert trace.block_at(3) == (0, 2, 3)


def test_blocks_keep_steps_that_share_a_line_together():
    # a comprehension ticking on line 5, then line 6, then line 5 again: only the return splits
    quads = [[5, 0, 0, 0], [5, 0, 0, 0], [5, 0, 0, 0], [6, 0, 0, 0], [5, 0, 0, 0]]
    scopes = [{"scopeId": 0, "rid": 0, "name": "<module>", "parent": -1, "depth": 0, "first": 0, "last": 4}]
    trace = Trace.from_quads(quads, scopes, _resolve)
    assert trace.blocks() == [(0, 0, 3), (0, 4, 4)]


def test_blocks_ignore_steps_in_another_file():
    # rid 9 is in file 2: it neither ends file 1's block nor counts as a line coming back
    def resolve(rid: int):
        return (2, [1, 0, 1, 5]) if rid == 9 else _resolve(rid)

    quads = [[1, 0, 0, 0], [9, 0, 0, 0], [2, 0, 0, 0]]
    scopes = [{"scopeId": 0, "rid": 0, "name": "<module>", "parent": -1, "depth": 0, "first": 0, "last": 2}]
    assert Trace.from_quads(quads, scopes, resolve).blocks() == [(0, 0, 2)]


def test_empty_trace_has_no_moves():
    trace = Trace([], [], _resolve)
    assert trace.count == 0 and trace.blocks() == [] and trace.call_stack(0) == []
    assert trace.moves(0) == {"into": None, "over": None, "out": None, "back": None, "backOver": None, "backOut": None}
