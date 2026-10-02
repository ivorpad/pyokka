"""Which live session a command drives (docs/design/debugger-product.md, 4.7).

A file may have two descriptors now: the run-all session's (``kind: "run"``) and the Debugger's
(``kind: "debug"``). This rule lives in Python and only in Python: the host writes descriptors and
answers on the socket it is asked on, it never picks one. ``prefer_kind`` says which kind a verb
wants, ``pick_session`` applies it after ``--session`` and the command's file have narrowed the list.
"""

from __future__ import annotations

import os

from .source import AgentError, display_path

NO_SESSION = "no live session"
NO_SESSION_HINT = "open the file in VS Code with pyokka.agentAccess on, or use a saved run (`pyokka run FILE --save run.json`)"

#: the verbs that drive a live program: they prefer a ``kind: "debug"`` descriptor (4.7)
DEBUG_VERBS = frozenset({"debug", "continue", "pause", "stop", "restart", "break", "watches", "locals", "exec"})
#: the verbs that read a recording: they prefer a ``kind: "run"`` descriptor
RUN_VERBS = frozenset({"why", "origin", "var", "story", "walkthrough", "graph", "exceptions", "http", "values", "find", "steps"})
#: the verbs that fit either: a debug session when one exists (it is the live thing), else a run
EITHER_VERBS = frozenset({"state", "context", "eval", "expand", "select", "watch", "shell"})


def descriptor_kind(d: dict) -> str:
    """``run`` or ``debug``; a descriptor written by an older extension has no ``kind`` and is a run."""
    kind = d.get("kind")
    return kind if kind in ("run", "debug") else "run"


def prefer_kind(command: str, kind: str | None = None) -> str | None:
    """Which descriptor a command wants: ``debug``, ``run``, or None when either will do.

    ``step`` prefers a debug session for the moves that execute (``--into/--over/--out``) and a run
    for the backward moves and ``--to``, which only a recording can serve.
    """
    if command == "step":
        return "debug" if kind in ("into", "over", "out") else "run"
    if command in DEBUG_VERBS:
        return "debug"
    if command in RUN_VERBS:
        return "run"
    return "debug" if command in EITHER_VERBS else None


def _by_kind(matches: list[dict], prefer: str | None) -> dict | None:
    """The one descriptor ``prefer`` chooses, or None when the caller must say which."""
    if prefer:
        same = [d for d in matches if descriptor_kind(d) == prefer]
        if len(same) == 1:
            return same[0]
        if len(same) > 1:
            return None
        other = [d for d in matches if descriptor_kind(d) != prefer]
        if len(other) == 1:
            # Serving a verb from the other product is usually right (`debug` asks a recording
            # session's window to launch). It is worth saying so only when the command then fails,
            # so the substitution rides along and `substitution_note` renders it there.
            return dict(other[0], substituted=prefer)
    return matches[0] if len(matches) == 1 else None


def substitution_note(descriptor: dict) -> str | None:
    """Why this session is not the kind the verb asked for, for a failed command's hint.

    A command that reaches the wrong product fails with the host's own message, which describes
    the session it landed in and never mentions that a different one was wanted. Without this the
    only way to see the substitution is to read `$PYOKKA_HOME/sessions` by hand.
    """
    wanted = descriptor.get("substituted")
    kind = descriptor_kind(descriptor)
    if not wanted or wanted == kind:
        return None
    name = descriptor.get("displayName") or os.path.basename(str(descriptor.get("file")))
    if wanted == "debug":
        return "no debug session here: this is the run session on %s. `pyokka debug FILE` starts one." % name
    return "no recording here: this is the debug session on %s. `pyokka debug FILE --record` records one." % name


def _describe(d: dict) -> str:
    return "%s %s (pid %s, %s) %s" % (descriptor_kind(d), d.get("displayName") or os.path.basename(str(d.get("file"))), d.get("pid"), display_path(str(d.get("file")), str(d.get("workspace") or "")), d.get("descriptor") or "")


def _file_matches(d: dict, name: str) -> bool:
    file = str(d.get("file") or "")
    if not name:
        return False
    if name == d.get("displayName") or name == os.path.basename(file) or file.endswith(os.sep + name):
        return True
    if os.sep in name or name.startswith("."):
        return os.path.abspath(name) == file
    return False


def pick_session(descriptors: list[dict], *, session: str | None = None, file_hint: str | None = None, cwd: str | None = None, prefer: str | None = None) -> dict:
    """``--session NAME|PATH``, else the session of the command's file, else the one whose workspace holds the cwd.

    A file may have two descriptors now, one per product, so ``prefer`` (``prefer_kind``) says which
    kind the verb wants: the preferred kind when exactly one matches, the other kind when none
    does, and "say which" when several of the preferred kind match. ``--session <descriptor path>``
    always selects exactly that socket, whatever the verb.
    """
    if not descriptors:
        raise AgentError(NO_SESSION, NO_SESSION_HINT)
    listing = "; ".join(_describe(d) for d in descriptors[:6])
    if session:
        wanted = os.path.abspath(session)
        exact = [d for d in descriptors if d["descriptor"] == wanted]
        if exact:
            return exact[0]
        matches = [d for d in descriptors if _file_matches(d, session)]
        if not matches:
            raise AgentError("%s for %s" % (NO_SESSION, session), "live sessions: %s" % listing)
        chosen = _by_kind(matches, prefer)
        if chosen is not None:
            return chosen
        raise AgentError("%d live sessions match %s" % (len(matches), session), "pick one by descriptor: --session " + " | ".join(d["descriptor"] for d in matches))
    if file_hint:
        matches = [d for d in descriptors if _file_matches(d, file_hint)]
        if matches:
            chosen = _by_kind(matches, prefer)
            if chosen is not None:
                return chosen
            raise AgentError("%d live sessions on %s" % (len(matches), file_hint), "say which: --session " + " | ".join(d["descriptor"] for d in matches))
    cwd = os.path.abspath(cwd or os.getcwd())
    in_ws = [d for d in descriptors if d.get("workspace") and (cwd == str(d["workspace"]) or cwd.startswith(str(d["workspace"]).rstrip(os.sep) + os.sep))]
    candidates = in_ws or descriptors
    chosen = _by_kind(candidates, prefer)
    if chosen is not None:
        return chosen
    raise AgentError("%d live sessions; say which" % len(candidates), "--session NAME with one of: %s" % "; ".join(_describe(d) for d in candidates[:6]))


__all__ = ["DEBUG_VERBS", "EITHER_VERBS", "NO_SESSION", "NO_SESSION_HINT", "RUN_VERBS", "descriptor_kind", "pick_session", "prefer_kind", "substitution_note"]
