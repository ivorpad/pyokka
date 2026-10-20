"""What a request at a pause runs stays off the recording.

At a pause the debugger runs code the program never runs: the Debug Console (``exec``), the
evaluations, the reprs of the values it shows, the watches. A replay of the run (``replay.py``)
runs the program alone, so any of that code in the recording would make the recording take steps
the replay does not, or hand the program a clock reading it never made: a function the console
called would be steps of the run, its ``time.time()`` the program's first recorded read. So each
request served at a pause runs with the recording quiet (no steps, as for a value's ``__repr__``),
the inputs held (its reads are not the program's), and the debugger's statement count put back
after it (the count a recording that begins at a pause starts at, ``startedAt``).

Another thread that runs while a request is served loses its steps for that long, as it does
while a ``__repr__`` runs: threads are outside what a replay repeats in any case.
"""

from __future__ import annotations

from typing import Any, Callable, TypeVar

T = TypeVar("T")


def off_the_record(debugger: Any, serve: Callable[[], T]) -> T:
    tracer = getattr(debugger, "tracer", None)
    if tracer is None:
        return serve()
    inputs = getattr(tracer, "inputs", None)
    count = getattr(debugger, "count", None)
    before = count[0] if isinstance(count, list) and count else None
    tracer.quiet += 1
    if inputs is not None:
        inputs.held += 1
    try:
        return serve()
    finally:
        tracer.quiet = max(0, tracer.quiet - 1)
        if inputs is not None:
            inputs.held = max(0, inputs.held - 1)
        if before is not None:
            count[0] = before
