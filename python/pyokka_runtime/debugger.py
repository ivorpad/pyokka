"""The frontier debugger: pause, step, break and evaluate inside a running program.

A debug run is an ordinary run whose frontier can pause. The tracer calls ``Debugger.on_step``
from the statement hook and the function-entry hook, only while a debugger is attached, so a
run without one never pays for the check. ``on_step`` decides whether this step pauses: the
start of a run asked to start paused, a pending step (into / over / out), a breakpoint whose
condition holds, a break-when watch that changed or turned true, or a pause request that came
in while the program ran. A pause flushes what the run has recorded so far (buffered output,
the trace delta, timings, new locals), emits ``debug.paused`` and hands the live frame to the
control channel (``control.py``), which serves requests against it (evaluate, expand, locals,
breakpoints, watches) until one resumes with ``continue`` or ``step``, or the runner stops the
run. Behind the frontier the host navigates the recording; at the frontier the frame is live;
ahead is the future. The hook runs before the statement executes, so a pause on ``total += i``
sees ``total`` before the addition, as in any debugger.

Two modes, one debugger. With a recording (``config.record`` absent or true) the pause reads the
trace: ``step`` is the trace index, ``scopeId`` the recorded scope, the stack the scope parent
chain, and the step rules follow that chain. Without one (``config.debug`` with
``config.record: false``) nothing is recorded: ``step`` is a plain statement counter,
``scopeId`` a per-call id from a counter, the stack comes from the frames themselves
(``dbgframes``) with each caller's real line, and the step rules use frame exits
(``on_leave``, from the ``_pk_x`` the instrumenter already calls in a ``finally``). The hook set
differs too (``hooks_debug.py``): in debugger mode the arming lives in a two-flag list cell this
class owns, so a statement nothing is armed for costs one integer increment and one list read.

A run with ``config.recordFrom`` is the second mode until a pause turns it into the first:
``_pause`` calls ``Tracer.start_recording`` at the pause ``recordFrom`` names (the ``record``
action does it at any pause), and from then on every rule above reads the recording
(``record_from.py``).

Exceptions are a pause reason of their own, off the ``armed`` path, and live in
``dbgexceptions.py``. A pause is never entered while one is being served on this thread, so an
expression that raises in the paused frame cannot pause again; a second instrumented thread that
hits a reason while another is paused blocks on ``pause_lock`` and pauses when the first resumes,
so the events stay sequential and exactly one thread is paused at a time.

Step semantics follow the Time Machine's: ``into`` is the next step whatever its scope, ``over``
the next step in the paused scope or one of its ancestors (a call from here runs to completion, a
return lands in the caller), ``out`` the next step in an ancestor. Scopes are per call, so
recursion is exact. Breakpoints are kept as the host gave them (a path and a line, or a function
name) and resolved to a statement id by ``dbgbreakpoints`` as each file is instrumented, so one
set on a module before its import is honoured.

The debugger only reads the program until something writes: ``exec`` (``dbgexec``) runs a
statement in the paused frame, and from then on ``modified`` rides on every stop and on every
``locals`` reply, because the values are no longer only the program's own. A new run gets a new
``Debugger``, so it starts unmodified.
"""

from __future__ import annotations

import ast
import os
import sys
import threading
import types
from typing import Any

from . import dbgbreakpoints, dbgframes, secrets
from .dbgexceptions import ExceptionPauseMixin
from .record_from import RecordPauseMixin
from .protocol import EXCEPTION_MODE_DEFAULT
from .pure import eval_pure
from .serialize import expression_name, short_repr
from .tracer import FOREIGN

STEP_KINDS = ("into", "over", "out")
WATCH_MODES = ("change", "true")
_MODULE_NOISE = (type, types.ModuleType, types.FunctionType, types.BuiltinFunctionType, types.MethodType)
_LOOKUP = object()  # `on_step` default: the caller did not match a breakpoint for us (the recording hook set)


class _Serving(threading.local):
    """Per thread: whether this thread is inside a pause it is serving."""

    on = False


class Breakpoint:
    __slots__ = ("path", "line", "function", "condition", "code", "error", "rid", "file_id", "resolved_line")

    def __init__(self, path: str, line: int, condition: str | None = None, function: str | None = None) -> None:
        self.path = path
        self.line = int(line)
        self.function = (function or "").strip() or None  # `--at NAME`: resolved in `dbgbreakpoints`
        self.condition = (condition or "").strip() or None
        self.code: Any = None
        self.error: str | None = None
        self.rid: int | None = None
        self.file_id: int | None = None
        self.resolved_line: int | None = None
        if self.condition:
            try:
                self.code = compile(self.condition, "<breakpoint %s:%d>" % (os.path.basename(path), self.line), "eval")
            except SyntaxError as exc:
                self.error = "SyntaxError: %s" % exc.msg

    def to_json(self) -> dict:
        out: dict[str, Any] = {"path": self.path, "line": self.line}
        if self.function:
            out["function"] = self.function
        if self.condition:
            out["condition"] = self.condition
        if self.rid is not None:
            out.update(rid=self.rid, fileId=self.file_id, resolvedLine=self.resolved_line)
        if self.error:
            out["error"] = self.error
        return out


class BreakWatch:
    """A watch that pauses the run: ``change`` when its text changes, ``true`` when it turns truthy."""

    __slots__ = ("id", "exp", "mode", "code", "last", "error", "missing")

    def __init__(self, wid: str, exp: str, mode: str) -> None:
        self.id = wid
        self.exp = exp
        self.mode = mode if mode in WATCH_MODES else "change"
        self.last: Any = None  # the last text (change) or truthiness (true) observed; None = never evaluated
        self.missing = False  # evaluated at least once while the expression had no value (a name not yet bound)
        self.error: str | None = None
        try:
            self.code = compile(exp, "<watch %s>" % wid, "eval")
        except SyntaxError as exc:
            self.code = None
            self.error = "SyntaxError: %s" % exc.msg

    def to_json(self) -> dict:
        out: dict[str, Any] = {"id": self.id, "exp": self.exp, "breakWhen": self.mode}
        if self.error:
            out["error"] = self.error
        return out


class Debugger(ExceptionPauseMixin, RecordPauseMixin):
    """Attached to a tracer as ``tracer.dbg``; ``control`` serves the paused frame."""

    _serial = 0

    def __init__(self, tracer: Any, control: Any, request: dict) -> None:
        self.tracer = tracer
        self.control = control
        self.start_paused = bool(tracer.config.debug) and bool(getattr(tracer.config, "stop_on_entry", True))
        self.breakpoints: list[Breakpoint] = []
        self.by_rid: dict[int, Breakpoint] = {}  # mutated in place: the debugger-mode hooks close over this dict
        self.watches: list[BreakWatch] = []
        # (kind, target_sid, wait_exit) without a recording, (kind, allowed_scopes) with one.
        self.pending: tuple | None = None
        self.pending_sid = -1  # the sid `_pk_x` watches for; -1 while no step waits for a frame exit
        self.pause_requested = False
        self.armed = False
        self.count = [0]  # the statement counter the debugger-mode hooks increment
        self.cell = [0, 0]  # [any reason can fire, a reason other than a breakpoint is armed]
        # per-call ids without a recording; 0 stays the main module's scope. A run that records from a
        # pause starts them at FOREIGN, so the recording can tell them from its own (record_from.py)
        self.next_sid = [FOREIGN if tracer.config.records_later else 0]
        self.frames: list[Any] = []  # the paused frame and its callers, while a pause is served
        self.frame_lines: dict[int, int] = {}  # id(frame) -> line, from a traceback (dbgexceptions)
        self.modified = False  # a write from the console or `exec` has happened in this run
        self.pauses = 0
        self.pause_lock = threading.Lock()  # one thread paused at a time, `debug.paused`/`debug.resumed` sequential
        self.break_on_exception = getattr(tracer.config, "break_on_exception", EXCEPTION_MODE_DEFAULT)
        self.serving = _Serving()  # per thread: nothing that runs inside a pause may pause again
        self.paused_at: tuple[int, int, int] | None = None  # (step, rid, scope) of the pause being served
        self._reason = "pause"  # the served pause's reason and extras, for the stop `record` announces again
        self._extra: dict[str, Any] = {}
        self.record_from = self._record_from_spec(tracer.config.record_from)
        self.set_breakpoints(request.get("breakpoints") or [])
        self.rearm()

    # -- arming ---------------------------------------------------------------------------------
    def rearm(self) -> None:
        """Recompute ``armed`` and the hook set's arming cell. Called whenever a reason appears or goes."""
        other = bool(self.start_paused or self.pause_requested or self.pending is not None or self.watches)
        self.armed = other or bool(self.by_rid)
        quiet = bool(self.tracer.quiet)  # a library module body is not steppable
        self.cell[0] = 0 if quiet or not self.armed else 1
        self.cell[1] = 0 if quiet or not other else 1

    def request_pause(self) -> None:
        self.pause_requested = True
        self.rearm()

    # -- breakpoints ------------------------------------------------------------------------------
    def set_breakpoints(self, specs: list[dict]) -> dict:
        """Replace every breakpoint; resolves those whose file is already instrumented."""
        bps = []
        for spec in specs:
            try:
                bps.append(Breakpoint(str(spec.get("path") or ""), int(spec.get("line") or 0), spec.get("condition"), spec.get("function")))
            except (TypeError, ValueError):
                continue
        for bp in bps:
            dbgbreakpoints.resolve(self.tracer, bp)
        self.breakpoints = bps
        self._index()
        return {"breakpoints": [bp.to_json() for bp in bps]}

    def file_added(self, info: Any) -> None:
        if isinstance(self.record_from, Breakpoint):
            dbgbreakpoints.resolve(self.tracer, self.record_from, info)
        changed = False
        for bp in self.breakpoints:
            if dbgbreakpoints.resolve(self.tracer, bp, info):
                changed = True
        if changed:
            self._index()

    def _index(self) -> None:
        # In place: the debugger-mode hook set holds this dict and must see every change.
        self.by_rid.clear()
        self.by_rid.update({bp.rid: bp for bp in self.breakpoints if bp.rid is not None})
        self.rearm()

    # -- watches ---------------------------------------------------------------------------------
    def set_watches(self, specs: list[dict]) -> dict:
        watches = []
        for spec in specs:
            exp = str(spec.get("exp") or "").strip()
            if exp:
                watches.append(BreakWatch(str(spec.get("id") or "w%d" % (len(watches) + 1)), exp, str(spec.get("breakWhen") or "change")))
        self.watches = [w for w in watches if w.code is not None]
        self.rearm()
        return {"watches": [w.to_json() for w in watches]}

    def _watch_fires(self, w: BreakWatch, frame: Any) -> str | None:
        """The watch's text when it fires at this step, else None. A name not in scope is silent."""
        try:
            value = eval(w.code, frame.f_globals, frame.f_locals)  # noqa: S307 - user watch expression
        except BaseException:  # noqa: BLE001
            if w.last is None:
                w.missing = True  # the name does not exist yet: its first value will count as a change
            return None
        if w.mode == "true":
            now = bool(value)
            fired = now and not w.last
            w.last = now
            return secrets.current.mask_text(expression_name(w.exp), value, short_repr(value)) if fired else None
        text = secrets.current.mask_text(expression_name(w.exp), value, short_repr(value))
        if w.last is None:
            w.last = text
            # a watch set while the name already had a value starts from that baseline; one set before
            # the name existed fires when it appears, which is the change the user is waiting for
            return text if w.missing else None
        if text == w.last:
            return None
        w.last = text
        return text

    # -- scopes ------------------------------------------------------------------------------------
    def _scope_of(self, frame: Any) -> int:
        """The scope this frame records its steps in, read from the instrumented ``_pk_scope_``."""
        sid = dbgframes.scope_of(frame)
        if not self.tracer.record:
            return sid if sid is not None else 0  # no scope table to bound it against
        if sid is not None and sid >= FOREIGN:
            sid = self.tracer.foreign.get(sid)  # a frame entered before a `recordFrom` recording began
        return sid if sid is not None and sid < len(self.tracer.scopes) else self.tracer.cur_scope

    # -- the hook ----------------------------------------------------------------------------------
    def on_step(self, n: int, rid: int, scope: int, bp: Any = _LOOKUP) -> None:
        """One statement, before it runs. ``bp`` is the breakpoint the caller matched, if it matched one.

        The frame is fetched here, with ``sys._getframe(2)`` (this frame, the hook's, the
        program's), and only once a reason needs one: a breakpoint with a condition, a break-when
        watch, or the pause itself. A breakpoint without a condition never touches a frame until it
        pauses.
        """
        if not self.armed or self.serving.on:
            return
        reason = None
        extra: dict[str, Any] = {}
        if self.start_paused:
            self.start_paused = False
            reason = "start"
        elif self.pending is not None:
            reason, kind = self._pending_fires(scope)
            if reason is not None:
                extra["kind"] = kind
        if reason is None and self.pause_requested:
            reason = "pause"
        if reason is None:
            if bp is _LOOKUP:
                bp = self.by_rid.get(rid) if self.by_rid else None
            if bp is not None:
                hit, err = self._condition_holds(bp, sys._getframe(2))
                if hit:
                    reason = "breakpoint"
                    extra["breakpoint"] = bp.to_json()
                    if err:
                        extra["conditionError"] = err
        if reason is None and self.watches:
            frame = sys._getframe(2)
            for w in self.watches:
                text = self._watch_fires(w, frame)
                if text is not None:
                    reason = "watch"
                    extra["watch"] = {"id": w.id, "exp": w.exp, "text": text}
                    break
        if reason is not None:
            self._pause(n, rid, scope, sys._getframe(2), reason, extra)

    def _pending_fires(self, scope: int) -> tuple[str | None, str | None]:
        """Whether the pending step stops at this statement, and which kind it was."""
        pending = self.pending
        if pending is None:
            return None, None
        if self.tracer.record:
            kind, allowed = pending
            return ("step", kind) if allowed is None or scope in allowed else (None, None)
        kind, target_sid, wait_exit = pending
        # a target below 0 means any scope: a step into, or one whose frame exited into code that is
        # not instrumented, where the next statement of the program's own code is the stop
        if not wait_exit and (target_sid < 0 or scope == target_sid):
            return "step", kind
        return None, None

    def on_leave(self, frame: Any) -> None:
        """The frame a step is waiting on has returned (``_pk_x``): re-arm the step in its caller.

        So a step over the last statement of a function lands on the next statement of the nearest
        instrumented ancestor, and a step out walks up as the ancestors return. ``wait_exit`` is
        false from here on, which is why ``out`` can never stop in the frame it was armed in.

        When the frame has no instrumented ancestor to take the step (``dbgframes.step_target``: it
        was called from a library, a thread's bootstrap or a web framework, or from nothing), the
        step becomes the next statement of the program's own code wherever it runs, as a debugger
        with "just my code" does. A request handler that unwound into a framework has no frame of
        ours to come back to, and waiting for one means the next request is served with the client
        still waiting for its stop.
        """
        pending = self.pending
        if pending is None or self.tracer.record or pending[1] < 0:
            self.pending_sid = -1  # no step, a recording, or one already waiting for any scope
            return
        target = dbgframes.step_target(frame)
        self.pending = (pending[0], target if target is not None else -1, False)
        self.pending_sid = self.pending[1]

    @staticmethod
    def _condition_holds(bp: Breakpoint, frame: Any) -> tuple[bool, str | None]:
        if bp.code is None:
            return True, None
        try:
            return bool(eval(bp.code, frame.f_globals, frame.f_locals)), None  # noqa: S307 - user condition
        except BaseException as exc:  # noqa: BLE001
            return True, "%s: %s" % (type(exc).__name__, exc)  # a broken condition pauses and says why

    # -- pausing -----------------------------------------------------------------------------------
    def _pause(self, n: int, rid: int, scope: int, frame: Any, reason: str, extra: dict) -> None:
        """Emit the stop, serve requests against ``frame``, emit the resume. One thread at a time.

        ``pause_lock`` is held across all three, so a second instrumented thread that computed a
        reason of its own waits here and pauses with it once this one resumes.
        """
        t = self.tracer
        with self.pause_lock:
            self.pending = None
            self.pending_sid = -1
            self.pause_requested = False
            self.pauses += 1
            if self._records_here(rid):
                scope = t.start_recording(frame, rid, scope)
                n = 0
                extra = {**extra, "recordingStarted": True}
            self.paused_at = (n, rid, scope)
            self._reason = reason
            self._extra = {k: v for k, v in extra.items() if k != "recordingStarted"}
            self.frames = dbgframes.frame_chain(t, frame) if frame is not None else []
            self._flush()
            begin = getattr(self.control, "begin_pause", None)
            if begin is not None:
                begin()  # a `continue` sent the instant the stop arrives must not be refused
            t.emit(self._stop_event(n, rid, scope, frame, reason, extra))
            self.serving.on = True
            try:
                action = self.control.serve_paused(self, frame) or {}
            finally:
                self.serving.on = False
                self.frames = []
                self.frame_lines = {}
                n, rid, scope = self.paused_at  # `record` may have moved the pause onto step 0
                self.paused_at = None
            kind = action.get("kind")
            if action.get("action") == "step":
                self._arm_step(kind if kind in STEP_KINDS else "into", scope)
            t.emit({"type": "debug.resumed", "step": n, "action": "step" if self.pending is not None else "continue", **({"kind": self.pending[0]} if self.pending is not None else {})})
            self.rearm()

    def _stop_event(self, n: int, rid: int, scope: int, frame: Any, reason: str, extra: dict) -> dict:
        t = self.tracer
        line = self._line_of(rid)
        if t.record:
            stack = self.stack(scope)
            depth = t.depth_of[scope] if scope < len(t.depth_of) else 0
        else:
            stack = dbgframes.frame_stack(t, frame, dbgframes.top_line(self.frame_lines, frame, line)) if frame is not None else []
            depth = max(0, len(stack) - 1)
        event = {"type": "debug.paused", "step": n, "rid": rid, "fileId": t.file_id_for(rid), "line": line, "scopeId": scope, "depth": depth, "reason": reason, "thread": dbgframes.thread_info(), "stack": stack, **extra}
        if self.modified:
            event["modified"] = True
        return event

    def _arm_step(self, kind: str, scope: int) -> None:
        """Arm the next step. With a recording it is a set of scopes; without one, a target frame id."""
        if self.tracer.record:
            self.pending = (kind, self._allowed_scopes(kind, scope))
            self.pending_sid = -1
            return
        if kind == "over":
            self.pending = ("over", scope, False)
        elif kind == "out":
            self.pending = ("out", scope, True)
        else:
            self.pending = ("into", -1, False)
        self.pending_sid = self.pending[1]

    def _allowed_scopes(self, kind: str | None, scope: int) -> frozenset[int] | None:
        if kind == "over":
            return frozenset(self._chain(scope))
        if kind == "out":
            return frozenset(self._chain(scope)[1:])
        return None

    def _chain(self, scope: int) -> list[int]:
        """The scope and its ancestors, innermost first."""
        scopes = self.tracer.scopes
        out = []
        s = scope
        while 0 <= s < len(scopes) and len(out) < 10_000:
            out.append(s)
            s = scopes[s]["parent"]
        return out

    def stack(self, scope: int) -> list[dict]:
        scopes = self.tracer.scopes
        return [{"scopeId": s, "name": scopes[s]["name"], "rid": scopes[s]["rid"], "depth": scopes[s]["depth"]} for s in self._chain(scope)]

    def _line_of(self, rid: int) -> int | None:
        t = self.tracer
        info = t.files_by_id.get(t.file_id_for(rid))
        if info is None:
            return None
        local = rid - info.range_base
        if 0 <= local < len(info.ranges):
            return int(info.ranges[local][0])
        return None

    def _flush(self) -> None:
        t = self.tracer
        for stream in (sys.stdout, sys.stderr):
            try:
                stream.flush()
            except Exception:  # noqa: BLE001
                pass
        if not t.record:
            return  # nothing is recorded: the output flush is the whole flush
        t.flush_partial_trace()
        if t.times_dirty:
            t.times_dirty = False
            t._emit_times()
        if len(t.locals_entries) > t.locals_flushed:
            entries = t.locals_entries
            for i in range(t.locals_flushed, len(entries), 5000):
                t.emit({"type": "locals", "entries": entries[i : i + 5000]})
            t.locals_flushed = len(entries)

    # -- the live frame ----------------------------------------------------------------------------
    def value_key(self) -> str:
        """The next ``d:N`` value id. One counter for evaluate, locals and exec, so ``expand`` sees one namespace."""
        Debugger._serial += 1
        return "d:%d" % Debugger._serial

    def evaluate(self, expression: str, frame: Any, limits: dict | None = None) -> dict:
        """A pure expression in the paused frame, locals over globals (the rule is in ``pure.py``)."""
        tree = ast.parse(expression.strip(), mode="eval")
        value = eval_pure(tree.body, frame.f_globals, frame.f_locals, "<pyokka-debug>")
        return {"text": secrets.current.mask_text(expression_name(expression), value, short_repr(value)), "valueBag": self.tracer._bag(value, self.value_key(), 1, "value", expression)}

    def locals(self, frame: Any) -> list[dict]:
        """The paused frame's variables, masked, each with a value bag `expand` can open."""
        module_level = frame.f_code.co_name == "<module>"
        out = []
        for name, val in list(frame.f_locals.items()):
            if name.startswith("_pk_") or (module_level and (name.startswith("__") or isinstance(val, _MODULE_NOISE))):
                continue
            out.append({"name": name, "text": secrets.current.mask_text(name, val, short_repr(val)), "valueBag": self.tracer._bag(val, self.value_key(), 1, "value", name)})
        return out
