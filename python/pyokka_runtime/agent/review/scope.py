"""``review start --only PATH …``: the agenda narrowed to some files before it is numbered.

A Codex smoke test (2026-10-19, a langchain range, a review of two IPv6 functions) got 58 items from ``start``
and made 56 ``skip`` calls, 31 KB of output, to leave the two it wanted. ``--only`` names them at ``start``
instead. Each PATH is a file or a directory relative to the repository, or a glob, which is tried on the file
and on every directory above it, so ``libs/*/langchain_core`` names directories. ``start`` reads only the diff of
the files inside (``state.change_diff`` with ``inside_any`` as its filter, by file name): a change's configuration
outside them is never read, and the files left out are listed in the plan's ``outside``. ``narrow`` then sets
aside whatever of the plan still lies outside every PATH, in the plan's ``aside`` with the reason, and the edge
candidates the same way (``aside_edges``). The agenda is then numbered 1..N and the edges E1..En again, so
``open_debug`` sets breakpoints for the agenda alone.
"""

from __future__ import annotations

import fnmatch
import os
import posixpath
from typing import Any

from .debugger import describe
from .render import ONLY_REASON
from .state import NO_REVIEW_HEADER, Refusal, inside

GLOB_CHARS = "*?["


def only_paths(f: dict, repo: str) -> list[str]:
    """``--only`` (the CLI's list) or ``only`` (MCP: a list, or one string) as ``/``-separated paths relative to the
    repository, without ``./`` or a trailing ``/``. An absolute path inside the repository is made relative; one
    outside it stays as given and matches nothing, which ``narrow`` notes."""
    given = f.get("only")
    if isinstance(given, str):
        given = [given]
    out: list[str] = []
    for raw in given or []:
        text = os.path.expanduser(str(raw).strip())
        if not text:
            continue
        if os.path.isabs(text) and inside(text, repo):
            text = os.path.relpath(os.path.realpath(text), os.path.realpath(repo))
        path = posixpath.normpath(text.replace(os.sep, "/"))
        if path not in out:
            out.append(path)
    return out


def within(file: str, path: str) -> bool:
    """Whether the repository-relative ``file`` is ``path``, lies under the directory ``path``, or is matched by the
    glob ``path`` (the file itself or a directory above it). ``.`` is the whole repository."""
    if path in ("", "."):
        return True
    if any(c in path for c in GLOB_CHARS):
        parts = file.split("/")
        return any(fnmatch.fnmatchcase("/".join(parts[:i]), path) for i in range(len(parts), 0, -1))
    return file == path or file.startswith(path.rstrip("/") + "/")


def inside_any(file: Any, paths: list[str]) -> bool:
    rel = str(file or "").replace(os.sep, "/")
    return any(within(rel, p) for p in paths)


def narrow(plan: dict, paths: list[str], changed_files: list[str] | None = None) -> tuple[dict, list[str]]:
    """``(plan, notes)``: ``plan_items``'s plan with what lies outside every PATH set aside and the rest numbered
    again, and a note for each PATH that matched no changed file, so a typo shows. No PATH: the plan as it is.
    ``changed_files`` is every file of the change before ``--only`` limited the diff that was read, which the
    refusal and the notes name, since the narrowed plan holds only what was kept.

    An ``--only`` that leaves no item is refused: a debug session with no breakpoint shows nothing, and ``start``
    calls this before it touches the review directory, so the last review stays as it was.
    """
    if not paths:
        return plan, []
    stops = [s for s in plan.get("stops") or [] if isinstance(s, dict)]
    kept = [s for s in stops if inside_any(s.get("file"), paths)]
    if not kept:
        them = "it" if len(paths) == 1 else "them"
        if changed_files is not None:  # the diff read was already limited to PATH: what it left is the change's file names
            files = sorted(f for f in changed_files if f.endswith(".py"))
            why = "--only %s leaves no item: no changed function is in a file inside %s" % (", ".join(paths), them)
            listed = "the change's Python files: %s%s" % (", ".join(files[:12]), ", …" if len(files) > 12 else "") if files else "the change has no Python file, so there is nothing to narrow"
        else:
            files = sorted({str(s.get("file")) for s in stops})
            why = "--only %s leaves no item: none of the %d changed function%s is in a file inside %s" % (", ".join(paths), len(stops), "" if len(stops) == 1 else "s", them)
            listed = "the agenda's files: %s%s" % (", ".join(files[:12]), ", …" if len(files) > 12 else "") if files else "the diff changes no function, so there is nothing to narrow"
        raise Refusal(NO_REVIEW_HEADER, why,
                      "review start --base REF --only PATH",
                      [listed,
                       "a PATH is relative to the repository: a file, a directory, or a glob such as shopkit/*.py; module-level and test-file changes are set aside whatever --only says"])
    kept_ids = {id(s) for s in kept}
    left = [{**{k: v for k, v in s.items() if k != "n"}, "reason": ONLY_REASON} for s in stops if id(s) not in kept_ids]
    for i, s in enumerate(kept, 1):
        s["n"] = i
    edges = [e for e in plan.get("edges") or [] if isinstance(e, dict)]
    kept_edges = [e for e in edges if inside_any(e.get("file"), paths)]
    edge_ids = {id(e) for e in kept_edges}
    left_edges = [{**e, "reason": ONLY_REASON} for e in edges if id(e) not in edge_ids]
    for i, e in enumerate(kept_edges, 1):
        e["id"] = "E%d" % i
    outside = sorted(f for f in changed_files or [] if not inside_any(f, paths)) if changed_files is not None else None
    summary = dict(plan.get("summary") or {})
    summary.update(items=len(kept), functions=len(kept), agenda_files=len({s.get("file") for s in kept}), edges=len(kept_edges),
                   only={"paths": list(paths), "items": len(left), "edges": len(left_edges), **({"outside": outside} if outside is not None else {})})
    summary["text"] = "%s %s" % (describe(summary), only_sentence(summary["only"]))
    changed = {str(x.get("file")).replace(os.sep, "/") for x in [*stops, *(plan.get("aside") or []), *edges] if isinstance(x, dict)}
    changed |= {str(f).replace(os.sep, "/") for f in [*(plan.get("other_files") or []), *(changed_files or [])]}
    notes = ["note: --only %s matched no changed file" % p for p in paths if not any(within(f, p) for f in changed)]
    narrowed = {**plan, "stops": kept, "aside": [*(plan.get("aside") or []), *left], "edges": kept_edges, "aside_edges": left_edges, "only": list(paths), "summary": summary,
                **({"outside": outside} if outside is not None else {})}
    return narrowed, notes


def untracked_sentence(files: list[str]) -> str:
    """The summary's sentence for the untracked files ``change_diff`` read as added ones."""
    return "%d untracked file%s included as new: %s%s." % (len(files), "" if len(files) == 1 else "s", ", ".join(files[:6]), ", …" if len(files) > 6 else "")


def only_sentence(only: dict) -> str:
    """The summary's sentence for ``--only``: the changed files outside it, which were not read, or (a plan that read
    the whole diff) how many items and edge candidates it left out."""
    items, edges = int(only.get("items") or 0), int(only.get("edges") or 0)
    paths = ", ".join(str(p) for p in only.get("paths") or [])
    outside = only.get("outside")
    if isinstance(outside, list) and not items and not edges:
        if not outside:
            return "--only %s left nothing out: every changed file is inside it." % paths
        return "%d changed file%s outside --only %s, not read: %s%s." % (len(outside), "" if len(outside) == 1 else "s", paths, ", ".join(outside[:6]), ", …" if len(outside) > 6 else "")
    if not items and not edges:
        return "--only %s left nothing out: every changed function is inside it." % paths
    return "%d item%s and %d edge candidate%s left out: their files are outside --only %s." % (items, "" if items == 1 else "s", edges, "" if edges == 1 else "s", paths)


__all__ = ["GLOB_CHARS", "inside_any", "narrow", "only_paths", "only_sentence", "untracked_sentence", "within"]
