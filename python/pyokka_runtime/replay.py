"""Replay a recorded run to one step and read a value there whole, checking every step on the way.

A run request with ``replay`` (docs/PROTOCOL.md, "Replay") runs the program again exactly as a
recording run does: same instrumentation, same steps, the same locals and logs recorded. A
``ReplayDriver`` sits where a debugger would (``tracer.dbg``), so the recorder calls it at every
step. It compares the step's statement and call depth with the recording (``expect``) and stops
at the first one that differs, because every value after that point belongs to a different run.
At ``check.step`` it computes the text the recorder keeps for ``check.name`` there, so the host can
compare it with what the recording kept; at ``at.step`` it evaluates ``at.expr`` with the pure
evaluator in that step's frame, before the statement runs (as the Time Machine's watches do), and
serializes the value whole. Then it sends one ``replay.result`` and stops the program.

The driver never adds to the recording: what it evaluates and serializes runs with the recorder
quiet (a ``__repr__`` in instrumented code records no steps), and it emits nothing but the result.
The program stops through ``ReplayStop``, so its ``finally`` blocks and the recorder's own finish
still run and the locals and logs up to the stop reach the host like any run's.

A recording that began at a pause (``recordFrom``, or the ``record`` action) numbers its steps from
that pause, and its ``trace`` says where: ``startedAt``, the debugger's statement count there.
``replay.startAt`` replays it the same way. The run starts as a ``recordFrom`` run does before its
switch, on the debugger's hook set (``hooks_debug.py``), which records nothing and counts
statements; the driver stands in for the debugger there, armed only for the statement the
recording began at (``expect``'s step 0), and never pauses. When that statement runs at count
``startAt``, the driver makes the switch the ``recordFrom`` pause makes (``start_recording``: a
scope for every instrumented frame on the stack, the silent locals snapshot, that statement as step
0) and the check runs from step 0 as for any recording. A program that ends first, or runs that
statement at another count, says the start point did not match.
"""

from __future__ import annotations

import ast
import base64
import binascii
import sys
from array import array
from typing import Any

from .protocol import LogLimitSet
from .pure import compile_pure, run_pure
from .serialize import serialize
from .values import cut_entry

# what a rerun value keeps: far past the inline limits (5 levels, 8192 characters), short of unbounded
FULL = LogLimitSet(depth=30, elements=5000, string_length=200_000)


class ReplayStop(BaseException):
    """Raised into the program once the replay has its answer, or knows the run went another way.

    A ``BaseException``, so the program's own ``except Exception`` lets it through. A program that
    swallows it (a bare ``except:``) meets it again at its next step.
    """


def decode_pairs(b64: str) -> array:
    """``replay.expect``: (rid, depth) per step, little-endian int32 pairs."""
    out = array("i")
    out.frombytes(base64.b64decode(b64, validate=True))
    if sys.byteorder == "big":
        out.byteswap()
    if len(out) % 2:
        raise ValueError("expect holds %d ints, not (rid, depth) pairs" % len(out))
    return out


class ReplayDriver:
    """The recorder's debugger for one replay run (the duck type ``Debugger`` fills in a debug run)."""

    break_on_exception = "off"  # the recorder reads it only for a run that does not record

    def __init__(self, tracer: Any, replay: dict) -> None:
        self.tracer = tracer
        self.done = False
        self.matched = 0
        self.check: dict | None = None
        self.error: str | None = None
        self.expect = array("i")
        self.at_step = -1
        self.check_step = -1
        self.check_name = ""
        self.expr = ""
        self.code: Any = None
        self.start_at: int | None = None
        # The debugger hook set's cells (hooks_debug.py), live only while a late start waits for its
        # statement: the statement counter, the arming cell, the one "breakpoint", the per-call ids.
        self.count = [0]
        self.cell = [0, 0]
        self.by_rid: dict[int, bool] = {}
        self.next_sid = [0]
        self.pending_sid = -1
        self.started = True
        try:
            self.expect = decode_pairs(str(replay.get("expect") or ""))
            at = replay.get("at") if isinstance(replay.get("at"), dict) else {}
            self.at_step = int(at["step"])
            self.expr = str(at.get("expr") or "").strip()
            check = replay.get("check")
            if isinstance(check, dict) and check.get("step") is not None:
                self.check_step = int(check["step"])
                self.check_name = str(check.get("name") or "").strip()
            if replay.get("startAt") is not None:
                self.start_at = int(replay["startAt"])
        except (KeyError, TypeError, ValueError, binascii.Error) as exc:
            self.error = "the replay request is malformed: %s: %s" % (type(exc).__name__, exc)
            return
        if not 0 <= self.at_step < self.n_expect_steps:
            self.error = "step %d is outside the %d recorded steps sent" % (self.at_step, self.n_expect_steps)
        elif self.start_at is not None and self.start_at < 0:
            self.error = "the start point %d is not a statement count" % self.start_at
        elif self.check_step > self.at_step:
            self.error = "the check step %d comes after the step %d it checks" % (self.check_step, self.at_step)
        elif not self.expr:
            self.error = "nothing to evaluate: the replay names no expression"
        else:
            try:
                self.code = compile_pure(ast.parse(self.expr, "<replay>", mode="eval").body, "<replay>")
            except (SyntaxError, ValueError) as exc:
                self.error = "%s cannot be evaluated: %s" % (self.expr, exc)

    @property
    def n_expect_steps(self) -> int:
        return len(self.expect) // 2

    # -- what the recorder calls -------------------------------------------------------------
    def file_added(self, info: Any) -> None:
        pass

    def on_raise(self, exc: BaseException, frame: Any, record: Any) -> None:
        pass

    def on_uncaught(self, exc: BaseException) -> None:
        pass  # replay_finished says how the run ended, once the recorder is done with the program

    def rearm(self) -> None:
        """The debugger hooks' arming cell: on while the start waits, off in a library module body."""
        self.cell[0] = 0 if self.started or self.tracer.quiet or not self.by_rid else 1
        self.cell[1] = 0

    def on_leave(self, frame: Any) -> None:
        pass  # no step waits for a frame to return: the driver never steps

    def on_step(self, n: int, rid: int, scope: int, bp: Any = None) -> None:
        """Every recorded step; before a late start, the debugger hooks' call for the start statement (``bp``)."""
        if self.done:
            raise ReplayStop("the replay has its answer")
        if not self.started:
            self._wait(n, rid, scope, sys._getframe(2))  # on_step <- the debugger's hook <- the program's frame
            return
        if self.error is not None:
            self._result("error", n, message=self.error)
            raise ReplayStop(self.error)
        depth = self.tracer.steps[4 * n + 2]  # the recorder appended this step before calling
        if n >= self.n_expect_steps:
            self._result("diverged", n, actual={"rid": rid, "depth": depth}, message="the replay ran past the %d steps the recording sent" % self.n_expect_steps)
            raise ReplayStop("diverged")
        want_rid, want_depth = self.expect[2 * n], self.expect[2 * n + 1]
        if rid != want_rid or depth != want_depth:
            message = "the recording ran statement %d at depth %d here, the replay statement %d at depth %d" % (want_rid, want_depth, rid, depth)
            self._result("diverged", n, expected={"rid": want_rid, "depth": want_depth}, actual={"rid": rid, "depth": depth}, message=message)
            raise ReplayStop("diverged")
        self.matched = n + 1
        if n == self.check_step:
            self._check(n, sys._getframe(2))  # on_step <- the recorder's hook <- the program's frame
        if n == self.at_step:
            fields = self._evaluate(n, sys._getframe(2))
            self._result("reached", n, **fields)
            raise ReplayStop("reached")

    # -- what the inputs and the run call ------------------------------------------------------
    def input_failed(self, message: str) -> BaseException:
        """A replayed read did not match the recording (inputs.py): the result, and what to raise."""
        self._result("input", self.tracer.cur_step, message=message)
        return ReplayStop(message)

    def replay_finished(self, uncaught: BaseException | None) -> None:
        """The program ended without the replay stopping it: it never reached the step."""
        if self.done:
            return
        if self.error is not None:
            self._result("error", 0, message=self.error)
            return
        if not self.started:
            ran = self.count[0]
            self._result("diverged", 0, message="the start point did not match: the program ended after %d statements, before statement %d where the recording began" % (ran, self.start_at))
            return
        ran = self.tracer.n_steps
        how = "with an uncaught %s" % type(uncaught).__name__ if uncaught is not None else ""
        self._result("ended", ran, message="the program ended%s after %d step%s, before step %d" % (" " + how if how else "", ran, "" if ran == 1 else "s", self.at_step))

    # -- a late start (``startAt``) ---------------------------------------------------------------
    def wait_for_start(self) -> None:
        """Start the run as a ``recordFrom`` run starts: unrecorded, counting statements, armed for one statement."""
        from .tracer import FOREIGN

        t = self.tracer
        self.started = False
        t.record = False  # `install` puts the debugger's hook set in (hooks_debug.py)
        t.record_locals = False  # `start_recording` turns it back on from the config
        self.next_sid[0] = FOREIGN  # per-call ids no recorded scope can have, as in a recordFrom run
        self.by_rid[self.expect[0]] = True  # the statement the recording began at: the hooks call only there
        self.rearm()

    def _wait(self, n: int, rid: int, scope: int, frame: Any) -> None:
        """The start statement ran at count ``n``: earlier than the start point, at it (switch), or past it."""
        if n < self.start_at:  # type: ignore[operator]
            return  # the same statement on an earlier pass: the recording began on a later one
        if n > self.start_at:  # type: ignore[operator]
            self._result("diverged", 0, message="the start point did not match: statement %d did not run at statement %d, where the recording began (it ran at %d)" % (rid, self.start_at, n))
            raise ReplayStop("diverged")
        t = self.tracer
        self.started = True
        self.by_rid.clear()
        self.rearm()
        t.start_recording(frame, rid, scope, count=n)
        got = (t.steps[0], t.steps[2]) if len(t.steps) >= 4 else (rid, -1)
        want = (self.expect[0], self.expect[1])
        if got != want:
            message = "the start point did not match: the recording began at statement %d at depth %d, the replay is at statement %d at depth %d" % (want[0], want[1], got[0], got[1])
            self._result("diverged", 0, expected={"rid": want[0], "depth": want[1]}, actual={"rid": got[0], "depth": got[1]}, message=message)
            raise ReplayStop("diverged")
        self.matched = 1
        if self.check_step == 0:
            self._check(0, frame)
        if self.at_step == 0:
            fields = self._evaluate(0, frame)
            self._result("reached", 0, **fields)
            raise ReplayStop("reached")

    # -- the values ----------------------------------------------------------------------------
    def _check(self, n: int, frame: Any) -> None:
        """The text the recorder keeps for ``check_name`` at this step (``_record_locals`` reads the frame's locals)."""
        tracer = self.tracer
        tracer.quiet += 1
        try:
            local_vars = frame.f_locals
            if self.check_name in local_vars:
                entry = cut_entry({"name": self.check_name}, self.check_name, local_vars[self.check_name], tracer.locals_chars)
                self.check = {"step": n, "text": entry["text"]}
            else:
                self.check = {"step": n, "missing": "%s is not a local of the frame at step %d" % (self.check_name, n)}
        except Exception as exc:  # noqa: BLE001 - the program's repr, reported on the result
            self.check = {"step": n, "error": "%s: %s" % (type(exc).__name__, exc)}
        finally:
            tracer.quiet -= 1

    def _evaluate(self, n: int, frame: Any) -> dict:
        tracer = self.tracer
        tracer.quiet += 1
        try:
            try:
                value = run_pure(self.code, frame.f_globals, frame.f_locals)
            except NameError as exc:
                return {"missing": str(exc)}
            except Exception as exc:  # noqa: BLE001 - the program's own error, reported on the result
                return {"error": "%s: %s" % (type(exc).__name__, exc)}
            node = serialize(value, FULL, root_key="replay", hit=n, resolve_getters=tracer.config.resolve_getters, expression_root=self.expr)
            return {"value": {"data": node}}
        finally:
            tracer.quiet -= 1

    def _result(self, status: str, step: int, **fields: Any) -> None:
        """The run's one ``replay.result``."""
        if self.done:
            return
        self.done = True
        out: dict[str, Any] = {"type": "replay.result", "status": status, "step": step, "matched": self.matched}
        if self.check is not None:
            out["check"] = self.check
        out.update({k: v for k, v in fields.items() if v is not None})
        self.tracer.emit(out)


def attach_replay(tracer: Any, replay: dict) -> ReplayDriver:
    """``Execution.on_tracer`` for a replay run: the driver as the recorder's debugger.

    A run that records only from a pause (``recordFrom``) numbers no steps from the program's start,
    so there is nothing to compare: the driver answers with an error at once and is not attached.
    """
    driver = ReplayDriver(tracer, replay)
    if driver.start_at is not None and driver.error is None:
        driver.wait_for_start()  # a recording that began at a pause: unrecorded up to its start point
        tracer.dbg = driver
        return driver
    if not tracer.record:
        driver.error = "a replay needs a run that records from its first statement, and this one records from a pause on"
        driver._result("error", 0, message=driver.error)
        return driver
    tracer.dbg = driver
    return driver
