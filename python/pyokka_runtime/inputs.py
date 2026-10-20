"""What a recorded program reads from outside itself, kept so a replay can hand it back (``replay.py``).

Covered: ``time.time``, ``time.time_ns``, ``os.urandom`` (so ``uuid.uuid4`` too) and the seed of
the ``random`` module's shared generator. A recording run (``config.recordInputs``, on by default)
keeps every read in order with what it returned and sends them in one ``inputs`` event when the
program ends. A replay run that carries them (``replay.inputs``) hands the same values back in the
same order, and stops the program at a read the recording never made: one read too many, or a
different function in that place.

Only reads whose direct caller is not the runtime count. The recorder reads the clock for itself
(its flush timers, the HTTP plugin's timestamps); those pass through untouched, so they never use
up a recorded value and the two runs see the same sequence whatever the recorder did in between.
The standard library reading the clock for the program (``logging``) counts as the program.

Not covered, and each one can make a replay go another way, which the step check then reports:
``datetime.now`` and ``date.today``, ``time.monotonic`` and ``perf_counter``, a ``random.Random()``
the program seeds from the OS itself, the ``secrets`` module, files, sockets that are not HTTP,
environment variables changed between the runs, and threads, whose turns cannot be repeated.
"""

from __future__ import annotations

import os
import random
import sys
import time
from typing import Any, Callable

MAX_READS = 10_000
# a seed the host can carry as a JSON number without losing a bit (JavaScript integers are exact to 2**53)
SEED_BITS = 52
_RUNTIME = "pyokka_runtime"


def _from_program() -> bool:
    """Whether the call into the patched function (two frames up from here) came from the program."""
    caller = sys._getframe(2).f_globals.get("__name__") or ""
    return not str(caller).startswith(_RUNTIME)


# How each function's result travels as JSON: time_ns is an int past 2**53, urandom bytes.
_ENCODE: dict[str, tuple[Callable[[Any], Any], Callable[[Any], Any]]] = {
    "time": (float, float),
    "time_ns": (str, int),
    "urandom": (bytes.hex, bytes.fromhex),
}


class Inputs:
    """``mode`` is ``record`` (keep every read) or ``replay`` (hand back ``saved``).

    ``on_mismatch(message)`` returns the exception to raise into the program when a replayed read
    does not match the recording; the replay driver reports the result before it hands one back.
    """

    def __init__(self, mode: str, saved: dict | None = None, on_mismatch: Callable[[str], BaseException] | None = None) -> None:
        self.mode = mode
        self.saved = saved or {}
        self.on_mismatch = on_mismatch
        self.seed: int | None = None
        self.reads: list[list[Any]] = []
        self.truncated = False
        self.pos = 0
        self._undo: list[tuple[Any, str, Any]] = []

    def install(self) -> None:
        if self.mode == "replay":
            try:
                self.seed = int(self.saved["seed"]) if self.saved.get("seed") is not None else None
            except (TypeError, ValueError):
                self.seed = None
        else:
            self.seed = int.from_bytes(os.urandom(7), "big") >> (56 - SEED_BITS)
        if self.seed is not None:
            random.seed(self.seed)
        self._patch(time, "time")
        self._patch(time, "time_ns")
        self._patch(os, "urandom")

    def uninstall(self) -> None:
        for owner, name, old in reversed(self._undo):
            setattr(owner, name, old)
        self._undo.clear()

    def event(self) -> dict:
        """The recording run's ``inputs`` event."""
        out: dict[str, Any] = {"type": "inputs", "seed": self.seed, "reads": self.reads}
        if self.truncated:
            out["truncated"] = True
        return out

    # -- the patches ---------------------------------------------------------------------------
    def _patch(self, owner: Any, name: str) -> None:
        real = getattr(owner, name)
        encode, decode = _ENCODE[name]
        inputs = self

        def read(*args: Any) -> Any:
            if not _from_program():
                return real(*args)
            label = "%s(%s)" % (name, ", ".join(map(repr, args))) if args else name
            if inputs.mode == "record":
                value = real(*args)
                inputs._keep(label, encode(value))
                return value
            return decode(inputs._replayed(label))

        read.__name__ = getattr(real, "__name__", name)
        read.__qualname__ = getattr(real, "__qualname__", name)
        read.__doc__ = getattr(real, "__doc__", None)
        self._undo.append((owner, name, real))
        setattr(owner, name, read)

    def _keep(self, label: str, value: Any) -> None:
        if self.truncated:
            return
        if len(self.reads) >= MAX_READS:
            self.truncated = True  # a replay stops at the first read past the last one kept
            return
        self.reads.append([label, value])

    def _replayed(self, label: str) -> Any:
        reads = self.saved.get("reads") or []
        if self.pos >= len(reads):
            if self.saved.get("truncated"):
                self._mismatch("the program read %s past the %d reads the recording kept" % (label, len(reads)))
            self._mismatch("the program read %s once more than the recorded run did (%d read%s)" % (label, len(reads), "" if len(reads) == 1 else "s"))
        was, value = reads[self.pos]
        if was != label:
            self._mismatch("the program read %s where the recorded run read %s (read %d)" % (label, was, self.pos + 1))
        self.pos += 1
        return value

    def _mismatch(self, message: str) -> None:
        if self.on_mismatch is not None:
            raise self.on_mismatch(message)
        from .replay import ReplayStop

        raise ReplayStop(message)


def for_run(spec: Any, tracer: Any) -> Inputs | None:
    """The run's inputs, or None: recorded by a recording run, handed back by a replay that carries them."""
    replay = getattr(spec, "replay", None)
    if replay is not None:
        saved = replay.get("inputs") if isinstance(replay, dict) else None
        if not isinstance(saved, dict):
            return None  # a replay without inputs patches nothing: the program reads the clock afresh
        return Inputs("replay", saved, getattr(tracer.dbg, "input_failed", None))
    if spec.config.records and spec.config.record_inputs:
        return Inputs("record")
    return None
