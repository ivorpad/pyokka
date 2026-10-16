"""The review's state: its directory, ``review.json``, the current pointer, the header and the ``next:`` line.

DIR (``--dir``, default ``$PYOKKA_HOME/reviews/<repo-name>-<base7>/``) holds ``review.json``,
``base/`` (the base tree), ``base.json`` and ``head.json`` (the recordings), ``tries/<id>.json``,
``fixed/`` and ``fixed.json`` (head with the patch applied, and its recording) and ``report.md``.
``$PYOKKA_HOME/reviews/current`` names the directory of the last ``start``, so ``--dir`` can be
left out after it. Nothing is ever written inside the repository under review.

The review is a conversation: after a stop is shown the review waits for the person (``waiting``
holds that stop's number) and the next ``stop`` needs ``--go-on``, the agent's word that they said
next; ``ask``, ``look`` and ``try`` answer them meanwhile. The plan is an agenda they reorder: any
remaining stop may be shown, ``skip`` sets one aside with their reason. Every answer, a refusal
included, is the header line first and ``next: <one command>`` last.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import subprocess
from typing import Any

from ...home import pyokka_home
from ..source import AgentError

ACTIONS = ("start", "stop", "ask", "skip", "look", "try", "finding", "fix", "report", "state")
PHASES = ("stops", "findings", "reported")
SURFACES = ("auto", "page", "vscode", "chat")
SEVERITIES = ("blocker", "major", "minor")
STATE_FILE = "review.json"
START = "review start --base REF"
WAIT = "wait for the person"
FINDING_ADD = "review finding add --file F --line L --severity blocker|major|minor --title T --step N --repro ID|CMD --fix TEXT"
NO_REVIEW_HEADER = "review (none) · no review started · stops 0/0 shown · findings 0 · tries 0"


class Refusal(AgentError):
    """An action the review refuses. Its text has the shape of every answer: the header line first,
    ``refused: <why>``, the detail lines, and ``next:`` last."""

    def __init__(self, header: str, why: str, next_command: str, details: list[str] | None = None) -> None:
        self.header = header
        self.why = why
        self.details = [str(d) for d in (details or [])]
        self.next_command = next_command
        super().__init__("\n".join([header, "refused: %s" % why, *self.details]), "next: %s" % next_command)

    @property
    def text(self) -> str:
        return "%s\n%s" % (self.message, self.hint)

    def to_json(self) -> dict:
        return {"ok": False, "error": self.why, "header": self.header, "details": self.details, "next": self.next_command}


# -- directories ---------------------------------------------------------------------------------------------------

def reviews_home() -> str:
    return os.path.join(pyokka_home(), "reviews")


def current_path() -> str:
    return os.path.join(reviews_home(), "current")


def set_current(directory: str) -> None:
    os.makedirs(reviews_home(), exist_ok=True)
    with open(current_path(), "w", encoding="utf-8") as fh:
        fh.write(os.path.abspath(directory) + "\n")


def current_dir() -> str | None:
    try:
        with open(current_path(), "r", encoding="utf-8") as fh:
            text = fh.read().strip()
    except OSError:
        return None
    return text or None


def resolve_dir(given: Any) -> str:
    """``--dir``, else the current review's directory; a refusal when there is neither."""
    if given:
        return os.path.abspath(os.path.expanduser(str(given)))
    cur = current_dir()
    if cur:
        return cur
    raise Refusal(NO_REVIEW_HEADER, "no review to continue: no --dir, and no current review under %s" % reviews_home(), START)


def default_dir(repo: str, base: str) -> str:
    name = os.path.basename(os.path.abspath(repo).rstrip(os.sep)) or "repo"
    return os.path.join(reviews_home(), "%s-%s" % (name, base[:7]))


def inside(path: str, root: str) -> bool:
    """Whether ``path`` is ``root`` or under it (symlinks resolved)."""
    try:
        return os.path.commonpath([os.path.realpath(path), os.path.realpath(root)]) == os.path.realpath(root)
    except ValueError:  # different drives
        return False


def now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def next_id(items: list[dict], prefix: str) -> str:
    """``t1``, ``t2``, … / ``f1``, ``f2``, …: one more than the highest id of its kind."""
    highest = 0
    for item in items:
        value = str(item.get("id") or "")
        if value.startswith(prefix) and value[len(prefix):].isdigit():
            highest = max(highest, int(value[len(prefix):]))
    return "%s%d" % (prefix, highest + 1)


# -- git -------------------------------------------------------------------------------------------------------------

def git(repo: str, *args: str, check: bool = True) -> str:
    """``git -C repo ARGS``; its stdout. A failing call is an ``AgentError`` naming the command (``check``)."""
    try:
        done = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, timeout=300)
    except FileNotFoundError:
        raise AgentError("git is not on PATH", "the review resolves the base commit and hashes the tree with git") from None
    if check and done.returncode != 0:
        raise AgentError("git %s failed in %s: %s" % (args[0], repo, (done.stderr or done.stdout).strip()[:300]), "the repository under review must be a git checkout")
    return done.stdout


def tree_hash(repo: str) -> str:
    """HEAD, ``git status --porcelain``, the working tree's diff against HEAD and the content of the
    untracked files, folded into one hash: the review describes this tree and no other."""
    h = hashlib.sha256()
    h.update(git(repo, "rev-parse", "HEAD").encode("utf-8"))
    status = [l for l in git(repo, "status", "--porcelain", "--untracked-files=all").splitlines() if not _derived(l[3:])]
    h.update("\n".join(status).encode("utf-8"))
    h.update(git(repo, "diff", "HEAD", "--no-ext-diff", "--no-color").encode("utf-8"))
    for line in status:
        if not line.startswith("?? "):
            continue
        rel = line[3:].strip()
        if rel[:1] == '"' and rel[-1:] == '"':
            rel = rel[1:-1]
        try:
            with open(os.path.join(repo, rel), "rb") as fh:
                h.update(hashlib.sha256(fh.read()).digest())
        except OSError:
            continue
    return h.hexdigest()


def _derived(rel: str) -> bool:
    """Bytecode and pyokka's own run directory: written by running the tree, not part of the change."""
    parts = rel.strip().strip('"').split("/")
    return "__pycache__" in parts or ".pyokka" in parts or rel.endswith((".pyc", ".pyo"))


# -- the state file --------------------------------------------------------------------------------------------------

class Review:
    """``review.json`` in memory: ``{id, repo, base, head, entry, test, dir, created, phase, tree_hash,
    plan: {stops, unreached, edges}, shown, skipped, waiting, asked, conversation, tries, findings, fix, summary}``."""

    def __init__(self, directory: str, data: dict) -> None:
        self.dir = os.path.abspath(directory)
        self.data = data
        self.data["dir"] = self.dir

    @classmethod
    def load(cls, directory: str) -> "Review":
        path = os.path.join(directory, STATE_FILE)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except FileNotFoundError:
            raise Refusal(NO_REVIEW_HEADER, "no review in %s (no %s there)" % (directory, STATE_FILE), START) from None
        except ValueError as exc:
            raise Refusal(NO_REVIEW_HEADER, "%s is not a review state file: %s" % (path, exc), START) from None
        if not isinstance(data, dict) or not isinstance(data.get("plan"), dict):
            raise Refusal(NO_REVIEW_HEADER, "%s has no plan" % path, START)
        return cls(directory, data)

    def save(self) -> None:
        path = os.path.join(self.dir, STATE_FILE)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self.data, fh, ensure_ascii=False, indent=1)
            fh.write("\n")
        os.replace(tmp, path)

    def path(self, *parts: str) -> str:
        return os.path.join(self.dir, *parts)

    # -- fields ----------------------------------------------------------------------------------------------
    @property
    def phase(self) -> str:
        return str(self.data.get("phase") or "stops")

    @phase.setter
    def phase(self, value: str) -> None:
        self.data["phase"] = value

    @property
    def repo(self) -> str:
        return str(self.data.get("repo") or "")

    @property
    def plan(self) -> dict:
        return self.data.setdefault("plan", {})

    @property
    def stops(self) -> list[dict]:
        return [s for s in (self.plan.get("stops") or []) if isinstance(s, dict)]

    @property
    def findings(self) -> list[dict]:
        return self.data.setdefault("findings", [])

    @property
    def tries(self) -> list[dict]:
        return self.data.setdefault("tries", [])

    @property
    def shown(self) -> list[int]:
        return self.data.setdefault("shown", [])

    @property
    def skipped(self) -> list[dict]:
        return self.data.setdefault("skipped", [])

    @property
    def asked(self) -> list[dict]:
        return self.data.setdefault("asked", [])

    @property
    def conversation(self) -> list[dict]:
        """What happened in order: stops shown, lines asked, stops skipped, looks and tries, each with its text."""
        return self.data.setdefault("conversation", [])

    @property
    def waiting(self) -> int | None:
        """The stop the person has not spoken since, until a ``stop --go-on`` says they did."""
        value = self.data.get("waiting")
        return int(value) if value is not None else None

    def stop(self, n: int) -> dict | None:
        return next((s for s in self.stops if int(s.get("n", -1)) == n), None)

    def skipped_numbers(self) -> list[int]:
        return [int(s["n"]) for s in self.skipped if isinstance(s, dict) and s.get("n") is not None]

    def remaining(self) -> list[int]:
        """The agenda items neither shown nor skipped, in plan order."""
        done = {int(x) for x in self.shown} | set(self.skipped_numbers())
        return [int(s["n"]) for s in self.stops if int(s.get("n", -1)) not in done]

    def note(self, kind: str, **fields: Any) -> dict:
        entry = {"kind": kind, **fields, "at": now()}
        self.conversation.append(entry)
        return entry

    def mark_shown(self, n: int) -> None:
        if n not in self.shown:
            self.shown.append(n)
        self.data["skipped"] = [s for s in self.skipped if int(s.get("n", -1)) != n]
        self.data["waiting"] = n
        if self.phase == "stops" and not self.remaining():
            self.phase = "findings"

    def mark_skipped(self, n: int, why: str) -> None:
        self.data["skipped"] = [s for s in self.skipped if int(s.get("n", -1)) != n] + [{"n": n, "why": why, "at": now()}]
        if self.phase == "stops" and not self.remaining():
            self.phase = "findings"

    def reopen(self) -> None:
        """New evidence after the report: the report no longer stands, so the phase goes back."""
        if self.phase == "reported":
            self.phase = "findings"

    # -- the two lines every answer carries -------------------------------------------------------------------
    def header(self) -> str:
        total = len(self.stops)
        shown = sum(1 for s in self.stops if int(s.get("n", -1)) in {int(x) for x in self.shown})
        return "review %s · %s · stops %d/%d shown · findings %d · tries %d" % (self.data.get("id"), self.phase, shown, total, len(self.findings), len(self.tries))

    def after_stops(self) -> str:
        """The one command once the agenda is done: the findings, the fix, the report, or state."""
        if self.phase == "reported":
            return "review state"
        if not self.findings:
            return FINDING_ADD
        if not self.data.get("fix"):
            return "review fix --patch FILE.diff"
        return "review report"

    def next_command(self) -> str:
        """The one command that applies now; while the person has the floor, what to run once they say next."""
        remaining = self.remaining()
        if remaining:
            if self.waiting is not None:
                return "%s; when they say next, review stop %d --say TEXT --go-on" % (WAIT, remaining[0])
            return "review stop %d --say TEXT" % remaining[0]
        return self.after_stops()

    def refuse(self, why: str, details: list[str] | None = None, next_command: str | None = None) -> Refusal:
        return Refusal(self.header(), why, next_command or self.next_command(), details)


def result(review: Review | None, lines: list[str], next_command: str | None = None, **extra: Any) -> dict:
    """The answer shape: ``header``, the body ``lines``, ``next``; the raw parts under their own keys."""
    header = review.header() if review is not None else NO_REVIEW_HEADER
    nxt = next_command or (review.next_command() if review is not None else START)
    return {"kind": "review", "header": header, "lines": [str(l) for l in lines], "next": nxt, **extra}


__all__ = ["ACTIONS", "PHASES", "SURFACES", "SEVERITIES", "STATE_FILE", "START", "WAIT", "FINDING_ADD", "NO_REVIEW_HEADER", "Refusal", "Review", "result", "reviews_home", "current_path", "set_current", "current_dir", "resolve_dir", "default_dir", "inside", "now", "next_id", "git", "tree_hash"]
