"""What a recording left out, said where an agent reads it.

Two losses are reported. A trace cut at the step cap (``maxTraceSteps``, ``run --max-steps``):
the final ``trace`` event carries ``truncated`` and, from this runtime on, ``cap``, ``stepsRun``
and ``spentBy`` (``Tracer.cap_report``). ``run`` prints a warning, ``state`` and every verb over
that run print a ``note:`` line first, and ``--json`` gets a ``recording`` field. And a value text
cut at ``maxValueChars``: the text itself ends in ``…(+N chars)`` (``values.value_text``), and
``--json`` gets ``truncated`` and ``length`` next to any such ``text``.
"""

from __future__ import annotations

import os
import re
from typing import Any

# the mark `values.value_text` leaves on a cut text, and the one the CLI's own line cuts leave
CUT_RE = re.compile(r"…\((?:\+([\d,]+) chars|cut)\)$")


def cap_info(trace_ev: dict | None, meta: dict, display: Any, kept: int) -> dict | None:
    """``{truncated, cap, kept, stepsRun, spentBy: [{path, steps}], exclude}`` for a capped trace, else None.

    ``kept`` is the number of recorded steps; ``display`` turns a path into the one the verbs print."""
    if not trace_ev or not trace_ev.get("truncated"):
        return None
    steps_run = trace_ev.get("stepsRun") or meta.get("stepCount")
    cap = trace_ev.get("cap") or (meta.get("config") or {}).get("maxTraceSteps") or kept
    main = os.path.abspath(str(meta.get("file") or ""))
    spent = [e for e in trace_ev.get("spentBy") or [] if isinstance(e, dict)]
    exclude = next((exclude_for(str(e.get("path")), display) for e in spent if os.path.abspath(str(e.get("path"))) != main), None)
    return {
        "truncated": True,
        "cap": int(cap),
        "kept": int(kept),
        "stepsRun": int(steps_run) if steps_run else None,
        "spentBy": [{"path": display(str(e.get("path"))), "steps": int(e.get("steps") or 0)} for e in spent[:3]],
        "exclude": exclude,
    }


def exclude_for(path: str, display: Any) -> str:
    """The ``--exclude`` that leaves a file out: its dotted module for a library file, its relative path for a project file."""
    shown = str(display(path)).replace(os.sep, "/")
    library = any(seg in path.split(os.sep) for seg in ("site-packages", "dist-packages"))
    if library and shown.endswith(".py"):
        parts = shown[:-3].split("/")
        if parts[-1] == "__init__":
            parts = parts[:-1]
        if parts and all(p.isidentifier() for p in parts):
            return ".".join(parts)
    return shown


def _n(value: Any) -> str:
    return format(int(value), ",") if isinstance(value, int) else "?"


def spent_text(info: dict) -> str:
    return " · ".join("%s %s" % (e["path"], _n(e["steps"])) for e in info.get("spentBy") or [])


def note_line(info: dict) -> str:
    """The one line every verb over a capped run prints first."""
    total = info.get("stepsRun")
    head = "note: truncated recording: steps 0-%s of %s kept (step cap %s)" % (_n(max(0, info["kept"] - 1)), _n(total) if total else "an unknown number", _n(info["cap"]))
    if info.get("spentBy"):
        head += "; most steps in %s" % spent_text(info)
    if info.get("exclude"):
        head += "; rerun with --exclude %s" % info["exclude"]
    else:
        head += "; rerun with a higher --max-steps"
    return head


def warning_lines(info: dict) -> list[str]:
    """What ``run`` prints when the cap cut the recording."""
    total = info.get("stepsRun")
    out = ["WARNING: recording truncated at step %s: the program ran %s steps and only the first %s are recorded; nothing after step %s can be read" % (_n(info["cap"]), _n(total) if total else "more", _n(info["kept"]), _n(max(0, info["kept"] - 1)))]
    if info.get("spentBy"):
        out.append("  most steps: %s" % spent_text(info))
    hint = "  rerun with --exclude %s (that code then runs unrecorded at full speed)" % info["exclude"] if info.get("exclude") else "  the steps are in the program file itself"
    out.append(hint + ", or raise --max-steps (now %s)" % _n(info["cap"]))
    return out


def annotate_cut(value: Any) -> Any:
    """Every dict under ``value`` whose ``text`` carries the cut mark gets ``truncated: true`` and, when known, ``length``."""
    if isinstance(value, dict):
        text = value.get("text")
        if isinstance(text, str) and "truncated" not in value:
            m = CUT_RE.search(text)
            if m is not None:
                value["truncated"] = True
                if m.group(1):
                    value["length"] = len(text) - len(m.group(0)) + int(m.group(1).replace(",", ""))
        for v in value.values():
            if isinstance(v, (dict, list)):
                annotate_cut(v)
    elif isinstance(value, list):
        for v in value:
            if isinstance(v, (dict, list)):
                annotate_cut(v)
    return value


def cut_line(text: Any, limit: int, *, strip: bool = False) -> str:
    """One line of at most ``limit`` characters; a cut says how much it left out, adding what the recording cut already."""
    s = " ".join(str(text if text is not None else "").split("\n"))
    if strip:
        s = s.strip()
    if len(s) <= limit:
        return s
    m = CUT_RE.search(s)
    core = s[: m.start()] if m else s
    earlier = int(m.group(1).replace(",", "")) if m and m.group(1) else 0
    keep = max(limit // 2, limit - 16, 1)
    if len(core) <= keep:
        return s
    if m and not m.group(1):
        return "%s…(cut)" % core[:keep]
    return "%s…(+%s chars)" % (core[:keep], format(len(core) - keep + earlier, ","))


__all__ = ["cap_info", "note_line", "warning_lines", "annotate_cut", "cut_line", "CUT_RE", "exclude_for"]
