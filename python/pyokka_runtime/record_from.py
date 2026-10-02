"""Recording from a pause on (``config.recordFrom``), mixed into ``Tracer``.

A debug run with ``recordFrom`` starts like a ``record: false`` one: the debugger's hook set
(``hooks_debug.py``), which counts statements and records nothing. At the pause ``recordFrom``
names (or at any pause, on the ``record`` action) ``start_recording`` swaps the recording hook set
in, so the rest of the run is recorded as any run-all run is, and the paused statement is step 0.
The instrumented code is the same in both modes, so nothing is re-instrumented.

The one thing the two hook sets disagree on is the scope id. The debugger's ``_pk_f`` hands out
per-call ids from a counter, and those ids are stored in each frame's ``_pk_scope_``; the recording
indexes ``depth_of`` with the same local. In a ``recordFrom`` run the debugger's ids start at
``FOREIGN`` (``1 << 40``), so an id from before the switch can never be a recorded scope.
``start_recording`` gives every instrumented frame on the paused stack a recorded scope, parent
before child, and maps its id in ``foreign``; a frame the stack walk did not see (a generator or a
coroutine suspended at the switch and resumed later, another thread) gets one the first time the
recording hooks meet its id (``adopt``), with the caller that resumed it as parent.

What ran before the switch is not recoverable: its steps, hits, values, parameters and caught
exceptions were never kept. The trace says so (``midRun`` on every ``trace`` event), and a ``why``
chain that reaches a value made before step 0 ends there.
"""

from __future__ import annotations

import builtins
import time
from typing import Any

from .instrument import HOOK_NAMES
from .protocol import FLAG_SCOPE_ENTRY


class RecordFromMixin:
    """Mixed into ``Tracer``; reads its scope tables, ``files``, ``config`` and ``_make_hooks``."""

    def start_recording(self, frame: Any, rid: int, scope: int) -> int:
        """Record from here on; the paused statement ``rid`` becomes step 0. Returns its recorded scope.

        ``scope`` is the id the debugger's hook reported for the paused frame. At a function-entry
        pause (``--at NAME``) the frame's ``_pk_scope_`` is not assigned yet, so the id comes from
        the hook, not from the frame. Called from ``Debugger._pause`` with the program thread
        stopped; another instrumented thread meets the new hooks at its next statement.
        """
        from .dbgframes import frame_chain, scope_of
        from .tracer import FOREIGN

        if self.record:
            return self.foreign.get(scope, scope) if scope >= FOREIGN else scope
        entry = rid in self.function_names  # paused on a `def`: the entry hook, before the body runs
        chain = frame_chain(self, frame) if frame is not None else []
        parent = 0
        top = 0
        for f in reversed(chain):  # outermost first, so each scope's parent exists before it
            sid = scope if f is frame else scope_of(f)
            if sid is None or sid < 0:
                continue  # not instrumented (a library or the stdlib calling back into the program)
            if sid < FOREIGN:
                parent = top = sid  # the main module, scope 0
                continue
            def_rid = rid if f is frame and entry else self._def_rid(f)
            top = parent = self._new_scope(def_rid, parent, 0)
            self.foreign[sid] = top
        if frame is not None and frame not in chain and scope >= FOREIGN:
            top = self.adopt(scope, frame)
        self.record = True
        self.mid_run = True
        self.record_locals = bool(self.config.record_locals)
        if self.cap > 0:
            self.steps.extend((rid, top, self.depth_of[top], FLAG_SCOPE_ENTRY if entry else 0))
            self.scope_last[top] = 0
        self.cur_step = 0
        self.n_steps = 1
        self.cur_scope = top
        if self.record_locals:
            self._baseline_locals(chain, frame, entry)
        if entry and frame is not None:
            info = self.def_logs.get(rid)
            if info is not None:
                self.log_parameters(rid, info, frame)
        hooks = self._make_hooks()
        for name in HOOK_NAMES:
            setattr(builtins, name, hooks[name])  # `_saved_builtins` keeps what `install` replaced
        builtins.print = hooks["print"]
        self._monitoring_start()  # a debug run with `breakOnException: off` had no exception callbacks
        self.last_trace_flush = self.last_time_flush = time.perf_counter()
        return top

    def adopt(self, fsid: int, frame: Any) -> int:
        """The recorded scope of a frame the debugger's hooks entered before the recording began."""
        sid = self.foreign.get(fsid)
        if sid is not None:
            return sid
        sid = self._new_scope(self._def_rid(frame), self._recorded_caller(frame), self.n_steps)
        self.foreign[fsid] = sid
        return sid

    def _recorded_caller(self, frame: Any) -> int:
        """The recorded scope of the nearest instrumented caller, adopting it first if it is foreign."""
        from .dbgframes import scope_of
        from .tracer import FOREIGN, PARENT_FRAMES

        f = frame.f_back
        hops = 0
        while f is not None and hops < PARENT_FRAMES:
            sid = scope_of(f)
            if sid is not None:
                return self.adopt(sid, f) if sid >= FOREIGN else sid
            f = f.f_back
            hops += 1
        return 0

    def _new_scope(self, rid: int, parent: int, first: int) -> int:
        sid = len(self.scopes)
        depth = (self.depth_of[parent] if 0 <= parent < len(self.depth_of) else 0) + 1
        self.scopes.append({"scopeId": sid, "rid": rid, "name": self.function_names.get(rid, "<function>"), "parent": parent, "depth": depth, "first": first, "last": first})
        self.depth_of.append(depth)
        self.scope_last.append(first)
        return sid

    def _def_rid(self, frame: Any) -> int:
        """The rid of the ``def`` (or module) a frame runs: the one ``_pk_f`` was called with at its entry.

        The innermost function of that name whose body holds the frame's line; a module body's
        whole-module range.
        """
        info = self.files.get(frame.f_code.co_filename)
        if info is None:
            return 0
        code = frame.f_code
        if code.co_name == "<module>":
            return info.range_base + info.module_rid
        line = frame.f_lineno or code.co_firstlineno
        best: tuple[int, int] | None = None
        for fn in info.functions:
            body = fn.get("bodyRange") or []
            if fn.get("name") != code.co_name or len(body) < 3 or not body[0] <= line <= body[2]:
                continue
            if best is None or body[2] - body[0] < best[0]:
                best = (body[2] - body[0], int(fn["rid"]))
        return info.range_base + best[1] if best is not None else self.rid_at(info, code.co_firstlineno)

    def _baseline_locals(self, chain: list[Any], frame: Any, entry: bool) -> None:
        """What every frame on the stack holds at the switch, kept as the snapshot to diff against.

        Nothing is emitted: a value that was there before step 0 was not made by the statement at
        step 0, and a locals entry is attributed to the statement before it. The frame paused at its
        entry keeps no baseline, so its parameters show at its first body step, as in any recording.
        """
        from .dbgframes import scope_of
        from .tracer import FOREIGN

        for f in chain:
            if f is frame and entry:
                continue
            sid = scope_of(f)
            if sid is None or sid < 0:
                continue
            sid = self.foreign.get(sid) if sid >= FOREIGN else sid
            if sid is None:
                continue
            before = len(self.locals_entries)
            self._record_locals(0, sid, f)
            del self.locals_entries[before:]


class RecordPauseMixin:
    """Mixed into ``Debugger``: which pause starts the recording, and the ``record`` action."""

    def _record_from_spec(self, spec: Any) -> Any:
        """``config.recordFrom`` as what a pause is matched against: ``"pause"``, a ``Breakpoint``, or None."""
        from . import dbgbreakpoints
        from .debugger import Breakpoint

        if not self.tracer.config.records_later:
            return None
        if spec == "pause":
            return "pause"
        bp = Breakpoint(str(spec.get("path") or ""), int(spec.get("line") or 0), None, spec.get("function"))
        dbgbreakpoints.resolve(self.tracer, bp)
        return bp

    def _records_here(self, rid: int) -> bool:
        """Whether the recording starts at this pause: the first one, or the first one where ``recordFrom`` points."""
        spec = self.record_from
        if spec is None or self.tracer.record:
            return False
        return spec == "pause" or (spec.rid is not None and spec.rid == rid)

    def record_here(self, frame: Any) -> dict:
        """The ``record`` action: record from the pause being served on. The pause is announced again as step 0.

        Only a run that was asked to record from a pause can: its host holds a recording session for
        it. A run that records from the start answers where it already is.
        """
        t = self.tracer
        at = self.paused_at
        if at is None or frame is None:
            raise ValueError("the program is running; pause it first")
        if t.record:
            return {"ok": True, "recording": True, "already": True, "step": at[0]}
        if not t.config.records_later:
            raise ValueError("this run was started without a recording; start it with recordFrom to record from a pause")
        _n, rid, scope = at
        scope = t.start_recording(frame, rid, scope)
        self.paused_at = (0, rid, scope)
        self._flush()
        t.emit(self._stop_event(0, rid, scope, frame, self._reason, {**self._extra, "recordingStarted": True}))
        return {"ok": True, "recording": True, "step": 0}
