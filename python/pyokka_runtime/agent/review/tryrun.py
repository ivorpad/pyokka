"""A reproduction for the review: the page's Scratchpad experiment when a page is open on the review's tree, else the headless sandbox.

Both run the code in a separate ``python -I`` with the head tree's root on ``sys.path`` and the
network denied on macOS (``pyokka_runtime/scratchpad.py``). The page's experiment is sent as
``POST /api/command {action: scratchpad, op: experiment, code, inputs, mocks}`` so the person sees
it in the Scratchpad; headless, ``scratchpad.run`` runs it beside the entry file (``main.py`` at the
repo root, else the first ``.py`` there), whose directory is what the child puts on ``sys.path``.
The answer has one shape either way: ``{result, values, output, error, surface}``.
"""

from __future__ import annotations

import os
from typing import Any

from ...scratchpad import ScratchError, run as sandbox_run
from .surfaces import default_port, http_json, page_is_open, page_state

EXPERIMENT_TIMEOUT_S = 60.0  # the bridge gives an experiment 45 s (seeding and a 5 s run)


def inputs_source(value: Any) -> str:
    """Inputs as Python source: text as given, a ``{name: expression}`` object as ``name = expression`` lines."""
    if value is None:
        return ""
    if isinstance(value, dict):
        return "".join("%s = %s\n" % (k, v) for k, v in value.items())
    return str(value)


def mocks_source(value: Any) -> str:
    """Mocks as Python source: text as given, a ``{target: expression}`` object as one dict literal."""
    if value is None:
        return ""
    if isinstance(value, dict):
        return "{%s}" % ", ".join("%r: %s" % (k, v) for k, v in value.items()) if value else ""
    return str(value)


def entry_file(repo: str) -> str | None:
    """The file the sandbox runs beside: ``repo`` itself when it is a file, else ``main.py`` at its root, else the first ``.py`` there."""
    if os.path.isfile(repo):
        return os.path.abspath(repo)
    main = os.path.join(repo, "main.py")
    if os.path.isfile(main):
        return os.path.abspath(main)
    try:
        names = sorted(n for n in os.listdir(repo) if n.endswith(".py"))
    except OSError:
        return None
    return os.path.abspath(os.path.join(repo, names[0])) if names else None


def _under(path: str | None, repo: str) -> bool:
    if not path:
        return False
    root = os.path.realpath(repo if os.path.isdir(repo) else os.path.dirname(repo))
    return os.path.realpath(str(path)).startswith(root.rstrip(os.sep) + os.sep)


def _shape(result: dict | None, surface: str, **extra: Any) -> dict:
    r = result or {}
    # the child reports {name, line, value, type}; `text` is the same value under the name every other listing uses
    values = [{**v, "text": v.get("value")} if isinstance(v, dict) else v for v in r.get("values") or []]
    out = {"result": r.get("result"), "values": values, "output": r.get("output") or "", "error": r.get("error"), "surface": surface}
    for key in ("traceback", "missing", "mocks", "sandbox"):
        if r.get(key):
            out[key] = r[key]
    out.update({k: v for k, v in extra.items() if v is not None})
    return out


def _page_try(port: int, code: str, inputs: str, mocks: str, title: str | None) -> dict | None:
    """The page's experiment, or None (with no side effect) when no page on ``port`` shows a file of the repo."""
    command: dict[str, Any] = {"action": "scratchpad", "op": "experiment", "code": code}
    if inputs.strip():
        command["inputs"] = inputs
    if mocks.strip():
        command["mocks"] = mocks
    if title:
        command["title"] = title
    try:
        status, body = http_json(port, "/api/command", command, timeout=EXPERIMENT_TIMEOUT_S)
    except (OSError, ValueError) as exc:
        return {"refused": "the page did not answer: %s" % exc}
    if status != 200 or not isinstance(body, dict) or body.get("error"):
        return {"refused": str((body or {}).get("error") if isinstance(body, dict) else "HTTP %d" % status)}
    state = body.get("result") if isinstance(body.get("result"), dict) else {}
    out = _shape(state.get("result"), "page", status=state.get("status"), title=state.get("title"), id=state.get("id"), command=command)
    if state.get("status") != "completed" and not out["error"]:
        out["error"] = {"type": "ScratchError", "message": str(state.get("error") or "the experiment did not complete (status %s)" % state.get("status")), "stage": "page"}
    return out


def run_try(code: str, inputs: Any, mocks: Any, repo: str, page_port: int | None, *, title: str | None = None) -> dict:
    """Run ``code`` as a reproduction: on the page when one is open on ``page_port`` (``$PYOKKA_PORT`` or 4777 when None;
    ``0`` skips the page) and shows a file of ``repo``, else headless in the sandbox. ``inputs`` and ``mocks`` are source
    text or ``{name: expression}`` objects."""
    inputs_text, mocks_text = inputs_source(inputs), mocks_source(mocks)
    note = None
    if page_port not in (0, False):
        port = default_port(page_port)
        state = page_state(port)
        if page_is_open(state) and _under(state.get("file") if state else None, repo):
            answer = _page_try(port, code, inputs_text, mocks_text, title)
            if answer is not None and "refused" not in answer:
                return answer
            note = "the page on port %d refused the experiment (%s); ran headless" % (port, (answer or {}).get("refused"))
    file = entry_file(repo)
    if file is None:
        return _shape({"error": {"type": "ScratchError", "message": "no Python file at the root of %s to run the experiment beside" % repo, "stage": "setup"}}, "sandbox", note=note)
    try:
        result = sandbox_run({"file": file, "code": code, "inputs": inputs_text, "mocks": mocks_text})
    except ScratchError as exc:
        return _shape({"error": {"type": "ScratchError", "message": str(exc), "stage": "setup"}}, "sandbox", note=note)
    return _shape(result, "sandbox", note=note, file=file)


__all__ = ["entry_file", "inputs_source", "mocks_source", "run_try"]
