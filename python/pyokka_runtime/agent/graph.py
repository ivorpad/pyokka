"""The execution graph: the diagram of a run as a projection of the walkthrough (``docs/PROTOCOL.md``, "Execution graph").

Nodes are the modules, the user functions, the library packages (or, unrolled, their functions),
the decisions a run touched and the simple statements it ran in user code (``graph_statements.py``);
edges are the calls between them (from the statement that made the call), the tool callbacks,
the values that went from one node into a call of another and the names one statement assigned
for another to read. Everything comes from the uncapped moments of ``walkthrough.py`` plus the
trace's scope table, the file maps and the source lines; a model never touches it.
``src/session/executionGraph.ts`` is the same builder over a live session and
``test/unit/fixtures/execution-graph*.json`` pin both to identical JSON, so the rules here
(``docs/HANDOFF-execution-diagram.md`` lists them) are followed to the letter on both sides.
``render_graph`` is the text form; ``graph_dot.py`` the Graphviz one.
"""

from __future__ import annotations

import bisect
from typing import TYPE_CHECKING, Any

from .graph_statements import NODE_RANK, STATEMENTS_MAX, collect_statements, raised, row, statement_data_edges, statement_rows
from .moments import MomentBuilder
from .names import loop_names, names_of
from .recording import CUT_RE, cut_line
from .walkthrough import library_package, walkthrough

if TYPE_CHECKING:
    from .source import SavedRun

GRAPH_CAP = 200
SPANS_MAX = 50
STEPS_MAX = 50
ROWS_MAX = 12
DATA_EDGES_MAX = 100
LINE_MAX = 100
CUT_ROW_MAX = 36  # a cut value on a node line: short enough that its `…(+N chars)` survives the line's own cut
EDGE_STEPS_SHOWN = 6

_EDGE_RANK = {"call": 0, "tool": 0, "data": 1}


class _Builder:
    def __init__(self, run: "SavedRun", *, all_scopes: bool, scope: str | None, expand: list[str] | None, cap: int, statements: bool) -> None:
        self.run = run
        self.trace = run.trace
        self.unroll_all = bool(all_scopes)
        self.expand = set(expand or [])
        self.cap = cap
        self.with_statements = statements
        self.mb = MomentBuilder(run, all_scopes=self.unroll_all or bool(self.expand))
        self.main_fid = self.mb.main_file_id()
        w = walkthrough(run, all_scopes=self.unroll_all or bool(self.expand), scope=scope, cap=10**9)
        self.count = int(w["count"])
        self.moments: list[dict] = w["moments"]
        # the walkthrough's scope window, on steps: statements outside it are not nodes
        self.window: list[tuple[int, int]] | None = None
        if scope is not None:
            self.window = [(int(s["first"]), int(s["last"])) for s in self.trace.scopes if str(s["name"]) == scope or self.mb.scope_qualname(int(s["scopeId"])).endswith(scope)]
        self.scope_firsts = sorted(int(s["first"]) for s in self.trace.scopes)
        self.nodes: dict[str, dict] = {}  # module, function, package records by key, in creation order
        self.decisions: dict[tuple, dict] = {}  # (fileId, line) -> decision record
        self.statements: dict[tuple, dict] = {}  # (fileId, line) -> statement record (key ("s", fileId, line))
        self.placeholders: dict[tuple, dict] = {}
        self.dropped: dict[str, tuple] = {}  # dropped function key -> placeholder key
        self.calls: list[tuple[dict, str, str | None]] = []  # (moment, callee key, caller scope key)
        self.edges: dict[tuple, dict] = {}  # (from key, to key, kind) -> call edge record
        self.data_edges: dict[tuple, dict] = {}  # (from key, to key, label) -> data edge record
        self.node_of_moment: dict[str, Any] = {}
        self.edge_of_moment: dict[str, tuple] = {}
        self.capped = False
        self.truncated = False

    # -- keys (rule 2) ---------------------------------------------------------------------------------------
    def key_of(self, file: str | None, fid: int, function: str) -> str:
        if self.mb.user(fid):
            return "%d:%s" % (fid, function)
        pkg = library_package(file) or "?"
        if not self.unroll_all and pkg not in self.expand:
            return "pkg:" + pkg
        return "%d:%s" % (fid, function)

    def scope_key(self, s: dict) -> str | None:
        if int(s.get("parent", -1)) < 0:
            return self.main_key
        loc = self.run.locate(int(s["rid"]))
        if loc is None:
            return None
        fid = int(loc["fileId"])
        fn = "<module>" if str(s["name"]) == "<module>" else self.mb.scope_qualname(int(s["scopeId"]))
        return self.key_of(self.run.file_path(fid), fid, fn)

    def user_scope(self, s: dict) -> bool:
        """A module scope of a user file or a user function scope (never a library scope)."""
        if int(s.get("parent", -1)) < 0:
            return self.mb.user(self.main_fid)
        loc = self.run.locate(int(s["rid"]))
        return loc is not None and self.mb.user(int(loc["fileId"]))

    def in_window(self, step: int) -> bool:
        return self.window is None or any(a <= step <= b for a, b in self.window)

    def caller_key(self, m: dict) -> str | None:
        if m["kind"] == "tool":
            parent = self.tool_caller(m)
            return self.scope_key(parent) if parent else None
        loc = m["location"]
        return self.key_of(loc["file"], int(loc["fileId"]), str(loc["function"]))

    def tool_caller(self, m: dict) -> dict | None:
        """The scope a tool moment was called back under: ``callerScopeId``, else the callee's recorded parent."""
        if m.get("callerScopeId") is not None:
            return self.trace.scope(int(m["callerScopeId"]))
        s = self.trace.scope(int(m["scopeId"]))
        return self.trace.scope(int(s["parent"])) if s else None

    def location_key(self, m: dict) -> str:
        loc = m["location"]
        return self.key_of(loc["file"], int(loc["fileId"]), str(loc["function"]))

    def statement_key(self, m: dict) -> tuple | None:
        """The key of the statement node at a moment's location, when there is one."""
        loc = m["location"]
        sk = (int(loc["fileId"]), int(loc["line"]))
        return self.statements[sk]["key"] if sk in self.statements else None

    # -- nodes (rules 3, 4) --------------------------------------------------------------------------------
    @staticmethod
    def _record(key: str, kind: str, label: str, step: int, **fields: Any) -> dict:
        rec = {"key": key, "kind": kind, "label": label, "file": None, "line": None, "fileId": None, "function": None, "package": None, "calls": 0, "firstStep": step, "spans": [], "rows": [], "nested": None, "more": None, "moments": []}
        rec.update(fields)
        return rec

    def add_main(self) -> None:
        self.main_key = "%d:<module>" % self.main_fid
        self.nodes[self.main_key] = self._record(self.main_key, "module", "<module>", 0, file=self.run.file_path(self.main_fid), line=1, fileId=self.main_fid, function="<module>", calls=1, spans=[[0, self.count - 1]])

    def node_for_callee(self, m: dict) -> dict:
        c = m["callee"]
        fid = int(c["fileId"])
        key = self.key_of(c["file"], fid, str(c["function"]))
        node = self.nodes.get(key)
        if node is not None:
            return node
        if key.startswith("pkg:"):
            node = self._record(key, "package", key[4:], m["step"], package=key[4:], nested=0)
        elif c["function"] == "<module>":
            node = self._record(key, "module", self.run.display_path(c["file"]), m["step"], file=c["file"], line=int(c["line"]), fileId=fid, function="<module>")
        else:
            pkg = None if self.mb.user(fid) else (library_package(c["file"]) or "?")
            node = self._record(key, "function", str(c["function"]), m["step"], file=c["file"], line=int(c["line"]), fileId=fid, function=str(c["function"]), package=pkg)
        self.nodes[key] = node
        return node

    def add_calls(self) -> None:
        for m in self.moments:
            if m["kind"] not in ("call", "tool"):
                continue
            node = self.node_for_callee(m)
            caller = self.caller_key(m)
            self.node_of_moment[m["id"]] = node["key"]
            if caller == node["key"] and node["kind"] == "package":
                continue  # a call inside one folded package
            entry, end = int(m["entryStep"]), int(m["endStep"])
            node["moments"].append(m)
            node["calls"] += 1
            node["spans"].append([entry, end])
            if node["kind"] == "package":
                node["nested"] += bisect.bisect_right(self.scope_firsts, end) - bisect.bisect_right(self.scope_firsts, entry)
            if caller is not None:
                self.calls.append((m, node["key"], caller))

    # -- call edges (rule 7, S5): from the statement of the call site when it has a node -------------------
    def add_call_edges(self) -> None:
        for m, callee, caller in self.calls:
            src: Any = caller
            if m["kind"] == "call":
                src = self.statement_key(m) or caller
            ek = (src, callee, m["kind"])
            edge = self.edges.setdefault(ek, {"from": src, "to": callee, "kind": m["kind"], "moments": []})
            edge["moments"].append(m)
            self.edge_of_moment[m["id"]] = ek

    # -- decisions (rule 6) --------------------------------------------------------------------------------
    def add_decisions(self) -> None:
        for m in self.moments:
            if m["kind"] != "decision":
                continue
            loc = m["location"]
            fid, line = int(loc["fileId"]), int(loc["line"])
            loop = m.get("count") is not None
            if loop:
                label, taken = m["text"].rpartition(" ran ")[0], None
            else:
                label, _, taken = m["text"].rpartition(" took ")
            dk = (fid, line)
            rec = self.decisions.get(dk)
            if rec is None:
                rec = {"key": dk, "kind": "decision", "parent": self.location_key(m), "label": label, "file": loc["file"], "line": line, "fileId": fid, "text": m["text"], "taken": taken, "firstStep": int(m["step"]), "hits": 0, "notRun": [], "rows": [], "takens": [], "loop": loop, "first": m, "targets": [], "reads": []}
                self.decisions[dk] = rec
            rec["hits"] += int(m["count"]) if loop else 1
            if not loop:
                rec["takens"].append(taken)
            self.node_of_moment[m["id"]] = dk
        for rec in self.decisions.values():
            fm = self.mb.fmap(rec["fileId"])
            if rec["loop"]:
                # internal: a `for` assigns its target and reads the iterable, a `while` reads its condition
                lp = fm["loops"].get(rec["line"])
                if lp is not None:
                    rec["targets"], rec["reads"] = loop_names(lp["text"]) if lp["kind"] == "for" else ([], names_of([lp["text"]])[1])
                continue
            dec = fm["decisions"].get(rec["line"])
            if dec is None:
                continue
            rec["reads"] = names_of([dec["text"]])[1]
            takens = set(rec["takens"])
            if dec["kind"] == "match":
                rec["notRun"] = [a["body"][0] for a in dec["arms"] if ("case %s" % a["text"]) not in takens]
            else:
                took_true, took_false = "True" in takens, "False" in takens
                if took_false and not took_true and dec["body"][0]:
                    rec["notRun"] = [dec["body"][0]]
                elif took_true and not took_false and dec.get("orelse", [0, 0])[0]:
                    rec["notRun"] = [dec["orelse"][0]]

    # -- rows (rule 5, S4) ---------------------------------------------------------------------------------
    def add_rows(self) -> None:
        for node in self.nodes.values():
            if not node["moments"]:
                continue
            first = node["moments"][0]
            for v in first["values"]:
                if v["role"] == "in":
                    node["rows"].append(row("in", v["name"], v["text"], int(first["entryStep"])))
                elif v["role"] == "out" and v["name"] == "raised":
                    name, text = raised(v["text"])
                    node["rows"].append(row("raised", name, text, int(first["endStep"])))
                elif v["role"] == "out":
                    node["rows"].append(row("out", v["name"], v["text"], int(first["endStep"])))
        statement_rows(self)  # also the `raised` rows of error moments without a statement node
        for rec in self.decisions.values():
            rec["rows"] = [row("took", v["name"], v["text"], int(rec["first"]["step"])) for v in rec["first"]["values"] if v["role"] == "took"]
        for rec in list(self.nodes.values()) + list(self.decisions.values()) + list(self.statements.values()):
            seen: set[tuple] = set()
            rows = []
            for r in rec["rows"]:
                k = (r["kind"], r["name"], r["text"])
                if k not in seen:
                    seen.add(k)
                    rows.append(r)
            if len(rows) > ROWS_MAX:
                # a long parameter list must not push the result or the exception off the card: drop `in` rows first
                self.truncated = True
                while len(rows) > ROWS_MAX and any(r["kind"] == "in" for r in rows):
                    last_in = max(i for i, r in enumerate(rows) if r["kind"] == "in")
                    del rows[last_in]
                rows = rows[:ROWS_MAX]
            rec["rows"] = rows

    # -- data edges (rule 8, S6) ---------------------------------------------------------------------------
    def add_data_edges(self) -> None:
        by_name: dict[str, list[tuple]] = {}
        by_text: dict[str, list[tuple]] = {}
        order = 0
        for m in self.moments:
            if m["kind"] in ("call", "tool"):
                for v in m["values"]:
                    if v["role"] == "out" and v["name"] != "raised":
                        p = (int(m["endStep"]), order, self.node_of_moment[m["id"]], v["name"], v["text"])
                        order += 1
                        by_name.setdefault(v["name"], []).append(p)
                        by_text.setdefault(v["text"], []).append(p)
            elif m["kind"] == "value" and m["values"]:
                key = self.location_key(m)
                if key in self.nodes:
                    v = m["values"][0]
                    p = (int(m["step"]), order, key, v["name"], v["text"])
                    order += 1
                    by_name.setdefault(v["name"], []).append(p)
                    by_text.setdefault(v["text"], []).append(p)
        for m in self.moments:
            if m["kind"] not in ("call", "tool"):
                continue
            ins = [v for v in m["values"] if v["role"] == "in"]
            if not ins:
                continue
            step = int(m["step"])
            if m["kind"] == "tool":
                scope = self.tool_caller(m)
            else:
                scope = self.trace.scope(self.trace.scope_id(step))
            if scope is None:
                continue
            first = int(scope["first"])
            caller = self.caller_key(m)
            callee = self.node_of_moment[m["id"]]
            for v in ins:
                best: tuple | None = None
                for p in by_name.get(v["name"], []) + by_text.get(v["text"], []):
                    if first <= p[0] < step and p[2] != caller and (best is None or p[:2] > best[:2]):
                        best = p
                if best is not None:
                    self.data_edges.setdefault((best[2], callee, v["name"]), {"from": best[2], "to": callee, "kind": "data", "label": v["name"], "firstStep": int(m["entryStep"])})
        if self.with_statements:
            statement_data_edges(self)

    # -- the cap (rule 9) ----------------------------------------------------------------------------------
    def apply_cap(self) -> None:
        if len(self.nodes) <= self.cap:
            return
        keep = {k for k, n in self.nodes.items() if n["kind"] != "function"}
        keep.update(rec["parent"] for rec in self.decisions.values() if rec["parent"] in self.nodes)
        for n in sorted((n for n in self.nodes.values() if n["key"] not in keep), key=lambda n: (-n["calls"], n["firstStep"])):
            if len(keep) >= self.cap:
                break
            keep.add(n["key"])
        for key in [k for k in self.nodes if k not in keep]:
            n = self.nodes.pop(key)
            pk = ("more", n["fileId"])
            ph = self.placeholders.get(pk)
            if ph is None:
                ph = self.placeholders[pk] = self._record(pk, "package", "", n["firstStep"], file=n["file"], fileId=n["fileId"], more=0)  # type: ignore[arg-type]
            ph["more"] += 1
            ph["calls"] += n["calls"]
            ph["firstStep"] = min(ph["firstStep"], n["firstStep"])
            self.dropped[key] = pk
        for ph in self.placeholders.values():
            ph["label"] = "%d more function%s" % (ph["more"], "" if ph["more"] == 1 else "s")
        self.capped = True

    # -- assembly (rules 10, 11, S8) -----------------------------------------------------------------------
    def emit_node(self, n: dict, ids: dict) -> dict:
        out: dict[str, Any] = {"id": ids[n["key"]], "kind": n["kind"]}
        if n["kind"] == "statement":
            out.update(parent=ids[n["parent"]], label=n["label"], file=n["file"], line=n["line"], fileId=n["fileId"], text=n["text"], targets=list(n["targets"]), reads=list(n["reads"]), firstStep=n["firstStep"], hits=n["hits"], rows=n["rows"])
            return out
        if n["kind"] == "decision":
            out.update(parent=ids[n["parent"]], label=n["label"], file=n["file"], line=n["line"], fileId=n["fileId"], text=n["text"])
            if n["taken"] is not None:
                out["taken"] = n["taken"]
            out.update(firstStep=n["firstStep"], hits=n["hits"], notRun=n["notRun"], rows=n["rows"])
            return out
        out["label"] = n["label"]
        if n["more"] is not None:
            out.update(file=n["file"], fileId=n["fileId"])
        elif n["kind"] != "package":
            out.update(file=n["file"], line=n["line"], fileId=n["fileId"], function=n["function"])
        if n["package"] is not None:
            out["package"] = n["package"]
        spans = n["spans"]
        if len(spans) > SPANS_MAX:
            spans = spans[:SPANS_MAX]
            self.truncated = True
        out.update(calls=n["calls"], firstStep=n["firstStep"], spans=spans, rows=n["rows"])
        if n["nested"] is not None:
            out["nested"] = n["nested"]
        if n["more"] is not None:
            out["more"] = n["more"]
        return out

    def sorted_edges(self, ids: dict) -> list[dict]:
        """Call, tool and data edges in the global order; the data edges cut at DATA_EDGES_MAX."""
        edges: list[dict] = []
        for ek, e in self.edges.items():
            if e["from"] in ids and e["to"] in ids:
                steps = [int(m["step"]) for m in e["moments"]]
                edges.append({"_key": ek, "_first": steps[0], "_label": "", "id": "", "from": ids[e["from"]], "to": ids[e["to"]], "kind": e["kind"], "count": len(steps), "firstStep": steps[0], "steps": steps[:STEPS_MAX], "momentIds": [m["id"] for m in e["moments"]]})
                if len(steps) > STEPS_MAX:
                    self.truncated = True
        for dk, e in self.data_edges.items():
            if e["from"] in ids and e["to"] in ids:
                edges.append({"_key": dk, "_first": e["firstStep"], "_label": e["label"], "id": "", "from": ids[e["from"]], "to": ids[e["to"]], "kind": "data", "label": e["label"], "firstStep": e["firstStep"]})
        edges.sort(key=lambda e: (e["_first"], _EDGE_RANK[e["kind"]], int(e["from"][1:]), int(e["to"][1:]), e["_label"]))
        n_data = 0
        kept: list[dict] = []
        for e in edges:
            if e["kind"] == "data":
                n_data += 1
                if n_data > DATA_EDGES_MAX:
                    self.truncated = True
                    continue
            kept.append(e)
        return kept

    def build(self) -> dict:
        self.add_main()
        self.add_calls()
        if self.with_statements:
            collect_statements(self)
        self.add_call_edges()
        self.add_decisions()
        self.add_rows()
        self.add_data_edges()
        self.apply_cap()
        under = [d for d in list(self.decisions.values()) + list(self.statements.values()) if d["parent"] in self.nodes]
        records = list(self.nodes.values()) + list(self.placeholders.values()) + under
        records.sort(key=lambda n: (n["firstStep"], NODE_RANK[n["kind"]], n["label"]))
        ids = {n["key"]: "n%d" % i for i, n in enumerate(records)}
        nodes = [self.emit_node(n, ids) for n in records]
        edges = self.sorted_edges(ids)
        edge_ids = {}
        for i, e in enumerate(edges):
            e["id"] = "e%d" % i
            edge_ids[e.pop("_key")] = e["id"]
            e.pop("_first")
            e.pop("_label")
        moments = []
        for m in self.moments:
            kind = m["kind"]
            if kind in ("start", "end"):
                key: Any = self.main_key
            elif kind in ("call", "tool", "decision"):
                key = self.node_of_moment.get(m["id"])
            else:
                key = self.statement_key(m) or self.location_key(m)
            if key not in ids:
                continue
            ref = {"id": m["id"], "kind": kind, "step": int(m["step"]), "nodeId": ids[key]}
            ek = self.edge_of_moment.get(m["id"])
            if ek is not None and ek in edge_ids:
                ref["edgeId"] = edge_ids[ek]
            moments.append(ref)
        scopes: dict[str, str] = {}
        for s in sorted(self.trace.scopes, key=lambda s: int(s["scopeId"])):
            key = self.scope_key(s)
            if key in self.dropped:
                key = self.dropped[key]
            if key in ids:
                scopes[str(int(s["scopeId"]))] = ids[key]
        return {"count": self.count, "nodes": nodes, "edges": edges, "moments": moments, "scopes": scopes, "capped": self.capped, "truncated": self.truncated}


def graph(run: "SavedRun", *, all_scopes: bool = False, scope: str | None = None, expand: list[str] | None = None, cap: int = GRAPH_CAP, statements: bool = True) -> dict:
    """The execution graph of a saved run; ``expand`` unrolls those packages, ``all_scopes`` every one; ``statements=False`` leaves the statement nodes out."""
    return _Builder(run, all_scopes=all_scopes, scope=scope, expand=expand, cap=cap, statements=statements).build()


# -- text form -----------------------------------------------------------------------------------------------

def _line(text: str, limit: int = LINE_MAX) -> str:
    indent = len(text) - len(text.lstrip(" "))
    s = " ".join(text.strip().split("\n"))
    s = s if len(s) <= limit - indent else s[: limit - indent - 1] + "…"
    return " " * indent + s


def row_text(r: dict) -> str:
    if r["kind"] == "out" and r["name"] == "return":
        return "out %s" % r["text"]
    if r["kind"] == "raised":
        return "raised %s%s" % (r["name"], (": " + r["text"]) if r["text"] else "")
    return "%s %s = %s" % (r["kind"], r["name"], r["text"])


def _where(source: Any, n: dict) -> str:
    name = source.display_path(n.get("file")) if hasattr(source, "display_path") else str(n.get("file"))
    return "%s:%s" % (name, n["line"]) if n.get("line") else name


def _short_row(r: dict) -> dict:
    """``r`` with a value the recording cut shortened to ``CUT_ROW_MAX``, mark kept, so ``_line`` does not drop the mark."""
    text = r.get("text")
    if isinstance(text, str) and len(text) > CUT_ROW_MAX and CUT_RE.search(text):
        return {**r, "text": cut_line(text, CUT_ROW_MAX)}
    return r


def render_graph(result: dict, source: Any, args: Any) -> list[str]:
    nodes = result["nodes"]
    n_edges = len(result["edges"])
    head = "%d nodes, %d edge%s over %d steps" % (len(nodes), n_edges, "" if n_edges == 1 else "s", result["count"])
    if result.get("capped"):
        head += ", capped"
    out = [head]
    under: dict[str, list[dict]] = {}  # decisions and statements under their parent, in node (firstStep) order
    for n in nodes:
        if n["kind"] in ("decision", "statement"):
            under.setdefault(n["parent"], []).append(n)
    for n in nodes:
        if n["kind"] in ("decision", "statement"):
            continue
        bits = ["%s %s" % (n["id"], n["label"]) + (("  " if n.get("more") else " ") + _where(source, n) if n.get("file") else ""), "×%d" % n["calls"]]
        if n.get("nested") is not None:
            bits.append("%d nested" % n["nested"])
        if n["rows"]:
            bits.append(" · ".join(row_text(_short_row(r)) for r in n["rows"]))
        out.append(_line("  ".join(bits)))
        for d in under.get(n["id"], []):
            bits = ["   %s %s" % (d["id"], d["text"] if d["kind"] == "decision" else d["label"]), "×%d" % d["hits"]]
            if d.get("notRun"):
                bits.append("not run: " + ", ".join(str(l) for l in d["notRun"]))
            if d["rows"]:
                bits.append(" · ".join(row_text(_short_row(r)) for r in d["rows"]))
            out.append(_line("  ".join(bits)))
    for e in result["edges"]:
        if e["kind"] == "data":
            out.append(_line("%s ⇢ %s  %s" % (e["from"], e["to"], e["label"])))
            continue
        steps = " ".join("#%d" % s for s in e["steps"][:EDGE_STEPS_SHOWN]) + (" …" if len(e["steps"]) > EDGE_STEPS_SHOWN else "")
        out.append(_line("%s → %s  %s×%d  %s" % (e["from"], e["to"], "tool " if e["kind"] == "tool" else "", e["count"], steps)))
    return out


__all__ = ["graph", "render_graph", "row_text", "GRAPH_CAP", "SPANS_MAX", "STEPS_MAX", "ROWS_MAX", "DATA_EDGES_MAX", "STATEMENTS_MAX"]
