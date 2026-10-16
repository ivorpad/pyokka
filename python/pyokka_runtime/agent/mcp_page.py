"""``pyokka_page``: the browser page (docs/WEB.md) as an MCP tool.

``open`` starts the page's bridge (``node <dist>/web/server.js FILE --port N``, the one ``pyokka
web`` runs) as a child of this server and waits until it listens; ``close`` stops a page this
server started; ``list`` names them. Every other action is one agent command, sent the way ``pyokka
web ctl`` sends it: ``GET /api/state`` for ``state``, else ``POST /api/command`` with the command's
JSON. The answer is the bridge's JSON; an HTTP error or an ``error`` in the reply is an error
result. The page needs exactly one browser tab open on the URL ``open`` returns.
"""

from __future__ import annotations

import atexit
import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from typing import Any

from .source import AgentError
from .web import DEFAULT_PORT, find_server, listening, node_command

PAGE_ACTIONS = ("open", "close", "list", "state", "goto", "step", "line", "say", "clear", "start", "stop", "run", "eval", "var", "why", "watch", "breakpoint", "debug", "story", "profile", "peek", "wait_pause", "values", "definition")
STEP_KINDS = ("next", "into", "over", "out", "back", "backOver", "backOut")
DEBUG_OPS = ("start", "continue", "step", "pause", "stop", "state")
WAIT_PAUSE_MAX_MS = 25_000
OPEN_TIMEOUT_S = 15.0

#: the pages this server started, by port: {"proc", "file", "url", "log"}
STARTED: dict[int, dict] = {}


def close_pages() -> None:
    """Stop every page this server started (the server is ending)."""
    for page in STARTED.values():
        if page["proc"].poll() is None:
            page["proc"].terminate()
    STARTED.clear()


atexit.register(close_pages)


def _port(a: dict) -> int:
    v = a.get("port")
    port = int(os.environ.get("PYOKKA_PORT") or DEFAULT_PORT) if v in (None, "") else v
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise AgentError("port must be 1 to 65535, got %r" % (v,))
    return port


def _int(a: dict, key: str, low: int = 0) -> int | None:
    v = a.get(key)
    if v is None or v == "":
        return None
    if not isinstance(v, int) or isinstance(v, bool) or v < low:
        raise AgentError("%s must be an integer of at least %d" % (key, low))
    return v


def _str(a: dict, key: str) -> str | None:
    v = a.get(key)
    if v is None or v == "":
        return None
    if not isinstance(v, str):
        raise AgentError("%s must be a string" % key)
    return v


def _need(v: Any, action: str, key: str, example: str) -> Any:
    if v is None:
        raise AgentError("%s needs `%s`" % (action, key), "e.g. %s" % example)
    return v


def page_command(a: dict) -> dict:
    """The agent command (web/bridgeProtocol.ts ``AgentCommand``) of an action other than open, close and list."""
    action = str(a.get("action") or "")
    say = _str(a, "say")
    out: dict[str, Any]
    if action in ("state", "clear", "start", "stop", "run", "story", "profile", "values"):
        out = {"action": action}
    elif action == "goto":
        out = {"action": action, "step": _need(_int(a, "step"), "goto", "step", '{"action": "goto", "step": 12}'), "say": say}
    elif action == "step":
        kind = _str(a, "kind") or "into"
        if kind not in STEP_KINDS:
            raise AgentError("step kind is one of " + ", ".join(STEP_KINDS))
        out = {"action": action, "kind": kind, "say": say}
    elif action == "line":
        out = {"action": action, "line": _need(_int(a, "line", 1), "line", "line", '{"action": "line", "line": 12}'), "file": _str(a, "file"), "say": say}
    elif action == "say":
        out = {"action": action, "text": _need(_str(a, "text"), "say", "text", '{"action": "say", "text": "total is 0 here", "line": 12}'), "line": _int(a, "line", 1), "step": _int(a, "step")}
    elif action == "eval":
        out = {"action": action, "expression": _need(_str(a, "expression"), "eval", "expression", '{"action": "eval", "expression": "len(items)"}')}
    elif action == "var":
        out = {"action": action, "name": _need(_str(a, "name"), "var", "name", '{"action": "var", "name": "total"}')}
    elif action == "why":
        out = {"action": action, "name": _str(a, "name") or "", "step": _int(a, "step")}
    elif action == "peek":
        out = {"action": action, "name": _str(a, "name") or ""}
    elif action == "watch":
        out = {"action": action, "exp": _need(_str(a, "expression"), "watch", "expression", '{"action": "watch", "expression": "total * 2"}'), "remove": True if a.get("remove") is True else None}
    elif action == "breakpoint":
        out = {"action": action, "line": _need(_int(a, "line", 1), "breakpoint", "line", '{"action": "breakpoint", "line": 12, "on": true}'), "on": a.get("on") if isinstance(a.get("on"), bool) else None, "condition": _str(a, "condition")}
    elif action == "debug":
        op = _str(a, "op") or "state"
        if op not in DEBUG_OPS:
            raise AgentError("debug op is one of " + ", ".join(DEBUG_OPS))
        kind = _str(a, "kind")
        if op == "step" and kind is not None and kind not in ("into", "over", "out"):
            raise AgentError("debug step kind is into, over or out")
        out = {"action": action, "op": op, **({"kind": kind or "over"} if op == "step" else {}), "say": say}
    elif action == "definition":
        out = {"action": action, "line": _need(_int(a, "line", 1), "definition", "line", '{"action": "definition", "line": 12, "column": 5}'), "column": _need(_int(a, "column", 1), "definition", "column", '{"action": "definition", "line": 12, "column": 5}')}
    elif action == "wait_pause":
        timeout = _int(a, "timeout_ms")
        if timeout is not None and timeout > WAIT_PAUSE_MAX_MS:
            raise AgentError("timeout_ms is at most %d" % WAIT_PAUSE_MAX_MS)
        out = {"action": "waitPause", "after": _int(a, "after"), "timeoutMs": timeout}
    else:
        raise AgentError("unknown page action %r" % action, "one of " + ", ".join(PAGE_ACTIONS))
    expect = a.get("expect")
    if expect is not None:
        if not isinstance(expect, dict):
            raise AgentError("expect must be an object: source, runId, step, frame, file")
        out["expect"] = expect
    return {k: v for k, v in out.items() if v is not None}


def _http(port: int, command: dict, timeout: float) -> tuple[int, Any]:
    base = "http://127.0.0.1:%d" % port
    if command["action"] == "state":
        req = urllib.request.Request(base + "/api/state")
    else:
        req = urllib.request.Request(base + "/api/command", data=json.dumps(command).encode("utf-8"), headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, json.loads(res.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(body)
        except ValueError:
            return exc.code, {"error": body.strip() or exc.reason}


def _open(a: dict) -> tuple[str, bool]:
    file = os.path.abspath(_need(_str(a, "file"), "open", "file", '{"action": "open", "file": "/abs/path/demo.py"}'))
    if not os.path.isfile(file):
        raise AgentError("no file %s" % file, "give the absolute path of a Python file")
    cwd = os.path.abspath(str(a["cwd"])) if _str(a, "cwd") else None
    if cwd and not os.path.isdir(cwd):
        raise AgentError("no directory %s" % cwd, "cwd is the project folder the run starts in, given as an absolute path")
    port = _port(a)
    if listening(port):
        raise AgentError("port %d is taken, most likely by another page" % port, '{"action": "state", "port": %d} names its file; pass another port' % port)
    node, node_env = node_command()
    argv = [node, find_server(), file, "--port", str(port)]
    if a.get("no_watch") is True:
        argv.append("--no-watch")
    if _str(a, "python"):
        argv += ["--python", str(a["python"])]
    if cwd:
        argv += ["--cwd", cwd]
    from ..home import pyokka_home

    log = os.path.join(pyokka_home(), "page-%d.log" % port)
    os.makedirs(os.path.dirname(log), exist_ok=True)
    with open(log, "w", encoding="utf-8") as fh:
        proc = subprocess.Popen(argv, stdout=fh, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, cwd=os.path.dirname(file), env={**os.environ, **node_env})
    deadline = time.time() + OPEN_TIMEOUT_S
    while time.time() < deadline and proc.poll() is None and not listening(port, 0.2):
        time.sleep(0.1)
    if proc.poll() is not None or not listening(port, 0.2):
        proc.terminate()
        with open(log, encoding="utf-8", errors="replace") as fh:
            tail = fh.read()[-1500:]
        raise AgentError("the page did not start on port %d" % port, tail.strip() or "see %s" % log)
    url = "http://127.0.0.1:%d/" % port
    STARTED[port] = {"proc": proc, "file": file, "url": url, "log": log}
    return json.dumps({"opened": True, "url": url, "file": file, "port": port, "pid": proc.pid, "next": "open the URL in one browser tab, then {\"action\": \"state\", \"port\": %d}" % port}, indent=1) + "\n", False


def call_page(a: dict) -> tuple[str, bool]:
    action = str(a.get("action") or "")
    if action == "open":
        return _open(a)
    if action == "close":
        port = _port(a)
        page = STARTED.pop(port, None)
        if page is None:
            raise AgentError("this server started no page on port %d" % port, "list names the pages it started; a page started elsewhere stops with Ctrl+C there")
        page["proc"].terminate()
        try:
            page["proc"].wait(5)
        except subprocess.TimeoutExpired:
            page["proc"].kill()
        return json.dumps({"closed": True, "port": port, "file": page["file"]}) + "\n", False
    if action == "list":
        pages = [{"port": p, "file": v["file"], "url": v["url"], "pid": v["proc"].pid, "running": v["proc"].poll() is None} for p, v in sorted(STARTED.items())]
        return json.dumps({"pages": pages}, indent=1) + "\n", False
    command = page_command(a)
    port = _port(a)
    if not listening(port):
        raise AgentError("no Pyokka page is served on 127.0.0.1:%d" % port, '{"action": "open", "file": "/abs/demo.py"} starts one')
    timeout = (command.get("timeoutMs") or 10_000) / 1000 + 10 if command["action"] == "waitPause" else 60
    status, body = _http(port, command, timeout)
    failed = status != 200 or not isinstance(body, dict) or bool(body.get("error"))
    return json.dumps(body, ensure_ascii=False, indent=1) + "\n", failed


SCRATCH_OPS = ("open", "experiment", "create", "state", "update", "run", "restore", "close", "save", "list", "load", "history", "say")


def scratchpad_command(a: dict) -> dict:
    """``pyokka_scratchpad``'s arguments as the page's ``scratchpad`` command (web/scratchpadProtocol.ts)."""
    op = _str(a, "op") or "state"
    if op not in SCRATCH_OPS:
        raise AgentError("scratchpad op is one of " + ", ".join(SCRATCH_OPS))
    out: dict[str, Any] = {"action": "scratchpad", "op": op, "id": _str(a, "id"), "title": _str(a, "title"), "version": _int(a, "version", 1), "line": _int(a, "line", 1), "code": _str(a, "code")}
    for key in ("inputs", "mocks"):
        v = a.get(key)
        if v is None or v == "":
            continue
        if isinstance(v, dict) and all(isinstance(k, str) and isinstance(x, str) for k, x in v.items()):
            out[key] = v
        elif isinstance(v, str):
            out[key] = v
        else:
            raise AgentError("%s is Python source text, or an object of name -> Python expression (both strings)" % key, '{"inputs": {"items": "[1, 2, 3]"}, "mocks": {"shop.fetch_price": "9.5"}}')
    if isinstance(a.get("auto_run"), bool):
        out["autoRun"] = a["auto_run"]
    if op == "say":
        text = a.get("text", "")
        if not isinstance(text, str):
            raise AgentError("say's text is a string; an empty one clears the bubble", '{"op": "say", "text": "this loop sums the prices", "line": 3}')
        out["text"] = text
    if op == "experiment" and not out["code"]:
        raise AgentError("experiment needs `code`", '{"op": "experiment", "code": "result = total(items)"}')
    if op == "load" and not out["id"]:
        raise AgentError("load needs `id`", '{"op": "list"} names the saved scratchpads')
    expect = a.get("expect")
    if expect is not None:
        if not isinstance(expect, dict):
            raise AgentError("expect must be an object: source, runId, step, frame, file")
        out["expect"] = expect
    return {k: v for k, v in out.items() if v is not None}


def call_scratchpad(a: dict) -> tuple[str, bool]:
    """One scratchpad command to the page on ``port`` (``list`` and ``history`` answer with no tab open)."""
    command = scratchpad_command(a)
    port = _port(a)
    if not listening(port):
        raise AgentError("no Pyokka page is served on 127.0.0.1:%d" % port, 'pyokka_page {"action": "open", "file": "/abs/demo.py"} starts one')
    status, body = _http(port, command, 60)
    result = body.get("result") if isinstance(body, dict) else None
    failed = status != 200 or not isinstance(body, dict) or bool(body.get("error"))
    if not failed and command["op"] in ("run", "experiment") and isinstance(result, dict) and result.get("status") != "completed":
        failed = True
    return json.dumps(body, ensure_ascii=False, indent=1) + "\n", failed


__all__ = ["call_page", "call_scratchpad", "scratchpad_command", "SCRATCH_OPS", "page_command", "close_pages", "PAGE_ACTIONS", "STEP_KINDS", "DEBUG_OPS"]
