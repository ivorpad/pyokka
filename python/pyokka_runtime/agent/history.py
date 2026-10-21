"""Variable history over a ``SavedRun``: every recorded change of one name, in step order.

The same rules as ``src/session/variableHistory.ts``; ``docs/PROTOCOL.md`` ("Variable history")
has the shape. Three sources, in order of trust: recorded locals (``recordLocals``, on by
default for ``pyokka run --save``), logged values whose context is the name (``# ?``, ``# ?+``, Auto
Log, identifier statements), and the statements that assign the name (bindings from the AST,
``bindings.py``) when nothing recorded the value. The provenance tree (``provenance.py``) reuses the
same lookups: ``rows`` for the change at a step, ``value_at`` for what a statement read.

A locals entry at step S is the state at the *start* of S, so a change it reports was made by
the scope's previous step; when that statement binds the name the change is attributed to it,
which is where the Time Machine should land. Loop headers are the exception: the per-iteration
step fires after the target is bound, so an iteration step owns the change it observes. Each
change carries ``reads``: the names the statement loaded, with the latest value recorded for
each before the step, one level, so a reader can walk backwards. The names are the source's
(``bindings.read_names``) unless the exact recording logged what the statement loaded (``reads``
on its locals entry), which leaves out an operand that did not run (``fallback`` in ``tier or fallback``).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from ..bindings import matches_name
from ..protocol import MAX_LOCALS_ENTRIES

if TYPE_CHECKING:
    from .source import SavedRun

VAR_CAP = 200
VAR_READS = 8
VALUE_KINDS = ("value", "autoLog", "autoExpand")  # a `# ?+` entry is a value of its context like a `# ?`


def is_definition(text: str | None) -> bool:
    """The repr of a function or a class: a value no statement of the run made."""
    return bool(text) and (str(text).startswith("<function ") or str(text).startswith("<class "))


def _module_scope_ids(run: "SavedRun", file_id: int) -> set[int]:
    """Scopes that are a module body of ``file_id``: scope 0 for the main file, the depth-1 module scope of an imported project file."""
    out: set[int] = set()
    for s in run.trace.scopes:
        loc = run.locate(int(s.get("rid", -1)))
        if loc and loc["fileId"] == file_id and loc["localRid"] == 0:
            out.add(int(s["scopeId"]))
    if file_id == run.main_file_id():
        out.add(0)
    return out


def _previous_step_in_scope(run: "SavedRun", step: int, scope_id: int) -> int:
    scope = run.trace.scope(scope_id)
    first = int(scope["first"]) if scope else 0
    j = step - 1
    while j >= first and j >= 0:
        if run.trace.scope_id(j) == scope_id:
            return j
        j -= 1
    return -1


def _next_step_in_scope(run: "SavedRun", step: int, scope_id: int) -> int:
    scope = run.trace.scope(scope_id)
    last = int(scope["last"]) if scope else run.trace.count - 1
    j = step + 1
    while j <= last and j < run.trace.count:
        if run.trace.scope_id(j) == scope_id:
            return j
        j += 1
    return -1


class History:
    def __init__(self, run: "SavedRun") -> None:
        self.run = run
        self.trace = run.trace
        # name -> [(observed step, scopeId, text, exact)] ascending
        self.locals_by_name: dict[str, list[tuple[int, int, str, bool]]] = {}
        # (step, scopeId, name) of the changes an exact recording made (`exacttrace.py`): made *by* that step,
        # where a snapshot change at step N was only observed at N, after the statement before it ran
        self.exact_keys: set[tuple[int, int, str]] = set()
        self.exact_steps: set[tuple[int, str]] = set()  # the same changes as (step, name), whatever scope recorded them
        # the same key -> how the name holds the object a statement changed through another name (`shared`)
        self.shared_by_key: dict[tuple[int, int, str], dict] = {}
        # the same key -> where a function or class value was defined (`defined: {fileId, line}`, `defsite.py`)
        self.defined_by_key: dict[tuple[int, int, str], dict] = {}
        # step -> the names its statement loaded, as the exact recording logged them (``reads`` on its entry)
        self.reads_by_step: dict[int, list[str]] = {}
        for entry in run.locals_entries:
            step = int(entry.get("step", -1))
            sid = int(entry.get("scopeId", 0))
            if isinstance(entry.get("reads"), list):
                have = self.reads_by_step.setdefault(step, [])
                have.extend(str(n) for n in entry["reads"] if str(n) not in have)
            for ch in entry.get("changes") or []:
                name = ch.get("name")
                if name:
                    self.locals_by_name.setdefault(str(name), []).append((step, sid, str(ch.get("text", "")), bool(ch.get("exact"))))
                    if ch.get("exact"):
                        self.exact_keys.add((step, sid, str(name)))
                        self.exact_steps.add((step, str(name)))
                    if isinstance(ch.get("shared"), dict):
                        self.shared_by_key[(step, sid, str(name))] = ch["shared"]
                    if isinstance(ch.get("defined"), dict):
                        self.defined_by_key[(step, sid, str(name))] = ch["defined"]
        for lst in self.locals_by_name.values():
            lst.sort(key=lambda t: t[0])
        # context -> [log events] ascending by step, the kinds that carry a variable's value
        self.values_by_context: dict[str, list[dict]] = {}
        for ev in run.logs:
            ctx = ev.get("context")
            if ctx and ev.get("kind") in VALUE_KINDS and ev.get("step") is not None:
                self.values_by_context.setdefault(str(ctx), []).append(ev)
        for lst in self.values_by_context.values():
            lst.sort(key=lambda e: int(e["step"]))
        self._module_scopes: dict[int, set[int]] = {}
        # every step was observed, so a name with no recorded change at the next step of its scope kept its object
        self.observed_all = 0 < len(run.locals_entries) < MAX_LOCALS_ENTRIES
        # a logged value is a change only when it is not a read: `print(x)` and a bare `x` log the value x already had
        for ctx, events in self.values_by_context.items():
            kept: list[dict] = []
            self.values_by_context[ctx] = kept  # value_at reads the events kept so far, all before this one
            kept.extend(ev for ev in events if not self.logged_read(ctx, ev))

    def logged_read(self, ctx: str, ev: dict) -> bool:
        """A logged value of ``ctx`` that its statement did not assign and that equals the value ``ctx`` had before it."""
        loc = self.run.locate(int(ev.get("rid", -1)))
        binding = self.run.bindings(int(loc["fileId"])).get(int(ev["rid"])) if loc else None
        if binding and any(matches_name(a, ctx) for a in binding.get("assigns") or []):
            return False
        step = int(ev["step"])
        where = self.trace.location(step)
        if where is None:
            return False
        before = self.value_at(ctx, step, self.trace.scope_id(step), where[0])
        return before.get("text") is not None and before["text"] == str(ev.get("text", ""))

    def module_scopes(self, file_id: int) -> set[int]:
        if file_id not in self._module_scopes:
            self._module_scopes[file_id] = _module_scope_ids(self.run, file_id)
        return self._module_scopes[file_id]

    def location(self, step: int) -> dict:
        """Where the statement at ``step`` is, as a change row (and a provenance node) carries it."""
        loc = self.trace.location(step)
        sid = self.trace.scope_id(step)
        return {
            "step": step,
            "file": self.run.file_path(loc[0]) if loc else None,
            "fileId": loc[0] if loc else -1,
            "line": int(loc[1][0]) if loc else 0,
            "function": self.run.scope_name(sid),
            "scopeId": sid,
        }

    def _row(self, step: int, name: str, text: str | None, source: str) -> dict:
        row: dict[str, Any] = {**self.location(step), "name": name, "source": source}
        if text is not None:
            row["text"] = text
        return row

    def log_for(self, step: int, name: str) -> str | None:
        """The log entry the statement at ``step`` wrote for ``name``, when there is one.

        A value is logged when its statement completes, so the entry's step is the last step the
        statement ran (inside a callee when it called one): the entry belongs to the statement whose
        range it names and lies between the step and the scope's next step.
        """
        rid = self.trace.rid(step)
        end = _next_step_in_scope(self.run, step, self.trace.scope_id(step))
        if end < 0:
            end = self.trace.count
        found: dict | None = None
        for ev in self.values_by_context.get(name, ()):
            s = int(ev["step"])
            if s >= end:
                break
            if s >= step and int(ev.get("rid", -1)) == rid:
                found = ev
        return str(found["logId"]) if found and found.get("logId") else None

    def value_at(self, name: str, step: int, scope_id: int, file_id: int) -> dict:
        """The latest recorded value of ``name`` visible at the start of ``step``, from the step's scope or its module.

        ``{name}`` alone when nothing was recorded; else ``text``, ``source`` (``locals`` or ``value``),
        ``step`` (the statement that made it, the same step the change list names), ``logId`` when a
        log entry holds the value and ``exact`` when the recorded change was made by that step. A function
        or class has no ``step``; ``defined`` (``file``, ``fileId``, ``line``) names its ``def`` or ``class``
        when the recording linked it.
        """
        scopes = {scope_id} | self.module_scopes(file_id)
        best_step = -1
        best_text: str | None = None
        best_scope = scope_id
        best_exact = False
        for s, sid, text, exact in reversed(self.locals_by_name.get(name, ())):
            if s > step or s == step and (s, sid, name) in self.exact_keys:
                continue  # an exact change at `step` is the statement's own write, not what it read
            if sid in scopes:
                best_step, best_text, best_scope, best_exact = s, text, sid, exact
                break
        event: dict | None = None
        for ev in reversed(self.values_by_context.get(name, ())):
            s = int(ev["step"])
            if s >= step or s <= best_step:
                continue
            if self.trace.scope_id(s) in scopes:
                best_step, best_text, event = s, str(ev.get("text", "")), ev
                break
        out: dict[str, Any] = {"name": name}
        if best_step < 0:
            return out
        out["text"] = best_text
        defined = self.defined_by_key.get((best_step, best_scope, name)) if event is None else None
        if event is None and (defined is not None or is_definition(best_text)):
            # a recorded local that is a definition has no producing step: `def` and `class` statements are
            # never steps, so the recorder saw the binding at whatever statement ran next. `defined` says
            # which `def` or `class` made it instead.
            out["source"] = "locals"
            if defined is not None:
                fid = int(defined.get("fileId", -1))
                out["defined"] = {"file": self.run.file_path(fid), "fileId": fid, "line": int(defined.get("line", 0))}
            return out
        if event is None:
            out["source"] = "locals"
            out["step"] = self.made_at(best_step, best_scope, name)
            if best_exact:
                out["exact"] = True
            shared = self.shared(best_step, best_scope, name)
            if shared:
                out["shared"] = shared
            log_id = self.log_for(int(out["step"]), name)
        else:
            out["source"] = "value"
            out["step"] = best_step
            log_id = event.get("logId")
        if log_id:
            out["logId"] = str(log_id)
        return out

    def binding_at(self, step: int) -> dict | None:
        loc = self.trace.location(step)
        if loc is None:
            return None
        return self.run.bindings(loc[0]).get(self.trace.rid(step))

    def is_iteration_step(self, step: int, binding: dict) -> bool:
        """A loop header step that follows a step of the loop's own lines in the same scope (not the step before the loop)."""
        end = binding.get("loop")
        if end is None:
            return False
        prev = _previous_step_in_scope(self.run, step, self.trace.scope_id(step))
        if prev < 0:
            return False
        here = self.trace.location(step)
        there = self.trace.location(prev)
        return bool(here and there and there[0] == here[0] and int(here[1][0]) <= int(there[1][0]) <= int(end))

    def shared(self, observed: int, scope_id: int, changed: str) -> dict | None:
        """How ``changed`` holds the object a change reached it through: ``{path, as?, since?}``, with ``since``'s
        place (``file``, ``line``, ``function``) added: where the edge into the object was first seen."""
        info = self.shared_by_key.get((observed, scope_id, changed))
        if info is None:
            return None
        out: dict[str, Any] = {k: info[k] for k in ("path", "as", "since") if k in info}
        since = info.get("since")
        if isinstance(since, int) and self.trace.valid(since):
            where = self.location(since)
            out.update({k: where[k] for k in ("file", "fileId", "line", "function")})
        return out

    def made_at(self, observed: int, scope_id: int, changed: str) -> int:
        """The step whose statement made a recorded change: its own for an exact one, else ``attribute``'s."""
        return observed if (observed, scope_id, changed) in self.exact_keys else self.attribute(observed, scope_id, changed)

    def attribute(self, observed: int, scope_id: int, changed: str) -> int:
        """The step whose statement made the change observed at ``observed``."""
        own = self.binding_at(observed)
        if own and own.get("loop") is not None and any(matches_name(a, changed) for a in own.get("assigns") or []) and self.is_iteration_step(observed, own):
            return observed
        prev = _previous_step_in_scope(self.run, observed, scope_id)
        if prev >= 0:
            binding = self.binding_at(prev)
            if binding and any(matches_name(a, changed) for a in binding.get("assigns") or []):
                return prev
        return observed

    def recorded_reads(self, step: int) -> bool:
        """Whether the exact recording logged the names the statement at ``step`` loaded. A loop's iteration step
        loads nothing (its iterable was loaded at the header's first step), so its reads stay the source's."""
        if step not in self.reads_by_step:
            return False
        binding = self.binding_at(step)
        return not (binding and binding.get("loop") is not None and self.is_iteration_step(step, binding))

    def read_names(self, step: int) -> list[str]:
        """The names the statement at ``step`` loaded, at most ``VAR_READS``: the recorded ones when the exact
        recording logged them (in the source's order where the binding lists the name, then the others in
        load order), else the binding's."""
        binding = self.binding_at(step) or {}
        source = list(binding.get("reads") or [])
        if not self.recorded_reads(step):
            return source[:VAR_READS]
        recorded = self.reads_by_step[step]
        return ([n for n in source if n in recorded] + [n for n in recorded if n not in source])[:VAR_READS]

    def resolved_reads(self, step: int) -> list[dict]:
        """The names the statement at ``step`` loaded (``read_names``), each resolved with ``value_at``."""
        loc = self.trace.location(step)
        if loc is None:
            return []
        sid = self.trace.scope_id(step)
        return [self.value_at(n, step, sid, loc[0]) for n in self.read_names(step)]

    def reads_for(self, step: int) -> list[dict]:
        """The change list's reads: ``{name, text?, step?}``, one level (the provenance tree keeps the rest)."""
        return [{k: v for k, v in r.items() if k in ("name", "text", "step")} for r in self.resolved_reads(step)]

    def rows(self, name: str) -> list[dict]:
        """Every change of ``name`` from the three sources, ascending by step, before caps, filters and reads."""
        rows: dict[tuple[int, str], dict] = {}
        recorded_in: dict[tuple[int, str], int] = {}  # a locals row's key -> the scope whose entry made it

        def add(row: dict, scope: int | None = None) -> None:
            key = (int(row["step"]), str(row["name"]))
            have = rows.get(key)
            if have is None:
                rows[key] = row
                if scope is not None:
                    recorded_in[key] = scope
            elif scope is not None and recorded_in.get(key) == scope:
                # the same frame recorded the name twice at one step: a statement a yield or an await split in two
                # (`d["got"] = yield d.pop("seed")`), closed again after the resume. The later one is its value after.
                have["text"] = row["text"]
                if "shared" in row:
                    have["shared"] = row["shared"]
                else:
                    have.pop("shared", None)
            elif row.get("logId") and not have.get("logId"):
                have["logId"] = row["logId"]

        # 1. recorded locals, attributed to the statement that bound the name when the scope's previous step did
        for entry in self.run.locals_entries:
            observed = int(entry.get("step", -1))
            sid = int(entry.get("scopeId", 0))
            if not self.trace.valid(observed):
                continue
            for ch in entry.get("changes") or []:
                changed = str(ch.get("name") or "")
                if not matches_name(changed, name):
                    continue
                row = self._row(self.made_at(observed, sid, changed), changed, str(ch.get("text", "")), "locals")
                shared = self.shared(observed, sid, changed)
                if shared:
                    row["shared"] = shared
                add(row, sid)
        # 2. logged values whose context is the name (or a path under it)
        for ctx, events in self.values_by_context.items():
            if not matches_name(ctx, name):
                continue
            for ev in events:
                step = int(ev["step"])
                if not self.trace.valid(step):
                    continue
                row = self._row(step, ctx, str(ev.get("text", "")), "value")
                if ev.get("logId"):
                    row["logId"] = ev["logId"]
                add(row)
        # 3. statements that assign the name, where nothing recorded the value (a loop header only on its iteration steps)
        assigning: dict[int, tuple[str, dict]] = {}
        for fid in list(self.run.files):
            for rid, binding in self.run.bindings(fid).items():
                for a in binding.get("assigns") or []:
                    if matches_name(a, name):
                        assigning[rid] = (a, binding)
                        break
        if assigning:
            steps_with_rows = {k[0] for k in rows}
            for step in range(self.trace.count):
                hit = assigning.get(self.trace.rid(step))
                if hit is None or step in steps_with_rows:
                    continue
                a, binding = hit
                if binding.get("loop") is not None and not self.is_iteration_step(step, binding):
                    continue
                row = self._row(step, a, None, "assign")
                # The scope's next step recorded no change for the name, so it is the same object. That
                # is not the same as unchanged: the marker in `tracer._record_locals` is (id, len), so
                # `d[k] = v` on a key that already exists is invisible and the text below is the value
                # from before the statement. Rendered as `(same object)` for that reason; making it
                # exact needs the instrumenter to tell the tracer which names a statement assigns
                # (docs/HANDOFF.md, work items).
                if self.observed_all and a == name and _next_step_in_scope(self.run, step, row["scopeId"]) >= 0:
                    before = self.value_at(a, step, row["scopeId"], row["fileId"])
                    if before.get("text") is not None:
                        row["text"] = before["text"]
                        row["unchanged"] = True
                add(row)
        return sorted(rows.values(), key=lambda r: (int(r["step"]), str(r["name"])))

    def first_change_after(self, name: str, step: int, scope_id: int, file_id: int) -> dict | None:
        """The first change ``var`` lists for exactly ``name`` after ``step``, in the step's scope or its module:
        where a name with no value yet at ``step`` gets one."""
        scopes = {scope_id} | self.module_scopes(file_id)
        for row in self.rows(name):  # ascending by step
            if row["name"] == name and int(row["step"]) > step and int(row["scopeId"]) in scopes:
                return row
        return None

    def build(self, name: str, *, file_id: int | None = None, scope: str | None = None, limit: int = VAR_CAP) -> dict:
        ordered = self.rows(name)
        if file_id is not None:
            ordered = [r for r in ordered if r["fileId"] == file_id]
        if scope is not None:
            ordered = [r for r in ordered if r["function"] == scope]
        shown = ordered[: max(1, limit)]
        for row in shown:
            reads = self.reads_for(int(row["step"]))
            if reads:
                row["reads"] = reads
        return {
            "name": name,
            "changes": shown,
            "total": len(ordered),
            "truncated": len(ordered) > len(shown),
            "recordedLocals": bool(self.run.locals_entries),
            "stale": bool(self.run.stale_files()),
            "staleFiles": self.run.stale_files(),
        }


def variable_history(run: "SavedRun", name: str, *, file_id: int | None = None, scope: str | None = None, limit: int = VAR_CAP) -> dict:
    """Every recorded change of ``name`` (``docs/PROTOCOL.md``, "Variable history"), ascending by step."""
    return History(run).build(name.strip(), file_id=file_id, scope=scope, limit=limit)


__all__ = ["variable_history", "History", "VAR_CAP", "VAR_READS", "VALUE_KINDS"]
