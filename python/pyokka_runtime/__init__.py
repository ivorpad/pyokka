"""Pyokka runtime. Pure standard library; shipped inside the VS Code extension.

Modules:
    instrument  - AST instrumentation (coverage, steps, value hooks, magic comments)
    tracer      - per-run recorder (coverage bits, trace steps, logs, timings)
    serialize   - bounded value snapshots in the protocol's node schema
    runner      - long-lived server process talking NDJSON to the extension host
    protocol    - message constructors shared by runner and tests
"""

__version__ = "0.3.0"
