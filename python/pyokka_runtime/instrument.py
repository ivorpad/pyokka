"""AST instrumentation: coverage, trace steps, scopes, value hooks, magic comments, markers, snaps.

The instrumented module is compiled from the rewritten AST with the original
filename and original positions, so tracebacks, ``sys.monitoring`` and
``sys._getframe().f_lineno`` all report source lines. Hooks are plain
builtins installed by the tracer:

    _pk_s(rid[, scope])              statement step
    (_pk_c(rid), expr)[1]            expression coverage (and/or, ternary, comprehension parts, ...)
    _pk_scope_ = _pk_f(rid)        function entry, then _pk_rv_ = _pk_u
    return (_pk_rv_ := value)      every return; _pk_rv_ = _pk_end where the body ends
    _pk_x(_pk_scope_, _pk_rv_)     in a finally on exit (a module body: _pk_x(_pk_scope_))
    (_pk_f(rid), body)[1]            lambda entry (exit inferred by the tracer)
    _pk_v(rid, ctx, value, kind, markerId, changeId, fn)   value log, returns value
    _pk_t(rid, ctx, t0, value, kind, markerId, changeId)   timed value log
    _pk_print(rid, *args, **kw)      print attribution
    _pk_logpoint(rid, kind, template, ctx, markerId, changeId, is_expr)
    _pk_snap_error(exc, rid)         snaps mode: report and continue

Range ids are assigned in source order after the rewrite (a pre-pass records
spans, the constants in the injected calls are patched afterwards).
"""

from __future__ import annotations

import ast
import types
from dataclasses import dataclass, field
from typing import Any

from . import magic as magic_mod
from .protocol import KIND_AUTO_EXPAND, KIND_TIME, KIND_TIME_AUTO_EXPAND, KIND_VALUE
from .rewrite import (
    HOOK_EXIT,
    HOOK_FN,
    HOOK_NAMES,
    HOOK_SNAP_ERROR,
    SCOPE_NAME,
    InstrumentOptions,
    LogpointPlan,
    ValuePlan,
    _const,
    _locate,
    _name,
    _normalise_positions,
    _Rewriter,
)
from .spans import (
    Span,
    attach_to_line,
    collect_candidates,
    find_covering,
    is_docstring,
    is_future_import,
    module_span,
    node_span,
    statement_at_line,
)

__all__ = ["InstrumentOptions", "InstrumentedFile", "Instrumenter", "instrument", "relocate", "relocation_slots", "HOOK_NAMES", "SCOPE_NAME"]

# Relocatable code objects (library files, cached across runs): range ids are compiled in as
# ``RELOC_BASE + local`` and shifted to the run's ``range_base`` afterwards. The constant slots
# holding them are found by compiling twice, ``RELOC_DELTA`` apart, and diffing ``co_consts``
# (a user constant that happens to equal a sentinel merges with it in one compile only, which
# shows up as a structural mismatch, and the file is then compiled normally instead).
RELOC_BASE = (1 << 40) + 0x5A5A5
RELOC_DELTA = 1 << 20
Slots = list[tuple[int, ...]]
Clause = tuple[int, int, int, bool]  # (clause line, body first line, body last line, broad)
TryClauses = tuple[int, list[Clause]]  # (the try statement's line, its clauses in order)
_BROAD_NAMES = ("Exception", "BaseException")


def _is_broad(handler_type: ast.expr | None) -> bool:
    """A bare ``except:``, ``Exception``/``BaseException``, or a tuple naming one of them."""
    if handler_type is None:
        return True
    elts = handler_type.elts if isinstance(handler_type, ast.Tuple) else [handler_type]
    return any(isinstance(e, ast.Name) and e.id in _BROAD_NAMES for e in elts)


def _clause(handler: ast.ExceptHandler) -> Clause:
    last = max(getattr(s, "end_lineno", None) or s.lineno for s in handler.body)
    return (handler.lineno, handler.body[0].lineno, last, _is_broad(handler.type))


def except_clauses(tree: ast.AST) -> dict[int, TryClauses]:
    """The clause table of ``tree`` (see ``InstrumentedFile.except_clauses``); walk before rewriting."""
    out: dict[int, TryClauses] = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.Try, ast.TryStar)) and node.handlers:
            out[node.handlers[0].lineno] = (node.lineno, [_clause(h) for h in node.handlers])
    return out


def _same_const(x: Any, y: Any) -> bool:
    if type(x) is not type(y):
        return False
    if isinstance(x, (tuple, frozenset)):
        return x == y and all(_same_const(a, b) for a, b in zip(sorted(x, key=repr), sorted(y, key=repr)))
    try:
        return x == y or (x != x and y != y)  # nan
    except Exception:  # noqa: BLE001
        return False


def _diff_consts(a: types.CodeType, b: types.CodeType, path: tuple[int, ...], out: Slots) -> bool:
    ca, cb = a.co_consts, b.co_consts
    if len(ca) != len(cb):
        return False
    for i, (x, y) in enumerate(zip(ca, cb)):
        if isinstance(x, types.CodeType):
            if not isinstance(y, types.CodeType) or not _diff_consts(x, y, path + (i,), out):
                return False
        elif type(x) is int and type(y) is int and x != y:
            if y - x != RELOC_DELTA:
                return False
            out.append(path + (i,))
        elif not _same_const(x, y):
            return False
    return True


def relocation_slots(code_a: types.CodeType, code_b: types.CodeType) -> Slots | None:
    """Paths (co_consts indices, nested) of the range-id constants, or None when ambiguous."""
    out: Slots = []
    return out if _diff_consts(code_a, code_b, (), out) else None


def relocate(code: types.CodeType, slots: Slots, delta: int) -> types.CodeType:
    """Copy of ``code`` with every range-id constant shifted by ``delta``."""
    tree: dict = {}
    for path in slots:
        node = tree
        for idx in path[:-1]:
            node = node.setdefault(idx, {})
        node[path[-1]] = None
    return _apply_relocation(code, tree, delta)


def _apply_relocation(code: types.CodeType, tree: dict, delta: int) -> types.CodeType:
    consts = list(code.co_consts)
    for i, sub in tree.items():
        consts[i] = consts[i] + delta if sub is None else _apply_relocation(consts[i], sub, delta)
    return code.replace(co_consts=tuple(consts))


@dataclass
class InstrumentedFile:
    filename: str
    file_id: int
    range_base: int
    code: types.CodeType | None
    ranges: list[list[int]]
    statements: list[int]
    functions: list[dict]
    magic: list[dict]
    instrumented_source: str | None
    inline_config: dict | None
    expr_children: dict[int, list[int]] = field(default_factory=dict)
    line_rids: dict[int, int] = field(default_factory=dict)
    ignored: set[int] = field(default_factory=set)
    ignore_file: bool = False
    library: bool = False
    def_logs: dict[int, dict] = field(default_factory=dict)
    function_names: dict[int, str] = field(default_factory=dict)
    error: str | None = None
    error_line: int | None = None
    warnings: list[str] = field(default_factory=list)
    snaps: int = 0
    module_rid: int = 0  # local rid of the whole-module range (the scope entry of module_scope files)
    # (code compiled at RELOC_BASE, slots) when `InstrumentOptions.relocatable`; what the cache stores
    relocatable: tuple[types.CodeType, Slots] | None = None
    # Every try statement with except clauses, keyed by the line of its first clause (where
    # `sys.monitoring`'s EXCEPTION_HANDLED lands whichever clause matches): the try's own line
    # (its range covers only the `try:` header) and, per clause, (clause line, body first line,
    # body last line, broad). Empty for library files, whose handlers are never reported.
    except_clauses: dict[int, TryClauses] = field(default_factory=dict)

    @property
    def range_count(self) -> int:
        return len(self.ranges)

    def to_event(self, path: str, instrument_ms: float | None = None) -> dict:
        from .protocol import ev_file_instrumented

        return ev_file_instrumented(
            instrument_ms=instrument_ms,
            file_id=self.file_id,
            path=path,
            range_base=self.range_base,
            ranges=self.ranges,
            statements=self.statements,
            functions=self.functions,
            magic=self.magic,
            instrumented_source=self.instrumented_source,
        )


class Instrumenter:
    def __init__(self, source: str, filename: str, file_id: int = 1, range_base: int = 0, options: InstrumentOptions | None = None) -> None:
        self.source = source
        self.filename = filename
        self.file_id = file_id
        self.range_base = range_base
        self.options = options or InstrumentOptions()

    def run(self) -> InstrumentedFile:
        try:
            tree = ast.parse(self.source, self.filename, type_comments=False)
        except SyntaxError as exc:
            return InstrumentedFile(self.filename, self.file_id, self.range_base, None, [], [], [], [], None, None, error="%s: %s" % (type(exc).__name__, exc.msg), error_line=exc.lineno)
        clauses = {} if self.options.library else except_clauses(tree)  # before the rewrite adds its own try statements
        rw = _Rewriter(self.source, self.options)
        inline = magic_mod.inline_config(tree)
        if inline is not None:
            tree.body = tree.body[1:]
        comments = magic_mod.scan_comments(self.source)
        cands = collect_candidates(tree)
        if self.options.magic:
            self._plan_magic(rw, cands, magic_mod.find_magic(comments))
        self._plan_markers(rw, cands)
        ignore_lines, ignore_file = magic_mod.find_ignores(comments, self.options.ignore_coverage, self.options.ignore_coverage_for_file)
        for line in ignore_lines:
            st = statement_at_line(cands, line)
            if st is not None:
                for sub in ast.walk(st):
                    if isinstance(sub, ast.stmt):
                        rw.ignored_spans.add(node_span(sub))
        mod_span = module_span(self.source)
        rw.span_index(mod_span)
        snaps = magic_mod.extract_snaps(tree, self.source) if self.options.mode == "snaps" else []
        for snap in snaps:
            if snap.tree is not None and not self.options.library:
                clauses.update(except_clauses(snap.tree))  # snap trees carry file line numbers
        module_ref = tree.body[0] if tree.body else None
        head: list[ast.stmt] = []
        rest = list(tree.body)
        while rest and (is_future_import(rest[0]) or (not head and is_docstring(rest[0], 0))):
            head.append(rest.pop(0))
        # docstring may come before __future__ imports; keep the original order
        head = [s for s in tree.body if s in head]
        snaps_mode = self.options.mode == "snaps"
        body = rw.body(rest, in_function=self.options.module_scope, guard=snaps_mode)
        if snaps_mode:
            body.extend(self._snaps_body(rw, snaps))
        if self.options.module_scope and module_ref is not None:
            rw.functions.append((mod_span, "<module>", mod_span))
            assign = ast.Assign(targets=[_name(SCOPE_NAME, ast.Store())], value=ast.Call(func=_name(HOOK_FN), args=[rw.rid_const(mod_span)], keywords=[]))
            _locate(assign, module_ref, point=True)
            exit_call = ast.Expr(value=ast.Call(func=_name(HOOK_EXIT), args=[_name(SCOPE_NAME)], keywords=[]))
            _locate(exit_call, module_ref, point=True)
            tryf = ast.Try(body=body or [_locate(ast.Pass(), module_ref, point=True)], handlers=[], orelse=[], finalbody=[exit_call])  # type: ignore[list-item]
            # Only the Try node itself: `_locate` walks the subtree, and that is the whole module body,
            # whose positions (f_lineno in error stacks and tracebacks) must stay their own.
            tryf.lineno = tryf.end_lineno = module_ref.lineno
            tryf.col_offset = tryf.end_col_offset = module_ref.col_offset
            body = [assign, tryf]
        tree.body = head + body
        ast.fix_missing_locations(tree)
        result = self._finish(rw, tree, mod_span, inline)
        result.snaps = len(snaps)
        result.except_clauses = clauses
        return result

    # -- planning ----------------------------------------------------------
    def _plan_magic(self, rw: _Rewriter, cands: Any, magics: list[magic_mod.MagicComment]) -> None:
        for mc in magics:
            target = attach_to_line(cands, mc.line)
            if target is None:
                rw.warnings.append("line %d: `# ?` has no expression to attach to" % mc.line)
                continue
            what, node = target
            if mc.code is not None:
                _locate(mc.code, node)
            plan = ValuePlan(kind=mc.kind, code=mc.code, source="magic")
            if what == "stmt":
                rw.stmt_plans[id(node)] = plan
            else:
                rw.expr_plans[id(node)] = plan

    def _plan_markers(self, rw: _Rewriter, cands: Any) -> None:
        for m in self.options.markers or []:
            try:
                kind = m.get("kind", "value")
                rng = m.get("range")
                if not rng or len(rng) != 4:
                    continue
                rng_t: Span = (int(rng[0]), int(rng[1]), int(rng[2]), int(rng[3]))
                marker_id = m.get("id")
                change_id = m.get("changeId")
                context = m.get("context")
                if kind in ("value", "time"):
                    exp = m.get("exp")
                    if exp:
                        st = statement_at_line(cands, rng_t[0])
                        if st is None:
                            continue
                        rw.stmt_logpoints.setdefault(id(st), []).append(LogpointPlan("value", exp, context or exp, marker_id, change_id, True, True))
                        continue
                    target = find_covering(cands, rng_t)
                    if target is None:
                        continue
                    what, node = target
                    if kind == "time":
                        vkind = KIND_TIME_AUTO_EXPAND if m.get("autoExpand") else KIND_TIME
                    else:
                        vkind = KIND_AUTO_EXPAND if m.get("autoExpand") else KIND_VALUE
                    plan = ValuePlan(kind=vkind, context=context, marker_id=marker_id, change_id=change_id, source="marker")
                    if what == "stmt":
                        rw.stmt_plans[id(node)] = plan
                    else:
                        rw.expr_plans[id(node)] = plan
                elif kind == "logpoint":
                    st = statement_at_line(cands, rng_t[0])
                    if st is None:
                        continue
                    message = m.get("logMessage")
                    if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)) and not message:
                        rw.stmt_plans[id(st)] = ValuePlan(kind="logpoint", context=context, marker_id=marker_id, change_id=change_id, source="logpoint")
                    elif message:
                        rw.stmt_logpoints.setdefault(id(st), []).append(LogpointPlan("logpoint", message, context, marker_id, change_id, False, False))
                    else:
                        rw.stmt_plans[id(st)] = ValuePlan(kind="logpoint", context=context, marker_id=marker_id, change_id=change_id, source="logpoint")
            except Exception as exc:  # noqa: BLE001
                rw.warnings.append("marker %r ignored: %s" % (m.get("id"), exc))

    def _snaps_body(self, rw: _Rewriter, snaps: list[magic_mod.Snap]) -> list[ast.stmt]:
        out: list[ast.stmt] = []
        for snap in snaps:
            fence_span = node_span(snap.fence)
            if snap.tree is None:
                call = ast.Expr(value=ast.Call(func=_name(HOOK_SNAP_ERROR), args=[_const(snap.error), rw.rid_const(fence_span)], keywords=[]))
                out.append(_locate(call, snap.fence, point=True))  # type: ignore[arg-type]
                continue
            out.extend(rw.body(snap.tree.body, in_function=self.options.module_scope, snap=True, guard=True))
        return out

    # -- renumbering and compile ------------------------------------------------
    def _finish(self, rw: _Rewriter, tree: ast.Module, mod_span: Span, inline: dict | None) -> InstrumentedFile:
        order = sorted(rw.spans, key=lambda s: (s[0], s[1], -s[2], -s[3]))
        final = {s: i for i, s in enumerate(order)}
        base = self.range_base
        ranges = [list(s) for s in order]
        ignored = {final[s] for s in rw.ignored_spans if s in final}
        statements = sorted({final[s] for s in rw.stmt_spans} - ignored)
        functions = [{"rid": final[s], "name": n, "bodyRange": list(b)} for s, n, b in rw.functions]
        functions.sort(key=lambda f: f["rid"])
        magic = [{"rid": final[s], "kind": k} for s, k in rw.magic]
        expr_children = {final[s]: [final[c] for c in cs] for s, cs in rw.expr_children.items() if s in final}
        line_rids: dict[int, int] = {}
        for s, start, end in sorted(rw.stmt_lines, key=lambda t: (t[1], t[0][1])):
            for line in range(start, end + 1):
                line_rids[line] = final[s]
        def_logs = {base + final[s]: v for s, v in rw.def_logs.items()}
        function_names = {base + f["rid"]: f["name"] for f in functions}
        code = None
        error = None
        error_line = None
        relocatable = None
        if self.options.relocatable:
            _set_rids(rw, final, RELOC_BASE)
            code_a, error, error_line = self._compile(tree)
            if code_a is not None:
                _set_rids(rw, final, RELOC_BASE + RELOC_DELTA)
                code_b, _, _ = self._compile(tree)
                slots = relocation_slots(code_a, code_b) if code_b is not None else None
                if slots is not None:
                    relocatable = (code_a, slots)
                    code = relocate(code_a, slots, base - RELOC_BASE)
        _set_rids(rw, final, base)
        if code is None and error is None:
            code, error, error_line = self._compile(tree)
        if code is None:
            # Fall back to the plain program so the user's code still runs.
            try:
                code = compile(self.source, self.filename, "exec", dont_inherit=True)
            except SyntaxError as exc:
                error, error_line = "%s: %s" % (type(exc).__name__, exc.msg), exc.lineno
        instrumented_source = None
        if self.options.unparse:
            try:
                instrumented_source = ast.unparse(tree)
            except Exception:  # noqa: BLE001
                instrumented_source = None
        return InstrumentedFile(
            filename=self.filename,
            file_id=self.file_id,
            range_base=base,
            code=code,
            ranges=ranges,
            statements=statements,
            functions=functions,
            magic=magic,
            library=self.options.library,
            instrumented_source=instrumented_source,
            inline_config=inline,
            expr_children=expr_children,
            line_rids=line_rids,
            ignored=ignored,
            ignore_file=magic_mod.find_ignores(magic_mod.scan_comments(self.source), "", self.options.ignore_coverage_for_file)[1],
            def_logs=def_logs,
            function_names=function_names,
            error=error,
            error_line=error_line,
            warnings=list(rw.warnings),
            module_rid=final[mod_span],
            relocatable=relocatable,
        )

    def _compile(self, tree: ast.Module) -> tuple[types.CodeType | None, str | None, int | None]:
        try:
            return compile(tree, self.filename, "exec", dont_inherit=True), None, None
        except ValueError as exc:
            if "line range" in str(exc) or "position" in str(exc):
                _normalise_positions(tree)
                try:
                    return compile(tree, self.filename, "exec", dont_inherit=True), None, None
                except Exception as exc2:  # noqa: BLE001
                    return None, "instrumentation failed: %s" % exc2, None
            return None, "instrumentation failed: %s" % exc, None
        except SyntaxError as exc:
            return None, "instrumentation failed: %s" % exc.msg, exc.lineno
        except RecursionError:
            return None, "instrumentation failed: source too deeply nested", None


def _set_rids(rw: _Rewriter, final: dict[Span, int], base: int) -> None:
    for c, s in rw.consts:
        c.value = base + final[s]


def instrument(source: str, filename: str = "<scratch>", file_id: int = 1, range_base: int = 0, options: InstrumentOptions | None = None) -> InstrumentedFile:
    return Instrumenter(source, filename, file_id, range_base, options).run()
