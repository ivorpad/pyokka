"""The moment builder behind ``walkthrough.py``: one pass per kind over a ``SavedRun``.

Calls (with library scopes merged per user-code call site), decisions and loops (from the
``decisions.py`` file map), logged values, prints and errors, then the start and end. The
sentences are templates over recorded data; the shape is in ``docs/PROTOCOL.md``.
"""

from __future__ import annotations

import bisect
import os
import re
from typing import TYPE_CHECKING, Any

from .decisions import enclosing_function, file_map
from .source import display_path
from .walkthrough import INLINE_MAX, PRINT_MAX, VALUE_MAX, cut, format_duration, is_user_file, library_package

if TYPE_CHECKING:
    from .source import SavedRun

_ORDER = {"start": 0, "call": 1, "tool": 1, "decision": 2, "value": 3, "print": 4, "error": 5, "end": 9}
_VALUE_KINDS = ("value", "autoLog", "logpoint")
_SKIP_PARAMS = ("self", "cls")
PARAM_MAX = 20


class MomentBuilder:
    def __init__(self, run: "SavedRun", *, all_scopes: bool = False) -> None:
        self.run = run
        self.trace = run.trace
        self.all = all_scopes
        self.main = str(run.meta.get("file") or "")
        self.root = run.workspace_root
        self._fmaps: dict[int, dict] = {}
        self._user: dict[int, bool] = {}
        self.consumed: set[int] = set()  # ids of log events used as in/out/took
        self.moments: list[dict] = []
        self.steps_by_scope: dict[int, list[int]] = {}
        for i in range(self.trace.count):
            self.steps_by_scope.setdefault(self.trace.scope_id(i), []).append(i)
        self.logs_by_step: dict[int, list[dict]] = {}
        for ev in run.logs:
            if ev.get("step") is not None:
                self.logs_by_step.setdefault(int(ev["step"]), []).append(ev)
        self.log_steps = sorted(self.logs_by_step)

    def logs_in(self, first: int, last: int):
        """``(step, event)`` for every log event recorded at a step in ``first..last``, in step order (bisect: a long scope over a run with few logs costs nothing)."""
        i = bisect.bisect_left(self.log_steps, first)
        while i < len(self.log_steps) and self.log_steps[i] <= last:
            step = self.log_steps[i]
            for ev in self.logs_by_step[step]:
                yield step, ev
            i += 1

    # -- files ----------------------------------------------------------------------------------------------
    def fmap(self, fid: int) -> dict:
        if fid not in self._fmaps:
            self._fmaps[fid] = file_map("\n".join(self.run.source_lines(fid)))
        return self._fmaps[fid]

    def user(self, fid: int) -> bool:
        if fid not in self._user:
            self._user[fid] = is_user_file(self.run.file_path(fid), self.root, self.main)
        return self._user[fid]

    def loc(self, step: int) -> tuple[int, int, int]:
        """``(fileId, line, rid)`` of a step; ``(-1, 0, rid)`` without a mapping."""
        l = self.trace.location(step)
        return (l[0], int(l[1][0]), self.trace.rid(step)) if l else (-1, 0, self.trace.rid(step))

    def location(self, step: int, function: str | None = None) -> dict:
        fid, line, _ = self.loc(step)
        return {"file": self.run.file_path(fid), "line": line, "function": function if function is not None else self.scope_qualname(self.trace.scope_id(step)), "fileId": fid}

    def main_file_id(self) -> int:
        for fid, f in self.run.files.items():
            if os.path.abspath(str(f.get("path"))) == os.path.abspath(self.main):
                return fid
        return min(self.run.files) if self.run.files else 1

    def display(self, fid: int) -> str:
        return display_path(self.run.file_path(fid), self.root)

    # -- names ----------------------------------------------------------------------------------------------
    def scope_qualname(self, scope_id: int) -> str:
        s = self.trace.scope(scope_id)
        if not s or int(s.get("parent", -1)) < 0:
            return "<module>"
        loc = self.run.locate(int(s["rid"]))
        if loc is None:
            return str(s["name"])
        if str(s["name"]) == "<module>":
            return "<module>"
        qual = self.fmap(loc["fileId"])["qualnames"].get(int(loc["range"][0]))
        return qual or str(s["name"])

    def function_at(self, fid: int, line: int) -> str:
        fn = enclosing_function(self.fmap(fid), line)
        return fn["name"] if fn else "<module>"

    # -- scopes --------------------------------------------------------------------------------------------
    def call_site(self, scope: dict) -> int:
        steps = self.steps_by_scope.get(int(scope["parent"]), [])
        i = bisect.bisect_left(steps, int(scope["first"])) - 1
        return steps[i] if i >= 0 else int(scope["first"])

    def site_in(self, scope_id: int, before: int) -> int:
        """The last step of scope ``scope_id`` before step ``before`` (``before`` itself when there is none)."""
        steps = self.steps_by_scope.get(scope_id, [])
        i = bisect.bisect_left(steps, before) - 1
        return steps[i] if i >= 0 else before

    def statement_text(self, step: int) -> str:
        """The source of the whole statement a step ran (every line of its range)."""
        loc = self.run.locate(self.trace.rid(step))
        if loc is None:
            return ""
        lines = self.run.source_lines(int(loc["fileId"]))
        rng = loc["range"]
        return "\n".join(lines[int(rng[0]) - 1:int(rng[2])])

    def callback_caller(self, s: dict, site: int, open_scopes: list[dict]) -> int | None:
        """The scope that was running when code the recording does not show called ``s`` back, else ``None``.

        ``s`` is a callback when the statement at its call site has a call but does not name it
        (``graph.invoke(state)`` entering a node function; dunders, lambdas and comprehensions are
        never counted). Its recorded parent can be too shallow: the tracer looks a few frames up for
        a caller, and a library's own frames use them up, so a LangGraph node's parent is the
        module. The caller is then the latest-entered scope under the recorded parent that was still
        running (it records a step after ``s`` entered); else the recorded parent.
        """
        name = str(s["name"]).rsplit(".", 1)[-1]
        first = int(s["first"])
        if name.startswith("<") or (name.startswith("__") and name.endswith("__")) or site >= first:
            return None
        text = self.statement_text(site)
        if "(" not in text or re.search(r"(?<![A-Za-z0-9_])%s(?![A-Za-z0-9_])" % re.escape(name), text) or self.generator(s):
            return None
        parent = int(s["parent"])
        best: dict | None = None
        for q in open_scopes:
            if int(q["last"]) > first and int(q["first"]) < first and (best is None or int(q["first"]) > int(best["first"])) and self.descends(int(q["scopeId"]), parent):
                best = q
        return int(best["scopeId"]) if best is not None else parent

    def generator(self, s: dict) -> bool:
        """Whether the scope's function has a ``yield``: ``next(g)`` resumes it under a name the statement does not show."""
        loc = self.run.locate(int(s["rid"]))
        if loc is None:
            return False
        line = int(loc["range"][0])
        fn = self.fmap(loc["fileId"])["functions"].get(line)
        end = int(fn["end"]) if fn else line
        lines = self.run.source_lines(loc["fileId"])[line - 1:end]
        return any(re.search(r"(?<![A-Za-z0-9_])yield(?![A-Za-z0-9_])", ln) for ln in lines)

    def descends(self, scope_id: int, ancestor: int) -> bool:
        """Whether ``scope_id`` is a strict descendant of ``ancestor`` in the recorded parents."""
        s = self.trace.scope(scope_id)
        hops = 0
        while s and int(s.get("parent", -1)) >= 0 and hops < 10_000:
            p = int(s["parent"])
            if p == ancestor:
                return True
            s = self.trace.scope(p)
            hops += 1
        return False

    def params(self, scope: dict) -> list[dict]:
        first = int(scope["first"])
        out: list[dict] = []
        for step in (first, first + 1):
            for entry in self.run.locals_by_step.get(step, ()):
                if int(entry.get("scopeId", -1)) == int(scope["scopeId"]):
                    out.extend({"role": "in", "name": str(ch.get("name")), "text": cut(ch.get("text"), VALUE_MAX)} for ch in entry.get("changes") or [] if ch.get("name") not in _SKIP_PARAMS)
                    if out:
                        break
            if out:
                break
        for step in (first, first + 1):
            for ev in self.logs_by_step.get(step, ()):
                if int(ev.get("rid", -1)) == int(scope["rid"]) and ev.get("kind") in _VALUE_KINDS and id(ev) not in self.consumed:
                    self.consumed.add(id(ev))
                    out.append({"role": "in", "name": str(ev.get("context") or "value"), "text": cut(ev.get("text"), VALUE_MAX)})
        return out[:PARAM_MAX]

    def result(self, scope: dict, call_site: int, last: int) -> list[dict]:
        """The ``out`` row: what the scope recorded at its exit (``returned``), else what the logs suggest (runs from before 0.1.7).

        A function that ran off the end of its body (``returned: null``) gets no row, as before.
        """
        first = int(scope["first"])
        loc = self.run.locate(int(scope["rid"]))
        if "returned" in scope or "raised" in scope:
            self.consume_return_logs(scope, loc, first, last)
            returned = scope.get("returned")  # null: the body ran off its end, nothing to show
            return [{"role": "out", "name": "return", "text": cut(returned, VALUE_MAX)}] if returned is not None else []
        if str(scope["name"]).startswith("<") and str(scope["name"]) != "<module>":
            # a lambda or a generator expression records no return value, and the value its call
            # site logged (`ranked = sorted(..., key=lambda kv: kv[1])`) is the statement's, not its own
            return []
        if loc is not None and self.user(loc["fileId"]):
            returns = self.fmap(loc["fileId"])["returns"]
            best: dict | None = None
            for step, ev in self.logs_in(first, last):
                if ev.get("kind") in _VALUE_KINDS and int(ev.get("fileId", -1)) == loc["fileId"] and id(ev) not in self.consumed:
                    l = self.run.locate(int(ev.get("rid", -1)))
                    if l and int(l["range"][0]) in returns:
                        best = ev
            if best is not None:
                self.consumed.add(id(best))
                return [{"role": "out", "name": "return", "text": cut(best.get("text"), VALUE_MAX)}]
        site_rid = self.trace.rid(call_site)
        best = None
        for step, ev in self.logs_in(call_site, last + 1):
            if int(ev.get("rid", -1)) == site_rid and ev.get("kind") in _VALUE_KINDS and id(ev) not in self.consumed:
                best = ev
        if best is not None:
            self.consumed.add(id(best))
            return [{"role": "out", "name": str(best.get("context") or "value"), "text": cut(best.get("text"), VALUE_MAX)}]
        lfid, lline, _ = self.loc(last)
        src = self.run.source_lines(lfid) if lfid >= 0 else []
        stmt = src[lline - 1].strip() if 0 < lline <= len(src) else ""
        returned = stmt[len("return "):].strip() if stmt.startswith("return ") else None
        if returned and returned.isidentifier():
            for entry in self.run.locals_by_step.get(last, ()):
                if int(entry.get("scopeId", -1)) == int(scope["scopeId"]):
                    for ch in entry.get("changes") or []:
                        if ch.get("name") == returned:
                            return [{"role": "out", "name": "return", "text": cut(ch.get("text"), VALUE_MAX)}]
        return []

    def consume_return_logs(self, scope: dict, loc: dict | None, first: int, last: int) -> None:
        """The value logs of this function's own ``return`` lines (``--auto-log``), so they are not listed again as values."""
        if loc is None or not self.user(loc["fileId"]):
            return
        fmap = self.fmap(loc["fileId"])
        returns, def_line = fmap["returns"], int(loc["range"][0])
        # `return f(x)` logs after f's steps, at f's last one: read on to the caller's next step
        after = self.steps_by_scope.get(int(scope.get("parent", -1)), [])
        i = bisect.bisect_right(after, last)
        end = after[i] if i < len(after) else self.trace.count
        for step, ev in self.logs_in(first, max(end, last + 2) - 1):
            if ev.get("kind") in _VALUE_KINDS and int(ev.get("fileId", -1)) == loc["fileId"] and id(ev) not in self.consumed:
                l = self.run.locate(int(ev.get("rid", -1)))
                line = int(l["range"][0]) if l else -1
                fn = enclosing_function(fmap, line) if line in returns else None
                if fn is not None and int(fn["line"]) == def_line:
                    self.consumed.add(id(ev))

    def exit_raised(self, scope: dict, first: int, last: int) -> list[dict]:
        """The exception a scope recorded leaving it by, when ``raised`` found no unhandled error event (the caller caught it)."""
        name = scope.get("raised")
        if not name:
            return []
        for ev in self.run.errors:
            if ev.get("errorType") == name and ev.get("step") is not None and first <= int(ev["step"]) <= last:
                message = cut(ev.get("message"), VALUE_MAX)
                return [{"role": "out", "name": "raised", "text": "%s%s" % (name, (": " + message) if message else "")}]
        return [{"role": "out", "name": "raised", "text": str(name)}]

    def raised(self, first: int, last: int) -> list[dict]:
        out = []
        for ev in self.run.errors:
            if not ev.get("handled") and ev.get("step") is not None and first <= int(ev["step"]) <= last:
                message = cut(ev.get("message"), VALUE_MAX)
                out.append({"role": "out", "name": "raised", "text": "%s%s" % (ev.get("errorType"), (": " + message) if message else "")})
                break
        return out

    def calls(self) -> None:
        scopes = sorted((s for s in self.trace.scopes if int(s.get("parent", -1)) >= 0), key=lambda s: int(s["first"]))
        groups: dict[int, dict] = {}  # root scopeId -> group
        group_of: dict[int, int] = {}  # member scopeId -> root scopeId
        root_by_site: dict[tuple, int] = {}
        entries: list[dict] = []  # per user call / tool / group: {kind, scope, call_site, members, caller?}
        running: list[dict] = []  # non-library scopes entered so far that may still record a step
        for s in scopes:
            sid = int(s["scopeId"])
            parent = int(s["parent"])
            loc = self.run.locate(int(s["rid"]))
            fid = loc["fileId"] if loc else -1
            library = not self.user(fid) and fid >= 0 and str(s["name"]) != "<module>"
            first = int(s["first"])
            running = [q for q in running if int(q["last"]) > first]
            if not library:
                running.append(s)
            if library and not self.all:
                if parent in group_of:
                    root = group_of[parent]
                    groups[root]["members"].append(s)
                    group_of[sid] = root
                    continue
                site = self.call_site(s)
                pkg = library_package(self.run.file_path(fid))
                if (site, pkg) in root_by_site and int(self.trace.scope(root_by_site[(site, pkg)])["parent"]) == parent:
                    root = root_by_site[(site, pkg)]
                    groups[root]["members"].append(s)
                    group_of[sid] = root
                    continue
                groups[sid] = {"kind": "call", "scope": s, "call_site": site, "members": [s], "library": True}
                group_of[sid] = sid
                root_by_site[(site, pkg)] = sid
                entries.append(groups[sid])
                continue
            kind = "tool" if (parent in group_of or (self.all and self._is_library_scope(parent))) and not library else "call"
            site = self.call_site(s)
            caller = parent if kind == "tool" else None
            if kind == "call" and not library and str(s["name"]) != "<module>":
                caller = self.callback_caller(s, site, running)
                if caller is not None:
                    kind = "tool"
                    site = self.site_in(caller, first)
            entries.append({"kind": kind, "scope": s, "call_site": site, "members": [s], "library": library, "caller": caller})
        # a call's extent: its own steps and those of every scope under it, so `return f(x)`
        # ends after f ran, not at the `return` statement (children enter after their parent)
        subtree_last: dict[int, int] = {int(s["scopeId"]): int(s["last"]) for s in scopes}
        for s in reversed(scopes):
            sid, parent = int(s["scopeId"]), int(s["parent"])
            if parent in subtree_last and subtree_last[sid] > subtree_last[parent]:
                subtree_last[parent] = subtree_last[sid]
        # numbering: calls of the same function from the same site
        counts: dict[tuple, int] = {}
        for e in entries:
            key = (int(e["scope"]["rid"]), self.trace.rid(e["call_site"]))
            e["key"] = key
            counts[key] = counts.get(key, 0) + 1
        seen: dict[tuple, int] = {}
        for e in entries:
            s = e["scope"]
            key = e["key"]
            seen[key] = seen.get(key, 0) + 1
            n, i = counts[key], seen[key]
            callee = self.scope_qualname(int(s["scopeId"]))
            first = int(s["first"])
            last = max(subtree_last[int(m["scopeId"])] for m in e["members"])
            site = e["call_site"]
            loc = self.run.locate(int(s["rid"]))
            fid = loc["fileId"] if loc else -1
            if str(s["name"]) == "<module>":
                text = "module %s runs" % self.display(fid)
                step = site
                location = self.location(site)
            elif e["kind"] == "tool":
                caller = self.scope_qualname(int(e["caller"]))
                site_fid = self.loc(site)[0]
                pkg = None if self.user(site_fid) else library_package(self.run.file_path(site_fid))
                text = ("%s calls back into %s (%s)" % (pkg, callee, caller)) if pkg else ("callback into %s from %s" % (callee, caller))
                step = first
                location = self.location(first, callee)
            else:
                caller = self.scope_qualname(int(s["parent"]))
                who = callee + ((" (%s)" % library_package(self.run.file_path(fid))) if e["library"] else "")
                text = ("call %d of %d to %s from %s" % (i, n, who, caller)) if n > 1 else ("call to %s from %s" % (who, caller))
                nested = len(e["members"]) - 1
                if nested:
                    text += ", %d nested call%s" % (nested, "" if nested == 1 else "s")
                step = site
                location = self.location(site, caller)
            values = self.params(s) + self.result(s, site, last) + (self.raised(first, last) or self.exit_raised(s, first, last))
            moment = {"kind": e["kind"], "step": step, "location": location, "text": text, "values": values, "scopeId": int(s["scopeId"]), "entryStep": first, "endStep": last, "callee": {"file": self.run.file_path(fid), "line": int(loc["range"][0]) if loc else 0, "function": callee, "fileId": fid}, "key": key}
            if e["kind"] == "tool":
                moment["callerScopeId"] = int(e["caller"])
            self.moments.append(moment)

    def _is_library_scope(self, scope_id: int) -> bool:
        s = self.trace.scope(scope_id)
        if not s or int(s.get("parent", -1)) < 0:
            return False
        loc = self.run.locate(int(s["rid"]))
        return loc is not None and not self.user(loc["fileId"]) and str(s["name"]) != "<module>"

    # -- decisions, loops ----------------------------------------------------------------------------------
    def next_in_scope(self, step: int) -> int | None:
        steps = self.steps_by_scope.get(self.trace.scope_id(step), [])
        i = bisect.bisect_right(steps, step)
        return steps[i] if i < len(steps) else None

    def took_value(self, step: int, rid: int) -> list[dict]:
        for ev in self.logs_by_step.get(step, ()):
            if int(ev.get("rid", -1)) == rid and ev.get("kind") in _VALUE_KINDS and id(ev) not in self.consumed:
                self.consumed.add(id(ev))
                return [{"role": "took", "name": str(ev.get("context") or "value"), "text": cut(ev.get("text"), VALUE_MAX)}]
        return []

    def decisions_and_loops(self) -> None:
        open_loops: dict[int, list[dict]] = {}  # scope -> stack of open loop moments
        for i in range(self.trace.count):
            fid, line, rid = self.loc(i)
            if fid < 0 or not self.user(fid):
                continue
            sid = self.trace.scope_id(i)
            loc = self.run.locate(rid)
            starts_here = loc is not None and int(loc["range"][0]) == line
            stack = open_loops.setdefault(sid, [])
            while stack and not (stack[-1]["_fid"] == fid and stack[-1]["_line"] <= line <= stack[-1]["_end"]):
                stack.pop()
            if not starts_here:
                continue
            fm = self.fmap(fid)
            loop = fm["loops"].get(line)
            if loop is not None:
                if stack and stack[-1]["_line"] == line and stack[-1]["_fid"] == fid:
                    stack[-1]["count"] += 1
                else:
                    m = {"kind": "decision", "step": i, "location": self.location(i), "text": "", "values": self.took_value(i, rid), "count": 1, "_loop": loop, "_fid": fid, "_line": line, "_end": int(loop["end"])}
                    stack.append(m)
                    self.moments.append(m)
                continue
            dec = fm["decisions"].get(line)
            if dec is None:
                continue
            nxt = self.next_in_scope(i)
            nline = self.loc(nxt)[1] if nxt is not None and self.loc(nxt)[0] == fid else -1
            self.moments.append({"kind": "decision", "step": i, "location": self.location(i), "text": self.decision_text(dec, nline), "values": self.took_value(i, rid)})
        for m in self.moments:
            loop = m.pop("_loop", None)
            if loop is not None:
                runs = int(m.pop("count")) - 1
                m.pop("_fid", None)
                m.pop("_line", None)
                m.pop("_end", None)
                m["text"] = "%s %s ran %d time%s" % (loop["kind"], loop["text"], runs, "" if runs == 1 else "s")
                m["count"] = runs

    @staticmethod
    def decision_text(dec: dict, next_line: int) -> str:
        """``if x took True``: the next step of the scope landed in the body; ``match x took case y`` likewise."""
        if dec["kind"] == "match":
            arm = next((a for a in dec["arms"] if a["body"][0] <= next_line <= a["body"][1]), None)
            return "match %s took %s" % (dec["text"], ("case %s" % arm["text"]) if arm else "no case")
        took = dec["body"][0] <= next_line <= dec["body"][1]
        return "%s %s took %s" % (dec["label"], dec["text"], "True" if took else "False")

    # -- values, prints, errors ------------------------------------------------------------------------------
    def values(self) -> None:
        for ev in self.run.logs:
            if id(ev) in self.consumed or ev.get("step") is None:
                continue
            fid = int(ev.get("fileId", -1))
            if not self.user(fid):
                continue
            step = int(ev["step"])
            loc = self.run.locate(int(ev.get("rid", -1)))
            line = int(loc["range"][0]) if loc else 0
            kind = ev.get("kind")
            location = {"file": self.run.file_path(fid), "line": line, "function": self.function_at(fid, line), "fileId": fid}
            if kind == "log":
                where = " to stderr" if ev.get("context") == "stderr" else ""
                self.moments.append({"kind": "print", "step": step, "location": location, "text": "prints%s %s" % (where, cut(ev.get("text"), PRINT_MAX)), "values": []})
            elif kind in _VALUE_KINDS:
                ctx = ev.get("context")
                text = ("%s = %s" % (ctx, cut(ev.get("text"), INLINE_MAX))) if ctx else cut(ev.get("text"), INLINE_MAX)
                self.moments.append({"kind": "value", "step": step, "location": location, "text": text, "values": [{"role": "value", "name": str(ctx or "value"), "text": cut(ev.get("text"), VALUE_MAX)}]})

    def errors(self) -> None:
        seen: set[tuple] = set()
        for ev in sorted(self.run.errors, key=lambda e: bool(e.get("handled"))):
            step = ev.get("step")
            key = (ev.get("errorType"), ev.get("message"), step)
            if key in seen or step is None:
                continue
            seen.add(key)
            step = int(step)
            frame = next((f for f in ev.get("stack") or [] if self.user(int(f.get("fileId", -1)))), None)
            if frame is not None:
                fid, line = int(frame["fileId"]), int(frame.get("line") or 0)
                location = {"file": self.run.file_path(fid), "line": line, "function": self.function_at(fid, line), "fileId": fid}
            else:
                location = self.location(step)
            message = cut(ev.get("message"), INLINE_MAX)
            text = "raised %s%s" % (ev.get("errorType"), (": " + message) if message else "")
            if ev.get("handled"):
                nxt = step + 1 if self.trace.valid(step + 1) else None
                if nxt is not None and self.loc(nxt)[0] >= 0:
                    nfid, nline, _ = self.loc(nxt)
                    text += ", handled at %s:%d" % (self.display(nfid), nline)
                else:
                    text += " (handled)"
            else:
                text += " uncaught"
            self.moments.append({"kind": "error", "step": step, "location": location, "text": text, "values": []})

    def ends(self) -> None:
        if self.trace.count == 0:
            return
        main = self.main_file_id()
        self.moments.append({"kind": "start", "step": 0, "location": self.location(0), "text": "module %s starts" % self.display(main), "values": []})
        last = self.trace.count - 1
        fin = self.run.finished or {}
        code = self.run.meta.get("exitCode", fin.get("exitCode"))
        ms = self.run.meta.get("durationMs", fin.get("durationMs"))
        if fin.get("timedOut"):
            text = "run killed by the timeout after %s" % format_duration(ms)
        elif fin.get("stopped"):
            text = "run stopped after %s" % format_duration(ms)
        else:
            text = "run ends with exit code %s after %s" % (code, format_duration(ms))
        self.moments.append({"kind": "end", "step": last, "location": self.location(last), "text": text, "values": []})

    # -- assembly --------------------------------------------------------------------------------------------
    def build(self) -> list[dict]:
        self.calls()
        self.decisions_and_loops()
        self.values()
        self.errors()
        self.ends()
        order = {id(m): n for n, m in enumerate(self.moments)}
        self.moments.sort(key=lambda m: (int(m["step"]), _ORDER.get(m["kind"], 5), order[id(m)]))
        for n, m in enumerate(self.moments):
            m["id"] = "m%d" % n
            m.setdefault("durationMs", None)
            m.setdefault("gloss", None)
        return self.moments


__all__ = ["MomentBuilder"]
