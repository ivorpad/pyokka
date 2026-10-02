"""Perf guard: a 300k-step loop traces in under 1.5 s."""

from __future__ import annotations

import time


def test_300k_steps_under_budget(run):
    t0 = time.perf_counter()
    out = run("total = 0\nfor i in range(100_000):\n    x = i * 2\n    total += x\n", config={"maxTraceSteps": 999999})
    elapsed = time.perf_counter() - t0
    assert out.result.step_count == 300_002
    assert not out.trace["truncated"]
    assert elapsed < 1.5, elapsed


def test_redact_is_linear_in_the_length_of_a_line():
    """One long line must not cost what two short ones do not.

    `_KV`'s leading `[A-Za-z0-9_.-]*` used to restart at every offset of a run of those
    characters and backtrack the length of the run at each one. 64 KB on a single line took
    around 100 s against a fraction of a millisecond for the same bytes as short lines, and a
    program is free to print a line that long. The budget here is loose on purpose: it is a
    guard against the quadratic coming back, not a benchmark.
    """
    import time

    from pyokka_runtime.redact import redact

    def cost(text: str) -> float:
        best = None
        for _ in range(3):
            t0 = time.perf_counter()
            redact(text)
            d = time.perf_counter() - t0
            best = d if best is None else min(best, d)
        return best or 0.0

    small = cost("a" * 8 * 1024)
    large = cost("a" * 64 * 1024)
    assert large < 0.2, "64 KB on one line took %.1f ms" % (large * 1000)
    # eight times the input, not sixty-four times the work
    assert large < small * 24 + 0.01, "8 KB %.2f ms, 64 KB %.2f ms: superlinear" % (small * 1000, large * 1000)
