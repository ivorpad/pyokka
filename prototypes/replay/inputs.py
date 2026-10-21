"""What a program reads from outside itself, kept by the recording run and handed back by a replay.

Covered: ``time.time``, ``time.time_ns``, ``time.monotonic``, ``time.perf_counter``,
``datetime.datetime.now`` / ``utcnow`` / ``today``, ``os.urandom`` (so ``uuid.uuid4`` too) and
the seed of the ``random`` module's shared generator. Each read is kept in order with what it
returned; a replay hands the same values back in the same order and stops the program when it
asks for something the recording never read. Reads made by the recorder itself (its flush
timers) pass through untouched, so they never use up a recorded value.

Not covered, and each one can make a replay go another way: ``datetime.date.today``, a
``random.Random()`` the program seeds itself from the OS, the ``secrets`` module, files,
sockets that are not HTTP (a database driver), environment variables changed between the runs,
and threads, whose turns Python cannot repeat.
"""

from __future__ import annotations

import datetime as _datetime
import os
import random
import sys
import time
from typing import Any, Callable

from probe import Diverged

CLOCKS = ("time", "time_ns", "monotonic", "perf_counter")
_OWN = ("pyokka_runtime", "probe", "inputs", "snapshot", "replay")


def _from_program(depth: int = 2) -> bool:
    """Whether the frame ``depth`` levels up (past the patched function) belongs to the program.

    Only the direct caller is looked at: the standard library reading the clock for the program
    (``logging``) counts as the program, and so would a thread the recorder started, which the
    in-process recorder used here does not do.
    """
    caller = sys._getframe(depth).f_globals.get("__name__") or ""
    return not caller.startswith(_OWN)


class Inputs:
    """``mode`` is ``record`` (keep every read), ``replay`` (hand them back) or ``off``."""

    def __init__(self, mode: str, saved: dict | None = None) -> None:
        self.mode = mode
        self.saved = saved or {}
        self.kept: dict[str, Any] = {"seed": None, "reads": []}
        self.pos = 0
        self._undo: list[tuple[Any, str, Any]] = []

    def install(self) -> None:
        if self.mode == "off":
            return
        seed = self.saved.get("seed") if self.mode == "replay" else int.from_bytes(os.urandom(8), "big")
        self.kept["seed"] = seed
        random.seed(seed)
        for name in CLOCKS:
            self._patch(time, name, self._wrap(name, getattr(time, name)))
        real_urandom = os.urandom
        self._patch(os, "urandom", self._wrap("urandom", real_urandom, encode=bytes.hex, decode=bytes.fromhex))
        self._patch(_datetime, "datetime", self._datetime_class(_datetime.datetime))

    def uninstall(self) -> None:
        for owner, name, old in reversed(self._undo):
            setattr(owner, name, old)
        self._undo.clear()

    def _patch(self, owner: Any, name: str, new: Any) -> None:
        self._undo.append((owner, name, getattr(owner, name)))
        setattr(owner, name, new)

    def _read(self, label: str, real: Callable[[], Any], encode: Callable = lambda v: v, decode: Callable = lambda v: v) -> Any:
        """One read from outside: kept while recording, the recorded value while replaying."""
        if self.mode == "record":
            value = real()
            self.kept["reads"].append([label, encode(value)])
            return value
        reads = self.saved.get("reads") or []
        if self.pos >= len(reads):
            raise Diverged("the program read %s once more than the recorded run did (%d reads)" % (label, len(reads)))
        was, value = reads[self.pos]
        if was != label:
            raise Diverged("the program read %s where the recorded run read %s (read %d)" % (label, was, self.pos + 1))
        self.pos += 1
        return decode(value)

    def _wrap(self, label: str, real: Callable, encode: Callable = lambda v: v, decode: Callable = lambda v: v) -> Callable:
        def read(*args: Any) -> Any:
            if not _from_program():
                return real(*args)
            return self._read(label + ("(%s)" % ", ".join(map(repr, args)) if args else ""), lambda: real(*args), encode, decode)

        read.__name__ = getattr(real, "__name__", label)
        return read

    def _datetime_class(self, base: type) -> type:
        inputs = self

        class datetime(base):  # type: ignore[misc, valid-type]
            """``datetime.datetime`` whose clock reads are kept and replayed; everything else is the original."""

            @classmethod
            def now(cls, tz: Any = None) -> Any:
                return inputs._stamp(cls, "datetime.now", lambda: base.now(tz))

            @classmethod
            def utcnow(cls) -> Any:
                return inputs._stamp(cls, "datetime.utcnow", base.utcnow)

            @classmethod
            def today(cls) -> Any:
                return inputs._stamp(cls, "datetime.today", base.today)

        datetime.__module__ = "datetime"
        datetime.__qualname__ = "datetime"
        return datetime

    def _stamp(self, cls: type, label: str, real: Callable[[], Any]) -> Any:
        if not _from_program(3):  # _from_program <- _stamp <- now/utcnow/today <- the caller
            return real()
        text = self._read(label, lambda: real().isoformat(), lambda v: v, lambda v: v)
        return cls.fromisoformat(text)
