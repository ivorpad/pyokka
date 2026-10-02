"""``{function: NAME}`` breakpoints: what ``--at rrf`` resolves to, and when.

The runtime resolves the name, not the host, so a module imported later gets its breakpoint when
it loads. The cases here are the four the resolution rule has: every entry pauses, a module that
arrives mid-run, a name two files define, and a name given as ``Class.method``.
"""

from __future__ import annotations

from tests.test_debug import CONTINUE, Scripted, attach, pauses, results
from tests.test_debug_record_off import debug_run

BUMPS = """
def bump(n):
    return n + 1


total = 0
for i in range(4):
    total = bump(total)
print(total)
"""

LATER_FILES = {
    "ranker.py": """
    def rank(rows):
        return sorted(rows)
    """
}
LATER_MAIN = """
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ranker

print(ranker.rank([3, 1]))
"""

TWICE_FILES = {
    "lib/rank.py": """
    def rank(rows):
        return list(reversed(rows))
    """
}
TWICE_MAIN = """
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib.rank import rank as other


def rank(rows):
    return sorted(rows)


print(rank([3, 1]), other([3, 1]))
"""

METHOD = """
class Ranker:
    def rank(self, rows):
        return sorted(rows)


class Other:
    def keep(self, rows):
        return rows


print(Ranker().rank([3, 1]))
"""


def echo(out, index: int = 0) -> dict:
    """The breakpoint echo of the ``index``-th ``debug.result`` that carries one."""
    return [e for e in results(out, "debug.result") if "breakpoints" in e][index]["breakpoints"][0]


def test_function_breakpoint_pauses_at_every_entry(run, tmp_path):
    out = debug_run(run, BUMPS, batches=[[CONTINUE]] * 4, breakpoints=[{"function": "bump"}])
    ps = pauses(out)
    assert [(p["reason"], p["line"]) for p in ps] == [("breakpoint", 2)] * 4, "one stop per call, on the `def` line"
    assert ps[0]["breakpoint"]["function"] == "bump" and ps[0]["breakpoint"]["resolvedLine"] == 2
    assert ps[0]["breakpoint"]["fileId"] == 1 and ps[0]["breakpoint"]["path"] == str(tmp_path / "scratch.py")
    assert "error" not in ps[0]["breakpoint"]
    assert [(s["name"], s["line"]) for s in ps[0]["stack"]] == [("bump", 2), ("<module>", 8)], "inside the call, frame 0 on the `def` line the pause reports, the caller on its call"
    assert "".join(e["text"] for e in out.of("output")) == "4\n"


def test_function_breakpoint_resolves_in_a_module_imported_later(run, tmp_path):
    ask = {"type": "debug", "id": "set", "action": "breakpoints", "set": [{"function": "rank"}]}
    out = run(
        LATER_MAIN,
        config={"debug": True, "record": False, "stopOnEntry": True},
        on_tracer=attach(Scripted([ask, CONTINUE], [CONTINUE])),
        files=LATER_FILES,
    )
    assert echo(out) == {"path": "", "line": 0, "function": "rank"}, "nothing to resolve against yet: the module is not imported"
    (p,) = [x for x in pauses(out) if x["reason"] == "breakpoint"]
    assert p["line"] == 2 and p["breakpoint"]["path"] == str(tmp_path / "ranker.py")
    assert p["breakpoint"]["resolvedLine"] == 2 and p["fileId"] == 2
    assert [s["name"] for s in p["stack"]] == ["rank", "<module>"], "called from the main file, not from the module body"
    assert "".join(e["text"] for e in out.of("output")) == "[1, 3]\n"


def test_function_breakpoint_reports_a_second_definition(run, tmp_path):
    # set from the first stop, when both files are already instrumented, so the echo can say so
    ask = {"type": "debug", "id": "set", "action": "breakpoints", "set": [{"function": "rank"}]}
    out = run(
        TWICE_MAIN,
        config={"debug": True, "record": False, "stopOnEntry": False},
        on_tracer=attach(Scripted([ask, CONTINUE], [CONTINUE]), breakpoints=[{"path": str(tmp_path / "scratch.py"), "line": 13}]),
        files=TWICE_FILES,
    )
    spec = echo(out)
    assert spec["error"] == "also defined in lib/rank.py:2; give FILE:LINE to pick one"
    assert (spec["path"], spec["resolvedLine"], spec["fileId"]) == (str(tmp_path / "scratch.py"), 9, 1), "the first definition keeps the breakpoint"
    stopped = [p for p in pauses(out) if p["reason"] == "breakpoint" and p["breakpoint"].get("function")]
    assert [(p["line"], p["stack"][0]["name"]) for p in stopped] == [(9, "rank")], "the other file's `rank` runs without pausing"
    assert "".join(e["text"] for e in out.of("output")) == "[1, 3] [1, 3]\n"


def test_function_breakpoint_matches_a_qualified_method(run, tmp_path):
    out = debug_run(run, METHOD, batches=[[CONTINUE]], breakpoints=[{"function": "Ranker.rank"}])
    (p,) = pauses(out)
    assert (p["reason"], p["line"]) == ("breakpoint", 3), "the `def` inside the class"
    assert p["breakpoint"]["function"] == "Ranker.rank" and p["breakpoint"]["resolvedLine"] == 3
    assert [s["name"] for s in p["stack"]] == ["rank", "<module>"]
    # the table holds bare names, so the class is not checked; a name it does not hold resolves to nothing
    missing = debug_run(run, METHOD, batches=[[CONTINUE]], breakpoints=[{"function": "Ranker.missing"}])
    assert pauses(missing) == [] and missing.result.exit_code == 0
