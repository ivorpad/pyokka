"""The provenance tree (``pyokka why``): why a value is what it is, walked backwards through the run.

``docs/PROTOCOL.md`` ("Provenance") has the shape and the rules; ``src/session/provenance.ts``
is the same builder over a live session and ``test/unit/fixtures/provenance.json`` pins both to
the same trees. Nothing here is new data: the root is the change ``var`` lists at the step (or
the value the name had when the step ran), a node's reads are ``var``'s reads resolved one
statement further back, its calls are the walkthrough's call moments in short, and the calls no
stepped scope claimed come from the bindings' ``calls`` texts. Expansion is breadth-first with
a depth and a node budget, so a tree over a long chain stays readable.

Every node with a step says how it was resolved (``resolution``): ``seen`` when a ``--follow-objects``
recording made its value at that step and, below the root, logged the reads of the statement above it;
``guessed`` otherwise (snapshot changes, parameters, logged ``# ?`` values, source-parsed reads). A
logged value is guessed though its text is exact: its step is the statement whose range the log entry
names (``log_for``), which is not always the one that made the value. The root for an empty name (the
statement itself) is seen when its reads were recorded.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from ..bindings import class_name, instance_class, parameter_argument
from ..protocol import MAX_LOCALS_ENTRIES, PROVENANCE_DEPTH, PROVENANCE_MAX_DEPTH, PROVENANCE_NODES
from .history import History
from .moments import MomentBuilder
from .why_text import conclusion

if TYPE_CHECKING:
    from .source import SavedRun

CALLS_SHOWN = 8
INPUTS_SHOWN = 8


def callee_name(call_text: str) -> str:
    """The last dotted name before the parenthesis: ``describe`` for ``helper.describe(total, os.sep)``."""
    head = call_text.split("(", 1)[0].strip()
    return head.rsplit(".", 1)[-1].strip()


class ProvenanceBuilder:
    def __init__(self, run: "SavedRun") -> None:
        self.run = run
        self.trace = run.trace
        self.history = History(run)
        self.moments = MomentBuilder(run)
        # call site -> the scopes it entered, in entry order (the walkthrough's rule: the parent's last step before the scope's first)
        self.scopes_by_site: dict[int, list[dict]] = {}
        for s in sorted((s for s in self.trace.scopes if int(s.get("parent", -1)) >= 0), key=lambda s: int(s["first"])):
            self.scopes_by_site.setdefault(self.moments.call_site(s), []).append(s)

    # -- nodes ------------------------------------------------------------------------------------------------
    def statement(self, step: int) -> str | None:
        """The first source line of the statement at ``step``, trimmed, ``…`` appended when it spans more lines."""
        loc = self.trace.location(step)
        if loc is None:
            return None
        src = self.run.source_lines(loc[0])
        line, end = int(loc[1][0]), int(loc[1][2])
        if not 0 < line <= len(src):
            return None
        text = src[line - 1].strip()
        return text + " …" if end > line else text

    def node(self, name: str, step: int, *, text: str | None = None, source: str | None = None, log_id: str | None = None, unchanged: bool = False, shared: dict | None = None) -> dict:
        out: dict[str, Any] = {"name": name}
        if text is not None:
            out["text"] = text
        if source:
            out["source"] = source
        if log_id:
            out["logId"] = log_id
        if unchanged:
            out["unchanged"] = True
        if shared:
            out["shared"] = shared  # the change came through another name: how this one holds the object
        out.update(self.history.location(step))
        statement = self.statement(step)
        if statement is not None:
            out["statement"] = statement
        return out

    def leaf(self, name: str) -> dict:
        """Nothing recorded for the name. In a recording that began mid-run that is where the chain ends: at step 0."""
        return {"name": name, "beforeRecording": True} if getattr(self.run, "mid_run", False) else {"name": name}

    def from_read(self, read: dict) -> dict:
        """A node for what ``value_at`` found: a leaf when nothing was recorded, else the producing statement.

        A function or class has a value and no step; its node is placed at the ``def`` or ``class`` that made it
        (``file``, ``fileId``, ``line``, and ``defined`` to say so) when the recording linked it."""
        if read.get("step") is None:
            if read.get("text") is None:
                return self.leaf(read["name"])
            out: dict[str, Any] = {"name": read["name"], "text": read["text"]}
            if read.get("source"):
                out["source"] = read["source"]
            if read.get("defined"):
                out.update(read["defined"])
                out["defined"] = True
            return out
        return self.node(read["name"], int(read["step"]), text=read.get("text"), source=read.get("source"), log_id=read.get("logId"), shared=read.get("shared"))

    def root(self, name: str, step: int) -> dict:
        """The value ``name`` had after ``step``: the change made there, else the value read there, else a leaf.

        A dotted name nothing recorded falls back to its first segment by the read rule (``self`` for
        ``self.balance``); the node says so by its ``name``. An empty name is the statement itself.
        """
        if not name:
            return self.labelled(self.node("", step), self.history.recorded_reads(step))  # the statement itself: exact when its reads were recorded
        rows = [r for r in self.history.rows(name) if int(r["step"]) == step]
        exact = [r for r in rows if r["name"] == name]
        row = exact[0] if exact else rows[0] if rows else None
        if row is not None:
            log_id = row.get("logId") or self.history.log_for(step, str(row["name"]))
            out = self.node(str(row["name"]), step, text=row.get("text"), source=row.get("source"), log_id=log_id, unchanged=bool(row.get("unchanged")), shared=row.get("shared"))
            # the entry's scope is the holder's for a change that reached the name through another one, so match by step and name
            return self.labelled(out, row.get("source") == "locals" and (step, str(row["name"])) in self.history.exact_steps)
        loc = self.trace.location(step)
        scope_id, file_id = self.trace.scope_id(step), loc[0] if loc else -1
        read = self.history.value_at(name, step, scope_id, file_id)
        if read.get("step") is None and "." in name:
            read = self.history.value_at(name.split(".", 1)[0], step, scope_id, file_id)
        return self.labelled(self.from_read(read), bool(read.get("exact"))) if read.get("step") is not None else self.not_yet(name, step, scope_id, file_id)

    def labelled(self, node: dict, exact: bool) -> dict:
        """``node`` with its ``resolution`` when it has a step (module docstring)."""
        if node.get("step") is not None:
            node["resolution"] = "seen" if exact else "guessed"
        return node

    def not_yet(self, name: str, step: int, scope_id: int, file_id: int) -> dict:
        """A root name with no value at ``step``. A later assignment in its scope (or its module) says it has
        none yet only when every earlier value would have been seen: locals recorded from the program's start,
        under the recorder's cap. Otherwise an earlier value may only have gone unrecorded: a run without
        locals answers the leaf, and a recording that began at a pause names the later assignment without
        ruling out a value made before step 0. A dotted name falls back to its first segment, as ``root`` does."""
        later = self.history.first_change_after(name, step, scope_id, file_id)
        if later is None and "." in name:
            later = self.history.first_change_after(name.split(".", 1)[0], step, scope_id, file_id)
        entries = self.run.locals_entries
        capped = len(entries) >= MAX_LOCALS_ENTRIES and int(entries[-1]["step"]) < step  # past the cap nothing was observed
        if later is None or not entries or capped:
            return self.leaf(name)
        first = dict(self.history.location(int(later["step"])))
        statement = self.statement(int(later["step"]))
        if statement is not None:
            first["statement"] = statement
        if getattr(self.run, "mid_run", False):
            return {"name": str(later["name"]), "beforeRecording": True, "firstAssigned": first}
        return {"name": str(later["name"]), "firstAssigned": first}

    # -- a statement's inputs ---------------------------------------------------------------------------------
    def reads(self, step: int) -> list[dict]:
        recorded = self.history.recorded_reads(step)
        return [self.labelled(self.from_read(r), recorded and bool(r.get("exact"))) for r in self.history.resolved_reads(step)]

    def argument(self, node: dict) -> tuple[dict, list[dict]] | None:
        """For a parameter (a node at the ``def`` header that entered its function): where the call passed it and
        the names that argument read there, each resolved at the call site like a statement's reads. None when
        the node is not a parameter or the call site does not say which argument it was (``parameter_argument``)."""
        name, step = str(node.get("name") or ""), int(node["step"])
        scope = self.trace.scope_by_id.get(self.trace.scope_id(step))
        if not name or scope is None or int(scope["first"]) != step or int(scope.get("parent", -1)) < 0:
            return None
        params = (self.history.binding_at(step) or {}).get("params")
        if not params or name not in self.history.binding_at(step).get("assigns", []):
            return None
        site, parent = self.moments.call_site(scope), int(scope["parent"])
        loc = self.trace.location(site)
        if site >= step or loc is None or self.trace.scope_id(site) != parent:
            return None
        file_id = int(loc[0])

        def value_of(text: str) -> str | None:
            value = self.history.value_at(text, site, parent, file_id).get("text") if text.isidentifier() else None
            return None if value is None else str(value)

        calls = (self.history.binding_at(site) or {}).get("args") or []
        # the times this statement entered this function, in entry order: which call this one was
        same = [s for s in self.scopes_by_site.get(site, ()) if int(s["parent"]) == parent and int(s["rid"]) == int(scope["rid"])]
        index = next((i for i, s in enumerate(same) if s is scope), -1)
        made = None
        if scope["name"] in ("__init__", "__new__") and params.get("positional"):
            first = self.root(str(params["positional"][0]), step)  # self (cls for __new__), as recorded at the entry
            made = (class_name if scope["name"] == "__new__" else instance_class)(str(first.get("text") or ""))
        arg = parameter_argument(name, str(scope["name"]), params, calls, value_of, made, index, len(same))
        if arg is None:
            return None
        out: dict[str, Any] = {"text": arg["text"]}
        out.update(self.history.location(site))
        statement = self.statement(site)
        if statement is not None:
            out["statement"] = statement
        recorded = self.history.recorded_reads(site)
        values = [self.history.value_at(n, site, parent, file_id) for n in arg["names"]]
        return out, [self.labelled(self.from_read(v), recorded and bool(v.get("exact"))) for v in values]

    def calls(self, step: int) -> list[dict]:
        """The scopes the statement entered, as the walkthrough's call moments list them, in entry order."""
        scope_id = self.trace.scope_id(step)
        out: list[dict] = []
        for s in self.scopes_by_site.get(step, ()):
            if int(s["parent"]) != scope_id:
                continue
            first, last = int(s["first"]), int(s["last"])
            loc = self.run.locate(int(s["rid"]))
            fid = loc["fileId"] if loc else -1
            self.moments.consumed.clear()  # params and result mark the log entries they use; every call node stands alone
            inputs = [{"name": p["name"], "text": p["text"]} for p in self.moments.params(s) if p.get("role") == "in"][:INPUTS_SHOWN]
            result = next((v["text"] for v in self.moments.result(s, step, last) if v.get("role") == "out"), None)
            call: dict[str, Any] = {"name": str(s["name"]), "scopeId": int(s["scopeId"]), "entryStep": first, "returnStep": last, "file": self.run.file_path(fid), "fileId": fid, "line": int(loc["range"][0]) if loc else 0, "inputs": inputs}
            if result is not None:
                call["result"] = result
            out.append(call)
            if len(out) == CALLS_SHOWN:
                break
        return out

    def opaque(self, step: int, calls: list[dict]) -> list[str]:
        """The bindings' call texts no stepped scope claimed: each scope takes the first unclaimed text whose
        callee is its name (an ``__init__`` scope: a callee that starts with a capital)."""
        binding = self.history.binding_at(step) or {}
        texts = list(binding.get("calls") or [])
        claimed: set[int] = set()
        for call in calls:
            for i, text in enumerate(texts):
                if i in claimed:
                    continue
                callee = callee_name(text)
                if callee == call["name"] or (call["name"] == "__init__" and callee[:1].isupper()):
                    claimed.add(i)
                    break
        return [t for i, t in enumerate(texts) if i not in claimed]

    # -- the tree ---------------------------------------------------------------------------------------------
    def build(self, name: str, step: int, depth: int, budget: int) -> dict:
        depth = max(1, min(PROVENANCE_MAX_DEPTH, int(depth)))
        root = self.root(name, step)
        count = 1
        truncated = False
        queue: list[tuple[dict, int]] = [(root, 0)]
        while queue:
            node, level = queue.pop(0)
            if node.get("step") is None:
                continue
            if level >= depth:
                node["cut"] = True
                continue
            reads = self.reads(int(node["step"]))
            passed = self.argument(node)
            if passed is not None:
                node["argument"] = passed[0]  # a parameter: the argument the call passed, whose names are its reads
                reads = reads + passed[1]
            if count + len(reads) > budget:
                node["cut"] = True
                truncated = True
                continue
            count += len(reads)
            calls = self.calls(int(node["step"]))
            node["reads"] = reads
            node["calls"] = calls
            node["opaque"] = self.opaque(int(node["step"]), calls)
            for read in reads:
                # a name read from itself, or a loop variable, ends here: only an earlier statement is walked
                if read.get("step") is not None and int(read["step"]) < int(node["step"]):
                    queue.append((read, level + 1))
        result = {"name": name, "step": step, "depth": depth, "nodes": count, "truncated": truncated, "recordedLocals": bool(self.run.locals_entries), "root": root}
        result["conclusion"] = conclusion(result)  # the answer in words (why_text.py); empty when nothing was recorded
        return result


def provenance(run: "SavedRun", step: int, name: str = "", depth: int = PROVENANCE_DEPTH, nodes: int = PROVENANCE_NODES) -> dict:
    """The tree of what produced the value ``name`` had after ``step`` (``docs/PROTOCOL.md``, "Provenance")."""
    return ProvenanceBuilder(run).build(name.strip(), step, depth, nodes)


__all__ = ["provenance", "ProvenanceBuilder", "callee_name", "CALLS_SHOWN", "INPUTS_SHOWN"]
