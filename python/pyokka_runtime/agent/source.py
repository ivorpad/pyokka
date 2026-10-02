"""Where a run comes from: ``RunSource`` is the seam, ``SavedRun`` reads ``run.json``.

The command layer (``commands.py``) only ever sees the JSON shapes of ``docs/PROTOCOL.md``
("Context slice", the bridge replies): ``state``, ``context``, ``step``, ``values``, ``eval``,
``expand`` and the CLI-only ``story``, ``steps``, ``find``. ``LiveRun`` (``live.py``) talks to
the extension's bridge socket, receives the same context-slice JSON and implements the same
methods. Anything a source cannot do raises ``AgentError`` with a ``hint`` that says what to
do next.
"""

from __future__ import annotations

import bisect
import json
import os
from typing import Any, Protocol

from ..bindings import index_bindings, statement_bindings
from ..protocol import PROVENANCE_DEPTH, decode_steps
from ..redact import redact_value
from ..trace import Trace
from . import context as slice_mod
from . import history as history_mod
from .link import LinkClosed, SocketLink
from .recording import cap_info
from .save import file_hash, read_text


class AgentError(Exception):
    def __init__(self, message: str, hint: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint

    def to_json(self) -> dict:
        out: dict[str, Any] = {"ok": False, "error": self.message}
        if self.hint:
            out["hint"] = self.hint
        return out


class RunSource(Protocol):
    """What every command needs. Return values are the contract's JSON shapes (plain dicts)."""

    def state(self) -> dict: ...
    def context(self, *, step: int | None = None, file: str | None = None, line: int | None = None, scope: bool = False) -> dict: ...
    def step(self, step: int, *, kind: str | None = None, to: int | None = None, scope: bool = False) -> dict: ...
    def values(self, file: str, line: int) -> dict: ...
    def eval(self, expression: str) -> dict: ...
    def expand(self, value_id: str, query_path: list[str]) -> dict: ...
    def story(self, *, file: str | None = None, scope: str | None = None, line: tuple[str, int] | None = None, limit: int = slice_mod.STORY_LINE_CAP) -> dict: ...
    def steps(self, *, start: int = 0, count: int = 40, line: tuple[str, int] | None = None) -> dict: ...
    def find(self, text: str, limit: int = 50) -> dict: ...
    def walkthrough(self, *, file: str | None = None, scope: str | None = None, start: int | None = None, end: int | None = None, all_scopes: bool = False) -> dict: ...
    def var(self, name: str, *, file: str | None = None, scope: str | None = None, limit: int = 200) -> dict: ...
    def why(self, step: int | None, name: str = "", *, depth: int = PROVENANCE_DEPTH) -> dict: ...
    def origin(self, step: int | None, expr: str = "", *, depth: int = 20) -> dict: ...
    def graph(self, *, all_scopes: bool = False, scope: str | None = None, expand: list[str] | None = None, statements: bool = True) -> dict: ...
    def http(self) -> dict: ...
    def exceptions(self) -> dict: ...
    def close(self) -> None: ...


def display_path(path: str | None, workspace_root: str) -> str:
    """Workspace-relative, or from ``site-packages/`` on, or the path itself: never a bare absolute dump."""
    if not path:
        return "<unknown>"
    for marker in ("site-packages" + os.sep, "dist-packages" + os.sep):  # a venv inside the workspace is still a library
        i = path.rfind(marker)
        if i >= 0:
            return path[i + len(marker):]
    root = workspace_root.rstrip(os.sep) + os.sep
    if path.startswith(root):
        return path[len(root):]
    return path


class SavedRun:
    """A ``run.json`` written by ``save.py``: files table, trace, values, coverage, errors, staleness."""

    def __init__(self, path: str, doc: Any = None) -> None:
        """``doc`` is the ``{meta, events}`` document already in memory (a live session's ``recording`` reply); ``path`` then only names it."""
        self.path = os.path.abspath(path)
        if doc is None:
            try:
                with open(self.path, "r", encoding="utf-8") as fh:
                    doc = json.load(fh)
            except FileNotFoundError:
                raise AgentError("no saved run at %s" % self.path, "create one with `pyokka run FILE --save %s`" % os.path.basename(self.path)) from None
            except ValueError as exc:
                raise AgentError("%s is not a saved run: %s" % (self.path, exc), "save it again with `pyokka run FILE --save ...`") from None
        if not isinstance(doc, dict) or "events" not in doc or "meta" not in doc:
            raise AgentError("%s is not a saved run (no meta/events)" % self.path, "save it with `pyokka run FILE --save ...`")
        self.meta: dict = doc["meta"]
        self.events: list[dict] = doc["events"]
        self.workspace_root: str = str(self.meta.get("workspaceRoot") or os.path.dirname(str(self.meta.get("file") or self.path)))
        self.files: dict[int, dict] = {}
        self.logs: list[dict] = []
        self.logs_by_rid: dict[int, list[dict]] = {}
        self.locals_entries: list[dict] = []
        self.coverage: dict[int, dict] = {}
        self.errors: list[dict] = []
        self.output: list[dict] = []
        self.http_events: list[dict] = []
        self.finished: dict = {}
        trace_ev: dict | None = None
        for ev in self.events:
            kind = ev.get("type")
            if kind == "file.instrumented":
                self.files[int(ev["fileId"])] = ev
            elif kind == "log":
                self.logs.append(ev)
                self.logs_by_rid.setdefault(int(ev.get("rid", -1)), []).append(ev)
            elif kind == "locals":
                self.locals_entries.extend(ev.get("entries") or [])
            elif kind == "coverage":
                self.coverage[int(ev["fileId"])] = ev
            elif kind == "error":
                self.errors.append(ev)
            elif kind == "output":
                self.output.append(ev)
            elif kind == "http.exchange":
                self.http_events.append(ev)
            elif kind == "trace" and not ev.get("partial"):
                trace_ev = ev
            elif kind == "run.finished":
                self.finished = ev
        self.sorted_files = sorted(self.files.values(), key=lambda f: int(f["rangeBase"]))
        self._bases = [int(f["rangeBase"]) for f in self.sorted_files]
        self.locals_by_step: dict[int, list[dict]] = {}
        for entry in self.locals_entries:
            self.locals_by_step.setdefault(int(entry.get("step", -1)), []).append(entry)
        if trace_ev is not None:
            self.trace = Trace(decode_steps(trace_ev["steps"]), trace_ev.get("scopes") or [], self.locate_for_trace, bool(trace_ev.get("truncated")))
        else:
            self.trace = Trace([], [], self.locate_for_trace)
        # the recording began at a pause (`recordFrom`): step 0 is that pause, not the program's start
        self.mid_run = bool(trace_ev.get("midRun")) if trace_ev is not None else False
        # the step cap cut the trace: every verb says so first (`recording.py`)
        self.recording = cap_info(trace_ev, self.meta, self.display_path, self.trace.count)
        self._sources: dict[int, list[str]] = {}
        self._bindings: dict[int, dict[int, dict]] = {}
        self._stale: list[str] | None = None

    # -- files -----------------------------------------------------------------------------
    def main_file_id(self) -> int | None:
        main = str(self.meta.get("file") or "")
        for f in self.sorted_files:
            if os.path.abspath(str(f["path"])) == os.path.abspath(main):
                return int(f["fileId"])
        return int(self.sorted_files[0]["fileId"]) if self.sorted_files else None

    def bindings(self, file_id: int) -> dict[int, dict]:
        """What each statement of the file assigns and reads, by global range id (``bindings.py``); empty when the source is gone or does not parse."""
        if file_id not in self._bindings:
            f = self.files.get(file_id)
            src = "\n".join(self.source_lines(file_id))
            table: dict[int, dict] = {}
            if f and src:
                try:
                    entries = statement_bindings(src)
                except (SyntaxError, ValueError):
                    entries = []
                table = index_bindings(entries, f.get("ranges") or [], f.get("statements") or [], [int(fn.get("rid", -1)) for fn in f.get("functions") or []], int(f.get("rangeBase", 0)))
            self._bindings[file_id] = table
        return self._bindings[file_id]

    def locate(self, rid: int) -> dict | None:
        """``{fileId, path, range, localRid}`` for a global range id."""
        if not self.sorted_files:
            return None
        idx = bisect.bisect_right(self._bases, rid) - 1
        if idx < 0:
            return None
        f = self.sorted_files[idx]
        local = rid - int(f["rangeBase"])
        ranges = f.get("ranges") or []
        if local < 0 or local >= len(ranges):
            return None
        return {"fileId": int(f["fileId"]), "path": str(f["path"]), "range": ranges[local], "localRid": local}

    def locate_for_trace(self, rid: int):
        loc = self.locate(rid)
        return (loc["fileId"], loc["range"]) if loc else None

    def file_path(self, file_id: int) -> str | None:
        f = self.files.get(file_id)
        return str(f["path"]) if f else None

    def display_path(self, path: str | None) -> str:
        return display_path(path, self.workspace_root)

    def resolve_file(self, name: str) -> dict:
        """The file of the run that ``name`` (absolute path, suffix or basename) means."""
        if not self.files:
            raise AgentError("the run has no files", "the run did not start; check `pyokka run FILE --save`")
        wanted = os.path.abspath(name) if os.sep in name or name.startswith(".") else None
        exact = [f for f in self.sorted_files if wanted and os.path.abspath(str(f["path"])) == wanted]
        if exact:
            return exact[0]
        suffix = [f for f in self.sorted_files if str(f["path"]).endswith(os.sep + name) or os.path.basename(str(f["path"])) == name or self.display_path(str(f["path"])) == name]
        if len(suffix) == 1:
            return suffix[0]
        if len(suffix) > 1:
            raise AgentError("%s matches %d files of the run" % (name, len(suffix)), "use a longer suffix: " + ", ".join(self.display_path(str(f["path"])) for f in suffix[:6]))
        names = ", ".join(self.display_path(str(f["path"])) for f in self.sorted_files[:8])
        more = "" if len(self.sorted_files) <= 8 else ", … (%d files)" % len(self.sorted_files)
        raise AgentError("no file %s in the run" % name, "files that ran: %s%s" % (names, more))

    def source_lines(self, file_id: int) -> list[str]:
        """The file as it is on disk; the copy the run kept (``meta.files[].source``) when the file is gone."""
        if file_id not in self._sources:
            path = self.file_path(file_id)
            try:
                self._sources[file_id] = read_text(path).split("\n") if path else []
            except (OSError, UnicodeDecodeError, SyntaxError):
                kept = self.kept_source(path)
                self._sources[file_id] = kept.split("\n") if kept is not None else []
        return self._sources[file_id]

    def kept_source(self, path: str | None) -> str | None:
        """The redacted copy of ``path`` the run saved when it ran, if it saved one."""
        for f in self.meta.get("files") or []:
            if isinstance(f, dict) and str(f.get("path")) == str(path) and isinstance(f.get("source"), str):
                return f["source"]
        return None

    def scope_name(self, scope_id: int) -> str:
        s = self.trace.scope(scope_id)
        return str(s["name"]) if s else "<module>"

    # -- staleness ----------------------------------------------------------------------------------
    def stale_files(self) -> list[str]:
        if self._stale is None:
            out = []
            for f in self.meta.get("files") or []:
                path = str(f.get("path") or "")
                if not path or not f.get("sha256"):
                    continue
                if file_hash(path) != f["sha256"]:
                    out.append(path)
            self._stale = out
        return self._stale

    # -- the RunSource methods -----------------------------------------------------------------------------
    def state(self) -> dict:
        return {
            "runId": self.meta.get("runId"),
            "running": False,
            "finished": True,
            "stale": bool(self.stale_files()),
            "staleFiles": self.stale_files(),
            "nav": {"active": True, "step": 0, "count": self.trace.count},
            "file": self.meta.get("file"),
            "displayName": os.path.basename(str(self.meta.get("file") or "")),
            "exitCode": self.meta.get("exitCode"),
            "keep": self.meta.get("keep"),
        }

    def check_step(self, step: int) -> int:
        if self.trace.count == 0:
            raise AgentError("the run recorded no steps", "the file did not execute (syntax error?); see `pyokka story`")
        if not self.trace.valid(step):
            raise AgentError("step %d is past the recorded %d steps (0..%d)" % (step, self.trace.count, self.trace.count - 1) if step >= 0 else "step %d is negative" % step, "use `steps` or `find` to pick one")
        return step

    def step_on_line(self, file: str, line: int) -> int:
        f = self.resolve_file(file)
        fid = int(f["fileId"])
        on = self.trace.steps_on_line(fid, line)
        if on:
            return on[0]
        for j in range(self.trace.count):
            if self.trace._contains_line(j, fid, line):
                return j
        ran = sorted({self.trace.location(j)[1][0] for j in range(self.trace.count) if (self.trace.location(j) or (None, None))[0] == fid})
        near = [l for l in ran if abs(l - line) <= 5]
        hint = "lines of %s that ran near it: %s" % (self.display_path(str(f["path"])), ", ".join(map(str, near))) if near else ("no line of %s ran" % self.display_path(str(f["path"])) if not ran else "use `story --file %s` to see which lines ran" % self.display_path(str(f["path"])))
        raise AgentError("no step on %s:%d" % (self.display_path(str(f["path"])), line), hint)

    def context(self, *, step: int | None = None, file: str | None = None, line: int | None = None, scope: bool = False) -> dict:
        if step is None:
            if file is None or line is None:
                raise AgentError("context needs a step or --line FILE:LINE", "e.g. `context 12` or `context --line agent.py:16`")
            step = self.step_on_line(file, line)
        return slice_mod.context_slice(self, self.check_step(step), scope=scope)

    def step(self, step: int, *, kind: str | None = None, to: int | None = None, scope: bool = False) -> dict:
        step = self.check_step(step)
        if to is not None:
            target = self.check_step(to)
        elif kind:
            target = self.trace.move(step, kind)
            if target < 0:
                where = {"into": "the end of the run", "over": "the end of the run", "out": "the end of the run", "back": "the start of the run", "backOver": "the start of the run", "backOut": "the start of the run"}[kind]
                possible = [k for k, v in self.trace.moves(step).items() if v is not None]
                raise AgentError("cannot step %s from step %d: %s" % (kind, step, where), ("possible moves: " + ", ".join(possible)) if possible else "no move is possible from here")
        else:
            target = step
        out = slice_mod.context_slice(self, target, scope=scope)
        out["from"] = step
        return out

    def values(self, file: str, line: int) -> dict:
        f = self.resolve_file(file)
        return {"file": str(f["path"]), "line": line, "values": slice_mod.values_on_line(self, int(f["fileId"]), line)}

    def story(self, *, file: str | None = None, scope: str | None = None, line: tuple[str, int] | None = None, limit: int = slice_mod.STORY_LINE_CAP) -> dict:
        file_id = int(self.resolve_file(file)["fileId"]) if file else None
        line_key = (int(self.resolve_file(line[0])["fileId"]), line[1]) if line else None
        return slice_mod.story(self, file_id=file_id, scope=scope, line=line_key, line_cap=limit)

    def steps(self, *, start: int = 0, count: int = 40, line: tuple[str, int] | None = None) -> dict:
        return slice_mod.list_steps(self, start=start, count=count, line=(int(self.resolve_file(line[0])["fileId"]), line[1]) if line else None)

    def find(self, text: str, limit: int = 50) -> dict:
        return slice_mod.find(self, text, limit=limit)

    def walkthrough(self, *, file: str | None = None, scope: str | None = None, start: int | None = None, end: int | None = None, all_scopes: bool = False) -> dict:
        from .walkthrough import walkthrough

        return walkthrough(self, file=file, scope=scope, start=start, end=end, all_scopes=all_scopes)
    def var(self, name: str, *, file: str | None = None, scope: str | None = None, limit: int = history_mod.VAR_CAP) -> dict:
        if not name.strip():
            raise AgentError("var needs a variable name", "e.g. `var run.json dt`, or `var run.json self.balance`")
        file_id = int(self.resolve_file(file)["fileId"]) if file else None
        return history_mod.variable_history(self, name, file_id=file_id, scope=scope, limit=limit)

    def why(self, step: int | None, name: str = "", *, depth: int = PROVENANCE_DEPTH) -> dict:
        from .provenance import provenance

        if step is None:
            raise AgentError("why needs STEP, the step whose statement made the value", "e.g. `why run.json 24 label`; `var run.json label` lists the steps where it changed")
        out = provenance(self, self.check_step(step), name, depth=depth)
        out["stale"] = bool(self.stale_files())
        out["staleFiles"] = self.stale_files()
        return out

    def origin(self, step: int | None, expr: str = "", *, depth: int = 20) -> dict:
        from .origin import origin

        if step is None:
            raise AgentError("origin needs STEP, the step of the failing statement", "e.g. `origin run.json 64`; `exceptions run.json` lists the steps where exceptions were raised")
        out = origin(self, self.check_step(step), expr, depth=depth)
        out["stale"] = bool(self.stale_files())
        out["staleFiles"] = self.stale_files()
        return out

    def graph(self, *, all_scopes: bool = False, scope: str | None = None, expand: list[str] | None = None, statements: bool = True) -> dict:
        from .graph import graph

        return graph(self, all_scopes=all_scopes, scope=scope, expand=expand, statements=statements)

    def http(self) -> dict:
        from .http import http_table

        return http_table(self.http_events, self.finished.get("http"), locate=self.http_location, run_id=self.meta.get("runId"))

    def http_location(self, rid: int) -> dict | None:
        """``{file, line, col, fileId}`` of a range id: the shape of a context slice's ``location``, for a row's initiator."""
        loc = self.locate(rid)
        return {"file": loc["path"], "line": int(loc["range"][0]), "col": int(loc["range"][1]), "fileId": loc["fileId"]} if loc else None
    def exceptions(self) -> dict:
        from .exceptions import exceptions

        return exceptions(self)

    # -- the kept runner ------------------------------------------------------------------------------------
    def _keep_link(self) -> SocketLink:
        keep = self.meta.get("keep")
        if not keep:
            raise AgentError("this run was saved without --keep, so its values are gone", "run again with `pyokka run %s --save %s --keep`, or use --live with an open VS Code session" % (self.meta.get("file"), os.path.basename(self.path)))
        try:
            return SocketLink(str(keep.get("socket")), timeout=10.0)
        except LinkClosed:
            raise AgentError("the kept runner (pid %s) is gone" % keep.get("pid"), "run again with `pyokka run %s --save %s --keep`" % (self.meta.get("file"), os.path.basename(self.path))) from None

    def _keep_call(self, req: dict) -> dict:
        link = self._keep_link()
        try:
            reply = link.call(req)
        except LinkClosed as exc:
            raise AgentError("the kept runner stopped answering: %s" % exc, "run again with --keep") from None
        finally:
            link.close()
        if reply.get("type") == "error":
            raise AgentError(str(reply.get("message") or "request failed"), "names, attributes, subscripts, operators and pure calls can be evaluated (builtins like len, sorted, isinstance; non-mutating methods of str, dict, list, tuple, set); a user function is refused and no statement is re-run")
        return redact_value(reply)

    def eval(self, expression: str) -> dict:
        reply = self._keep_call({"type": "evaluate", "runId": self.meta.get("runId"), "expression": expression})
        return {"expression": expression, "text": reply.get("text"), "valueBag": reply.get("valueBag")}

    def expand(self, value_id: str, query_path: list[str]) -> dict:
        reply = self._keep_call({"type": "expand", "runId": self.meta.get("runId"), "valueId": value_id, "queryPath": query_path})
        return {"node": reply.get("node")}

    def release(self) -> dict:
        keep = self.meta.get("keep")
        if not keep:
            raise AgentError("this run has no kept runner", "nothing to release")
        try:
            link = SocketLink(str(keep.get("socket")), timeout=5.0)
        except LinkClosed:
            return {"released": False, "pid": keep.get("pid"), "note": "already gone"}
        try:
            link.send({"type": "shutdown"})
        finally:
            link.close()
        return {"released": True, "pid": keep.get("pid")}

    def close(self) -> None:
        return None


__all__ = ["AgentError", "RunSource", "SavedRun", "display_path"]
