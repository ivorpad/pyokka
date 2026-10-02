"""Agent access to a run: saved runs, the context slice, the ``pyokka`` commands.

Layers, bottom up:

    link      NDJSON client of a ``serve`` runner (pipes to a subprocess, or a Unix socket)
    keep      the keeper daemon that keeps a runner alive after ``run --keep``
    save      ``pyokka run FILE --save run.json``: drive a runner, redact, write ``{"meta", "events"}``
    source    ``RunSource`` (the seam) and ``SavedRun``
    live      ``LiveRun``: the same methods over the bridge socket of an open VS Code session (``--live``)
    context   the context slice and the Code Story blocks, computed over a saved run's data
    render    bounded text rendering of the contract shapes, one renderer per command
    commands  argparse subcommands, dispatch, ``--json``, ``watch --live``
"""
