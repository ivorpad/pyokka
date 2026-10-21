"""The step check and the watches of a replay, plugged into Pyokka's recorder.

A replay compares every step with the recording, statement and call depth, and stops the
program at the first step that differs, because every value after that point belongs to a
different run. Two ways in, by cost:

- With no watch, the check rides on the recorder's own periodic hook (every 1,024 steps) and
  compares the new block of steps with the recording at C speed. The program stops within one
  block of the first difference, and the report still names the exact step.
- With a watch, the probe becomes the recorder's debugger (``tracer.dbg``), which the recorder
  calls at every step, because a watch needs the live frame before its line runs. It checks each
  step as it arrives and evaluates the watch there, as the Time Machine does, copying the whole
  value. That costs a Python call per step.
"""

from __future__ import annotations

import ast
import os
import sys
from array import array
from dataclasses import dataclass, field
from typing import Any

from pyokka_runtime.pure import compile_pure, run_pure
from pyokka_runtime.serialize import expression_name

from snapshot import snapshot


class Diverged(BaseException):
    """The replay went another way than the recording; raised into the program to stop it.

    A ``BaseException``, so the program's own ``except Exception`` lets it through. A bare
    ``except:`` would swallow it; the probe then keeps the first divergence and stops checking.
    """


@dataclass
class Watch:
    """``EXPR`` evaluated before ``LINE`` of ``FILE`` runs, every time it runs."""

    file: str | None
    line: int
    expr: str
    code: Any = None
    refused: str | None = None
    rids: set[int] = field(default_factory=set)

    def __post_init__(self) -> None:
        try:
            self.code = compile_pure(ast.parse(self.expr, "<watch>", mode="eval").body, "<watch>")
        except (SyntaxError, ValueError) as exc:
            self.refused = "%s: %s" % (type(exc).__name__, exc)

    def matches(self, path: str, main: str) -> bool:
        if self.file is None:
            return os.path.abspath(path) == os.path.abspath(main)
        return path == self.file or path.endswith(os.sep + self.file) or os.path.basename(path) == self.file

    def evaluate(self, step: int, frame: Any) -> dict:
        if self.refused:
            return {"step": step, "error": self.refused}
        try:
            value = run_pure(self.code, frame.f_globals, frame.f_locals)
        except Diverged:
            raise
        except NameError as exc:
            return {"step": step, "missing": str(exc)}
        except BaseException as exc:  # noqa: BLE001 - the program's own error, reported on the hit
            return {"step": step, "error": "%s: %s" % (type(exc).__name__, exc)}
        return {"step": step, "value": snapshot(value, expression_name(self.expr))}


class Probe:
    """One replay's step check and watches; with ``recorded=None`` (a recording run) it attaches nothing."""

    break_on_exception = "off"  # the recorder reads it only for a run that does not record

    def __init__(self, main: str, recorded: array | None, locate_recorded: Any, watches: list[Watch]) -> None:
        self.main = main
        self.recorded = recorded
        self.n_recorded = len(recorded) // 4 if recorded is not None else 0
        self.locate_recorded = locate_recorded  # (rid, scope) -> "file:line function" in the recording
        self.watches = watches
        self.watch_rids: dict[int, list[Watch]] = {}
        self.tracer: Any = None
        self.checked = 0  # steps compared so far; the same as matched until a difference
        self.diverged: dict | None = None
        self.hits: list[tuple[Watch, dict]] = []

    @property
    def matched(self) -> int:
        return self.diverged["step"] if self.diverged else self.checked

    # -- plugging in ---------------------------------------------------------------------------
    def attach(self, tracer: Any) -> None:
        self.tracer = tracer
        if self.watches:
            tracer.dbg = self
        elif self.recorded is not None:
            periodic = tracer._periodic

            def check_then_flush() -> None:
                self.check(len(tracer.steps) // 4)
                periodic()

            tracer._periodic = check_then_flush  # the step hook calls it every 1,024 steps

    def note(self, exc: BaseException | None) -> None:
        """A stop the inputs raised inside the program: the statement at the current step read something else."""
        if not isinstance(exc, Diverged) or self.diverged is not None or self.tracer is None:
            return
        n, steps, rec = self.tracer.cur_step, self.tracer.steps, self.recorded
        where = self.locate(steps[4 * n], steps[4 * n + 1]) if 4 * n + 1 < len(steps) else "?"
        before = self.locate_recorded(rec[4 * (n - 1)], rec[4 * (n - 1) + 1]) if n > 0 and rec is not None else None  # type: ignore[index]
        self.diverged = {"step": n, "why": "%s, at %s" % (exc, where), "after": before, "caught": n + 1}

    def finish(self) -> None:
        """The steps the last block left unchecked, after the program ended."""
        if self.recorded is None or self.diverged is not None:
            return
        try:
            self.check(len(self.tracer.steps) // 4)
        except Diverged:
            pass

    # -- what the recorder calls when the probe is its debugger --------------------------------
    def file_added(self, info: Any) -> None:
        for w in self.watches:
            if w.matches(info.filename, self.main):
                # every id whose range starts on the line; only statements and function entries make steps
                w.rids.update(info.range_base + i for i, r in enumerate(info.ranges) if r and r[0] == w.line)
                for rid in w.rids:
                    listed = self.watch_rids.setdefault(rid, [])
                    if w not in listed:
                        listed.append(w)

    def on_step(self, n: int, rid: int, scope: int) -> None:
        if self.diverged is not None:
            return
        rec = self.recorded
        if rec is not None:
            if n >= self.n_recorded:
                self._diverge(n, "the replay ran past the end of the recording")
            if rec[4 * n] != rid or rec[4 * n + 2] != self.tracer.steps[4 * n + 2]:
                self._diverge(n, None)
            self.checked = n + 1
        watches = self.watch_rids.get(rid)
        if watches:
            frame = sys._getframe(2)  # on_step <- the recorder's hook <- the program's frame
            self.tracer.quiet += 1  # nothing the copy touches may record steps of its own
            try:
                for w in watches:
                    self.hits.append((w, w.evaluate(n, frame)))
            finally:
                self.tracer.quiet -= 1

    def on_raise(self, exc: BaseException, frame: Any, record: Any) -> None:
        pass

    def on_uncaught(self, exc: BaseException) -> None:
        pass

    # -- the check -----------------------------------------------------------------------------
    def check(self, end: int) -> None:
        """Compare steps ``checked`` .. ``end`` with the recording; raise ``Diverged`` at the first difference."""
        if self.diverged is not None or end <= self.checked:
            return
        steps, rec, a = self.tracer.steps, self.recorded, self.checked
        b = min(end, self.n_recorded)
        same = steps[4 * a : 4 * b : 4] == rec[4 * a : 4 * b : 4] and steps[4 * a + 2 : 4 * b : 4] == rec[4 * a + 2 : 4 * b : 4]  # type: ignore[index]
        if not same:
            n = next(i for i in range(a, b) if steps[4 * i] != rec[4 * i] or steps[4 * i + 2] != rec[4 * i + 2])  # type: ignore[index]
            self._diverge(n, None)
        self.checked = b
        if end > self.n_recorded:
            self._diverge(self.n_recorded, "the replay ran past the end of the recording")

    def locate(self, rid: int, scope: int) -> str:
        """``file:line function`` of a step of this run."""
        for info in self.tracer.file_order:
            i = rid - info.range_base
            if 0 <= i < len(info.ranges) and info.ranges[i]:
                name = self.tracer.scopes[scope]["name"] if 0 <= scope < len(self.tracer.scopes) else "?"
                return "%s:%d %s" % (os.path.basename(info.filename), info.ranges[i][0], name)
        return "rid %d" % rid

    def _diverge(self, n: int, why: str | None) -> None:
        steps, rec = self.tracer.steps, self.recorded
        if why is None:
            was = self.locate_recorded(rec[4 * n], rec[4 * n + 1])  # type: ignore[index]
            why = "the recording ran %s, the replay ran %s" % (was, self.locate(steps[4 * n], steps[4 * n + 1]))
        before = self.locate_recorded(rec[4 * (n - 1)], rec[4 * (n - 1) + 1]) if n > 0 else None  # type: ignore[index]
        # how far the program had run when the check saw it: the step itself with a watch, the block's end without
        caught = len(steps) // 4
        self.diverged = {"step": n, "why": why, "after": before, "caught": caught}
        raise Diverged("the replay went another way at step #%d: %s" % (n, why))
