"""The agenda and the conversation around it: ``skip`` sets a stop aside with the person's reason, ``look``
answers "what is X here" from the recording without moving anything, ``state`` lists the agenda (shown,
skipped, remaining), what was said, the tries and the findings.

``look`` evaluates a pure expression (``pyokka_runtime/pure.py``: names, operators, subscripts and the
calls that cannot change anything) over the values recorded at the step, rebuilt from their texts
with ``ast.literal_eval``; the kept runner answers first when the run has one. A value that is not a
literal (an object, a cut text) cannot be rebuilt, so the recorded texts the expression names are
printed instead, and ``try`` is the way to run it for real.
"""

from __future__ import annotations

import ast
import builtins
from typing import Any

from ...pure import eval_pure
from ..context import _step_location
from ..render import _one_line
from ..source import AgentError, SavedRun
from .actions import head_run, values_at
from .render import conversation_lines, fact_text, finding_lines, plan_lines, try_lines, value_lines, where
from .state import WAIT, Review, result
from .view import close_view


# -- skip ---------------------------------------------------------------------------------------------------------

def skip(review: Review, f: dict) -> dict:
    try:
        n = int(f.get("n"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        raise review.refuse("skip wants N, the stop's number in the plan", plan_lines(review), "review skip N --why TEXT") from None
    s = review.stop(n)
    if s is None:
        raise review.refuse("stop %d is not in the plan" % n, plan_lines(review), "review skip N --why TEXT")
    if n in review.shown:
        raise review.refuse("stop %d was shown already; nothing to skip" % n)
    why = str(f.get("why") or "").strip()
    if not why:
        raise review.refuse("skip %d needs --why TEXT, the reason the person gave" % n, next_command="review skip %d --why TEXT" % n)
    review.mark_skipped(n, why)
    review.note("skip", n=n, why=why)
    review.save()
    remaining = review.remaining()
    lines = [
        "skipped %d. %s  %s  %s" % (n, s.get("kind"), where(s), _one_line(fact_text(s.get("fact")), 120)),
        "why: %s" % why,
        "remaining: %s" % (", ".join(str(x) for x in remaining) or "none; the agenda is done"),
    ]
    return result(review, lines, skipped=review.skipped, remaining=remaining)


# -- look ---------------------------------------------------------------------------------------------------------

def current_step(review: Review) -> int | None:
    """The step of the last stop shown or line asked: where a ``look`` without ``--step`` evaluates."""
    for entry in reversed(review.conversation):
        if entry.get("kind") in ("stop", "ask") and entry.get("step") is not None:
            return int(entry["step"])
    return None


def evaluate(run_: SavedRun, expr: str, node: ast.AST, values: list[tuple[str, str]]) -> dict:
    """``{value, how}`` from the kept runner or from the recorded literals; else ``{locals, note}``, the recorded texts the expression names."""
    names = list(dict.fromkeys(n.id for n in ast.walk(node) if isinstance(n, ast.Name)))
    recorded = dict(values)
    if run_.meta.get("keep"):
        try:
            text = run_.eval(expr).get("text")
            if text is not None:
                return {"value": str(text), "how": "evaluated by the kept runner"}
        except AgentError:
            pass
    matched = [(name, recorded[name]) for name in names if name in recorded]
    missing = [n for n in names if n not in recorded and not hasattr(builtins, n)]
    if missing:
        return {"locals": matched, "note": "no recorded value for %s at this step" % ", ".join(missing)}
    namespace: dict[str, Any] = {}
    for name, text in matched:
        try:
            namespace[name] = ast.literal_eval(text)
        except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
            return {"locals": matched, "note": "the recorded text of %s is not a literal (an object, or a cut value), so the run cannot evaluate it" % name}
    try:
        value = eval_pure(node, {}, namespace)
    except ValueError as exc:  # not a pure expression
        return {"locals": matched, "note": str(exc)}
    except Exception as exc:  # noqa: BLE001  the expression itself failed on these values
        return {"locals": matched, "note": "%s: %s" % (type(exc).__name__, exc)}
    return {"value": repr(value), "how": "evaluated from the values recorded at this step"}


def look(review: Review, f: dict) -> dict:
    expr = str(f.get("expr") or "").strip()
    if not expr:
        raise review.refuse("look needs --expr EXPR, a pure expression over the values at the step", next_command="review look --expr EXPR")
    try:
        node = ast.parse(expr, mode="eval").body
    except SyntaxError as exc:
        raise review.refuse("--expr is not an expression: %s" % (exc.msg or exc), next_command="review look --expr EXPR") from None
    step = f.get("step")
    if step is None:
        step = current_step(review)
        if step is None:
            raise review.refuse("no current step: show a stop or ask a line first, or give --step N", next_command="review look --expr EXPR --step N")
    run_ = head_run(review)
    step = run_.check_step(int(step))
    at = _step_location(run_, step)
    values = values_at(run_, step)
    outcome = evaluate(run_, expr, node, values)
    review.note("look", expr=expr, step=step, value=outcome.get("value"))
    review.save()
    lines = ["look %s  at step %d  %s:%s %s" % (expr, step, run_.display_path(at["file"]), at["line"], at["function"])]
    if outcome.get("value") is not None:
        lines.append("= %s  (%s)" % (_one_line(outcome["value"], 300), outcome["how"]))
    else:
        named = outcome.get("locals") or []
        lines.append("not evaluated: %s" % outcome.get("note"))
        lines.append("recorded values it names:" if named else "it names no recorded value at this step; `review try --expr EXPR` runs it in the sandbox")
        lines.extend(value_lines(named))
    return result(review, lines, WAIT, expr=expr, step=step, **outcome)


# -- state --------------------------------------------------------------------------------------------------------

def state(review: Review, f: dict | None = None) -> dict:
    lines = list(plan_lines(review))
    lines.extend(conversation_lines(review))
    lines.append("tries (%d):" % len(review.tries) if review.tries else "tries: none")
    for t in review.tries:
        lines.extend(try_lines(t))
    lines.append("findings (%d):" % len(review.findings) if review.findings else "findings: none")
    for fd in review.findings:
        lines.extend(finding_lines(fd))
    fix = review.data.get("fix")
    if isinstance(fix, dict):
        tests = fix.get("tests")
        files = fix.get("files") or []
        checks = fix.get("checks") or []
        lines.append("fix: %s applied to %d file%s%s; %d check%s" % (fix.get("patch"), len(files), "" if len(files) == 1 else "s", ("; tests exit %s" % tests.get("exit")) if isinstance(tests, dict) else "", len(checks), "" if len(checks) == 1 else "s"))
    rep = review.data.get("report")
    if isinstance(rep, dict):
        lines.append("report: %s" % rep.get("path"))
    return result(review, lines, plan=review.plan, shown=list(review.shown), skipped=review.skipped, remaining=review.remaining(), waiting=review.waiting, asked=review.asked, conversation=review.conversation, tries=review.tries, findings=review.findings, fix=fix, phase=review.phase)


def close(review: Review, f: dict | None = None) -> dict:
    """Stop the page server ``start`` opened; the VS Code recording stays for the person to keep reading."""
    line = close_view(review.data)
    review.save()
    return result(review, [line or "nothing to close: start opened no page server (a VS Code recording runs nothing)"])


__all__ = ["close", "skip", "look", "state", "current_step", "evaluate"]
