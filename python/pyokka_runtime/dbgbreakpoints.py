"""Where a breakpoint spec lands: a file and a line, or the ``def`` a bare function name means.

Called from ``Debugger.set_breakpoints`` for the files already instrumented and from
``Debugger.file_added`` for each one as it arrives, so a breakpoint set on a module before its
import is honoured when it loads.

A ``path`` and a ``line`` resolve to the statement on that line, a blank or comment line to the
next statement in the file, and a line past the last statement to the nearest earlier one.

``{function: NAME}`` (``--at rrf``) is resolved here rather than on the host, because a module
imported later gets its breakpoint when it loads, which an AST scan of the program cannot do for
an arbitrary ``sys.path`` module, and because the instrumenter already built the table:
``info.function_names`` maps the rid of a ``def`` to its name, and that rid is the one the entry
hook (``_pk_f``) is called with. A breakpoint on it therefore pauses at every call, before the
function's first statement, through the same index the statement hook looks in.

The table holds bare names (``rank``, never ``Ranker.rank``), so a dotted NAME matches on its last
segment: the class is not in the table, and a user types a qualified name to tell two files apart
far more often than two classes in one file. With a ``path`` only that file is searched; without
one, every instrumented non-library file, in the order they were instrumented, and inside a file
in source order (rid order is source order). A second file that defines the same name does not
move the breakpoint: the first match keeps it and the echo says where else the name lives, so
``FILE:LINE`` is the way to pick.
"""

from __future__ import annotations

import os
from typing import Any


def resolve(tracer: Any, bp: Any, info: Any = None) -> bool:
    """Resolve one spec. True when this call is what gave it a rid, so the index needs rebuilding.

    ``info`` is the file that has just been instrumented, or ``None`` to search every file
    instrumented so far.
    """
    if bp.function:
        return _by_function(tracer, bp, info)
    return bp.rid is None and _by_line(tracer, bp, info)


def _by_line(tracer: Any, bp: Any, info: Any) -> bool:
    if not bp.path:
        return False
    for candidate in _files(tracer, bp, info):
        table = tracer.line_rids.get(candidate.filename) or {}
        if not table:
            return False
        if bp.line in table:
            line = bp.line
        else:
            later = [ln for ln in table if ln > bp.line]
            line = min(later) if later else max(ln for ln in table if ln <= bp.line) if any(ln <= bp.line for ln in table) else min(table)
        bp.rid = table[line]
        bp.file_id = candidate.file_id
        bp.resolved_line = line
        return True
    return False


def _by_function(tracer: Any, bp: Any, info: Any) -> bool:
    """Point ``bp`` at its function's ``def``.

    An already resolved breakpoint is never moved: another definition only adds the ``error`` the
    echo carries, so the run still pauses at the first one.
    """
    hit = False
    for candidate in _files(tracer, bp, info):
        rid = _first_def(candidate, bp.function or "")
        if rid is None:
            continue
        if bp.rid is None:
            bp.rid = rid
            bp.file_id = candidate.file_id
            bp.resolved_line = _line_of(candidate, rid)
            bp.path = bp.path or candidate.filename  # the echo names the file the name was found in
            bp.line = bp.line or bp.resolved_line
            hit = True
        elif rid != bp.rid and not bp.error:
            bp.error = "also defined in %s:%d; give FILE:LINE to pick one" % (_display(tracer, candidate), _line_of(candidate, rid))
    return hit


def _files(tracer: Any, bp: Any, info: Any) -> list[Any]:
    """The files to search: the spec's own, or every instrumented file that is not a library."""
    files = [info] if info is not None else list(tracer.file_order)
    if not bp.path:
        return [f for f in files if not f.library]
    want = os.path.realpath(bp.path)
    return [f for f in files if os.path.realpath(f.filename) == want]


def _first_def(info: Any, name: str) -> int | None:
    """The rid of the first ``def`` in this file called ``name``, else ``None``."""
    want = name.rsplit(".", 1)[-1] if "." in name else name
    if not want or want.startswith("<"):
        return None  # `<module>` and `<lambda>` are in the table but are not names a user gives
    for rid in sorted(info.function_names):
        if info.function_names[rid] == want:
            return rid
    return None


def _line_of(info: Any, rid: int) -> int:
    local = rid - info.range_base
    return int(info.ranges[local][0]) if 0 <= local < len(info.ranges) else 0


def _display(tracer: Any, info: Any) -> str:
    """A path to read: relative to the main file's directory when it lives under it, else absolute."""
    files = tracer.file_order
    if files:
        try:
            rel = os.path.relpath(info.filename, os.path.dirname(files[0].filename))
        except ValueError:
            return info.filename
        if not rel.startswith(os.pardir):
            return rel
    return info.filename
