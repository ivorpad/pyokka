"""``TourRun``: one pass over a ``SavedRun`` into the arrays and indexes the tour's rules read.

Per step: file, line, scope, depth, whether it entered a scope. Per scope: its steps, its
parent, the last step of everything under it. The walkthrough's moments with every library
scope unrolled (``MomentBuilder(all_scopes=True)``), the HTTP rows with the step of the
statement that issued each request, and every recorded local change filed at the statement
that made it (the rule ``var`` uses).
"""

from __future__ import annotations

import bisect
import os
import re
from typing import TYPE_CHECKING, Any

from ...bindings import assigned_paths, matches_name
from ...protocol import FLAG_SCOPE_ENTRY
from ..http import http_table
from ..moments import MomentBuilder
from ..walkthrough import is_user_file
from .astinfo import FileInfo, module_roots

if TYPE_CHECKING:
    from ..source import SavedRun

_LLM_URL = re.compile(r"/(chat/)?completions\b|/v1/messages\b|/responses\b|/embeddings\b|:generateContent|:streamGenerateContent|/api/(chat|generate)\b", re.I)


def is_llm_url(url: Any) -> bool:
    """A request to a model API: chat or text completions, messages, responses, embeddings, Gemini, Ollama."""
    return bool(_LLM_URL.search(str(url or "")))


class TourRun:
    def __init__(self, run: "SavedRun") -> None:
        self.run = run
        trace = run.trace
        self.trace = trace
        self.n = trace.count
        self.main = str(run.meta.get("file") or "")
        self.fid: list[int] = []
        self.line: list[int] = []
        self.scope: list[int] = []
        self.depth: list[int] = []
        self.entry: list[bool] = []
        self.by_scope: dict[int, list[int]] = {}
        self.steps_by_rid: dict[int, list[int]] = {}
        for i in range(self.n):
            loc = trace.location(i)
            self.fid.append(loc[0] if loc else -1)
            self.line.append(int(loc[1][0]) if loc else 0)
            sid = trace.scope_id(i)
            self.scope.append(sid)
            self.depth.append(trace.depth(i))
            self.entry.append(bool(trace.flags(i) & FLAG_SCOPE_ENTRY))
            self.by_scope.setdefault(sid, []).append(i)
            self.steps_by_rid.setdefault(trace.rid(i), []).append(i)
        self.scopes: dict[int, dict] = {int(s["scopeId"]): s for s in trace.scopes}
        self.builder = MomentBuilder(run, all_scopes=True)
        self.moments: list[dict] = self.builder.build()
        self.calls = [m for m in self.moments if m["kind"] in ("call", "tool") and m.get("entryStep") is not None and not m["text"].startswith("module ")]
        self.call_by_entry: dict[int, dict] = {int(m["entryStep"]): m for m in self.calls}
        self._infos: dict[int, FileInfo] = {}
        self._user: dict[int, bool] = {}
        self.user_paths = sorted({str(run.file_path(f)) for f in set(self.fid) if f >= 0 and self.user(f)})
        self.roots = module_roots(self.user_paths)
        self.defs: set[str] = set()
        for f in {f for f in self.fid if f >= 0 and self.user(f)}:
            self.defs |= self.info(f).defs
        self.children: dict[int, list[dict]] = {}
        for s in sorted(trace.scopes, key=lambda s: int(s["first"])):
            if str(s.get("name")) != "<module>":
                self.children.setdefault(int(s.get("parent", -1)), []).append(s)
        self._child_firsts = {p: [int(s["first"]) for s in kids] for p, kids in self.children.items()}
        self.decisions: dict[int, list[dict]] = {}
        for m in self.moments:
            if m["kind"] == "decision":
                self.decisions.setdefault(int(m["step"]), []).append(m)
        self.main_fid = run.main_file_id() if self.n else None
        self.http = self._http_rows()
        self.changes = self._changes()

    # -- files and statements -----------------------------------------------------------------------------
    def user(self, fid: int) -> bool:
        if fid not in self._user:
            self._user[fid] = is_user_file(self.run.file_path(fid), self.run.workspace_root, self.main)
        return self._user[fid]

    def info(self, fid: int) -> FileInfo:
        if fid not in self._infos:
            self._infos[fid] = FileInfo(self.run.source_lines(fid) if fid >= 0 else [])
        return self._infos[fid]

    def stmt(self, i: int) -> Any:
        return self.info(self.fid[i]).statements.get(self.line[i])

    def text(self, i: int) -> str:
        return self.info(self.fid[i]).statement_text(self.line[i])

    def path(self, i: int) -> str:
        return str(self.run.file_path(self.fid[i]) or "")

    def display(self, i: int) -> str:
        return self.run.display_path(self.run.file_path(self.fid[i]))

    def function(self, i: int) -> str:
        return self.builder.scope_qualname(self.scope[i])

    def scope_function(self, sid: int) -> str:
        return self.builder.scope_qualname(sid)

    # -- scopes ----------------------------------------------------------------------------------------------
    def parent(self, sid: int) -> int:
        s = self.scopes.get(sid)
        return int(s["parent"]) if s else -1

    def descends(self, sid: int, ancestor: int) -> bool:
        return sid != ancestor and self.builder.descends(sid, ancestor)

    def scope_last(self, sid: int) -> int:
        steps = self.by_scope.get(sid)
        return steps[-1] if steps else -1

    def next_in_scope(self, i: int) -> int | None:
        steps = self.by_scope.get(self.scope[i], [])
        k = bisect.bisect_right(steps, i)
        return steps[k] if k < len(steps) else None

    def prev_in_scope(self, i: int, sid: int | None = None) -> int | None:
        steps = self.by_scope.get(self.scope[i] if sid is None else sid, [])
        k = bisect.bisect_left(steps, i) - 1
        return steps[k] if k >= 0 else None

    def extent(self, m: dict) -> int:
        """Last step of a call and everything it led to: the step before its caller's next step, else the call's own end.

        A callback (``tool``) ends at its own end: its caller's next step is after the whole library
        call. ``endStep`` alone can run long: a scope whose recorded parent is too shallow (a
        LangGraph node under the first ``ask``) stretches its parent's subtree."""
        e = int(m["entryStep"])
        end = int(m.get("endStep") or e)
        if m["kind"] == "tool":
            return end
        own = self.by_scope.get(self.scope[e - 1] if e > 0 else -1, [])
        k = bisect.bisect_right(own, e)
        return own[k] - 1 if k < len(own) else max(end, self.scope_last(int(m["scopeId"])))

    def landing(self, sid: int) -> int:
        """Where the value a scope returned lands: its caller's next step (``if reply:`` after
        ``reply = await ask(...)``), else the scope's own last step (a callback of unrecorded code)."""
        last = self.scope_last(sid)
        m = self.call_by_entry.get(self.by_scope[sid][0]) if sid in self.by_scope else None
        if m is not None and m["kind"] == "tool":
            return last  # the recorded parent of a callback is not the frame it returns to
        parent = self.parent(sid)
        steps = self.by_scope.get(parent, [])
        k = bisect.bisect_right(steps, last)
        if parent >= 0 and k < len(steps) and self.user(self.fid[steps[k]]):
            return steps[k]
        return last

    def calls_made(self, i: int, cap: int = 20) -> list[dict]:
        """The scopes the statement at ``i`` entered: children of its scope that began before its
        scope's next step, without callbacks (a callback's recorded parent can be too shallow)."""
        sid = self.scope[i]
        nxt = self.next_in_scope(i)
        end = nxt if nxt is not None else self.n
        firsts = self._child_firsts.get(sid, [])
        kids = self.children.get(sid, [])
        k = bisect.bisect_right(firsts, i)
        out = []
        while k < len(kids) and firsts[k] < end and len(out) < cap:
            m = self.call_by_entry.get(firsts[k])
            if m is None or m["kind"] != "tool":
                out.append(kids[k])
            k += 1
        return out

    def decisions_at(self, i: int) -> list[dict]:
        return self.decisions.get(i, [])

    # -- recorded values --------------------------------------------------------------------------------------
    def _changes(self) -> dict[int, list[tuple[str, str, str]]]:
        """statement step -> ``[(role, name, text)]``: parameters at a scope's entry (``in``), else what the statement bound (``set``)."""
        out: dict[int, list[tuple[str, str, str]]] = {}
        assigns_cache: dict[tuple[int, int], list[str]] = {}
        for entry in self.run.locals_entries:
            observed = int(entry.get("step", -1))
            if not 0 <= observed < self.n:
                continue
            sid = int(entry.get("scopeId", self.scope[observed]))
            s = self.scopes.get(sid)
            first = int(s.get("first", -1)) if s is not None else -1
            prev = self.prev_in_scope(observed, sid) if observed != first else None
            # a function's first step is its `def` line, which binds nothing: what its next step sees are the arguments
            at_entry = s is not None and int(s.get("parent", -1)) >= 0 and str(s.get("name")) != "<module>" and (observed == first or prev == first)
            if at_entry:
                observed = first
            for ch in entry.get("changes") or []:
                name, text = str(ch.get("name") or ""), str(ch.get("text") if ch.get("text") is not None else "")
                if not name:
                    continue
                if at_entry:
                    out.setdefault(observed, []).append(("in", name, text))
                    continue
                target = observed
                if prev is not None:
                    key = (self.fid[prev], self.line[prev])
                    if key not in assigns_cache:
                        stmt = self.stmt(prev)
                        assigns_cache[key] = assigned_paths(stmt) if stmt is not None else []
                    if any(matches_name(a, name) for a in assigns_cache[key]):
                        target = prev
                out.setdefault(target, []).append(("set", name, text))
        return out

    def _http_rows(self) -> list[dict]:
        """The HTTP table's rows, each with ``step`` moved to the statement that issued it.

        A recording from before 0.1.7 gives every request of an ``asyncio.gather`` one step. When
        requests share a step and their own statement (the ``rid``) ran at least as often as it
        issued requests, the k-th request from it is filed at its k-th step.
        """
        if not self.run.http_events:
            return []
        rows = http_table(self.run.http_events, self.run.finished.get("http"), locate=self.run.http_location, run_id=self.run.meta.get("runId")).get("requests") or []
        rid_of = {str(e.get("n")): int(e.get("rid", -1)) for e in self.run.http_events if e.get("rid") is not None}
        by_rid: dict[int, list[dict]] = {}
        for r in rows:
            rid = rid_of.get(str(r.get("n")), -1)
            r["rid"] = rid
            by_rid.setdefault(rid, []).append(r)
        for rid, group in by_rid.items():
            steps = self.steps_by_rid.get(rid, [])
            if rid < 0 or not steps:
                continue
            filed = [int(r["step"]) for r in group if r.get("step") is not None]
            if len(filed) == len(group) and len(set(filed)) == len(filed) and all(self.trace.rid(s) == rid for s in filed):
                continue  # every request already at a step of its own statement
            if len(steps) >= len(group):
                for r, st in zip(sorted(group, key=lambda r: int(r.get("n") or 0)), steps):
                    r["recordedStep"] = r.get("step")
                    r["step"] = st
        for r in rows:
            r["llm"] = is_llm_url(r.get("url"))
        return [r for r in rows if r.get("step") is not None]

    def prints(self) -> list[dict]:
        return [ev for ev in self.run.logs if ev.get("kind") == "log" and ev.get("step") is not None]

    def file_label(self, path: str | None) -> str:
        return self.run.display_path(path) if path else "<unknown>"

    def short_path(self, i: int) -> str:
        p = self.display(i)
        parts = p.split(os.sep)
        return os.sep.join(parts[-2:]) if len(parts) > 2 else p


__all__ = ["TourRun", "is_llm_url"]
