"""``review start``: resolve the base, materialise its tree, record both trees, compare them, plan, write the state.

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
from .state import NO_REVIEW_HEADER, START, STATE_FILE, Refusal, Review, default_dir, git, inside, now, result, set_current, tree_hash

OURS = ("base", "fixed", "tries", STATE_FILE, "base.json", "head.json", "fixed.json", "report.md")
DIFF_LIMIT = 1_000_000


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
    _prepare(directory)
    base_dir = os.path.join(directory, "base")
    _materialise(repo, base, base_dir)
    head_json, base_json = os.path.join(directory, "head.json"), os.path.join(directory, "base.json")
    test_name = test_of(test, rel)
    _record(os.path.join(repo, rel), head_json, repo, argv, interp, test_name, "head")
    _record(os.path.join(base_dir, rel), base_json, base_dir, argv, interp, test_name, "base")
    base_run, head_run = SavedRun(base_json), SavedRun(head_json)
    diff_json = diff_sides(Side("a", base_json, base_run), Side("b", head_json, head_run), limit=DIFF_LIMIT)
    exc_a, exc_b = base_run.exceptions(), head_run.exceptions()
    notes: list[str] = []
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
    set_current(directory)
    paragraph = summary_paragraph(summary, diff_json, exc_a, exc_b)
    lines = ["%s: %s → %s, entry %s%s, review directory %s" % (os.path.basename(repo), base[:7], head[:7], rel, (" (test %s)" % test) if test else "", directory), paragraph, *notes, *plan_lines(review)]
    return result(review, lines, plan=review.plan, summary=data["summary"], dir=directory)


# -- the pieces ------------------------------------------------------------------------------------------------------

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
            raise _refuse("no entry: there is no main.py at %s" % repo, ["give --entry FILE (what both trees run) or --test FILE::NAME"], "review start --base REF --entry FILE")
    path = os.path.abspath(entry if os.path.isabs(str(entry)) else os.path.join(repo, str(entry)))
    if not os.path.isfile(path):
        raise _refuse("no file %s" % path, next_command="review start --base REF --entry FILE")
    if not inside(path, repo):
        raise _refuse("%s is outside the repository %s" % (path, repo), ["the entry must be a file of the tree, so the base tree can run it too"], "review start --base REF --entry FILE")
    rel = os.path.relpath(os.path.realpath(path), os.path.realpath(repo))
    status = git(repo, "status", "--porcelain", "--", rel).strip()
    if status:
        raise _refuse("%s has uncommitted changes (git status: %s)" % (rel, status.split()[0]), ["the review records the entry as committed; commit or stash the change, or name another --entry"])
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
    from ..interpreter import choose, probe

    try:
        return probe(choose(entry, str(python) if python else None))
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
