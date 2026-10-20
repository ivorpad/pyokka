"""A stop pauses on what the change decides, and a debugger answer at a stop nobody explained says so.

``stop_place.stop_line`` moves a stop off a changed function's first assignment onto the branch, return, raise or
call the change makes, only where the program reaches it as surely. ``reminder.reminder`` is the ``review:`` and
``next:`` lines a live move gains at an unexplained stop of the current review (a Codex review on 2026-10-20 stepped
past every stop and explained none); outside a review it answers None.
"""

import json
import os
import textwrap
from types import SimpleNamespace

import pytest

from pyokka_runtime.agent.review.debugger import breakable_line
from pyokka_runtime.agent.review.reminder import reminder
from pyokka_runtime.agent.review.stop_place import stop_line

CASES = [
    ("a branch after an assignment", """
        def total(items, limit):
            total = 0
            for i in items:
                total += i
            if total > limit:
                raise ValueError(total)
            return total
        """, [(3, 8)], 6),
    ("assignments only", """
        def f(a):
            x = a
            y = x + 1
            return y
        """, [(3, 4)], 3),
    ("a return inside a branch the change does not hold", """
        def g(x):
            y = x * 2
            if x:
                return y > 3
            return 0
        """, [(3, 3), (5, 5)], 3),
    ("a return in an except that may not run", """
        def h(text):
            value = 0
            try:
                value = int(text)
            except ValueError:
                return None
            return value
        """, [(3, 7)], 3),
    ("a call into other code over an assignment", """
        def k(path):
            name = path
            data = load(name)
            rows = len(data)
            return rows
        """, [(3, 5)], 4),
]


@pytest.mark.parametrize("name,source,spans,expected", CASES, ids=[c[0] for c in CASES])
def test_the_stop_goes_on_what_the_change_decides(name, source, spans, expected):
    src = textwrap.dedent(source)
    first, _ = breakable_line(src, *spans[0])
    assert stop_line(src, spans, first) == expected


def _review(tmp_path, monkeypatch, *, shown=(), mode="debugger"):
    """A current review in the debugger with two stops in cart.py, its session descriptor, and the source of a live move on it."""
    home = tmp_path / "home"
    monkeypatch.setenv("PYOKKA_HOME", str(home))
    descriptor = tmp_path / "session.json"
    descriptor.write_text(json.dumps({"socket": str(tmp_path / "s.sock"), "token": "t", "file": str(tmp_path / "repo" / "main.py"), "pid": os.getpid()}))
    directory = home / "reviews" / "repo-abc1234"
    directory.mkdir(parents=True, exist_ok=True)
    stops = [{"n": 1, "kind": "change", "file": "cart.py", "line": 6, "function": "total", "spans": [[3, 8]]},
             {"n": 2, "kind": "change", "file": "cart.py", "line": 20, "function": "refund", "spans": [[18, 21]]}]
    (directory / "review.json").write_text(json.dumps({"mode": mode, "repo": str(tmp_path / "repo"), "entry": "main.py", "plan": {"stops": stops},
                                                       "shown": list(shown), "waiting": shown[-1] if shown else None, "view": {"descriptor": str(descriptor)}}))
    (home / "reviews" / "current").write_text(str(directory) + "\n")
    return SimpleNamespace(descriptor={"socket": str(tmp_path / "s.sock")})


def _paused(tmp_path, line):
    return {"paused": {"file": str(tmp_path / "repo" / "cart.py"), "line": line, "reason": "breakpoint"}}


def test_a_pause_at_a_stop_nobody_explained_says_so(tmp_path, monkeypatch):
    source = _review(tmp_path, monkeypatch)
    nudge = reminder("continue", _paused(tmp_path, 6), source)
    assert nudge["stop"] == 1 and nudge["of"] == 2 and nudge["line"] == 6
    assert nudge["lines"][0].startswith("review: this is stop 1 of 2, `total` at cart.py:6, and nobody has explained it yet.")
    assert nudge["lines"][-1] == ('next: pyokka review stop 1 --say TEXT (MCP pyokka_review {"action": "stop", "n": 1, "say": TEXT}), '
                                  'or pyokka review skip 1 --why TEXT (MCP pyokka_review {"action": "skip", "n": 1, "why": TEXT})')
    # after stop 1 the next one needs the person's next, and the reminder says so
    source = _review(tmp_path, monkeypatch, shown=(1,))
    nudge = reminder("step", _paused(tmp_path, 20), source)
    assert nudge["stop"] == 2 and "Pass --go-on (go_on: true) only if the person said next since stop 1." in nudge["lines"]
    assert nudge["next"].startswith('pyokka review stop 2 --say TEXT --go-on (MCP pyokka_review {"action": "stop", "n": 2, "say": TEXT, "go_on": true})')


def test_outside_an_unexplained_stop_of_the_current_review_nothing_is_added(tmp_path, monkeypatch):
    source = _review(tmp_path, monkeypatch, shown=(1,))
    assert reminder("continue", _paused(tmp_path, 6), source) is None  # explained already
    assert reminder("continue", _paused(tmp_path, 12), source) is None  # a pause at no stop: a step the person asked for
    assert reminder("locals", _paused(tmp_path, 20), source) is None  # not a move
    assert reminder("continue", _paused(tmp_path, 20), SimpleNamespace(descriptor={"socket": "/elsewhere.sock"})) is None  # another session
    assert reminder("continue", {"finished": {"exitCode": 0}}, source) is None
    source = _review(tmp_path, monkeypatch, mode="recording")
    assert reminder("continue", _paused(tmp_path, 6), source) is None  # the recorded review moves its own view
    monkeypatch.setenv("PYOKKA_HOME", str(tmp_path / "nobody"))
    assert reminder("continue", _paused(tmp_path, 6), source) is None  # no review at all
