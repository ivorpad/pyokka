"""The provenance tree (``pyokka why``): why a value is what it is, walked backwards through the run.

``docs/PROTOCOL.md`` ("Provenance") has the shape and the rules; ``src/session/provenance.ts``
is the same builder over a live session and ``test/unit/fixtures/provenance.json`` pins both to
the same trees. Nothing here is new data: the root is the change ``var`` lists at the step (or
the value the name had when the step ran), a node's reads are ``var``'s reads resolved one
statement further back, its calls are the walkthrough's call moments in short, and the calls no
stepped scope claimed come from the bindings' ``calls`` texts. Expansion is breadth-first with
a depth and a node budget, so a tree over a long chain stays readable.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from ..protocol import PROVENANCE_DEPTH, PROVENANCE_MAX_DEPTH, PROVENANCE_NODES
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

    def node(self, name: str, step: int, *, text: str | None = None, source: str | None = None, log_id: str | None = None, unchanged: bool = False) -> dict:
        out: dict[str, Any] = {"name": name}
        if text is not None:
            out["text"] = text
        if source:
            out["source"] = source
        if log_id:
            out["logId"] = log_id
        if unchanged:
            out["unchanged"] = True
        out.update(self.history.location(step))
        statement = self.statement(step)
        if statement is not None:
            out["statement"] = statement
        return out

    def leaf(self, name: str) -> dict:
        """Nothing recorded for the name. In a recording that began mid-run that is where the chain ends: at step 0."""
        return {"name": name, "beforeRecording": True} if getattr(self.run, "mid_run", False) else {"name": name}

    def from_read(self, read: dict) -> dict:
        """A node for what ``value_at`` found: a leaf when nothing was recorded, else the producing statement."""
        if read.get("step") is None:
            return self.leaf(read["name"]) if read.get("text") is None else {"name": read["name"]}
        return self.node(read["name"], int(read["step"]), text=read.get("text"), source=read.get("source"), log_id=read.get("logId"))

    def root(self, name: str, step: int) -> dict:
        """The value ``name`` had after ``step``: the change made there, else the value read there, else a leaf.

        A dotted name nothing recorded falls back to its first segment by the read rule (``self`` for
        ``self.balance``); the node says so by its ``name``. An empty name is the statement itself.
        """
        if not name:
            return self.node("", step)
        rows = [r for r in self.history.rows(name) if int(r["step"]) == step]
        exact = [r for r in rows if r["name"] == name]
        row = exact[0] if exact else rows[0] if rows else None
        if row is not None:
            log_id = row.get("logId") or self.history.log_for(step, str(row["name"]))
            return self.node(str(row["name"]), step, text=row.get("text"), source=row.get("source"), log_id=log_id, unchanged=bool(row.get("unchanged")))
        loc = self.trace.location(step)
        scope_id, file_id = self.trace.scope_id(step), loc[0] if loc else -1
        read = self.history.value_at(name, step, scope_id, file_id)
        if read.get("step") is None and "." in name:
            read = self.history.value_at(name.split(".", 1)[0], step, scope_id, file_id)
        return self.from_read(read) if read.get("step") is not None else self.leaf(name)

    # -- a statement's inputs ---------------------------------------------------------------------------------
    def reads(self, step: int) -> list[dict]:
        return [self.from_read(r) for r in self.history.resolved_reads(step)]

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
