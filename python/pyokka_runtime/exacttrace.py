"""Exact writes for ``config.exact``: what each statement changed, recorded at that statement's own step.

The default recording compares a snapshot of the frame's locals, taken by the hook *before* each
statement, on ``(id(value), len(value))`` (``Tracer._record_locals``). That credits a change to the next
statement and misses one made in place (``prices["a"] = 10``, ``orders.append(x)``, a change through
another name). With ``exact`` the statement hook calls ``on_step`` instead, and the frame is traced by
opcode while it runs: a ``STORE_*`` names a binding the statement made, a ``LOAD_*`` a value it touched,
and each container a touched value reaches keeps a fingerprint of its own contents. When the frame's
next statement starts (or the frame returns or yields), the statement that ran is closed: every name it
stored, and every local whose containers changed, is a change at its step, marked ``exact``: made *by*
that step, where a snapshot change at step N was observed *at* N (``History`` reads the two differently).
The entry also carries ``reads``: the program's names the statement loaded, in first-load order, so
``tier or fallback`` lists ``fallback`` only when it ran (``History.read_names`` prefers them to the source's).

A change also reaches every other name that holds the changed object, directly or inside a container: the
caller's dict whose list a callee appended to, another order's line, a module global of a module that is not
running (``catalog.TEMPLATE``). Each container edge (parent holds child) is indexed with the step that first
showed it, at the loads and stores of a traced statement and at a traced frame's return value; at a change
the changed objects are walked up that index, and each name on the stack and in an instrumented module's
globals whose value is one of the ancestors, and still reaches the changed object, gets the change at the
statement's step. The change says how it holds the object (``shared``: the path, the name the statement
changed it through, the step the edge into it was first seen: where the sharing began, or the first time a
traced statement handled the container that holds it).

Not covered: an edge no traced statement showed before the change (``self.items.append(obj)`` inside an
untraced call, with ``self.items`` never loaded or stored by a traced statement after it), so the holder
misses the change; ids are reused after an object is freed, so a ``since`` step can be an older object's
(a stale edge itself costs nothing, since each holder is verified by a real path). The index, and the last
recorded fingerprint of each changed container (``last``, so a caller's statement does not repeat a
change its callee recorded), live for the run, like ``locals_entries``. A container past ``SHALLOW_MAX`` items falls back to ``(id, len)``. Fingerprints read builtin containers and plain ``__dict__`` only, so no
user code runs in them; the change text is ``cut_entry``'s, as the default recording's is.

The events come from ``sys.monitoring`` (PEP 669) under tool id 4, or 5 when 4 is taken: ``on_step`` (and
``baseline``) sets INSTRUCTION, PY_RETURN and PY_YIELD on the code object of each frame it traces, once per
code, and PY_UNWIND globally (a frame left by an exception, which ``sys.settrace`` reported as a return of
None). Every frame of an armed code then sends events, and the callbacks skip the ones not in ``frames``. An
instruction ``_opcode`` does nothing with (anything but a store or load of a program name) returns DISABLE,
which turns that instruction off for every frame of its code. Nothing else is called: frames of other code
cost nothing, and a ``sys.settrace`` function the program or a debugger installed stays in place. On 3.14 a
``sys.settrace`` or ``sys.setprofile`` call stops the INSTRUCTION events of every armed code (it has PY_RETURN
set too) until they are set again, so ``on_step`` sets them again when this thread's trace or profile
function changed (``_rearm``); a call in another thread is not seen until this one makes the same. Moving
off ``sys.settrace`` took the run of a traced 240,000-step loop from 10.7 s to 6.9 s, DISABLE to 5.8 s, and
the fingerprint fast path (``_PRIM_TYPES``) to 4.4 s; a snapshot recording of it runs in 0.6 s. Most of
what is left is the statement's own work: a fingerprint of every container it touched, before and after,
and the text of each change (``cut_entry``).

When both tool ids are taken, the frames are traced by ``sys.settrace`` instead (``_local``). On 3.14 a
frame's opcode events then need ``frame.f_trace`` set explicitly and ``f_trace_lines`` left on (turning it
off stops opcode events too), and a global trace function must be installed for any frame to be traced at
all; the global one returns None, so frames of code that is not instrumented cost one call each.
"""

from __future__ import annotations

import dis
import sys
from typing import Any

from .instrument import SCOPE_NAME
from .protocol import MAX_LOCALS_ENTRIES
from .defsite import defined_at, skipped_at_module
from .values import cut_entry

PRIM = (int, float, complex, str, bytes, bool, type(None))
_PRIM_TYPES = frozenset(PRIM)
SHALLOW_MAX = 10_000  # items: a bigger container is compared by length, not contents
REACH_MAX = 2_000  # containers followed from one value
_NOT_LOADS = frozenset({"LOAD_CONST", "LOAD_SMALL_INT", "LOAD_ATTR", "LOAD_METHOD", "LOAD_SUPER_ATTR", "LOAD_COMMON_CONSTANT", "LOAD_SPECIAL", "LOAD_BUILD_CLASS", "LOAD_ASSERTION_ERROR", "LOAD_LOCALS", "LOAD_FROM_DICT_OR_GLOBALS", "LOAD_FROM_DICT_OR_DEREF"})
_NOT_STORES = frozenset({"STORE_ATTR", "STORE_SUBSCR", "STORE_SLICE"})
_RESUMABLE = 0x20 | 0x80 | 0x100 | 0x200  # CO_GENERATOR, CO_COROUTINE, CO_ITERABLE_COROUTINE, CO_ASYNC_GENERATOR
_BUILTIN = (list, tuple, dict, set, frozenset)
ANCESTORS_MAX = 10_000  # containers walked up from the changed ones
HOPS = 64  # frames walked up the stack for holders
# `sys.monitoring` tool ids tried in order: 0-2 are the debugger, coverage and profiler ids (debugpy, coverage.py,
# cProfile) and 3 is the tracer's exceptions (`errors.py`); 4 and 5 have no conventional owner
TOOL_IDS = (4, 5)
_mon = getattr(sys, "monitoring", None)
_LOCAL_EVENTS = (_mon.events.INSTRUCTION | _mon.events.PY_RETURN | _mon.events.PY_YIELD) if _mon is not None else 0
_DISABLE = _mon.DISABLE if _mon is not None else None
_getframe = sys._getframe
_gettrace = sys.gettrace
_getprofile = sys.getprofile


def _ref(x: Any) -> Any:
    return x if type(x) in _PRIM_TYPES or isinstance(x, PRIM) else ("@", id(x))


# `type(x) in _PRIM_TYPES or isinstance(x, PRIM)` is `isinstance(x, PRIM)`, at half the cost for the exact types:
# a fingerprint runs it on every item of every container a statement touches
def shallow(o: Any) -> Any:
    """A container's own contents (primitives by value, other objects by id), or None for anything else."""
    t = type(o)
    pt = _PRIM_TYPES
    if t in (list, tuple):
        return (t.__name__, len(o)) if len(o) > SHALLOW_MAX else (t.__name__, tuple([x if type(x) in pt or isinstance(x, PRIM) else ("@", id(x)) for x in o]))
    if t is dict:
        return ("dict", len(o)) if len(o) > SHALLOW_MAX else ("dict", tuple([(k if type(k) in pt or isinstance(k, PRIM) else ("@", id(k)), v if type(v) in pt or isinstance(v, PRIM) else ("@", id(v))) for k, v in o.items()]))
    if t in (set, frozenset):
        return (t.__name__, len(o)) if len(o) > SHALLOW_MAX else (t.__name__, frozenset([x if type(x) in pt or isinstance(x, PRIM) else ("@", id(x)) for x in o]))
    if t in pt or isinstance(o, PRIM) or callable(o):
        return None
    d = getattr(t, "__dict__", {}).get("__dict__") and getattr(o, "__dict__", None)
    if type(d) is dict:
        return ("obj", tuple([(k, v if type(v) in pt or isinstance(v, PRIM) else ("@", id(v))) for k, v in d.items()]))
    return None


def _container(o: Any) -> bool:
    """What ``shallow`` fingerprints, without building the fingerprint."""
    t = type(o)
    if t in _BUILTIN:
        return True
    if t in _PRIM_TYPES or isinstance(o, PRIM) or callable(o):
        return False
    return bool(getattr(t, "__dict__", {}).get("__dict__")) and type(getattr(o, "__dict__", None)) is dict


def _labelled(o: Any) -> list[tuple[str, Any]]:
    """``_children`` with the subscript or attribute each child sits at, for a path (``['lines'][0]``)."""
    t = type(o)
    if t in (list, tuple):
        return [] if len(o) > SHALLOW_MAX else [("[%d]" % i, x) for i, x in enumerate(o) if not isinstance(x, PRIM)]
    if t in (set, frozenset):
        return [] if len(o) > SHALLOW_MAX else [("{…}", x) for x in o if not isinstance(x, PRIM)]
    if t is dict:
        if len(o) > SHALLOW_MAX:
            return []
        out = []
        for k, v in o.items():
            if not isinstance(v, PRIM):
                out.append(("[%r]" % (k,) if isinstance(k, PRIM) else "[…]", v))
            if not isinstance(k, PRIM):
                out.append(("{key}", k))
        return out
    d = getattr(o, "__dict__", None)
    return [("." + k, v) for k, v in d.items() if not isinstance(v, PRIM)] if type(d) is dict else []


def _children(o: Any) -> list:
    t = type(o)
    pt = _PRIM_TYPES
    if t in (list, tuple, set, frozenset):
        return [] if len(o) > SHALLOW_MAX else [x for x in o if type(x) not in pt and not isinstance(x, PRIM)]
    if t is dict:
        return [] if len(o) > SHALLOW_MAX else [x for kv in o.items() for x in kv if type(x) not in pt and not isinstance(x, PRIM)]
    d = getattr(o, "__dict__", None)
    return [v for v in d.values() if type(v) not in pt and not isinstance(v, PRIM)] if type(d) is dict else []


def reach(o: Any) -> dict[int, Any]:
    """``{id: container}`` for the containers ``o`` reaches, ``o`` included, at most ``REACH_MAX``."""
    out: dict[int, Any] = {}
    todo = [o]
    while todo and len(out) < REACH_MAX:
        x = todo.pop()
        if type(x) in _PRIM_TYPES or isinstance(x, PRIM) or id(x) in out or shallow(x) is None:
            continue
        out[id(x)] = x
        todo.extend(_children(x))
    return out


def path_to(root: Any, targets: set[int]) -> tuple[str, int, int] | None:
    """The shortest path from ``root`` to one of ``targets``: ``(path, target id, id of the container holding it)``,
    ``("", id, 0)`` when ``root`` is one, else None (within ``REACH_MAX`` containers)."""
    if id(root) in targets:
        return "", id(root), 0
    seen = {id(root)}
    level = [("", root)]
    while level and len(seen) < REACH_MAX:
        nxt = []
        for path, x in level:
            for label, c in _labelled(x):
                if id(c) in targets:
                    return path + label, id(c), id(x)
                if id(c) not in seen and _container(c):
                    seen.add(id(c))
                    nxt.append((path + label, c))
        level = nxt
    return None


def _loop_targets(ins: list[Any]) -> frozenset[int]:
    """The stores right after a ``FOR_ITER`` that a statement hook follows: an instrumented ``for`` loop's
    targets. A comprehension's loop has no hook after its target, so its stores stay with the statement."""
    out: set[int] = set()
    for k, i in enumerate(ins):
        if i.opname != "FOR_ITER":
            continue
        j, stores = k + 1, []
        while j < len(ins) and (ins[j].opname.startswith("STORE_") or ins[j].opname.startswith("UNPACK_")):
            stores.append(ins[j].offset)
            j += 1
        if stores and j < len(ins) and ins[j].opname == "LOAD_GLOBAL" and str(ins[j].argval).startswith("_pk_"):
            out.update(stores)
    return frozenset(out)


class _Frame:
    __slots__ = ("scope", "step", "stores", "pending", "touched", "loaded", "reads", "module", "seen", "inflight")
    # loaded: name -> ids of the containers its value reached when the statement first loaded it

    def __init__(self, scope: int, module: bool) -> None:
        self.scope = scope
        self.step: int | None = None
        self.stores: set[str] = set()
        self.pending: set[str] = set()  # a loop's targets, stored before its iteration step: that step's, not the open one's
        self.touched: dict[int, tuple[Any, Any]] = {}
        self.loaded: dict[str, set[int]] = {}  # name -> the container ids its value reached when first loaded here
        self.reads: list[str] = []  # the program's names the open statement loaded, in first-load order
        self.module = module
        self.seen = False
        self.inflight = False  # a caller on the stack when a recording began: its statement has no step


class ExactTracer:
    def __init__(self, tracer: Any) -> None:
        self.tracer = tracer
        names = tracer.config.exact
        # True: every frame; a list: only frames of functions with those names (a qualified name matches too)
        self.only: frozenset[str] | None = frozenset(names) if isinstance(names, list) else None
        self._wanted: dict[Any, bool] = {}
        self.frames: dict[int, _Frame] = {}
        self.instrs: dict[Any, dict[int, Any]] = {}
        self.loop_targets: dict[Any, frozenset[int]] = {}  # code -> offsets of the stores of a stepped loop's targets
        self._old_trace: Any = None
        self._tool: int | None = None  # the `sys.monitoring` tool id, None when tracing by `sys.settrace`
        self._armed: set[Any] = set()  # code objects with local events set
        self._acts: dict[Any, frozenset[int]] = {}  # code -> offsets of the instructions `_opcode` acts on
        self._legacy: tuple[Any, Any] = (None, None)  # this thread's sys.gettrace() and sys.getprofile() when last armed
        self.up: dict[int, dict[int, int]] = {}  # child id -> {parent id: the step that first showed the edge}
        self._modules: list[Any] = []  # the instrumented modules' globals (`_pk_scope_` set), refreshed as modules load
        self._modules_seen = -1
        self.last: dict[int, tuple[int, Any]] = {}  # container id -> (step, fingerprint) of the change last recorded for it

    # -- install -------------------------------------------------------------------------------
    def start(self) -> None:
        mon = getattr(sys, "monitoring", None)
        for tool in TOOL_IDS if mon is not None else ():
            try:
                mon.use_tool_id(tool, "pyokka exact")
            except ValueError:
                continue  # another tool holds it
            ev = mon.events
            mon.register_callback(tool, ev.INSTRUCTION, self._on_instruction)
            mon.register_callback(tool, ev.PY_RETURN, self._on_return)
            mon.register_callback(tool, ev.PY_YIELD, self._on_return)
            mon.register_callback(tool, ev.PY_UNWIND, self._on_unwind)
            self._tool = tool
            self._legacy = (_gettrace(), _getprofile())
            return
        self._old_trace = sys.gettrace()
        sys.settrace(_global)

    def stop(self) -> None:
        self.flush()
        tool, self._tool = self._tool, None
        if tool is None:
            sys.settrace(self._old_trace)
            return
        mon = sys.monitoring
        try:
            mon.set_events(tool, 0)
            for code in self._armed:
                mon.set_local_events(tool, code, 0)
            ev = mon.events
            for event in (ev.INSTRUCTION, ev.PY_RETURN, ev.PY_YIELD, ev.PY_UNWIND):
                mon.register_callback(tool, event, None)
            mon.free_tool_id(tool)
        except Exception:  # noqa: BLE001
            pass
        self._armed.clear()

    def _arm(self, frame: Any) -> None:
        """Trace ``frame`` by instruction: its code object for ``sys.monitoring`` (once per code, so every frame
        of it sends events and ``frames`` picks the traced ones), or the frame itself for ``sys.settrace``."""
        if self._tool is None:
            frame.f_trace = self._local
            frame.f_trace_opcodes = True  # f_trace_lines stays on: see the module docstring
            return
        code = frame.f_code
        if code in self._armed:
            return
        self._table(code)
        mon = sys.monitoring
        if not self._armed:
            mon.set_events(self._tool, mon.events.PY_UNWIND)  # a global event: a frame left by an exception
        self._armed.add(code)
        mon.set_local_events(self._tool, code, _LOCAL_EVENTS)

    def _rearm(self) -> None:
        """``sys.settrace`` or ``sys.setprofile`` was called: on 3.14 that stops the INSTRUCTION events of every code
        that has another local event set as well (PY_RETURN here), frames still to come included, until its
        events are set again. The statement that made the call loses what it does after it."""
        self._legacy = (_gettrace(), _getprofile())
        mon = sys.monitoring
        for code in self._armed:
            mon.set_local_events(self._tool, code, 0)
            mon.set_local_events(self._tool, code, _LOCAL_EVENTS)

    def _table(self, code: Any) -> dict[int, Any]:
        """``{offset: instruction}`` of ``code``, with its loop targets and the offsets ``_opcode`` acts on."""
        table = self.instrs.get(code)
        if table is None:
            table = self.instrs[code] = {i.offset: i for i in dis.get_instructions(code)}
            self.loop_targets[code] = _loop_targets(list(table.values()))
            self._acts[code] = frozenset(o for o, i in table.items() if _acts_on(i))
        return table

    # -- the statement hook --------------------------------------------------------------------
    def wants(self, frame: Any) -> bool:
        """Whether the frame is traced exactly: every one, or one of a named function's."""
        if self.only is None:
            return True
        code = frame.f_code
        hit = self._wanted.get(code)
        if hit is None:
            hit = self._wanted[code] = code.co_name in self.only or code.co_qualname in self.only
        return hit

    def on_step(self, n: int, scope: int, frame: Any) -> None:
        if self._tool is not None and (_gettrace() is not self._legacy[0] or _getprofile() is not self._legacy[1]):
            self._rearm()
        st = self.frames.get(id(frame))
        if st is None or st.scope != scope:
            st = self.frames[id(frame)] = _Frame(scope, frame.f_code.co_name == "<module>")
            self._arm(frame)
        if not st.seen:
            st.seen = True
            self._emit(n, st, frame, list(frame.f_locals), exact=False)  # the parameters: there before step n, as a snapshot entry says
        elif st.inflight:
            # the statement running when the recording began has no step: what it stored is observed here,
            # as a snapshot change is, and `History` credits it to the statement before
            st.inflight = False
            names = sorted(st.stores | self._changed_names(st, frame))
            st.stores, st.touched, st.loaded = set(), {}, {}
            if names:
                self._emit(n, st, frame, names, exact=False)
        else:
            self._close(st, frame)
        st.step = n
        if st.pending:
            st.stores |= st.pending
            st.pending = set()

    def baseline(self, chain: list[Any], frame: Any, entry: bool, top: int) -> None:
        """The recording starts at a pause (``recordFrom``): the frames on the stack are traced from now on, and
        what they hold is not emitted, since step 0 did not make it (as ``_baseline_locals`` keeps it). The
        paused frame's statement is step 0; one paused at its entry shows its parameters at its first step."""
        from .dbgframes import scope_of
        from .tracer import FOREIGN

        for f in chain:
            if not self.wants(f):
                continue
            sid = scope_of(f)
            if sid is not None and sid >= FOREIGN:
                sid = self.tracer.foreign.get(sid)
            if (sid is None or sid < 0) and f is frame:
                sid = top
            if sid is None or sid < 0:
                continue
            st = self.frames[id(f)] = _Frame(sid, f.f_code.co_name == "<module>")
            st.seen = not (f is frame and entry)
            if f is frame and not entry:
                st.step = 0
            elif f is not frame:
                st.inflight = True
            self._arm(f)

    def settle(self, frame: Any) -> None:
        """A pause at the frame's next statement: record what the statement that just ran changed, now, so the
        pause shows it. The hook goes on to ``on_step`` after the resume and finds nothing left to close."""
        st = self.frames.get(id(frame))
        if st is not None and st.seen and not st.inflight:
            self._close(st, frame)
            st.step = None

    def flush(self) -> None:
        """The run is ending: nothing will close the statements still open, so drop them (their frames are gone)."""
        self.frames.clear()

    # -- tracing -------------------------------------------------------------------------------
    # The event source: `sys.monitoring` callbacks (`_on_instruction`, `_on_return`, `_on_unwind`), or `_local`, a
    # `sys.settrace` frame function, when no tool id is free. Both find the frame's `_Frame` and call `_opcode` or
    # `_returned`; a frame of an armed code that is not in `frames` (not traced, or not at its first step yet) is skipped.
    def _on_instruction(self, code: Any, offset: int) -> Any:
        if offset not in self._acts[code]:
            return _DISABLE  # `_opcode` does nothing with this instruction in any frame: stop its events
        frame = _getframe(1)
        st = self.frames.get(id(frame))
        if st is not None and (st.step is not None or st.inflight):
            self._opcode(st, frame, self.instrs[code][offset])
        return None

    def _on_return(self, code: Any, offset: int, value: Any) -> None:
        frame = _getframe(1)
        st = self.frames.get(id(frame))
        if st is not None:
            self._returned(st, frame, value)

    def _on_unwind(self, code: Any, offset: int, exc: BaseException) -> None:
        if code not in self._armed:
            return  # PY_UNWIND is global: every frame an exception leaves
        frame = _getframe(1)
        st = self.frames.get(id(frame))
        if st is not None:
            self._returned(st, frame, None)  # as `sys.settrace` reports it: a return of None

    def _local(self, frame: Any, event: str, arg: Any) -> Any:
        st = self.frames.get(id(frame))
        if st is None:
            return None
        if event == "opcode":
            ins = self._table(frame.f_code).get(frame.f_lasti)
            if ins is not None and (st.step is not None or st.inflight):
                self._opcode(st, frame, ins)
        elif event == "return":
            self._returned(st, frame, arg)
        return self._local

    # The two handlers below are what the event source calls; keep what an instruction or a return means here.
    # `_acts_on` (below the class) says which instructions `_opcode` acts on, and must change with it.
    def _opcode(self, st: _Frame, frame: Any, ins: Any) -> None:
        """One instruction of a traced frame while a statement is open: a store names a binding, a load a value touched."""
        op = ins.opname
        names = ins.argval if isinstance(ins.argval, tuple) else (ins.argval,)
        if op.startswith("STORE_") and op not in _NOT_STORES:
            # `for x in xs:` binds x after the open statement (the header, or the body's last line on a later
            # iteration) and before the iteration step, which is the step that binds it
            into = st.pending if ins.offset in self.loop_targets[frame.f_code] else st.stores
            into.update(n for n in names if isinstance(n, str) and not n.startswith("_pk_"))
        elif op.startswith("LOAD_") and op not in _NOT_LOADS:
            for name in names:
                if isinstance(name, str) and not name.startswith("_pk_"):
                    # a read is a name the statement loaded before storing it (not a comprehension's target) that the
                    # frame or its module holds (not a builtin); a statement with no step (inflight) records none
                    if st.step is not None and name not in st.loaded and name not in st.stores and (name in frame.f_locals or name in frame.f_globals):
                        st.reads.append(name)
                    self._touch(st, frame, name)

    def _returned(self, st: _Frame, frame: Any, arg: Any) -> None:
        """A traced frame returned (or yielded) ``arg``: close its open statement."""
        if st.step is not None and not isinstance(arg, PRIM):
            self._index(arg, st.step)  # `return {"lines": [TEMPLATE]}`: where a returned container starts to hold what it holds
        self._close(st, frame)
        if frame.f_code.co_flags & _RESUMABLE:
            st.step = None  # a yield: the frame comes back, and its next statement step reopens it
        else:
            self.frames.pop(id(frame), None)

    def _touch(self, st: _Frame, frame: Any, name: str) -> None:
        if name in st.loaded:
            return
        st.loaded[name] = set()
        loc = frame.f_locals
        if name in loc:
            value = loc[name]
        elif name in frame.f_globals:
            value = frame.f_globals[name]
        else:
            return
        reached = self._index(value, st.step)
        st.loaded[name] = set(reached)
        for i, x in reached.items():
            if i not in st.touched:
                st.touched[i] = (x, shallow(x))

    def _close(self, st: _Frame, frame: Any) -> None:
        """The statement at ``st.step`` ended: record what it stored and every local whose containers it changed."""
        if st.step is None:
            return
        changed = self._changed_ids(st)
        names = st.stores | self._changed_names(st, frame, changed)
        loc = frame.f_locals
        for name in st.stores:
            if name in loc and not isinstance(loc[name], PRIM):
                self._index(loc[name], st.step)
        step = st.step
        for i in changed:  # `self.items.append(obj)`: the edges a change made, as of this step
            self._index(st.touched[i][0], step)
        st.stores = set()
        st.touched = {}
        st.loaded = {}
        reads, st.reads = st.reads, []
        self._emit(step, st, frame, sorted(names), reads=reads)
        if changed:
            self._holders(step, frame, changed, names)

    def _changed_ids(self, st: _Frame) -> set[int]:
        """The touched containers the statement changed. One whose contents a later step already recorded is the
        work of a call the statement made (``bulk_bonus(ana)`` closes after the callee's own statements), so it is
        left to that step instead of showing twice."""
        out: set[int] = set()
        last = self.last
        for i, (x, before) in st.touched.items():
            now = shallow(x)
            if now == before:
                continue
            seen = last.get(i)
            if seen is not None and st.step is not None and seen[0] > st.step and seen[1] == now:
                continue
            out.add(i)
            last[i] = (st.step if st.step is not None else -1, now)
        return out

    def _index(self, value: Any, step: int | None) -> dict[int, Any]:
        """``reach(value)``, indexing each edge it walks (the parent holds the child) with ``step`` when it is new."""
        out: dict[int, Any] = {}
        up = self.up
        todo = [value]
        pt = _PRIM_TYPES
        while todo and len(out) < REACH_MAX:
            x = todo.pop()
            if type(x) in pt or isinstance(x, PRIM) or id(x) in out or not _container(x):
                continue
            out[id(x)] = x
            for c in _children(x):
                if _container(c):
                    if step is not None:
                        up.setdefault(id(c), {}).setdefault(id(x), step)
                    todo.append(c)
        return out

    def _ancestors(self, changed: set[int]) -> set[int]:
        out = set(changed)
        todo = list(changed)
        while todo and len(out) < ANCESTORS_MAX:
            for p in self.up.get(todo.pop(), ()):
                if p not in out:
                    out.add(p)
                    todo.append(p)
        return out

    def _module_globals(self) -> list[Any]:
        if len(sys.modules) != self._modules_seen:
            self._modules_seen = len(sys.modules)
            files = self.tracer.files  # this run's files: a module another run instrumented keeps its `_pk_scope_`
            self._modules = [g for m in list(sys.modules.values()) if isinstance(g := getattr(m, "__dict__", None), dict) and isinstance(g.get(SCOPE_NAME), int) and g.get("__file__") in files]
        return self._modules

    def _holders(self, step: int, frame: Any, changed: set[int], done: set[str]) -> None:
        """Every other name that holds a changed object, directly or inside a container, gets the change at
        ``step``, in its own scope: names of this frame the statement did not touch, the frames up the stack,
        and the globals of the instrumented modules (``catalog.TEMPLATE`` with no catalog frame running)."""
        from .dbgframes import scope_of
        from .tracer import FOREIGN

        anc = self._ancestors(changed)
        loc = frame.f_locals
        through = next((n for n in sorted(done) if n in loc and id(loc[n]) in changed), None)  # the name the statement changed it through
        seen_globals: set[int] = set()
        holders: list[tuple[int, Any, set[str]]] = []
        f, hops = frame, 0
        while f is not None and hops < HOPS:
            other = self.frames.get(id(f))
            sid = other.scope if other is not None else scope_of(f)
            if sid is not None and sid >= FOREIGN:
                sid = self.tracer.foreign.get(sid)
            if sid is not None and sid >= 0:
                holders.append((sid, f, done if f is frame else set()))
                if f.f_code.co_name == "<module>":
                    seen_globals.add(id(f.f_globals))
            f, hops = f.f_back, hops + 1
        for g in self._module_globals():
            sid = g.get(SCOPE_NAME)
            if id(g) in seen_globals or not isinstance(sid, int) or sid < 0:
                continue
            if sid >= FOREIGN:
                sid = self.tracer.foreign.get(sid)
                if sid is None:
                    continue
            holders.append((sid, g, set()))
        for sid, where, skip in holders:
            mapping = where if isinstance(where, dict) else where.f_locals
            module = isinstance(where, dict) or where.f_code.co_name == "<module>"
            shared: dict[str, dict] = {}
            for name, value in list(mapping.items()):
                if name in skip or name.startswith("_pk_") or isinstance(value, PRIM) or id(value) not in anc:
                    continue
                found = path_to(value, changed)
                if found is None:
                    continue
                path, target, parent = found
                info: dict[str, Any] = {"path": name + path}
                if through is not None and not (where is frame and name == through):
                    info["as"] = through
                if parent:
                    since = self.up.get(target, {}).get(parent)
                    if since is not None:
                        info["since"] = since
                shared[name] = info
            if shared:
                self._emit(step, _Frame(sid, module), where, sorted(shared), shared=shared)

    def _changed_names(self, st: _Frame, frame: Any, changed: set[int] | None = None) -> set[str]:
        """The locals a change reached: a name the statement loaded whose value reaches a changed container, and any
        local that *is* a changed container (another name for it, ``alias.append(x)`` changing ``orders``). A local
        that only contains one and was not loaded is not followed: walking every local's containers at every
        statement cost 13x, measured on a 20,000-row loop."""
        changed = self._changed_ids(st) if changed is None else changed
        if not changed:
            return set()
        hit = {name for name, ids in st.loaded.items() if changed & ids}
        hit |= {name for name, value in frame.f_locals.items() if id(value) in changed and not name.startswith("_pk_")}
        return hit

    def _emit(self, step: int, st: _Frame, frame: Any, names: list[str], exact: bool = True, shared: dict[str, dict] | None = None, reads: list[str] | None = None) -> None:
        """A locals entry at ``step`` for ``names`` of ``frame`` (a frame, or a module's globals dict). ``reads`` (from
        ``_close`` only) are the names the statement loaded: the entry carries them, with empty ``changes`` when the
        statement changed nothing, and an entry without the key is one whose reads were not recorded."""
        t = self.tracer
        if len(t.locals_entries) >= MAX_LOCALS_ENTRIES:
            return
        loc = frame if isinstance(frame, dict) else frame.f_locals
        changes: list[dict] = []
        t.quiet += 1  # a __repr__ in instrumented code records nothing of its own (as in `_record_locals`)
        try:
            for name in names:
                if name.startswith("_pk_") or name not in loc:
                    continue
                value = loc[name]
                defined = defined_at(value, t.files)
                if st.module and skipped_at_module(name, value, defined):
                    continue  # imports and dunders, filtered as `_record_locals` filters them
                entry = cut_entry({"name": name}, name, value, t.locals_chars)
                if defined is not None:
                    entry["defined"] = defined
                if exact:
                    entry["exact"] = True
                if shared and name in shared:
                    entry["shared"] = shared[name]
                changes.append(entry)
        finally:
            t.quiet -= 1
        if changes or reads:
            out: dict[str, Any] = {"step": step, "scopeId": st.scope, "changes": changes}
            if reads is not None:
                out["reads"] = reads
            t.locals_entries.append(out)


def _acts_on(ins: Any) -> bool:
    """Whether ``_opcode`` does anything with the instruction (in any frame): a store or a load of a name
    that is not the instrumentation's. Instruction events return DISABLE for the others."""
    op = ins.opname
    names = ins.argval if isinstance(ins.argval, tuple) else (ins.argval,)
    if (op.startswith("STORE_") and op not in _NOT_STORES) or (op.startswith("LOAD_") and op not in _NOT_LOADS):
        return any(isinstance(n, str) and not n.startswith("_pk_") for n in names)
    return False


def _global(frame: Any, event: str, arg: Any) -> None:
    return None  # frames are traced from the statement hook (`ExactTracer.on_step`), not from here


__all__ = ["ExactTracer", "SHALLOW_MAX", "reach", "shallow"]
