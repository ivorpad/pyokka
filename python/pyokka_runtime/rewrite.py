"""The AST rewriter: statement hooks, expression coverage, scopes, value plans.

See ``instrument`` for the hook contract; this module is the mechanical part.
"""

from __future__ import annotations

import ast
import types
from dataclasses import dataclass, field
from typing import Any

from . import magic as magic_mod
from .protocol import KIND_AUTO_EXPAND, KIND_TIME, KIND_TIME_AUTO_EXPAND, KIND_VALUE
from .spans import (
    BODY_FIELDS,
    Span,
    attach_to_line,
    bound_names,
    collect_candidates,
    find_covering,
    full_span,
    is_docstring,
    is_future_import,
    load_copy,
    module_span,
    node_span,
    statement_at_line,
)

HOOK_STEP = "_pk_s"
HOOK_COV = "_pk_c"
HOOK_FN = "_pk_f"
HOOK_EXIT = "_pk_x"
HOOK_VALUE = "_pk_v"
HOOK_TIME = "_pk_t"
HOOK_PRINT = "_pk_print"
HOOK_LOGPOINT = "_pk_logpoint"
HOOK_NOW = "_pk_time"
HOOK_SNAP_ERROR = "_pk_snap_error"
HOOK_UNSET = "_pk_u"  # what `_pk_rv_` holds until a `return` runs: the frame is leaving by an exception
HOOK_END = "_pk_end"  # what `_pk_rv_` holds when the body ran off its end
SCOPE_NAME = "_pk_scope_"
RET_NAME = "_pk_rv_"
HOOK_NAMES = (HOOK_STEP, HOOK_COV, HOOK_FN, HOOK_EXIT, HOOK_VALUE, HOOK_TIME, HOOK_PRINT, HOOK_LOGPOINT, HOOK_NOW, HOOK_SNAP_ERROR, HOOK_UNSET, HOOK_END)

_SKIP_FIELDS = set(BODY_FIELDS) | {"annotation", "returns", "type_params", "pattern"}
_TIME_KINDS = (KIND_TIME, KIND_TIME_AUTO_EXPAND)


@dataclass
class InstrumentOptions:
    mode: str = "normal"  # normal | snaps | profile
    auto_log: bool = False
    markers: list[dict] = field(default_factory=list)
    ignore_coverage: str = "ignore coverage|pragma: no cover"
    ignore_coverage_for_file: str = "ignore file coverage"
    module_scope: bool = False  # imported project modules run in their own scope (depth 1)
    unparse: bool = True
    magic: bool = True  # honour `# ?` live comments (off for library files: their comments are not ours)
    library: bool = False  # third-party module instrumented via `libraryCode`
    relocatable: bool = False  # also keep a code object whose range ids can be rebased (for the cache)


@dataclass
class ValuePlan:
    kind: str
    context: str | None = None
    marker_id: str | None = None
    change_id: str | None = None
    code: ast.expr | None = None
    source: str = "magic"  # magic | marker | identifier | autoLog | snap | logpoint


@dataclass
class LogpointPlan:
    kind: str
    template: str
    context: str | None
    marker_id: str | None
    change_id: str | None
    is_expr: bool
    after: bool


def _name(n: str, ctx: ast.expr_context | None = None) -> ast.Name:
    return ast.Name(id=n, ctx=ctx or ast.Load())


def _const(v: Any) -> ast.Constant:
    return ast.Constant(value=v)


def _locate(node: ast.AST, ref: ast.AST, *, point: bool = False) -> ast.AST:
    """Copy ``ref``'s position onto ``node`` and everything below it."""
    for sub in ast.walk(node):
        if "lineno" in sub._attributes:
            sub.lineno = ref.lineno
            sub.col_offset = ref.col_offset
            if point:
                sub.end_lineno = ref.lineno
                sub.end_col_offset = ref.col_offset
            else:
                sub.end_lineno = getattr(ref, "end_lineno", ref.lineno)
                sub.end_col_offset = getattr(ref, "end_col_offset", ref.col_offset)
    return node


class _Rewriter(ast.NodeTransformer):
    def __init__(self, source: str, options: InstrumentOptions) -> None:
        self.source = source
        self.options = options
        self.spans: dict[Span, int] = {}
        self.consts: list[tuple[ast.Constant, Span]] = []
        self.stmt_spans: list[Span] = []
        self.stmt_lines: list[tuple[Span, int, int]] = []
        self.functions: list[tuple[Span, str, Span]] = []
        self.magic: list[tuple[Span, str]] = []
        self.expr_children: dict[Span, list[Span]] = {}
        self.cur_stmt: Span | None = None
        self.expr_plans: dict[int, ValuePlan] = {}
        self.stmt_plans: dict[int, ValuePlan] = {}
        self.stmt_logpoints: dict[int, list[LogpointPlan]] = {}
        self.def_logs: dict[Span, dict] = {}
        self.ignored_spans: set[Span] = set()
        self.in_function = False
        self.in_class_body = False  # statements executed while a class is being defined
        self.module_level = True  # not inside any def (the module body, class bodies at module level)
        self.snap_mode = False
        self.warnings: list[str] = []

    # -- span / constant bookkeeping ------------------------------------
    def span_index(self, span: Span) -> int:
        idx = self.spans.get(span)
        if idx is None:
            idx = len(self.spans)
            self.spans[span] = idx
        return idx

    def rid_const(self, span: Span) -> ast.Constant:
        self.span_index(span)
        c = _const(-1)
        self.consts.append((c, span))
        return c

    def segment(self, node: ast.AST) -> str:
        try:
            text = ast.get_source_segment(self.source, node)
        except Exception:  # noqa: BLE001
            text = None
        if text is None:
            try:
                text = ast.unparse(node)
            except Exception:  # noqa: BLE001
                text = ""
        return " ".join(text.split())

    # -- hook builders ---------------------------------------------------
    def _step_hook(self, span: Span, ref: ast.stmt) -> ast.stmt:
        args: list[ast.expr] = [self.rid_const(span)]
        if self.in_function:
            args.append(_name(SCOPE_NAME))
        call = ast.Call(func=_name(HOOK_STEP), args=args, keywords=[])
        return _locate(ast.Expr(value=call), ref, point=True)  # type: ignore[return-value]

    def coverage_only(self, s: ast.stmt | None = None) -> bool:
        """Statements that record coverage but no Time Machine step.

        Quokka records no step for declarations, so ``def``/``class`` statements and the
        statements of a class body (fields, decorators' targets) are coverage-only: the Time
        Machine goes straight from the previous statement to the first real statement or call.
        Library modules add their whole module body: import-time execution of a third-party
        package (pydantic building its models, ...) is not something the user stepped into.
        """
        if s is not None and isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            return True
        return self.in_class_body or (self.options.library and self.module_level)

    def _stmt_hook(self, span: Span, ref: ast.stmt, s: ast.stmt | None = None) -> ast.stmt:
        return self._cov_stmt(span, ref) if self.coverage_only(s) else self._step_hook(span, ref)

    def _cov_stmt(self, span: Span, ref: ast.stmt) -> ast.stmt:
        call = ast.Call(func=_name(HOOK_COV), args=[self.rid_const(span)], keywords=[])
        return _locate(ast.Expr(value=call), ref, point=True)  # type: ignore[return-value]

    def _cov(self, expr: ast.expr) -> ast.expr:
        span = full_span(expr)
        if self.cur_stmt is not None:
            self.expr_children.setdefault(self.cur_stmt, []).append(span)
        call = ast.Call(func=_name(HOOK_COV), args=[self.rid_const(span)], keywords=[])
        tup = ast.Tuple(elts=[call, expr], ctx=ast.Load())
        out = ast.Subscript(value=tup, slice=_const(1), ctx=ast.Load())
        for sub in (call, call.func, tup, out, out.slice):
            ast.copy_location(sub, expr)
        return out

    def _value_call(self, span: Span, plan: ValuePlan, value: ast.expr, ref: ast.AST, context: str | None = None, *, discard: bool = False) -> ast.expr:
        ctx = plan.context if plan.context is not None else (context if context is not None else self.segment(ref))
        kind = plan.kind
        if kind in _TIME_KINDS:
            now = ast.Call(func=_name(HOOK_NOW), args=[], keywords=[])
            args: list[ast.expr] = [self.rid_const(span), _const(ctx), now, value, _const(kind), _const(plan.marker_id), _const(plan.change_id)]
            call = ast.Call(func=_name(HOOK_TIME), args=args, keywords=[])
        else:
            args = [self.rid_const(span), _const(ctx), value, _const(kind), _const(plan.marker_id), _const(plan.change_id)]
            if plan.code is not None:
                fn = ast.Lambda(
                    args=ast.arguments(posonlyargs=[], args=[ast.arg(arg=magic_mod.DOLLAR_NAME)], vararg=None, kwonlyargs=[], kw_defaults=[], kwarg=None, defaults=[]),
                    body=plan.code,
                )
                args.append(fn)
            keywords = [ast.keyword(arg="discard", value=_const(True))] if discard else []
            call = ast.Call(func=_name(HOOK_VALUE), args=args, keywords=keywords)
        _locate_missing(call, ref)
        return call

    def _log_stmt(self, span: Span, plan: ValuePlan, value: ast.expr, ref: ast.AST, context: str | None) -> ast.stmt:
        call = self._value_call(span, plan, value, ref, context)
        return _locate(ast.Expr(value=call), ref, point=True)  # type: ignore[return-value]

    # -- bodies -----------------------------------------------------------
    def body(self, stmts: list[ast.stmt], *, in_function: bool | None = None, in_class: bool | None = None, snap: bool = False, guard: bool = False) -> list[ast.stmt]:
        """Rewrite a statement list. ``guard`` wraps each statement in try/except (snaps mode)."""
        saved = (self.in_function, self.in_class_body, self.snap_mode)
        if in_function is not None:
            self.in_function = in_function
        if in_class is not None:
            self.in_class_body = in_class
        self.snap_mode = snap
        out: list[ast.stmt] = []
        try:
            for index, s in enumerate(stmts):
                group = self.stmt(s, index)
                if guard and len(group) > 1:
                    out.append(self.guard(group, node_span(s), s))
                else:
                    out.extend(group)
        finally:
            self.in_function, self.in_class_body, self.snap_mode = saved
        return out

    def stmt(self, s: ast.stmt, index: int) -> list[ast.stmt]:
        if is_docstring(s, index) or is_future_import(s):
            return [s]
        span = node_span(s)
        self.span_index(span)
        self.stmt_spans.append(span)
        self.stmt_lines.append((span, s.lineno, span[2]))
        prev = self.cur_stmt
        self.cur_stmt = span
        try:
            if type(s).__name__ != "TypeAlias":
                self._visit_header(s)
            if isinstance(s, ast.Assert) and s.msg is not None:
                s.msg = self._cov(s.msg)
            self._visit_bodies(s, span)
        finally:
            self.cur_stmt = prev
        hook = self._stmt_hook(span, s, s)
        pre: list[ast.stmt] = []
        post: list[ast.stmt] = []
        plan = self._plan_for(s)
        if plan is not None:
            self._apply_plan(s, span, plan, pre, post)
        for lp in self.stmt_logpoints.get(id(s), ()):
            call = ast.Call(
                func=_name(HOOK_LOGPOINT),
                args=[self.rid_const(span), _const(lp.kind), _const(lp.template), _const(lp.context), _const(lp.marker_id), _const(lp.change_id), _const(lp.is_expr)],
                keywords=[],
            )
            target = post if lp.after and not isinstance(s, (ast.Return, ast.Raise, ast.Break, ast.Continue)) else pre
            target.append(_locate(ast.Expr(value=call), s, point=True))  # type: ignore[arg-type]
        return [hook, *pre, s, *post]

    def _visit_header(self, s: ast.stmt) -> None:
        for name, value in ast.iter_fields(s):
            if name in _SKIP_FIELDS:
                continue
            if isinstance(value, list):
                setattr(s, name, [self._visit_part(v) for v in value])
            elif isinstance(value, ast.AST):
                setattr(s, name, self._visit_part(value))

    def _visit_part(self, node: ast.AST) -> ast.AST:
        if isinstance(node, ast.expr):
            return self.visit(node)
        if isinstance(node, ast.arguments):
            node.defaults = [self.visit(d) for d in node.defaults]
            node.kw_defaults = [self.visit(d) if d is not None else None for d in node.kw_defaults]
            return node
        if isinstance(node, ast.withitem):
            node.context_expr = self.visit(node.context_expr)
            if node.optional_vars is not None:
                node.optional_vars = self.visit(node.optional_vars)
            return node
        if isinstance(node, ast.keyword):
            node.value = self.visit(node.value)
            return node
        return node

    def _visit_bodies(self, s: ast.stmt, span: Span) -> None:
        if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)):
            s.body = self._function_body(s, span)
            return
        if isinstance(s, ast.ClassDef):
            s.body = self.body(s.body, in_class=True)
            return
        for name in ("body", "orelse", "finalbody"):
            value = getattr(s, name, None)
            if isinstance(value, list) and value and isinstance(value[0], ast.stmt):
                setattr(s, name, self.body(value))
        if isinstance(s, (ast.For, ast.AsyncFor, ast.While)):
            # one step per iteration so the Time Machine can step back onto the loop line
            s.body.insert(0, self._stmt_hook(span, s))
        for h in getattr(s, "handlers", []) or []:
            if h.type is not None:
                h.type = self.visit(h.type)
            h.body = self.body(h.body)
        for case in getattr(s, "cases", []) or []:
            if case.guard is not None:
                case.guard = self._cov(self.visit(case.guard))
            case.body = self.body(case.body)

    def _function_body(self, fn: ast.FunctionDef | ast.AsyncFunctionDef, span: Span) -> list[ast.stmt]:
        body = fn.body
        doc = body[0] if body and is_docstring(body[0], 0) else None
        rest = body[1:] if doc is not None else body
        saved_level = self.module_level
        self.module_level = False
        try:
            inner = self.body(rest, in_function=True, in_class=False)
        finally:
            self.module_level = saved_level
        if not inner:
            inner = [_locate(ast.Pass(), fn, point=True)]  # type: ignore[list-item]
        self.functions.append((span, fn.name, full_span(fn)))
        first = rest[0] if rest else fn
        assign = ast.Assign(
            targets=[_name(SCOPE_NAME, ast.Store())],
            value=ast.Call(func=_name(HOOK_FN), args=[self.rid_const(span)], keywords=[]),
        )
        _locate(assign, first, point=True)
        unset = ast.Assign(targets=[_name(RET_NAME, ast.Store())], value=_name(HOOK_UNSET))
        _locate(unset, first, point=True)
        # the return value reaches the exit hook through a local, so a return costs a store, not a call
        exit_call = ast.Expr(value=ast.Call(func=_name(HOOK_EXIT), args=[_name(SCOPE_NAME), _name(RET_NAME)], keywords=[]))
        _locate(exit_call, rest[-1] if rest else fn, point=True)
        inner = _keep_returns(inner)
        fall_off = ast.Assign(targets=[_name(RET_NAME, ast.Store())], value=_name(HOOK_END))
        _locate(fall_off, rest[-1] if rest else fn, point=True)
        inner.append(fall_off)
        tryf = ast.Try(body=inner, handlers=[], orelse=[], finalbody=[exit_call])
        tryf.lineno = first.lineno
        tryf.col_offset = first.col_offset
        tryf.end_lineno = (rest[-1] if rest else fn).end_lineno
        tryf.end_col_offset = (rest[-1] if rest else fn).end_col_offset
        out: list[ast.stmt] = []
        if doc is not None:
            out.append(doc)
        out.extend([assign, unset, tryf])
        return out

    # -- expression visitors -------------------------------------------------
    def visit(self, node: ast.AST) -> Any:  # type: ignore[override]
        key = id(node)
        new = super().visit(node)
        plan = self.expr_plans.pop(key, None)
        if plan is not None and isinstance(new, ast.expr):
            span = node_span(node)
            if plan.source == "magic":
                self.magic.append((span, plan.kind))
            new = self._value_call(span, plan, new, node)
        return new

    def visit_Name(self, node: ast.Name) -> ast.AST:
        return node

    visit_Constant = visit_Name  # type: ignore[assignment]

    def visit_BoolOp(self, node: ast.BoolOp) -> ast.AST:
        self.generic_visit(node)
        node.values = [node.values[0]] + [self._cov(v) for v in node.values[1:]]
        return node

    def visit_IfExp(self, node: ast.IfExp) -> ast.AST:
        self.generic_visit(node)
        node.body = self._cov(node.body)
        node.orelse = self._cov(node.orelse)
        return node

    def _comp_generators(self, node: Any) -> None:
        for i, g in enumerate(node.generators):
            if i > 0:
                g.iter = self._cov(g.iter)
            g.ifs = [self._cov(x) for x in g.ifs]

    def visit_ListComp(self, node: ast.ListComp) -> ast.AST:
        self.generic_visit(node)
        node.elt = self._cov(node.elt)
        self._comp_generators(node)
        return node

    visit_SetComp = visit_ListComp  # type: ignore[assignment]
    visit_GeneratorExp = visit_ListComp  # type: ignore[assignment]

    def visit_DictComp(self, node: ast.DictComp) -> ast.AST:
        self.generic_visit(node)
        node.key = self._cov(node.key)
        node.value = self._cov(node.value)
        self._comp_generators(node)
        return node

    def visit_Compare(self, node: ast.Compare) -> ast.AST:
        self.generic_visit(node)
        node.comparators = [node.comparators[0]] + [self._cov(c) for c in node.comparators[1:]]
        return node

    def visit_Call(self, node: ast.Call) -> ast.AST:
        self.generic_visit(node)
        if isinstance(node.func, ast.Name) and node.func.id == "print" and isinstance(node.func.ctx, ast.Load):
            span = full_span(node)
            new_func = ast.copy_location(_name(HOOK_PRINT), node.func)
            node.func = new_func
            node.args = [ast.copy_location(self.rid_const(span), node), *node.args]
        return node

    def visit_Lambda(self, node: ast.Lambda) -> ast.AST:
        self.generic_visit(node)
        span = full_span(node)
        self.functions.append((span, "<lambda>", span))
        call = ast.Call(func=_name(HOOK_FN), args=[self.rid_const(span)], keywords=[])
        tup = ast.Tuple(elts=[call, node.body], ctx=ast.Load())
        out = ast.Subscript(value=tup, slice=_const(1), ctx=ast.Load())
        for sub in (call, call.func, tup, out, out.slice):
            ast.copy_location(sub, node.body)
        node.body = out
        return node

    # -- statement value plans ----------------------------------------------
    def _plan_for(self, s: ast.stmt) -> ValuePlan | None:
        plan = self.stmt_plans.get(id(s))
        if plan is not None:
            return plan
        if isinstance(s, ast.Expr) and isinstance(s.value, ast.Name):
            return ValuePlan(kind=KIND_VALUE, context=s.value.id, source="identifier")
        if self.snap_mode:
            if self._auto_loggable(s):
                return ValuePlan(kind=KIND_VALUE, source="snap")
            return None
        if self.options.auto_log and self._auto_loggable(s):
            return ValuePlan(kind="autoLog", source="autoLog")
        return None

    @staticmethod
    def _auto_loggable(s: ast.stmt) -> bool:
        if isinstance(s, (ast.Assign, ast.AugAssign, ast.Return)):
            return True
        if isinstance(s, ast.AnnAssign):
            return s.value is not None
        if isinstance(s, ast.Expr):
            v = s.value
            if isinstance(v, ast.Constant):
                return False
            if isinstance(v, ast.Call) and isinstance(v.func, ast.Name) and v.func.id in (HOOK_PRINT, "print"):
                return False
            return True
        return False

    def _apply_plan(self, s: ast.stmt, span: Span, plan: ValuePlan, pre: list[ast.stmt], post: list[ast.stmt]) -> None:
        if plan.source == "magic":
            self.magic.append((span, plan.kind))
        value_plan = plan
        if plan.kind in _TIME_KINDS and not isinstance(s, (ast.Assign, ast.AnnAssign, ast.Return, ast.Expr)):
            value_plan = ValuePlan(kind=KIND_AUTO_EXPAND if plan.kind == KIND_TIME_AUTO_EXPAND else KIND_VALUE, context=plan.context, marker_id=plan.marker_id, change_id=plan.change_id, code=plan.code, source=plan.source)
        if isinstance(s, ast.Assign):
            s.value = self._value_call(span, plan, s.value, s, self.segment(s.targets[0]))
        elif isinstance(s, ast.AnnAssign):
            if s.value is not None:
                s.value = self._value_call(span, plan, s.value, s, self.segment(s.target))
        elif isinstance(s, ast.AugAssign):
            post.append(self._log_stmt(span, value_plan, load_copy(s.target), s, self.segment(s.target)))
        elif isinstance(s, ast.Return):
            value = s.value if s.value is not None else ast.copy_location(_const(None), s)
            s.value = self._value_call(span, plan, value, s, self.segment(s.value) if s.value is not None else "return")
        elif isinstance(s, ast.Expr):
            ctx = plan.context if plan.context is not None else self.segment(s.value)
            s.value = self._value_call(span, plan, s.value, s, ctx, discard=True)
        elif isinstance(s, (ast.For, ast.AsyncFor)):
            s.body.insert(0, self._log_stmt(span, value_plan, load_copy(s.target), s, self.segment(s.target)))
        elif isinstance(s, (ast.With, ast.AsyncWith)):
            vars_ = [i.optional_vars for i in s.items if i.optional_vars is not None]
            if vars_:
                s.body.insert(0, self._log_stmt(span, value_plan, load_copy(vars_[-1]), s, self.segment(vars_[-1])))
        elif isinstance(s, (ast.If, ast.While)):
            s.test = self._value_call(span, value_plan, s.test, s, self.segment(s.test))
        elif isinstance(s, ast.Match):
            s.subject = self._value_call(span, value_plan, s.subject, s, self.segment(s.subject))
        elif isinstance(s, ast.Assert):
            s.test = self._value_call(span, value_plan, s.test, s, self.segment(s.test))
        elif isinstance(s, ast.Raise) and s.exc is not None:
            s.exc = self._value_call(span, value_plan, s.exc, s, self.segment(s.exc))
        elif isinstance(s, (ast.Import, ast.ImportFrom)):
            names = bound_names(s)
            if names:
                post.append(self._log_stmt(span, value_plan, ast.copy_location(_name(names[0]), s), s, names[0]))
        elif isinstance(s, ast.ClassDef):
            post.append(self._log_stmt(span, value_plan, ast.copy_location(_name(s.name), s), s, s.name))
        elif isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)):
            self.def_logs[span] = {"kind": "logpoint" if plan.source == "logpoint" else value_plan.kind, "markerId": plan.marker_id, "changeId": plan.change_id, "context": plan.context}

    # -- snaps ------------------------------------------------------------
    def guard(self, stmts: list[ast.stmt], span: Span, ref: ast.stmt) -> ast.stmt:
        handler_call = ast.Expr(value=ast.Call(func=_name(HOOK_SNAP_ERROR), args=[_name("_pk_e"), self.rid_const(span)], keywords=[]))
        handler = ast.ExceptHandler(type=_name("BaseException"), name="_pk_e", body=[handler_call])
        node = ast.Try(body=stmts, handlers=[handler], orelse=[], finalbody=[])
        _locate(handler, ref, point=True)
        node.lineno, node.col_offset = ref.lineno, ref.col_offset
        node.end_lineno, node.end_col_offset = ref.end_lineno, ref.end_col_offset
        return node


def _keep_returns(stmts: list[ast.stmt]) -> list[ast.stmt]:
    """Every ``return`` of this function, at any depth of try/except/finally, with, if, loop or match,
    stores its value in ``_pk_rv_`` on the way out: ``return (_pk_rv_ := value)``.

    A bare ``return`` becomes ``_pk_rv_ = None`` before it and stays bare (an async generator
    allows no value). Nested ``def`` and ``class`` bodies are skipped: an instrumented nested
    function keeps its own. The value keeps its positions, so a traceback from inside it still
    names the original column.
    """
    out: list[ast.stmt] = []
    for s in stmts:
        if isinstance(s, ast.Return):
            if s.value is None:
                store = ast.Assign(targets=[_name(RET_NAME, ast.Store())], value=_const(None))
                _locate(store, s, point=True)
                out.append(store)
            else:
                walrus = ast.NamedExpr(target=_name(RET_NAME, ast.Store()), value=s.value)
                ast.copy_location(walrus, s.value)
                _locate(walrus.target, s.value, point=True)
                s.value = walrus
            out.append(s)
            continue
        if not isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            for name in ("body", "orelse", "finalbody"):
                sub = getattr(s, name, None)
                if isinstance(sub, list) and sub:
                    setattr(s, name, _keep_returns(sub))
            for h in getattr(s, "handlers", None) or ():
                h.body = _keep_returns(h.body)
            for case in getattr(s, "cases", None) or ():
                case.body = _keep_returns(case.body)
        out.append(s)
    return out


def _locate_missing(node: ast.AST, ref: ast.AST, skip: ast.AST | None = None) -> None:
    for sub in ast.walk(node):
        if sub is skip:
            continue
        if "lineno" in sub._attributes and getattr(sub, "lineno", None) is None:
            ast.copy_location(sub, ref)


def _normalise_positions(tree: ast.AST) -> None:
    for node in ast.walk(tree):
        if "lineno" not in node._attributes:
            continue
        ln = getattr(node, "lineno", None)
        if ln is None:
            continue
        el = getattr(node, "end_lineno", None)
        if el is None or el < ln:
            node.end_lineno = ln
            node.end_col_offset = node.col_offset
        elif el == ln and (getattr(node, "end_col_offset", None) is None or node.end_col_offset < node.col_offset):
            node.end_col_offset = node.col_offset
