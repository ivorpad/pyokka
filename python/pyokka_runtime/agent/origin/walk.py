"""The walk behind ``pyokka origin``: from a name at a step back through arguments, returns, assignments and containers."""

from __future__ import annotations

import ast
from typing import TYPE_CHECKING, Any

from ..history import History
from ..moments import MomentBuilder
from ..provenance import callee_name
from ..reprs import UNKNOWN, parse, path_text, project, text_of, type_of
from .containers import ContainerMixin
from .pick import PickMixin
from .root import RootMixin

if TYPE_CHECKING:
    from ..source import SavedRun

ORIGIN_DEPTH = 20
ORIGIN_MAX_DEPTH = 60
MUTATIONS_SKIPPED_MAX = 10_000


def _is_mutation(node: ast.stmt, name: str) -> bool:
    """``name[k] = v``, ``name.x = v``, ``name[k] += v`` or ``name.append(v)``: the statement changes ``name`` in place."""
    targets: list[ast.expr] = []
    if isinstance(node, ast.Assign):
        targets = list(node.targets)
    elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
        targets = [node.target]
    elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Attribute):
        targets = [node.value.func]
    for t in targets:
        if isinstance(t, (ast.Subscript, ast.Attribute)) and _base_name(t) == name:
            return True
    return False


def _base_name(node: ast.expr) -> str | None:
    while isinstance(node, (ast.Subscript, ast.Attribute)):
        node = node.value
    return node.id if isinstance(node, ast.Name) else None


def _names_in(node: ast.AST) -> list[str]:
    out: list[str] = []
    for n in ast.walk(node):
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and n.id not in out:
            out.append(n.id)
    return out


def _is_literal(node: ast.expr) -> bool:
    try:
        ast.literal_eval(node)
        return True
    except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
        return isinstance(node, ast.JoinedStr)


def _raw_string(text: str | None) -> str | None:
    """The characters of a recorded ``str`` text, for finding it in source."""
    if type_of(text) != "str":
        return None
    value = parse(text)
    return value if isinstance(value, str) and value else None


class OriginBuilder(ContainerMixin, PickMixin, RootMixin):
    def __init__(self, run: "SavedRun", depth: int = ORIGIN_DEPTH) -> None:
        self.run = run
        self.trace = run.trace
        self.history = History(run)
        self.moments = MomentBuilder(run)
        self.depth = max(2, min(ORIGIN_MAX_DEPTH, int(depth)))
        self.scopes_by_site: dict[int, list[dict]] = {}
        self.scopes_by_rid: dict[int, list[dict]] = {}
        for s in sorted((s for s in self.trace.scopes if int(s.get("parent", -1)) >= 0), key=lambda s: int(s["first"])):
            self.scopes_by_site.setdefault(self.moments.call_site(s), []).append(s)
            self.scopes_by_rid.setdefault(int(s["rid"]), []).append(s)
        self._files: dict[int, tuple[str, dict[tuple[int, int], ast.stmt]]] = {}
        self._inserts: dict[int, list[tuple[str, Any, ast.expr]]] = {}
        self.links: list[dict] = []
        self.end = ""
        self.truncated = False
        self.visited: set[tuple] = set()
        self.certainty_next: str | None = None
        self.why_next: str | None = None  # why the next link is not `recorded`

    # -- source -------------------------------------------------------------------------------------------
    def _file(self, fid: int) -> tuple[str, dict[tuple[int, int], ast.stmt]]:
        if fid not in self._files:
            src = "\n".join(self.run.source_lines(fid))
            table: dict[tuple[int, int], ast.stmt] = {}
            try:
                for node in ast.walk(ast.parse(src)):
                    if isinstance(node, ast.stmt):
                        table.setdefault((node.lineno, node.col_offset), node)
            except (SyntaxError, ValueError):
                pass
            self._files[fid] = (src, table)
        return self._files[fid]

    def stmt(self, step: int) -> ast.stmt | None:
        loc = self.trace.location(step)
        if loc is None:
            return None
        return self._file(loc[0])[1].get((int(loc[1][0]), int(loc[1][1])))

    def seg(self, step: int, node: ast.AST) -> str:
        loc = self.trace.location(step)
        src = self._file(loc[0])[0] if loc else ""
        text = ast.get_source_segment(src, node) if src else None
        if text is None:
            try:
                text = ast.unparse(node)
            except Exception:  # noqa: BLE001 - a node unparse cannot handle is shown by its type
                text = type(node).__name__
        return " ".join(text.split())

    def statement(self, step: int) -> str | None:
        loc = self.trace.location(step)
        if loc is None:
            return None
        lines = self.run.source_lines(loc[0])
        line = int(loc[1][0])
        return lines[line - 1].strip() if 0 < line <= len(lines) else None

    # -- values -------------------------------------------------------------------------------------------
    def value(self, name: str, step: int) -> dict:
        loc = self.trace.location(step)
        return self.history.value_at(name, step, self.trace.scope_id(step), loc[0] if loc else -1)

    def scope_of(self, step: int) -> dict | None:
        return self.trace.scope(self.trace.scope_id(step))

    def callee_scopes(self, site: int, name: str) -> list[dict]:
        out = []
        for s in self.scopes_by_site.get(site, ()):
            sname = str(s["name"]).rsplit(".", 1)[-1]
            if sname == name or (sname == "__init__" and name[:1].isupper()):
                out.append(s)
        return out

    # -- links --------------------------------------------------------------------------------------------
    def add(self, step: int, expr: str, text: str | None, how: str, certainty: str = "recorded", note: str | None = None, **extra: Any) -> dict | None:
        if len(self.links) >= self.depth:
            self.truncated = True
            return None
        if self.certainty_next and certainty == "recorded":
            certainty = self.certainty_next
            if self.why_next:
                note = "%s; %s" % (note, self.why_next) if note else self.why_next
        self.certainty_next = None
        self.why_next = None
        link: dict[str, Any] = {**self.history.location(step), "expr": expr, "how": how, "certainty": certainty}
        if text is not None:
            link["text"] = text
            t = type_of(text)
            if t:
                link["type"] = t
        if note:
            link["note"] = note
        statement = self.statement(step)
        if statement is not None:
            link["statement"] = statement
        link.update(extra)
        self.links.append(link)
        return link

    def full(self) -> bool:
        if len(self.links) >= self.depth:
            self.truncated = True
            return True
        return False

    # -- the walk -----------------------------------------------------------------------------------------
    def follow_name(self, name: str, path: list, step: int, carried: str | None) -> None:
        if self.full():
            return
        key = ("name", name, tuple(map(repr, path)), step)
        if key in self.visited:
            self.end = "the chain loops back to %s at #%d" % (name, step)
            return
        self.visited.add(key)
        found = self.value(name, step)
        if found.get("step") is None:
            if path:
                self.element_search(path, step, carried)
                return
            if found.get("text") is not None:
                self.end = "%s is a definition (a def or class), made by no step" % name
            else:
                self.end = "nothing recorded %s before #%d (made in code the recording does not show, or before it started)" % (name, step)
            return
        made = int(found["step"])
        whole = found.get("text")
        projected = text_of(project(parse(whole), path)) if path else whole
        text = projected if projected is not None else carried
        node = self.stmt(made)
        scope = self.scope_of(made)
        expr = path_text(name, path)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and scope is not None and int(scope["first"]) == made:
            self.argument(node, name, path, made, scope, text)
            return
        if isinstance(node, (ast.For, ast.AsyncFor)):
            if path:
                self.element_search(path, step, carried)
                return
            if self.add(made, expr, text, "element", note="loop variable over %s" % self.seg(made, node.iter)) is None:
                return
            self.follow_expr(node.iter, [], made, None)
            return
        if node is not None and _is_mutation(node, name):
            self.mutation(node, name, path, made, text, carried)
            return
        if isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None:
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            whole_target = any(isinstance(t, ast.Name) and t.id == name for t in targets)
            if _is_literal(node.value) and whole_target:
                self.literal(made, expr, text, node.value, path)
                return
            if self.add(made, expr, text, "assigned", _sib=(name, self.trace.rid(made), made)) is None:
                return
            if whole_target:
                self.follow_expr(node.value, path, made, text)
            else:
                # unpacking (`a, b = f()`): the value is one part of what the right side made
                self.computed(node.value, made, text, unpacked=True)
            return
        if isinstance(node, ast.AugAssign):
            if self.add(made, expr, text, "assigned", note="updated in place (%s)" % self.seg(made, node)) is None:
                return
            self.end = "%s is computed at #%d from its old value and %s; ask origin for one of them" % (name, made, self.seg(made, node.value))
            return
        if self.add(made, expr, text, "assigned") is None:
            return
        if path:
            self.element_search(path, made, carried)
        else:
            self.end = "%s was bound by %s, which origin does not follow" % (name, type(node).__name__ if node is not None else "a statement the source no longer has")

    def mutation(self, node: ast.stmt, name: str, path: list, made: int, text: str | None, carried: str | None) -> None:
        """``name`` was changed in place at ``made``. With a path whose first key the statement sets, that is the element's link."""
        if path and isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name) and t.value.id == name:
                    k = self.key_of(t.slice, made)
                    if k is not UNKNOWN and k == path[0]:
                        if self.add(made, self.seg(made, node.value), text, "element", note="set as %s" % path_text(name, [k])) is None:
                            return
                        self.follow_expr(node.value, path[1:], made, text)
                        return
        if path:
            self.element_search(path, made + 1, carried)
            return
        if self.add(made, path_text(name, path), text, "assigned", note="changed in place") is None:
            return
        # the earlier changes in place are the same object filling up: jump to the statement that made it
        skipped = 0
        at = made
        while skipped < MUTATIONS_SKIPPED_MAX:
            before = self.value(name, at)
            if before.get("step") is None or int(before["step"]) >= at:
                break
            prev = int(before["step"])
            prev_node = self.stmt(prev)
            if prev_node is None or not _is_mutation(prev_node, name):
                if skipped:
                    self.links[-1]["note"] += "; %d earlier change%s in place not shown" % (skipped, "" if skipped == 1 else "s")
                self.follow_name(name, [], at, None)
                return
            skipped += 1
            at = prev
        self.end = "%s was changed in place %d times; the statement that made it is not in the recording" % (name, skipped + 1)

    def argument(self, fn: ast.FunctionDef | ast.AsyncFunctionDef, param: str, path: list, made: int, scope: dict, text: str | None) -> None:
        site = self.moments.call_site(scope)
        site_node = self.stmt(site)
        fname = str(scope["name"]).rsplit(".", 1)[-1]
        if site == made or site_node is None:
            self.add(made, path_text(param, path), text, "argument", note="parameter of %s, called from code the recording does not show" % fname)
            self.end = "%s was called from code the recording does not show" % fname
            return
        calls = [c for c in ast.walk(site_node) if isinstance(c, ast.Call) and (callee_name(self.seg(site, c)) == fname or (fname == "__init__" and callee_name(self.seg(site, c))[:1].isupper()))]
        if not calls:
            self.add(made, path_text(param, path), text, "argument", note="parameter of %s; the call at #%d does not name it (a callback)" % (fname, site))
            self.end = "%s was called back by code the recording does not show, from #%d" % (fname, site)
            return
        same = [s for s in self.callee_scopes(site, fname)]
        idx = next((i for i, s in enumerate(same) if int(s["scopeId"]) == int(scope["scopeId"])), 0)
        call = calls[min(idx, len(calls) - 1)] if len(calls) == len(same) else calls[0]
        arg = self.bind(fn, call, param)
        if arg is None:
            default = self.default_of(fn, param)
            if default is not None:
                self.add(made, "%s=%s" % (param, self.seg(made, default)), text, "literal", note="default value of %s's parameter %s" % (fname, param))
                self.end = "the default value of %s" % param
                return
            self.add(site, self.seg(site, call), text, "argument", note="%s of %s, passed through *args or **kwargs" % (param, fname))
            self.end = "%s reached %s through *args or **kwargs" % (param, fname)
            return
        sib = None if path else (param, self.trace.rid(made), made)
        if self.add(site, path_text(self.seg(site, arg), path) if path else self.seg(site, arg), text, "argument", note="%s of %s" % (param, fname), _sib=sib) is None:
            return
        self.follow_expr(arg, path, site, text)

    @staticmethod
    def bind(fn: ast.FunctionDef | ast.AsyncFunctionDef, call: ast.Call, param: str) -> ast.expr | None:
        for kw in call.keywords:
            if kw.arg == param:
                return kw.value
        a = fn.args
        positional = [p.arg for p in a.posonlyargs + a.args]
        if param not in positional:
            return None
        i = positional.index(param)
        if isinstance(call.func, ast.Attribute) and positional and positional[0] in ("self", "cls"):
            if i == 0:
                return call.func.value
            i -= 1
        args = call.args
        if any(isinstance(x, ast.Starred) for x in args[: i + 1]):
            return None
        return args[i] if i < len(args) else None

    @staticmethod
    def default_of(fn: ast.FunctionDef | ast.AsyncFunctionDef, param: str) -> ast.expr | None:
        a = fn.args
        positional = [p.arg for p in a.posonlyargs + a.args]
        if param in positional:
            i = positional.index(param) - (len(positional) - len(a.defaults))
            return a.defaults[i] if i >= 0 else None
        for p, d in zip(a.kwonlyargs, a.kw_defaults):
            if p.arg == param:
                return d
        return None

    def key_of(self, node: ast.expr, step: int) -> Any:
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub) and isinstance(node.operand, ast.Constant):
            return -node.operand.value
        if isinstance(node, ast.Name):
            found = self.value(node.id, step)
            value = parse(found.get("text")) if found.get("text") is not None else UNKNOWN
            return value if isinstance(value, (str, int, float, bool, tuple)) or value is None else UNKNOWN
        return UNKNOWN

    def follow_expr(self, node: ast.expr, path: list, step: int, carried: str | None, scope: dict | None = None) -> None:
        if self.full():
            return
        if isinstance(node, ast.Await):
            node = node.value
        if isinstance(node, ast.Name):
            self.follow_name(node.id, path, step, carried)
            return
        if isinstance(node, (ast.Subscript, ast.Attribute)):
            keys: list = []
            cur: ast.expr = node
            while isinstance(cur, ast.Subscript):
                k = self.key_of(cur.slice, step)
                if k is UNKNOWN:
                    break
                keys.insert(0, k)
                cur = cur.value
            if isinstance(cur, ast.Name):
                self.follow_name(cur.id, keys + path, step, carried)
                return
            self.computed(node, step, carried)
            return
        if isinstance(node, ast.Call):
            name = callee_name(self.seg(step, node))
            scopes = [scope] if scope is not None else self.callee_scopes(step, name)
            if scopes:
                if len(scopes) > 1 and carried is not None:
                    matching = [s for s in scopes if s.get("returned") is not None and text_of(project(parse(s.get("returned")), path)) == carried]
                    if len(matching) >= 1:
                        if len(matching) > 1:
                            self.certainty_next = "inferred"
                            self.why_next = "%d calls at this step returned the same text" % len(matching)
                        scopes = matching[-1:]
                self.returned(scopes[-1], path, carried)
                return
            self.computed(node, step, carried)
            return
        if isinstance(node, (ast.IfExp, ast.BoolOp)):
            branches = [node.body, node.orelse] if isinstance(node, ast.IfExp) else list(node.values)
            for b in branches:
                if carried is not None and self.simple_text(b, path, step) == carried:
                    self.certainty_next = "inferred"
                    self.why_next = "the branch whose value matches"
                    self.follow_expr(b, path, step, carried)
                    return
            self.computed(node, step, carried)
            return
        if isinstance(node, ast.Dict) and path:
            for k, v in zip(node.keys, node.values):
                if k is not None and self.key_of(k, step) == path[0]:
                    self.follow_expr(v, path[1:], step, carried)
                    return
        if isinstance(node, (ast.List, ast.Tuple)) and path and isinstance(path[0], int) and -len(node.elts) <= path[0] < len(node.elts):
            self.follow_expr(node.elts[path[0]], path[1:], step, carried)
            return
        if _is_literal(node):
            self.literal(step, self.seg(step, node), carried, node, path)
            return
        self.computed(node, step, carried)

    def simple_text(self, node: ast.expr, path: list, step: int) -> str | None:
        """The text of a branch whose value is in the recording: a name, a constant, a stepped call's result."""
        if isinstance(node, ast.Name):
            found = self.value(node.id, step)
            return text_of(project(parse(found.get("text")), path)) if path else found.get("text")
        if isinstance(node, ast.Constant) and not path:
            return repr(node.value)
        if isinstance(node, ast.Call):
            for s in self.callee_scopes(step, callee_name(self.seg(step, node))):
                if s.get("returned") is not None:
                    return text_of(project(parse(s["returned"]), path)) if path else s["returned"]
        return None

    def returned(self, scope: dict, path: list, carried: str | None) -> None:
        last = int(scope["last"])
        node = self.stmt(last)
        fname = str(scope["name"]).rsplit(".", 1)[-1]
        whole = scope.get("returned")
        text = (text_of(project(parse(whole), path)) if path else whole) if whole is not None else None
        text = text if text is not None else carried
        if "raised" in scope and "returned" not in scope:
            self.add(last, "%s()" % fname, text, "return", note="%s raised instead of returning" % fname)
            self.end = "%s raised" % fname
            return
        if isinstance(node, ast.Return) and node.value is not None:
            if self.add(last, "return %s" % self.seg(last, node.value), text, "return", note="%s returned it" % fname, scopeReturned=int(scope["scopeId"])) is None:
                return
            self.follow_expr(node.value, path, last, text)
            return
        if "returned" in scope and whole is None:
            self.add(last, "%s()" % fname, "None", "return", note="%s ended without reaching a return statement, so the call gave None" % fname, scopeReturned=int(scope["scopeId"]))
            self.end = "%s fell off its end at #%d" % (fname, last)
            return
        self.add(last, "%s()" % fname, text, "return", note="%s's last step is not a return statement" % fname, scopeReturned=int(scope["scopeId"]))
        self.end = "the return of %s is not in the recording" % fname

    def computed(self, node: ast.expr, step: int, carried: str | None, unpacked: bool = False) -> None:
        """The value is computed by code that left no steps (a builtin, a method of a str). One input: follow it."""
        if carried == "None" and isinstance(node, ast.Call):
            # None from a call is the call's own answer (`xs.sort()` changes xs and returns None), not one of its inputs
            self.end = "%s gave None at #%d: the None is the call's own result (list.sort and other in-place methods return None)" % (self.seg(step, node), step)
            return
        inputs = []
        for n in _names_in(node):
            found = self.value(n, step)
            if found.get("step") is None or type_of(found.get("text")) in ("function", "type") or str(found.get("text", "")).startswith("<class "):
                continue
            inputs.append((n, found))
        if len(inputs) == 1:
            self.certainty_next = "inferred"
            self.why_next = "the one input of %s" % self.seg(step, node)
            self.follow_name(inputs[0][0], [], step, None)
            return
        raw = _raw_string(carried)
        if raw is not None:
            holding = [(n, f) for n, f in inputs if raw in str(f.get("text", ""))]
            if len(holding) == 1:
                self.certainty_next = "text match"
                self.why_next = "the input of %s whose text holds the value" % self.seg(step, node)
                self.follow_name(holding[0][0], [], step, None)
                return
        if inputs:
            self.end = "computed at #%d by %s from %s; ask origin for one of them" % (step, self.seg(step, node), ", ".join(n for n, _ in inputs))
            if self.links:
                self.links[-1]["inputs"] = [{"name": n, "text": f.get("text"), "step": f.get("step")} for n, f in inputs]
        else:
            self.end = "made at #%d by %s, which reads no recorded name" % (step, self.seg(step, node))

    def literal(self, step: int, expr: str, text: str | None, node: ast.expr, path: list) -> None:
        """A literal ends the chain. In a multi-line one, the line holding a string the chain carried is named (by text)."""
        line = None
        lines = self.run.source_lines(self.history.location(step)["fileId"])
        start, end = getattr(node, "lineno", 0), getattr(node, "end_lineno", 0) or 0
        if end > start:
            for link in reversed(self.links):
                raw = _raw_string(link.get("text"))
                if raw is None or "\n" in raw:
                    continue
                hits = [i for i in range(start, end + 1) if 0 < i <= len(lines) and raw in lines[i - 1]]
                if len(hits) == 1:
                    line = hits[0]
                    text = link.get("text")
                    break
        if line is not None:
            self.add(step, lines[line - 1].strip(), text, "literal", "text match", note="the line of the literal %s that holds it" % expr.split("=")[0].strip(), line=line)
        else:
            self.add(step, expr, text, "literal")
        self.end = "a literal in the source"


__all__ = ["OriginBuilder", "ORIGIN_DEPTH", "ORIGIN_MAX_DEPTH"]
