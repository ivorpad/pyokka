"""``pyokka tour``: chapters and candidate stops of a recorded run (``docs/TOUR.md``).

    model     ``TourRun``: per-step arrays, scopes, moments, HTTP rows and local changes of a ``SavedRun``
    astinfo   what a statement is: its calls, what each reaches, whether it keeps a result
    chapters  top-level calls, then phases inside a long call, never through concurrent work
    signals   spine, crossing, io, exception, narrative, evidence: the steps worth a stop and why
    rank      novelty for repeated lines, scores, the token budget
    values    what the program held at a candidate, and how a long or repeated value is shaped
    build     ``build_tour``: ``tour.json``
    prose     ``--prose``: check tour.prose.json against the run, then merge it
    text      the text form
    cli       the ``tour`` subcommand
"""

from .build import DEFAULT_BUDGET, build_tour
from .text import render_tour

__all__ = ["build_tour", "render_tour", "DEFAULT_BUDGET"]
