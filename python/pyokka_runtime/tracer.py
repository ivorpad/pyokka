"""Per-run recorder: coverage, trace steps and scopes, logs, timings, watches, locals.

The hooks are installed as builtins so instrumented code can call them from
any module without imports. Every hook is wrapped so a bug in the runtime
surfaces as a ``system`` log instead of breaking the user's program.
"""

from __future__ import annotations

import bisect
import builtins
import sys
import time
from array import array
from typing import Any, Callable

from .errors import ErrorMixin
from .instrument import HOOK_NAMES, SCOPE_NAME, InstrumentedFile
from .logs import LogMixin
from .record_from import RecordFromMixin
from .protocol import (
    COV_COVERED,
    COV_IGNORED,
    COV_NOT_RUN,
    COV_PARTIAL,
    FLAG_SCOPE_ENTRY,
    MAX_LOCALS_ENTRIES,
    RunConfig,
    encode_steps,
    ev_coverage,
    ev_time,
    ev_trace,
)
from . import secrets
from .serialize import Registry, expression_name, serialize, short_repr
from .values import LOCALS_CHARS, LOG_CHARS, cut_entry, value_chars
from .values import child_by_segment
from .returns import END, INT_FAST, MIN_SECRET_LEN, MODULE_EXIT, UNSET, plain_text

_SIZED = (list, dict, set)
_SCAN_BACK = 5000
TIME_FLUSH_S = 0.25
TRACE_FLUSH_S = 1.0
NO_SCOPE = -1  # `_pk_f` result when no scope was recorded (quiet import, past the step cap)
LIB_MODULE = -2  # `_pk_f` result for a library module body: `_pk_x` ends the quiet import
# How many caller frames `_pk_f` inspects for the caller's scope. A direct call has it at 1;
# a decorator wrapper, `sorted(key=f)` or a library callback add a few uninstrumented frames.
# A task resumed by the event loop (`Handle._run`, `_run_once`, `run_forever`, ...) or a thread
# (`Thread.run`, `_bootstrap_inner`) has none within reach and gets the module as parent.
PARENT_FRAMES = 4
# The debugger's per-call ids start here in a run that records from a pause (`config.recordFrom`), so a
# frame entered before the recording began carries an id no recorded scope can have. The recording hooks
# map such an id through `Tracer.foreign`, creating the scope the first time (`adopt`).
FOREIGN = 1 << 40


class Tracer(LogMixin, ErrorMixin, RecordFromMixin):
    dbg: Any = None  # a debugger.Debugger while the run can pause (config.debug or breakpoints in the run request)

    def __init__(
        self,
        config: RunConfig,
        emit: Callable[[dict], None],
        *,
        trace_context: dict | None = None,
        watches: list[dict] | None = None,
        expressions_to_evaluate: dict | None = None,
        registry: Registry | None = None,
    ) -> None:
        self.config = config
        self.emit = emit
        # Whether this run records at all. `config.record` is only read with `config.debug`, so a
        # run-all run always records; a `record: false` debug run keeps nothing (hooks_debug.py). A run
        # with `recordFrom` starts like the second and turns into the first at a pause (`start_recording`).
        self.record = config.records and not config.records_later
        self.foreign: dict[int, int] = {}  # debugger per-call id (>= FOREIGN) -> recorded scope
        self.mid_run = False  # the recording began at a pause: step 0 is that pause, not the program's start
        self.files: dict[str, InstrumentedFile] = {}
        self.files_by_id: dict[int, InstrumentedFile] = {}
        self.file_bases: list[int] = []
        self.file_order: list[InstrumentedFile] = []
        self.hits: list[int] = []
        self.line_rids: dict[str, dict[int, int]] = {}
        self.function_names: dict[int, str] = {}
        self.def_logs: dict[int, dict] = {}
        # trace
        self.cap = max(0, int(config.max_trace_steps))
        self.steps = array("i")
        self.n_steps = 0
        self.cur_step = 0
        self.cur_scope = 0
        self.scopes: list[dict] = [{"scopeId": 0, "rid": 0, "name": "<module>", "parent": -1, "depth": 0, "first": 0, "last": 0}]
        self.depth_of: list[int] = [0]
        self.scope_last: list[int] = [0]
        self.flushed_steps = 0
        self.flushed_scopes = 0
        # Library module bodies (by module rid) run "quiet": coverage is recorded, steps and scopes
        # are not, until the import finishes. Import-time execution of a package is not code the
        # user stepped into, and pydantic building its models at import was 1 M steps.
        self.library_modules: set[int] = set()
        self.quiet = 0
        # logs
        self.log_serial = 0
        self.log_count = 0
        self.log_hits: dict[int, int] = {}
        self.system_messages: set[str] = set()
        self.console_limit_hit = False
        self.registry = registry if registry is not None else Registry()
        self.expressions_to_evaluate = (expressions_to_evaluate or {}) if config.records else {}
        self.compiled_cache: dict[str, Any] = {}
        self.real_print = builtins.print
        # timing
        self.times: dict[int, list] = {}
        self.times_dirty = False
        self.last_time_flush = time.perf_counter()
        self.last_trace_flush = self.last_time_flush
        self.started = self.last_time_flush
        # watches
        self.watch_codes: list[tuple[str, Any, str | None]] = []
        self.watch_lo = -1
        self.watch_hi = -1
        if trace_context and watches and self.record:
            self._setup_watches(trace_context, watches)
        # locals
        self.record_locals = bool(config.record_locals) and self.record
        self.locals_chars = value_chars(config.max_value_chars, LOCALS_CHARS)
        self.log_chars = value_chars(config.max_value_chars, LOG_CHARS)
        self.local_snaps: dict[int, dict] = {}
        self.locals_entries: list[dict] = []
        self.locals_flushed = 0  # entries already emitted at a debug pause
        self.stop_code = None
        self.installed = False
        self.finished = False
        self._saved_builtins: dict[str, Any] = {}
        self._errors_init()

    # -- files ----------------------------------------------------------------------
    def add_file(self, info: InstrumentedFile) -> None:
        self.files[info.filename] = info
        self.files_by_id[info.file_id] = info
        self.file_bases.append(info.range_base)
        self.file_order.append(info)
        need = info.range_base + info.range_count
        if len(self.hits) < need:
            self.hits.extend([0] * (need - len(self.hits)))
        self.line_rids[info.filename] = {line: info.range_base + rid for line, rid in info.line_rids.items()}
        self.function_names.update(info.function_names)
        self.def_logs.update(info.def_logs)
        if info.library:
            self.library_modules.add(info.range_base + info.module_rid)
        if self.dbg is not None:
            self.dbg.file_added(info)

    def next_range_base(self) -> int:
        return len(self.hits)

    def file_id_for(self, rid: int) -> int:
        if not self.file_bases:
            return 0
        idx = bisect.bisect_right(self.file_bases, rid) - 1
        return self.file_order[max(idx, 0)].file_id

    def rid_at(self, info: InstrumentedFile, line: int) -> int:
        table = self.line_rids.get(info.filename) or {}
        rid = table.get(line)
        if rid is not None:
            return rid
        # Nearest earlier line (an expression continued over several lines).
        best = None
        for ln, r in table.items():
            if ln <= line and (best is None or ln > best[0]):
                best = (ln, r)
        return best[1] if best else info.range_base

    def cur_rid(self) -> int:
        if self.n_steps == 0 or len(self.steps) < 4:
            return 0
        return self.steps[self.cur_step * 4]

    def step_for(self, rid: int) -> int:
        """Most recent recorded step for ``rid`` (bounded backwards scan), else the current step."""
        steps = self.steps
        n = self.cur_step
        if len(steps) >= 4:
            if steps[n * 4] == rid:
                return n
            lo = max(0, n - _SCAN_BACK)
            i = n - 1
            while i >= lo:
                if steps[i * 4] == rid:
                    return i
                i -= 1
        return n

    def _flag_step(self, idx: int, flag: int) -> None:
        pos = idx * 4 + 3
        if 0 <= idx and pos < len(self.steps):
            self.steps[pos] |= flag

    def step_count(self) -> int:
        """Statements executed: the debugger hook's counter with no recording, the trace length with one."""
        if not self.record and self.dbg is not None:
            return self.dbg.count[0]
        return self.n_steps

    def output_step(self) -> int:
        """The statement an ``output`` event came from: the one the counter is on, in both modes."""
        if not self.record and self.dbg is not None:
            return max(0, self.dbg.count[0] - 1)
        return self.cur_step

    # -- install ------------------------------------------------------------------------
    def install(self) -> None:
        if not self.record and self.dbg is not None:
            from .hooks_debug import make_debug_hooks

            hooks = make_debug_hooks(self, self.dbg)
        else:
            hooks = self._make_hooks()
        for name in HOOK_NAMES:
            self._saved_builtins[name] = getattr(builtins, name, None)
            setattr(builtins, name, hooks[name])
        self._saved_builtins["print"] = builtins.print
        builtins.print = hooks["print"]
        self._monitoring_start()
        self.installed = True

    def uninstall(self) -> None:
        if not self.installed:
            return
        self._monitoring_stop()
        for name, old in self._saved_builtins.items():
            if old is None:
                try:
                    delattr(builtins, name)
                except AttributeError:
                    pass
            else:
                setattr(builtins, name, old)
        self.installed = False

    def _make_hooks(self) -> dict[str, Callable]:
        tracer = self
        hits = self.hits
        steps = self.steps
        depth_of = self.depth_of
        scope_last = self.scope_last
        cap = self.cap
        record_locals = self.record_locals
        getframe = sys._getframe
        extend = steps.extend

        library_modules = self.library_modules
        scope_name = SCOPE_NAME
        foreign_get = self.foreign.get

        def mapped(sid: int, frame: Any) -> int:
            """A debugger per-call id from before the recording began, as its recorded scope."""
            s = foreign_get(sid)
            return s if s is not None else tracer.adopt(sid, frame)

        def step(rid: int, scope: int = 0) -> None:
            try:
                hits[rid] += 1
                if tracer.quiet:
                    return
                if scope < 0:  # entered without a scope (a generator created during an import, ...)
                    scope = tracer.cur_scope
                elif scope >= FOREIGN:  # a frame entered before the recording began (`recordFrom`)
                    scope = mapped(scope, getframe(1))
                n = tracer.n_steps
                if n < cap:
                    extend((rid, scope, depth_of[scope], 0))
                    scope_last[scope] = n
                    tracer.cur_step = n
                tracer.n_steps = n + 1
                tracer.cur_scope = scope
                if tracer.dbg is not None and n < cap:
                    tracer.dbg.on_step(n, rid, scope)  # it fetches this frame itself, only if a reason fires
                if tracer.watch_lo <= n < tracer.watch_hi:
                    tracer._eval_watches(n, getframe(1))
                if record_locals:
                    tracer._record_locals(n, scope, getframe(1))
                if (n & 1023) == 0:
                    tracer._periodic()
            except Exception as exc:  # noqa: BLE001
                tracer.hook_error(exc, "step")

        def cov(rid: int) -> None:
            try:
                hits[rid] += 1
            except Exception as exc:  # noqa: BLE001
                tracer.hook_error(exc, "coverage")

        def caller_scope(frame: Any) -> int:
            """The scope of the nearest instrumented caller frame, else the module.

            The parent of a scope is who called (or awaited, or iterated) it, read from the
            caller's own ``_pk_scope_`` local, not whichever scope last recorded a step: while
            gathered tasks interleave, the current scope belongs to another task.
            """
            f = frame.f_back
            hops = 0
            while f is not None and hops < PARENT_FRAMES:
                code = f.f_code
                if code.co_name == "<module>":
                    # module-level code: an imported project module assigns `_pk_scope_` as a
                    # global, the main file's scope is 0. Nothing above a module body is a caller.
                    sid = f.f_globals.get(scope_name)
                    if sid is not None and sid >= FOREIGN:
                        return mapped(sid, f)
                    return sid if sid is not None and sid >= 0 else 0
                # `f_locals` snapshots a function frame's locals on 3.12 (a proxy since 3.13):
                # only touch it where `_pk_scope_` can exist, an instrumented function's fast locals
                if scope_name in code.co_varnames:
                    sid = f.f_locals.get(scope_name)
                    if sid is not None and sid >= 0:
                        return mapped(sid, f) if sid >= FOREIGN else sid
                f = f.f_back
                hops += 1
            return 0

        def enter(rid: int) -> int:
            try:
                if rid in library_modules:
                    tracer.quiet += 1
                    return LIB_MODULE
                if tracer.quiet:
                    return NO_SCOPE
                n = tracer.n_steps
                info = tracer.def_logs.get(rid)
                if n >= cap:
                    # nothing past the cap is recorded; a scope here would only bloat the table
                    tracer.n_steps = n + 1
                    if info is not None:
                        tracer.log_parameters(rid, info, getframe(1))
                    return NO_SCOPE
                frame = getframe(1)
                parent = caller_scope(frame)
                sid = len(tracer.scopes)
                depth = depth_of[parent] + 1
                tracer.scopes.append({"scopeId": sid, "rid": rid, "name": tracer.function_names.get(rid, "<function>"), "parent": parent, "depth": depth, "first": n, "last": n})
                depth_of.append(depth)
                scope_last.append(n)
                extend((rid, sid, depth, FLAG_SCOPE_ENTRY))
                tracer.cur_step = n
                tracer.n_steps = n + 1
                tracer.cur_scope = sid
                if info is not None:
                    tracer.log_parameters(rid, info, frame)
                if tracer.dbg is not None:
                    tracer.dbg.on_step(n, rid, sid)
                return sid
            except Exception as exc:  # noqa: BLE001
                tracer.hook_error(exc, "scope")
                return NO_SCOPE

        scopes = self.scopes

        def leave(sid: int, rv: Any = MODULE_EXIT) -> None:
            """A frame is leaving: its parent becomes current, and ``rv`` (``_pk_rv_``) says how it left.

            ``rv`` is the value a ``return`` stored, ``END`` when the body ran off its end
            (``returned: null``), ``UNSET`` when an exception is leaving (inside this ``finally``
            it is the current one), ``MODULE_EXIT`` for a module body. The last ``return`` wins:
            a ``finally`` that returns again overwrites the local.
            """
            try:
                if sid == LIB_MODULE:
                    tracer.quiet = max(0, tracer.quiet - 1)
                    return
                if sid >= FOREIGN:
                    s = foreign_get(sid)
                    if s is None:
                        return
                    sid = s
                elif not 0 <= sid < len(scopes):
                    return
                scope = scopes[sid]
                tracer.cur_scope = max(scope["parent"], 0)
                if rv is MODULE_EXIT:
                    return
                t = type(rv)
                if t is int and -INT_FAST < rv < INT_FAST or t is float or t is bool or rv is None:
                    # the common case, inline: no user code runs in these reprs, and a text shorter
                    # than the shortest secret value the filter keeps cannot hold one
                    text = repr(rv)
                    scope["returned"] = text if len(text) < MIN_SECRET_LEN else secrets.current.scrub(text)
                elif rv is END:
                    scope["returned"] = None
                elif rv is UNSET:
                    exc = sys.exception()
                    scope["raised"] = type(exc).__name__ if exc is not None else "BaseException"
                elif not tracer.quiet:
                    chars = tracer.locals_chars
                    text = plain_text(rv, chars)
                    if text is not None:
                        scope["returned"] = secrets.current.scrub(text)
                        return
                    tracer.quiet += 1  # a `__repr__` in instrumented code is not the program running
                    try:
                        # cut and marked as a local is: `…(+N chars)`, `returnedTruncated`, `returnedLength`
                        entry = cut_entry({}, "return", rv, chars)
                    finally:
                        tracer.quiet -= 1
                    scope["returned"] = entry["text"]
                    if entry.get("truncated"):
                        scope["returnedTruncated"] = True
                        if "length" in entry:
                            scope["returnedLength"] = entry["length"]
            except Exception as exc:  # noqa: BLE001
                tracer.hook_error(exc, "scope")

        def value(rid: int, ctx: Any, val: Any, kind: str, marker_id: Any = None, change_id: Any = None, fn: Any = None, discard: bool = False) -> Any:
            try:
                tracer.log_value(rid, ctx, val, kind, marker_id, change_id, fn, discard)
            except Exception as exc:  # noqa: BLE001
                tracer.hook_error(exc, "value")
            return val

        def timed(rid: int, ctx: Any, t0: float, val: Any, kind: str, marker_id: Any = None, change_id: Any = None) -> Any:
            try:
                tracer.log_time(rid, ctx, t0, val, kind, marker_id, change_id)
            except Exception as exc:  # noqa: BLE001
                tracer.hook_error(exc, "time")
            return val

        def pk_print(rid: int, *args: Any, **kwargs: Any) -> None:
            try:
                tracer.log_print(rid, args, kwargs)
            except Exception as exc:  # noqa: BLE001
                tracer.hook_error(exc, "print")
                tracer.real_print(*args, **kwargs)

        def patched_print(*args: Any, **kwargs: Any) -> None:
            pk_print(tracer.cur_rid(), *args, **kwargs)

        def logpoint(rid: int, kind: str, template: str, ctx: Any, marker_id: Any, change_id: Any, is_expr: bool = False) -> None:
            try:
                tracer.log_point(rid, kind, template, ctx, marker_id, change_id, is_expr, getframe(1))
            except Exception as exc:  # noqa: BLE001
                tracer.hook_error(exc, "logpoint")

        def snap_error(exc_or_text: Any, rid: int) -> None:
            try:
                tracer.report_snap_error(exc_or_text, rid)
            except (SystemExit, KeyboardInterrupt):
                raise
            except Exception as exc:  # noqa: BLE001
                tracer.hook_error(exc, "snap")

        return {
            "_pk_s": step,
            "_pk_c": cov,
            "_pk_f": enter,
            "_pk_x": leave,
            "_pk_u": UNSET,
            "_pk_end": END,
            "_pk_v": value,
            "_pk_t": timed,
            "_pk_print": pk_print,
            "_pk_logpoint": logpoint,
            "_pk_time": time.perf_counter,
            "_pk_snap_error": snap_error,
            "print": patched_print,
        }

    # -- watches -----------------------------------------------------------------------------
    def _setup_watches(self, trace_context: dict, watches: list[dict]) -> None:
        try:
            start = int(trace_context.get("step", 0))
            prefetch = max(1, int(trace_context.get("prefetch", 10)))
        except (TypeError, ValueError):
            return
        for w in watches:
            exp = str(w.get("exp", "")).strip()
            wid = str(w.get("id"))
            if not exp:
                continue
            try:
                code = compile(exp, "<watch %s>" % wid, "eval")
            except SyntaxError as exc:
                self.emit({"type": "watch", "watchId": wid, "step": start, "error": "SyntaxError: %s" % exc.msg})
                continue
            self.watch_codes.append((wid, code, exp))
        if self.watch_codes:
            self.watch_lo = start
            self.watch_hi = start + prefetch

    def _eval_watches(self, step: int, frame: Any) -> None:
        for wid, code, exp in self.watch_codes:
            try:
                value = eval(code, frame.f_globals, frame.f_locals)  # noqa: S307 - user watch expression
            except BaseException as exc:  # noqa: BLE001
                self.emit({"type": "watch", "watchId": wid, "step": step, "error": "%s: %s" % (type(exc).__name__, exc)})
                continue
            key = "w:%s" % wid
            node = serialize(value, self.config.inline, root_key=key, hit=step, registry=self.registry, resolve_getters=self.config.resolve_getters, expression_root=exp, id_prefix="%s %d" % (key, step))
            self.emit({"type": "watch", "watchId": wid, "step": step, "valueBag": {"data": node, "runtimeKey": key}})

    # -- locals ----------------------------------------------------------------------------------
    def _record_locals(self, step: int, scope: int, frame: Any) -> None:
        if len(self.locals_entries) >= MAX_LOCALS_ENTRIES:
            return
        try:
            items = list(frame.f_locals.items())
        except Exception:  # noqa: BLE001
            return
        module_level = frame.f_code.co_name == "<module>"
        prev = self.local_snaps.get(scope)
        new: dict[str, tuple] = {}
        changes: list[dict] = []
        # A `__repr__` in instrumented library code would record steps and scopes of its own
        # (pydantic: 200k `__getattr__` scopes per run); snapshots are not the program running.
        self.quiet += 1
        try:
            for name, val in items:
                if name.startswith("_pk_"):
                    continue
                if module_level:
                    if name.startswith("__") or isinstance(val, (type, type(sys), type(self._record_locals), type(len))):
                        continue
                marker = (id(val), len(val) if type(val) in _SIZED else -1)
                new[name] = marker
                if prev is None or prev.get(name) != marker:
                    changes.append(cut_entry({"name": name}, name, val, self.locals_chars))
        finally:
            self.quiet -= 1
        self.local_snaps[scope] = new
        if changes:
            self.locals_entries.append({"step": step, "scopeId": scope, "changes": changes})

    # -- periodic flushes ---------------------------------------------------------------------------
    def _periodic(self) -> None:
        now = time.perf_counter()
        if self.times_dirty and now - self.last_time_flush >= TIME_FLUSH_S:
            self.last_time_flush = now
            self.times_dirty = False
            self._emit_times()
        if now - self.last_trace_flush >= TRACE_FLUSH_S and now - self.started >= TRACE_FLUSH_S:
            self.last_trace_flush = now
            self.flush_partial_trace()

    def _emit_times(self) -> None:
        for rid, agg in self.times.items():
            self.emit(ev_time(rid, agg[0], agg[1], agg[2], agg[3]))

    def flush_partial_trace(self) -> None:
        """Mid-run delta: the steps since the last flush and only the scopes created since then.

        Nothing is sent once the cap is reached (no new steps are recorded past it). Hosts
        that assemble deltas derive `last` of earlier scopes from the steps.
        """
        recorded = len(self.steps) // 4
        if recorded <= self.flushed_steps:
            return
        chunk = self.steps[self.flushed_steps * 4 : recorded * 4]
        new_scopes = self._scope_table(self.flushed_scopes)
        self.emit(ev_trace(encode_steps(chunk), new_scopes, self.n_steps > self.cap, partial=True, offset=self.flushed_steps, mid_run=self.mid_run))
        self.flushed_steps = recorded
        self.flushed_scopes = len(self.scopes)

    def _scope_table(self, start: int = 0) -> list[dict]:
        out = []
        for i in range(start, len(self.scopes)):
            d = dict(self.scopes[i])
            d["last"] = self.scope_last[i]
            out.append(d)
        return out

    # -- finalisation --------------------------------------------------------------------------------
    def coverage_states(self, info: InstrumentedFile) -> tuple[list[int], list[int]]:
        base = info.range_base
        n = info.range_count
        hits = self.hits[base : base + n]
        states = [COV_NOT_RUN] * n
        for local in range(n):
            if info.ignore_file or local in info.ignored:
                states[local] = COV_IGNORED
                continue
            if hits[local] == 0:
                continue
            state = COV_COVERED
            children = info.expr_children.get(local)
            if children:
                for c in children:
                    if self.hits[base + c] == 0:
                        state = COV_PARTIAL
                        break
            states[local] = state
        for rid, st in self.error_states.items():
            local = rid - base
            if 0 <= local < n and states[local] != COV_IGNORED:
                states[local] = st
        return states, hits

    def finish(self, uncaught: BaseException | None = None) -> None:
        """Emit coverage, time, locals and the full trace. Idempotent.

        With no recording the uncaught ``error`` event is the only thing a run ends with: there is
        no coverage, no trace, no times and no locals to send.
        """
        if self.finished:
            return
        self.finished = True
        try:
            if uncaught is not None:
                self.report_uncaught(uncaught)
            if not self.record:
                return
            self.flush_unemitted_errors()
            for info in self.file_order:
                states, hits = self.coverage_states(info)
                self.emit(ev_coverage(info.file_id, states, hits))
            self._emit_times()
            if self.locals_entries:
                for i in range(self.locals_flushed, len(self.locals_entries), 5000):
                    self.emit({"type": "locals", "entries": self.locals_entries[i : i + 5000]})
            trace = ev_trace(encode_steps(self.steps), self._scope_table(), self.n_steps > self.cap, mid_run=self.mid_run)
            if self.n_steps > self.cap:
                trace.update(self.cap_report())
            self.emit(trace)
        except Exception as exc:  # noqa: BLE001
            self.emit({"type": "runner.error", "message": "finalisation failed: %s: %s" % (type(exc).__name__, exc)})

    def cap_report(self) -> dict:
        """For a trace cut at ``maxTraceSteps``: the cap, the statements the run executed, and the files
        that executed most of them (``spentBy``, statement hits over the whole run, top 5)."""
        spent = []
        for info in self.file_order:
            base = info.range_base
            n = sum(self.hits[base + rid] for rid in info.statements if base + rid < len(self.hits))
            if n:
                spent.append({"path": info.filename, "steps": n})
        spent.sort(key=lambda e: -e["steps"])
        return {"cap": self.cap, "stepsRun": self.n_steps, "spentBy": spent[:5]}

    # -- evaluate (no re-run) -----------------------------------------------------------------------------
    _evaluate_counter = 0

    @staticmethod
    def _eval_expr(node: Any, module_globals: dict) -> Any:
        from .pure import eval_pure

        return eval_pure(node, module_globals)

    def evaluate(self, expression: str, module_globals: dict, limits: dict | None = None) -> dict:
        """Evaluate a pure expression against the finished run's module namespace.

        ``pure.py`` holds the rule: names, attributes, subscripts, operators, comprehensions and
        calls that cannot change the program (builtins like ``len``, non-mutating methods of the
        builtin types). A user function is never called here. Attribute access may still run a
        property and a subscript ``__getitem__``, as they always did.
        """
        import ast

        tree = ast.parse(expression.strip(), mode="eval")
        value = self._eval_expr(tree.body, module_globals)
        Tracer._evaluate_counter += 1
        key = "e:%d" % Tracer._evaluate_counter
        bag = self._bag(value, key, 1, "value", expression)
        return {"text": secrets.current.mask_text(expression_name(expression), value, short_repr(value)), "valueBag": bag}

    def shadow(self, source: str, module_globals: dict, limits: dict | None = None) -> dict:
        """What one edited statement would show, computed from the finished run's state.

        Supports ``print(...)`` (positional args, rendered like print), a bare expression, and
        ``name = expr`` / ``name: T = expr``. The namespace is never modified.
        """
        import ast
        import textwrap

        tree = ast.parse(textwrap.dedent(source).strip(), mode="exec")
        if len(tree.body) != 1:
            raise ValueError("one statement at a time")
        st = tree.body[0]
        Tracer._evaluate_counter += 1
        key = "s:%d" % Tracer._evaluate_counter
        if isinstance(st, ast.Expr) and isinstance(st.value, ast.Call) and isinstance(st.value.func, ast.Name) and st.value.func.id == "print" and not st.value.keywords:
            parts = [self._eval_expr(a, module_globals) for a in st.value.args]
            text = " ".join(str(p) for p in parts)
            value = parts[0] if len(parts) == 1 else text
            bag = self._bag(value, key, 1, "log", "print")
            return {"kind": "log", "context": "print", "text": text, "valueBag": bag}
        if isinstance(st, ast.Expr):
            value = self._eval_expr(st.value, module_globals)
            context = ast.unparse(st.value)
        elif isinstance(st, (ast.Assign, ast.AnnAssign)) and getattr(st, "value", None) is not None:
            value = self._eval_expr(st.value, module_globals)
            target = st.targets[0] if isinstance(st, ast.Assign) else st.target
            context = ast.unparse(target)
        else:
            raise ValueError("not a value-producing statement")
        bag = self._bag(value, key, 1, "value", context)
        return {"kind": "value", "context": context, "text": secrets.current.mask_text(expression_name(context), value, short_repr(value)), "valueBag": bag}

    # -- expand ------------------------------------------------------------------------------------------
    def expand(self, value_id: str | None, query_path: list[str] | None, limits: dict | None = None) -> dict:
        obj, path, load_more = self.registry.resolve(value_id, query_path)
        base = self.config.auto_expand
        depth = int((limits or {}).get("depth", base.depth))
        elements = int((limits or {}).get("elements", base.elements))
        if load_more:
            elements = max(elements, 100_000)
            depth = max(depth, 1)
        from .protocol import LogLimitSet

        lim = LogLimitSet(depth, elements, int((limits or {}).get("stringLength", base.string_length)))
        root_key = path[0] if path else (value_id or "0")
        node = serialize(obj, lim, root_key=root_key, registry=self.registry, resolve_getters=self.config.resolve_getters, query_path=path or None, id_prefix=(value_id or root_key).removesuffix(" +"))
        return node


__all__ = ["Tracer", "child_by_segment"]
