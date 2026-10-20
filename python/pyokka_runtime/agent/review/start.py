"""``review start``: resolve the base, then either the debugger (the default: the agenda from the diff, the entry under the
debugger in VS Code, ``debugger_actions.start_in_debugger``) or ``--full``: materialise the base tree, record both trees, compare them, plan.

The comparison calls the functions behind ``pyokka diff``, ``exceptions`` and ``coverage`` on the
two recordings (no subprocesses) and hands their JSON shapes to ``plan.build_plan`` (stream A2),
with the PR's diff text and its description. The base tree comes from ``git archive`` into
``DIR/base``, which leaves nothing in the repository (a worktree would register itself under
``.git/worktrees`` and collide on the next ``start``).
"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import tarfile
from importlib import import_module
from typing import Any

from ..coverage import coverage_report
from ..diff import Side, diff_sides
from ..source import AgentError, SavedRun
from .render import plan_lines
from .view import close_previous, code_found, open_view, start_hints, wanted
from .state import NO_REVIEW_HEADER, START, STATE_FILE, Refusal, Review, current_note, default_dir, git, inside, now, result, tree_hash

OURS = ("base", "fixed", "tries", STATE_FILE, "base.json", "head.json", "fixed.json", "report.md")
DIFF_LIMIT = 1_000_000
#: the source of a ``.venv`` found from the entry's directory up, in ``start``'s ``python:`` line
NEAREST_VENV = "the .venv nearest the entry; --python overrides"


def _refuse(why: str, details: list[str] | None = None, next_command: str = START) -> Refusal:
    return Refusal(NO_REVIEW_HEADER, why, next_command, details)


def _read(path: str) -> str:
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def start(f: dict) -> dict:
    repo = _repo(f.get("repo"))
    base_ref = str(f.get("base") or "").strip()
    if not base_ref:
        raise _refuse("start needs --base REF, the commit the change is reviewed against")
    base = _rev(repo, base_ref)
    head = git(repo, "rev-parse", "HEAD").strip()
    test = str(f.get("test") or "").strip() or None
    rel = _entry(repo, f.get("entry"), test, base)
    directory = _directory(f.get("dir"), repo, base)
    pr_text, pr_from = _pr_text(repo, f.get("pr"), base)
    argv = [str(x) for x in (f.get("args") or [])]
    interp = _interpreter(os.path.join(repo, rel), f.get("python"))
    if not f.get("full") and wanted(f) not in ("chat", "page"):
        # the debugger (the default): the agenda from the diff, the entry under the debugger in VS Code; the page and chat need the full recording
        from .debugger_actions import start_in_debugger

        return start_in_debugger(f, {"repo": repo, "base": base, "base_ref": base_ref, "head": head, "rel": rel, "test": test, "directory": directory, "argv": argv, "interp": interp, "pr_text": pr_text, "pr_from": pr_from})
    if f.get("only"):  # refused, not ignored: a recorded review plans its stops from the two runs and has no agenda to narrow
        raise _refuse("--only narrows the agenda of a review in the debugger; this start is the recorded review (--full, or surface page or chat), which plans its stops from the comparison of the two runs",
                      ["leave --only out here, or start without --full and without surface page or chat ($PYOKKA_REVIEW_SURFACE counts as one)"],
                      "review start --base REF --only PATH")
    close_previous(directory)
    _check_view(f, repo, rel)
    _prepare(directory)
    base_dir = os.path.join(directory, "base")
    _materialise(repo, base, base_dir)
    head_json, base_json = os.path.join(directory, "head.json"), os.path.join(directory, "base.json")
    test_name = test_of(test, rel)
    _record(os.path.join(repo, rel), head_json, repo, argv, interp, test_name, "head")
    _check_ran(head_json, "head", test, interp)
    _record(os.path.join(base_dir, rel), base_json, base_dir, argv, interp, test_name, "base")
    base_note = _check_ran(base_json, "base", test, interp)
    base_run, head_run = SavedRun(base_json), SavedRun(head_json)
    diff_json = diff_sides(Side("a", base_json, base_run), Side("b", head_json, head_run), limit=DIFF_LIMIT)
    exc_a, exc_b = base_run.exceptions(), head_run.exceptions()
    notes: list[str] = [base_note] if base_note else []
    try:
        cov_b = coverage_report(head_run)
    except AgentError as exc:
        cov_b = {"files": [], "total": {}}
        notes.append("note: no coverage of head: %s" % exc.message)
    diff_text = git(repo, "diff", base, "--no-ext-diff", "--no-color")
    build_plan = import_module(".plan", __package__).build_plan
    plan = build_plan(base_run, head_run, diff_json, exc_a, exc_b, cov_b, diff_text, pr_text, repo)
    stops, unreached, edges, anomalies, summary = _normalise(plan)
    data: dict[str, Any] = {
        "id": "%s-%s" % (os.path.basename(repo.rstrip(os.sep)) or "repo", base[:7]),
        "repo": repo,
        "base": base,
        "base_ref": base_ref,
        "head": head,
        "entry": rel,
        "test": test,
        "argv": argv,
        "python": interp.path,
        "dir": directory,
        "created": now(),
        "mode": "recording",
        "phase": "stops" if stops else "findings",
        "tree_hash": tree_hash(repo),
        "pr": pr_from,
        "plan": {"stops": stops, "unreached": unreached, "edges": edges, "anomalies": anomalies},
        "shown": [],
        "skipped": [],
        "waiting": None,
        "said": [],
        "asked": [],
        "conversation": [],
        "tries": [],
        "findings": [],
        "fix": None,
        "summary": summary if isinstance(summary, dict) else {"text": summary},
    }
    review = Review(directory, data)
    review.save()
    pointer_note = current_note(directory)
    view, view_lines = open_view(data, f)
    data["view"] = view
    review.save()
    paragraph = summary_paragraph(summary, diff_json, exc_a, exc_b)
    lines = ["%s: %s → %s, entry %s%s, review directory %s" % (os.path.basename(repo), base[:7], head[:7], rel, (" (test %s)" % test) if test else "", directory), interp.line(), paragraph, *notes, *pointer_note, *view_lines, *plan_lines(review)]
    return result(review, lines, plan=review.plan, summary=data["summary"], dir=directory)


# -- the pieces ------------------------------------------------------------------------------------------------------

def _check_vscode(repo: str, rel: str) -> None:
    """Surface vscode with no live Pyokka session and no ``code`` command is refused: nothing could open the recording."""
    from ..live import list_sessions

    if list_sessions():
        return
    try:
        from ..debug_start import code_command

        if code_command():
            return
    except Exception:  # noqa: BLE001  not found, or a debug_start without it
        pass
    vs, page = start_hints()
    raise _refuse("surface vscode needs VS Code: no live Pyokka session answers and the code command was not found (%s)" % code_found(),
                  ["VS Code needs the pyokka.agentAccess setting on and the code command: tell the person, and once they have them start with --surface vscode, or open it later with %s" % vs,
                   "or show the stops on the page: %s" % page],
                  "review start --base REF --surface page, or --surface chat")


def _check_view(f: dict, repo: str = "", rel: str = "") -> None:
    """What the asked view needs, checked before the two recordings: surface vscode a VS Code to reach (a live
    Pyokka session, or the ``code`` command to launch one), surface page a free port. A review of one test has
    no view to check: it stays in chat, and ``open_view`` says why."""
    if f.get("test"):
        return
    if str(f.get("surface") or "") == "vscode":
        _check_vscode(repo, rel)
        return
    if wanted(f) != "page":
        return
    from ..web import DEFAULT_PORT, listening

    port = int(f.get("port") or os.environ.get("PYOKKA_PORT") or DEFAULT_PORT)
    try:
        taken = listening(port)
    except AgentError:
        return  # a sandbox that blocks the probe: open_page reports what it finds
    if taken:
        raise _refuse("surface page needs a free port and %d is taken, most likely by another page" % port,
                      ["`pyokka web ctl --port %d state` (MCP: pyokka_page {\"action\": \"state\", \"port\": %d}) shows what it serves" % (port, port)],
                      "review start --base REF --surface page --port N with a free N, or --surface vscode")


def _repo(given: Any) -> str:
    repo = os.path.abspath(os.path.expanduser(str(given))) if given else os.getcwd()
    if not os.path.isdir(repo):
        raise _refuse("no directory %s" % repo)
    try:
        top = git(repo, "rev-parse", "--show-toplevel").strip()
    except AgentError as exc:
        raise _refuse("%s is not a git checkout (%s)" % (repo, exc.message), ["the review resolves --base in the repository under review"]) from None
    return top or repo


def _rev(repo: str, ref: str) -> str:
    out = git(repo, "rev-parse", "--verify", "--quiet", "%s^{commit}" % ref, check=False).strip()
    if not out:
        raise _refuse("cannot resolve %r in %s" % (ref, repo), ["a branch, a tag or a commit the repository knows; `git log --oneline -5` lists recent ones"])
    return out


def _is_test_file(rel: str) -> bool:
    """``test_x.py`` or ``x_test.py``: a file that defines tests and, run as a program, runs none."""
    import re

    return bool(re.match(r"^(test_.*|.*_test)\.py$", os.path.basename(rel)))


def _test_files(repo: str) -> list[str]:
    """The repository's tracked test files, for the refusal that found no main.py."""
    return sorted(line.strip() for line in git(repo, "ls-files", "--", "*test_*.py", "*_test.py").splitlines() if _is_test_file(line.strip()))


def _test_names(path: str) -> list[str]:
    """The tests a file defines, as ``--test`` names: ``test_x`` for a function, ``Class::test_x`` for a method
    (``Class.test_x``, unittest's form, when the class derives from TestCase)."""
    import ast

    try:
        with open(path, encoding="utf-8") as fh:
            tree = ast.parse(fh.read())
    except (OSError, SyntaxError, ValueError):
        return []
    names: list[str] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test"):
            names.append(node.name)
        elif isinstance(node, ast.ClassDef):
            unittest = any("TestCase" in ast.dump(b) for b in node.bases)
            names.extend("%s%s%s" % (node.name, "." if unittest else "::", m.name) for m in node.body if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)) and m.name.startswith("test"))
    return names


def _entry(repo: str, entry: Any, test: str | None, base: str) -> str:
    """The entry file relative to the repo: ``--entry``, the file of ``--test FILE::NAME``, else ``main.py``."""
    if test and not entry and "::" in test:
        entry = test.split("::", 1)[0]
    if test and not entry:
        raise _refuse("--test needs the test file: FILE::NAME, or --entry FILE beside it", next_command="review start --base REF --test tests/test_x.py::test_name")
    if not entry:
        if os.path.isfile(os.path.join(repo, "main.py")):
            entry = "main.py"
        else:
            tests = _test_files(repo)
            raise _refuse("no entry: there is no main.py at %s" % repo,
                          ["give --entry FILE, a program both trees run, or --test FILE::NAME, one test (a test file as --entry runs its imports and definitions, not its tests)%s"
                           % ((": test files here: " + ", ".join(tests[:6])) if tests else "")],
                          "review start --base REF --test FILE::NAME" if tests else "review start --base REF --entry FILE")
    path = os.path.abspath(entry if os.path.isabs(str(entry)) else os.path.join(repo, str(entry)))
    if not os.path.isfile(path):
        raise _refuse("no file %s" % path, next_command="review start --base REF --entry FILE")
    if not inside(path, repo):
        raise _refuse("%s is outside the repository %s" % (path, repo), ["the entry must be a file of the tree, so the base tree can run it too"], "review start --base REF --entry FILE")
    rel = os.path.relpath(os.path.realpath(path), os.path.realpath(repo))
    if not test and _is_test_file(rel):
        names = _test_names(path)
        raise _refuse("%s is a test file: run as a program it defines its tests and runs none (its imports and definitions only), so both trees would run no test" % rel,
                      ["give --test %s::NAME for one of its tests%s, or --entry a program file both trees run" % (rel, (" (%s)" % ", ".join(names[:8])) if names else "")],
                      "review start --base REF --test %s::NAME" % rel)
    # head is the working tree as it stands, the entry included: an uncommitted entry is reviewed as it is, and tree_hash pins it
    if not git(repo, "ls-tree", base, "--", rel).strip():
        raise _refuse("%s does not exist at %s" % (rel, base[:7]), ["the review needs an entry both trees run; name one with --entry FILE"], "review start --base REF --entry FILE")
    return rel


def test_of(test: str | None, rel: str) -> str | None:
    """The test's own name: ``FILE::NAME`` without the file when FILE is the entry."""
    if not test:
        return None
    head, sep, rest = test.partition("::")
    if sep and os.path.basename(head) == os.path.basename(rel):
        return rest
    return test


def _directory(given: Any, repo: str, base: str) -> str:
    directory = os.path.abspath(os.path.expanduser(str(given))) if given else default_dir(repo, base)
    if inside(directory, repo):
        raise _refuse("the review directory %s is inside the repository" % directory, ["nothing is written inside the repository under review; leave --dir out ($PYOKKA_HOME/reviews/…) or point it elsewhere"])
    return directory


def _prepare(directory: str) -> None:
    """An empty directory, a review directory started again (our files go, nothing else), or a new one."""
    if os.path.isdir(directory):
        if os.listdir(directory) and not os.path.isfile(os.path.join(directory, STATE_FILE)):
            raise _refuse("%s exists and is not a review directory" % directory, ["give an empty directory, a review directory (it is started again) or none"])
        for name in OURS:
            p = os.path.join(directory, name)
            if os.path.isdir(p) and not os.path.islink(p):
                shutil.rmtree(p)
            elif os.path.lexists(p):
                os.remove(p)
    os.makedirs(os.path.join(directory, "tries"), exist_ok=True)


def _pr_text(repo: str, given: Any, base: str) -> tuple[str, str]:
    """The PR's text and where it came from: ``--pr FILE``, ``pr.md`` at the root, else the commit messages base..HEAD."""
    if given:
        path = os.path.abspath(os.path.expanduser(str(given)))
        try:
            return _read(path), path
        except OSError as exc:
            raise _refuse("cannot read --pr %s: %s" % (path, exc.strerror or exc)) from None
    default = os.path.join(repo, "pr.md")
    if os.path.isfile(default):
        try:
            return _read(default), default
        except OSError:
            pass
    return git(repo, "log", "--format=%B", "%s..HEAD" % base), "commit messages %s..HEAD" % base[:7]


def _interpreter(entry: str, python: Any) -> Any:
    """``pyokka run``'s interpreter for the entry (``interpreter.choose``, its order unchanged), probed. Its ``python:`` line
    goes into ``start``'s answer: a Codex smoke test (2026-10-19) read a Makefile and a pyproject, and synced a venv, to
    guess what ``start`` would pick when nothing said it. A ``.venv`` found from the entry's directory up is labelled as
    the nearest to the entry, with the flag that overrides it."""
    from ..interpreter import choose, probe

    try:
        interp = choose(entry, str(python) if python else None)
        if interp.source.startswith(".venv in "):
            interp.source = NEAREST_VENV
        return probe(interp)
    except AgentError as exc:
        raise _refuse(exc.message, [exc.hint] if exc.hint else None) from None


def _materialise(repo: str, base: str, dest: str) -> None:
    os.makedirs(dest, exist_ok=True)
    try:
        done = subprocess.run(["git", "-C", repo, "archive", "--format=tar", base], capture_output=True, timeout=600)
    except FileNotFoundError:
        raise _refuse("git is not on PATH", ["the base tree comes from `git archive`"]) from None
    if done.returncode != 0:
        raise _refuse("git archive %s failed: %s" % (base[:7], done.stderr.decode("utf-8", "replace").strip()[:300]))
    with tarfile.open(fileobj=io.BytesIO(done.stdout), mode="r:") as tar:
        tar.extractall(dest, filter="data")


def _record(entry: str, out: str, cwd: str, argv: list[str], interp: Any, test: str | None, label: str) -> None:
    from ..save import save_run

    # the program's imports would write __pycache__ into the tree being reviewed: the child leaves no bytecode behind
    before = os.environ.get("PYTHONDONTWRITEBYTECODE")
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    try:
        save_run(entry, out, argv=argv, python=interp, cwd=cwd, test=test, record_locals=True)
    except (RuntimeError, OSError) as exc:
        raise _refuse("recording %s failed: %s" % (label, exc), ["`pyokka run %s --cwd %s` shows what the runner says" % (entry, cwd)]) from None
    finally:
        if before is None:
            os.environ.pop("PYTHONDONTWRITEBYTECODE", None)
        else:
            os.environ["PYTHONDONTWRITEBYTECODE"] = before


def _check_ran(run_json: str, label: str, test: str | None, interp: Any) -> str | None:
    """A recording with no statement of the tree is no run to review: refused with the runner's own words.

    A Codex harness (2026-10-17) reviewed a test under an interpreter without pytest: the runner said `No module named
    pytest`, both recordings held 0 steps, and ``start`` answered `0 statements compared, exit code 1 on both` as if that
    were a result. A head that recorded nothing, or a runner that failed on either tree, is refused before the comparison,
    and the refusal says why it ran nothing. A base that ran nothing with no runner error is a tree the change made run
    (an entry the PR adds or repairs): it goes through with a note, and everything head ran is new.
    """
    run = SavedRun(run_json)
    if int(run.meta.get("stepCount") or 0) > 0:
        return None
    errors = [str(e.get("message")) for e in run.events if isinstance(e, dict) and e.get("type") == "runner.error" and e.get("message")]
    if label == "base" and not errors:
        return "note: the base run recorded no statement (exit %s): everything head ran is new since base" % run.meta.get("exitCode")
    why = "the %s run recorded no statement (exit %s)%s" % (label, run.meta.get("exitCode"), (": " + "; ".join(errors[:2])) if errors else "")
    python = getattr(interp, "path", None) or "the interpreter"
    if test:
        raise _refuse(why, ["the test ran nothing: a runner that is not installed in %s is the usual cause; a unittest class runs without pytest as --test FILE::Class.test, or pass --python an interpreter that has pytest" % python],
                      "review start --base REF --test FILE::Class.test, or --python P")
    raise _refuse(why, ["the entry ran nothing of the tree: check the interpreter (%s) and the arguments; `pyokka run ENTRY --cwd REPO` shows what the program says" % python],
                  "review start --base REF --entry FILE --python P")


def _normalise(plan: Any) -> tuple[list[dict], list, list[dict], list, Any]:
    """The plan's parts with the stops numbered 1..N in rank order and the edges E1..En."""
    if not isinstance(plan, dict):
        raise _refuse("build_plan returned %s, not a dict" % type(plan).__name__)
    stops = []
    for i, s in enumerate([s for s in plan.get("stops") or [] if isinstance(s, dict)], 1):
        stops.append({**s, "n": i})
    edges = []
    for i, e in enumerate(plan.get("edges") or [], 1):
        e = dict(e) if isinstance(e, dict) else {"what": str(e)}
        e.setdefault("id", "E%d" % i)
        edges.append(e)
    return stops, list(plan.get("unreached") or []), edges, list(plan.get("anomalies") or []), plan.get("summary")


def summary_paragraph(summary: Any, diff_json: dict, exc_a: dict, exc_b: dict) -> str:
    """What changed in behaviour, in one paragraph: the plan's own summary, else the counts of the comparison."""
    if isinstance(summary, str) and summary.strip():
        return summary.strip()
    if isinstance(summary, dict) and summary:
        text = summary.get("text") or summary.get("paragraph")
        if isinstance(text, str) and text.strip():
            return text.strip()
        return "; ".join("%s: %s" % (k, v) for k, v in summary.items())
    a, b, m = diff_json.get("a") or {}, diff_json.get("b") or {}, diff_json.get("matching") or {}
    return "base ran %s steps (exit %s), head %s steps (exit %s); statements: %s same, %s edited, %s added, %s removed; %s did something different; exceptions: %s in base, %s in head" % (
        a.get("count"), a.get("exitCode"), b.get("count"), b.get("exitCode"), m.get("same"), m.get("edited"), m.get("added"), m.get("removed"), diff_json.get("total"), exc_a.get("total", 0), exc_b.get("total", 0))


__all__ = ["start", "summary_paragraph", "test_of"]
