"""Where `config.exact` gets its events: `sys.monitoring` (tool id 4 or 5), or `sys.settrace` when both are taken.

The recording is the same either way. A program that calls `sys.settrace` or `sys.setprofile` itself keeps its
exact changes: on 3.14 such a call stops the instruction events of code armed before it until they are set again
(`ExactTracer._rearm`). The settrace path, used only when both ids are taken, still loses them: there
`sys.settrace(None)` ends the tracing outright.
"""

from __future__ import annotations

import re
import sys

import pytest

from tests.conftest import run_source

MUTATE = """
import sys
{call}
prices = {{"a": 1}}


def bump(d, log):
    d["a"] = 10
    log.append(d["a"])
    return log


log = bump(prices, [])
prices["b"] = 2
sys.settrace(None)
sys.setprofile(None)
"""


def exact_changes(run) -> list[tuple[str, str]]:
    """The exact changes as (name, text), addresses masked: a function's text names where this run allocated it."""
    return [(c["name"], re.sub(r"0x[0-9a-f]+", "0x0", c["text"])) for ev in run.of("locals") for e in ev["entries"] for c in e["changes"] if c.get("exact")]


def squat(ids: tuple[int, ...]) -> None:
    for t in ids:
        sys.monitoring.use_tool_id(t, "test squatter")


def free(ids: tuple[int, ...]) -> None:
    for t in ids:
        sys.monitoring.free_tool_id(t)


@pytest.mark.parametrize("call", ["", 'sys.settrace(eval("lambda f, e, a: None"))', 'sys.setprofile(eval("lambda f, e, a: None"))', "sys.settrace(None)"])
def test_a_program_that_sets_a_trace_function_keeps_its_exact_changes(tmp_path, call):
    changes = exact_changes(run_source(MUTATE.format(call=call), tmp_path, config={"recordLocals": True, "exact": True}))
    assert ("prices", "{'a': 10}") in changes  # bump's `d["a"] = 10`, reaching the module global
    assert ("prices", "{'a': 10, 'b': 2}") in changes  # the module frame, armed before the call


def test_the_settrace_path_records_what_monitoring_records(tmp_path):
    source = MUTATE.format(call="")
    monitored = exact_changes(run_source(source, tmp_path, config={"recordLocals": True, "exact": True}))
    squat((4, 5))
    try:
        traced = exact_changes(run_source(source, tmp_path, config={"recordLocals": True, "exact": True}))
    finally:
        free((4, 5))
    assert monitored and traced == monitored
