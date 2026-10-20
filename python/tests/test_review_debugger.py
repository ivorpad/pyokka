"""The review when the debugger runs the program, over the shop fixture: the agenda from the diff, the entry
started under a faked debugger, pauses recorded with ``stop --say``.

``start`` without ``--full`` plans from ``git diff`` alone and opens the debugger through
``debug_start.open_debug_session``, faked here with ``FakeLive``: a session whose pause the test sets
(``state`` answers it), with ``locals``, ``breakpoints`` and ``context``. The review never continues
the program itself; the test moves the fake's pause the way ``pyokka_debug continue`` would. Nothing
here needs VS Code; the state machine, the refusals and the file layout are what these tests pin.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from pyokka_runtime.agent.review import actions, debugger
from pyokka_runtime.agent.review.debugger import CONTINUE, breakable_line, plan_items, spans_of
from pyokka_runtime.agent.review.render import text as render_text
from pyokka_runtime.agent.review.state import Refusal, Review
from pyokka_runtime.agent.source import AgentError
from tests.test_review_actions import git, install_fakes, make_repo


class FakeLive:
    """A debug session on ``main.py``: ``state`` answers the pause the test set (or that the program finished)."""

    def __init__(self, repo: Path) -> None:
        self.main = str(repo / "main.py")
        self.descriptor = {"descriptor": str(repo.parent / "fake-session.json"), "file": self.main, "socket": "fake", "token": "t", "pid": os.getpid(), "kind": "debug"}
        self.kind = "debug"
        self.paused: dict | None = {"file": self.main, "line": 1, "reason": "start"}
        self.finished: dict | None = None
        self.gone = False
        self.added: list[dict] = []
        self.removed: list[dict] = []
        self.locals_: dict[str, str] = {}
        self.contexts: dict[int, dict] = {}
        self.recording_doc: dict | None = None
        self.closed = 0

    def debug(self, launch=None, stop_on_entry=False):
        self.paused = {"file": self.main, "line": 1, "reason": "start"}
        self.finished = None
        return {"paused": dict(self.paused), "location": {"file": self.main, "line": 1, "function": "<module>"}}

    def breakpoints(self, add=None, remove=None, **_):
        self.added.extend(add or [])
        self.removed.extend(remove or [])
        return {"breakpoints": list(add or [])}

    def state(self):
        if self.gone:
            raise AgentError("the live session stopped answering", "the window may be gone")
        dbg = {"active": self.finished is None, "paused": dict(self.paused) if self.paused else None}
        out = {"debug": dbg, "nav": {"count": 0}}
        if self.finished is not None:
            out["finished"] = dict(self.finished)
        return out

    def locals(self, **_):
        return {"locals": [{"name": k, "text": v} for k, v in self.locals_.items()]}

    def context(self, step=None, file=None, line=None, scope=False):
        if step not in self.contexts:
            raise AgentError("no step %s" % step, "the recording has fewer steps")
        return self.contexts[step]

    def recording(self):
        if self.recording_doc is None:
            raise AgentError("the session has no recording", "a module launch records nothing")
        return self.recording_doc

    def close(self):
        self.closed += 1


@pytest.fixture
def world(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """The shop repository, the fakes, and the debugger routes pointed at a FakeLive."""
    from pyokka_runtime.agent import debug_start, live

    repo, base = make_repo(tmp_path)
    install_fakes(monkeypatch)
    monkeypatch.setenv("PYOKKA_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("PYOKKA_REVIEW_SURFACE", raising=False)  # chat or page in the environment would make every start a full review
    monkeypatch.setattr(live, "SESSIONS_ENV", "PYOKKA_TEST_NO_SESSIONS")
    monkeypatch.setenv("PYOKKA_TEST_NO_SESSIONS", str(tmp_path / "no-sessions"))
    fake = FakeLive(repo)
    launches: list[dict] = []

    def open_session(launch, at=None, **_):
        launches.append(launch)
        return fake, None, "uri"

    monkeypatch.setattr(debug_start, "open_debug_session", open_session)
    monkeypatch.setattr(debug_start, "code_command", lambda: "/usr/bin/true")
    monkeypatch.setattr(debug_start, "focus_editor", lambda *a, **k: True)
    monkeypatch.setattr(debugger, "list_sessions", lambda *a, **k: [])
    monkeypatch.setattr(debugger, "read_descriptor", lambda path: None if fake.gone else (dict(fake.descriptor) if path == fake.descriptor["descriptor"] else None))
    monkeypatch.setattr(debugger, "LiveRun", lambda descriptor: fake)
    return SimpleNamespace(repo=repo, base=base, fake=fake, launches=launches, dir=tmp_path / "review")


def run(action: str, **fields):
    return actions.run({"action": action, **fields})


def refusal(action: str, **fields) -> Refusal:
    with pytest.raises(Refusal) as info:
        actions.run({"action": action, **fields})
    exc = info.value
    lines = exc.text.split("\n")
    assert lines[0].startswith("review ") and lines[1].startswith("refused: ") and lines[-1].startswith("next: "), exc.text
    return exc


def start(world: SimpleNamespace, **fields) -> tuple[dict, Review]:
    answer = run("start", base=world.base, repo=str(world.repo), dir=str(world.dir), **fields)
    return answer, Review.load(str(world.dir))


def items_of(review: Review) -> list[dict]:
    return [s for s in review.stops if s.get("kind") == "change"]


def pause_at(world: SimpleNamespace, item: dict, locals_: dict[str, str], step: int | None = None) -> None:
    """What ``pyokka_debug continue`` leaves behind: the session paused at the item's breakpoint with these locals."""
    world.fake.paused = {"file": str(world.repo / item["file"]), "line": item["line"], "reason": "breakpoint", "function": item.get("function") or "<module>", **({"step": step} if step is not None else {})}
    world.fake.locals_ = dict(locals_)


# -- the plan ---------------------------------------------------------------------------------------------------------

def test_breakable_line_picks_the_first_statement_a_breakpoint_pauses_at():
    source = "import os\n\n\ndef f(a,\n      b=None):\n    \"\"\"doc\"\"\"\n    total = (a +\n             b)\n    return total\n\n\nclass C:\n    def m(self):\n        return 1\n"
    assert breakable_line(source, 1, 1) == (1, None)  # a plain statement: itself
    assert breakable_line(source, 4, 5) == (7, "f")  # a changed def header: the body's first statement, past the docstring
    assert breakable_line(source, 8, 8) == (7, "f")  # a change inside a multi-line statement: that statement
    assert breakable_line(source, 12, 12) == (14, "m")  # a class header: down to the first method's body
    assert spans_of({3, 4, 5, 9, 11, 12}) == [(3, 5), (9, 9), (11, 12)]


def test_plan_items_are_the_changed_functions_with_a_breakpoint_each(world):
    diff_text = git(world.repo, "diff", world.base, "--no-ext-diff", "--no-color")
    plan = plan_items(str(world.repo), diff_text)
    items = plan["stops"]
    assert items and [it["n"] for it in items] == list(range(1, len(items) + 1))
    assert all(it["kind"] == "change" and it["spans"] for it in items)
    assert all(it["fact"]["text"].startswith("changed line") for it in items)
    assert {"shopkit/pricing.py", "shopkit/discounts.py"} <= {it["file"] for it in items}
    assert len({(it["file"], it["function"]) for it in items if it["function"]}) == len([it for it in items if it["function"]])  # one item per changed function
    assert all(it["function"] and not it["test_file"] for it in items), "the agenda is the changed functions of the program's files"
    aside = plan["aside"]
    assert all((not a["function"] or a["test_file"]) and "n" not in a for a in aside), "module-level and test-file changes are set aside, unnumbered"
    assert {a["file"] for a in aside if a["test_file"]} <= {f for f in {a["file"] for a in aside} if f.startswith("tests/")}
    assert plan["edges"] and plan["unreached"] == []
    assert "one breakpoint each" in plan["summary"]["text"]


# -- start ------------------------------------------------------------------------------------------------------------

def test_start_plans_from_the_diff_and_starts_the_entry_under_the_debugger(world):
    answer, review = start(world)
    text = render_text(answer)
    assert text.startswith("review shop-%s · stops · stops 0/%d shown" % (world.base[:7], len(review.stops)))
    assert "view: VS Code debug session on main.py" in text and "paused on entry at main.py:1" in text and "recording is on" in text
    assert text.rstrip("\n").endswith("next: " + CONTINUE)
    assert review.data["mode"] == "debugger" and review.data["ended"] is None
    assert not (world.dir / "base").exists() and not (world.dir / "head.json").exists()  # nothing of base is run or materialised
    launch = world.launches[0]
    assert launch["stopOnEntry"] is True and launch["record"] is True and launch["program"] == str(world.repo / "main.py")
    assert len(world.fake.added) == len(review.stops) and all(os.path.isabs(bp["file"]) for bp in world.fake.added)
    assert review.data["view"]["kind"] == "vscode-debug" and review.data["view"]["descriptor"] == world.fake.descriptor["descriptor"]
    assert "(pending)" in text


def test_start_without_vscode_refuses_and_names_full(world, monkeypatch):
    from pyokka_runtime.agent import debug_start

    def missing():
        raise AgentError("no code command")

    monkeypatch.setattr(debug_start, "code_command", missing)
    exc = refusal("start", base=world.base, repo=str(world.repo), dir=str(world.dir))
    assert "a review in the debugger needs VS Code" in exc.why and "--full" in exc.text
    assert exc.next_command == "review start --base REF --full"
    assert not (world.dir / "review.json").exists()


def test_surface_chat_runs_the_full_review_instead(world):
    answer, review = start(world, surface="chat")
    assert review.data["mode"] == "recording" and (world.dir / "head.json").exists() and (world.dir / "base.json").exists()
    assert "view: chat." in render_text(answer) and not world.launches


def test_live_review_takes_an_external_or_new_launcher_and_full_refuses_both(world, tmp_path):
    """The debugger runs only the working tree, so a launcher outside the repository or one base lacks is its entry;
    --full runs both trees and still refuses them. The repository stays the cwd, and an edit to the launcher changes tree_hash."""
    from pyokka_runtime.agent.review.state import tree_hash

    outside = tmp_path / "launch" / "run_shop.py"
    outside.parent.mkdir()
    outside.write_text("import main\n")
    added = world.repo / "launcher.py"
    added.write_text("import main\n")
    assert "outside the repository" in refusal("start", base=world.base, repo=str(world.repo), dir=str(world.dir), entry=str(outside), full=True).why
    assert "does not exist at" in refusal("start", base=world.base, repo=str(world.repo), dir=str(world.dir), entry="launcher.py", full=True).why

    _, review = start(world, entry=str(outside))
    assert review.data["mode"] == "debugger" and review.data["entry"] == os.path.realpath(outside)
    launch = world.launches[-1]
    assert launch["program"] == os.path.realpath(outside) and launch["cwd"] == str(world.repo)
    pinned = review.data["tree_hash"]
    assert pinned == tree_hash(str(world.repo), review.data["entry"])
    outside.write_text("import main  # edited\n")
    assert tree_hash(str(world.repo), review.data["entry"]) != pinned

    _, review = start(world, entry="launcher.py")
    assert review.data["mode"] == "debugger" and review.data["entry"] == "launcher.py"
    assert world.launches[-1]["program"] == str(world.repo / "launcher.py")


# -- stop records the pause the debugger is at --------------------------------------------------------------------------

def test_stop_records_the_pause_and_its_say_must_name_a_value_of_the_frame(world):
    _, review = start(world)
    first = items_of(review)[0]
    # the review does not run the program: a stop without --say says so, and a pause on entry is not an item
    exc = refusal("stop", dir=str(world.dir))
    assert "stop records the pause the debugger is at" in exc.why and exc.next_command == CONTINUE
    exc = refusal("stop", dir=str(world.dir), say="the module starts")
    assert "paused on entry (main.py:1), not at an item" in exc.why and exc.next_command == CONTINUE and Review.load(str(world.dir)).stops[-1]["kind"] == "change"
    pause_at(world, first, {"total": "0.0", "price": "'1,249.00'"}, step=197)
    exc = refusal("stop", dir=str(world.dir), n=1, say="the subtotal looks wrong here")
    assert "names none of the values in the frame" in exc.why and "total = 0.0" in exc.text and "or the step number: 197" in exc.text
    exc = refusal("stop", dir=str(world.dir), n=2, say="total is 0.0")
    assert "the debugger is paused at item 1" in exc.why and exc.next_command == "review stop 1 --say TEXT"
    answer = run("stop", dir=str(world.dir), say="total is 0.0 after the first order, the string price was skipped")
    text = render_text(answer)
    assert "stop 1/%d  change  %s:%d" % (len(review.stops), first["file"], first["line"]) in text
    assert "paused at %s:%d (breakpoint)  step #197" % (os.path.basename(first["file"]), first["line"]) in text
    assert "locals:" in text and "total = 0.0" in text and "price = '1,249.00'" in text and "say: total is 0.0" in text
    assert text.rstrip("\n").endswith("next: wait for the person; when they say next, %s --go-on" % CONTINUE)
    review = Review.load(str(world.dir))
    assert review.shown == [1] and review.waiting == 1
    assert review.conversation[-1]["kind"] == "stop" and review.conversation[-1]["values"] == [["total", "0.0"], ["price", "'1,249.00'"]] and review.conversation[-1]["step"] == 197
    # the person has the floor: the next record needs --go-on; the program running means nothing to record
    second = items_of(review)[1]
    pause_at(world, second, {"unit_price": "'1,249.00'"})
    exc = refusal("stop", dir=str(world.dir), say="unit_price is '1,249.00'")
    assert "has not spoken since stop 1" in exc.why and exc.next_command.endswith("%s --go-on" % CONTINUE)
    world.fake.paused = None
    exc = refusal("stop", dir=str(world.dir), say="unit_price is '1,249.00'", go_on=True)
    assert "running, not paused" in exc.why
    pause_at(world, second, {"unit_price": "'1,249.00'"})
    run("stop", dir=str(world.dir), say="unit_price is the text '1,249.00' here", go_on=True)
    assert Review.load(str(world.dir)).shown == [1, 2]
    # an uncaught exception is a pause outside every item: an item of its own
    odd = next((f for f in ("shopkit/__init__.py", "main.py", "shopkit/nothing.py") if f not in {it["file"] for it in review.stops}), "shopkit/nothing.py")
    world.fake.paused = {"file": str(world.repo / odd), "line": 9, "reason": "exception", "function": "load"}
    world.fake.locals_ = {"text": "'$1,249.00'"}
    answer = run("stop", dir=str(world.dir), say="text is '$1,249.00' with the comma still in", go_on=True)
    review = Review.load(str(world.dir))
    assert review.stops[-1]["kind"] == "pause" and review.stops[-1]["file"] == odd and review.stops[-1]["n"] == len(review.stops)
    assert "stop %d/%d  pause  %s:9" % (len(review.stops), len(review.stops), odd) in render_text(answer)


def test_the_program_ending_turns_the_items_never_paused_at_into_unreached_lines(world):
    _, review = start(world)
    first = items_of(review)[0]
    pause_at(world, first, {"total": "0.0"})
    run("stop", dir=str(world.dir), say="total is 0.0")
    world.fake.paused = None
    world.fake.finished = {"exitCode": 0}
    exc = refusal("stop", dir=str(world.dir), say="anything", go_on=True)
    assert "the program ended (exit 0)" in exc.why and "review view vscode" in exc.text
    review = Review.load(str(world.dir))
    assert review.data["ended"]["exit"] == 0 and review.phase == "findings"
    assert review.plan["unreached"] and all("never paused" in u["text"] for u in review.plan["unreached"])
    text = render_text(run("state", dir=str(world.dir)))
    assert "(never paused at)" in text and "the program ended (exit 0)" in text


# -- skip, ask and look ----------------------------------------------------------------------------------------------

def test_skip_removes_the_breakpoint_and_ask_and_look_are_the_debuggers(world):
    _, review = start(world)
    first = items_of(review)[0]
    answer = run("skip", dir=str(world.dir), n=1, why="a rename, nothing to see")
    assert "its breakpoint is removed" in render_text(answer) and world.fake.removed == [{"file": str(world.repo / first["file"]), "line": first["line"]}]
    assert Review.load(str(world.dir)).remaining()[0] == 2
    exc = refusal("ask", dir=str(world.dir), line="shopkit/money.py:9", say="whatever")
    assert "ask is the debugger's job" in exc.why and "pyokka break --live FILE:LINE" in exc.text and exc.next_command == "review stop --say TEXT"
    exc = refusal("look", dir=str(world.dir), expr="total * 2")
    assert "look is the debugger's job" in exc.why and "pyokka eval --live EXPR" in exc.text


# -- finding, report ----------------------------------------------------------------------------------------------------

def test_finding_takes_a_recorded_pause_near_the_line_and_the_report_names_the_pauses(world):
    _, review = start(world)
    first = items_of(review)[0]
    pause_at(world, first, {"total": "0.0"}, step=10)
    run("stop", dir=str(world.dir), say="total is 0.0 and the string price was skipped")
    t = run("try", dir=str(world.dir), expr="1 + 1")["try"]
    exc = refusal("finding", dir=str(world.dir), file="shopkit/report.py", line=44, severity="major", title="x", repro=t["id"], fix="y")
    assert "no pause was recorded within 3 lines of shopkit/report.py:44" in exc.why
    answer = run("finding", dir=str(world.dir), file=first["file"], line=first["line"] + 1, severity="major", title="string prices are skipped", repro=t["id"], fix="parse the price first")
    text = render_text(answer)
    assert "f1 major  %s:%d" % (first["file"], first["line"] + 1) in text and "step #10" in text
    fd = Review.load(str(world.dir)).findings[0]
    assert fd["pause"]["line"] == first["line"] and fd["step"] == 10 and fd["values"] == [{"name": "total", "text": "0.0"}]
    # --step of the recording as the place
    world.fake.contexts[42] = {"step": 42, "location": {"file": str(world.repo / first["file"]), "line": first["line"] + 2, "function": first["function"]}, "values": [{"context": "total", "text": "3.5"}]}
    answer = run("finding", dir=str(world.dir), file=first["file"], line=first["line"], severity="minor", title="by step", step=42, repro=t["id"], fix="z")
    assert "step #42" in render_text(answer)
    # the run ends; a line never paused at takes a try, as an unreached line does in a full review
    world.fake.paused = None
    world.fake.finished = {"exitCode": 0}
    review = Review.load(str(world.dir))
    never_item = next(it for it in items_of(review) if it["n"] not in (1,))
    answer = run("finding", dir=str(world.dir), file=never_item["file"], line=never_item["spans"][0][0], severity="minor", title="never paused", repro=t["id"], fix="z")
    assert "never ran in head; reproduced by %s" % t["id"] in render_text(answer)
    answer = run("report", dir=str(world.dir))
    md = answer["markdown"]
    assert "Evidence: the pauses of the debug session in VS Code (main.py under the debugger with its recording on)" in md
    assert "- stop 1 (change %s:%d" % (first["file"], first["line"]) in md and "## Findings" in md
    exc = refusal("report", dir=str(world.dir), page=True)
    assert "--page and --tour need a head recording" in exc.why


def test_view_vscode_starts_the_entry_again_and_page_is_refused(world):
    _, review = start(world)
    world.fake.paused = None
    world.fake.finished = {"exitCode": 0}
    refusal("stop", dir=str(world.dir), say="x")  # marks the run ended
    assert Review.load(str(world.dir)).data["ended"]["exit"] == 0
    exc = refusal("view", dir=str(world.dir), surface="page")
    assert "runs in the person's VS Code" in exc.why and exc.next_command.endswith("--full --surface page")
    answer = run("view", dir=str(world.dir), surface="vscode")
    assert len(world.launches) == 2 and render_text(answer).rstrip("\n").endswith("next: " + CONTINUE)
    review = Review.load(str(world.dir))
    assert review.data["ended"] is None and review.plan["unreached"] == [] and review.data["waiting"] is None
    assert len(world.fake.added) == 2 * len(review.stops)  # every remaining item got its breakpoint again


def test_a_session_that_is_gone_is_refused_with_view_vscode(world):
    _, review = start(world)
    world.fake.gone = True
    exc = refusal("stop", dir=str(world.dir), say="x")
    assert "debug session of this review is gone" in exc.why and exc.next_command == "review view vscode"


def test_a_test_runs_through_its_runner_without_a_recording_and_a_finding_sits_at_the_pause(world):
    answer, review = start(world, test="tests/test_pricing.py::test_subtotal")
    launch = world.launches[0]
    assert launch["module"] == "pytest" and launch["record"] is False and "program" not in launch and launch["args"][0].endswith("tests/test_pricing.py::test_subtotal")
    assert review.data["test"] == "tests/test_pricing.py::test_subtotal" and review.data["view"]["record"] is False and "recording is off" in render_text(answer)
    first = items_of(review)[0]
    pause_at(world, first, {"qty": "3"})  # no step: nothing is recorded
    run("stop", dir=str(world.dir), say="qty is 3 here")
    assert Review.load(str(world.dir)).conversation[-1]["step"] is None
    t = run("try", dir=str(world.dir), expr="3 * 2")["try"]
    exc = refusal("finding", dir=str(world.dir), file=first["file"], line=first["line"], severity="minor", title="x", step=5, repro=t["id"], fix="y")
    assert "--step needs the debugger's recording" in exc.why
    answer = run("finding", dir=str(world.dir), file=first["file"], line=first["line"], severity="minor", title="at the pause", repro=t["id"], fix="y")
    assert "at the pause on %s:%d" % (first["file"], first["line"]) in render_text(answer)


def test_json_state_carries_the_mode_and_the_agenda(world):
    _, review = start(world)
    state = json.loads((world.dir / "review.json").read_text())
    assert state["mode"] == "debugger" and state["ended"] is None and state["plan"]["stops"][0]["spans"] and "current" not in state and "passed" not in state
    text = render_text(run("state", dir=str(world.dir)))
    assert "stops (%d):" % len(review.stops) in text and "(pending)" in text and text.rstrip("\n").endswith("next: " + CONTINUE)


def test_start_goes_on_when_the_reviews_home_is_not_writable(world, monkeypatch, tmp_path):
    """A sandbox that lets the agent write its workspace and /tmp only (Codex, 2026-10-19): the current-review pointer
    cannot be written, the review still starts, and the answer says to pass --dir."""
    from pyokka_runtime.agent.review import state

    blocker = tmp_path / "blocker"
    blocker.write_text("not a directory", encoding="utf-8")
    monkeypatch.setattr(state, "reviews_home", lambda: str(blocker / "reviews"))
    answer, review = start(world)
    assert review.data["mode"] == "debugger" and world.launches, "the debugger session opened all the same"
    text = render_text(answer)
    assert "is not writable" in text and "pass --dir %s" % world.dir in text
    assert state.current_dir() is None
