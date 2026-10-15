"""``debug --configuration NAME``: a Python launch configuration of the workspace's ``.vscode/launch.json``.

The configuration becomes the flags ``debug FILE`` already takes: ``program`` or ``module``,
``args``, ``cwd``, ``env`` and ``envFile``, ``python``, ``stopOnEntry``, and ``justMyCode: false``
as ``--library-code``. The nearest ``.vscode/launch.json`` at or above the file, the ``--cwd`` or
the current directory is the one read. VS Code's own variables are substituted; keys Pyokka has no
use for are named in the answer instead of dropped without a word. Configurations of type
``debugpy`` and ``python`` are read.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

from .source import AgentError

PYTHON_TYPES = ("debugpy", "python")
#: the keys ``debug`` applies, and the ones that change nothing about the run
MAPPED = {"type", "request", "name", "program", "module", "args", "cwd", "env", "envFile", "python", "stopOnEntry", "justMyCode"}
HARMLESS = {"console", "purpose", "presentation", "internalConsoleOptions", "preLaunchTask", "postDebugTask", "redirectOutput", "showReturnValue", "logToFile", "autoReload", "clientOS"}
#: the interpreter VS Code picked for the window: what `debug` uses when no --python is given
WINDOW_PYTHON = "${command:python.interpreterPath}"

_VAR = re.compile(r"\$\{([^}]+)\}")


def parse_jsonc(text: str) -> Any:
    """JSON with ``//`` and ``/* */`` comments and trailing commas, as launch.json is written."""
    out: list[str] = []
    i, n, in_string = 0, len(text), False
    while i < n:
        c = text[i]
        if in_string:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 1
            elif c == '"':
                in_string = False
        elif c == '"':
            in_string = True
            out.append(c)
        elif text.startswith("//", i):
            while i < n and text[i] != "\n":
                i += 1
            continue
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end < 0 else end + 2
            continue
        else:
            out.append(c)
        i += 1
    return json.loads(re.sub(r",(\s*[}\]])", r"\1", "".join(out)))


def find_launch_json(start: str) -> str | None:
    d = os.path.abspath(start)
    while True:
        candidate = os.path.join(d, ".vscode", "launch.json")
        if os.path.isfile(candidate):
            return candidate
        up = os.path.dirname(d)
        if up == d:
            return None
        d = up


def dotenv(path: str) -> dict[str, str]:
    out: dict[str, str] = {}
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            m = re.match(r"^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$", line)
            if not m:
                continue
            v = m.group(2)
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            out[m.group(1)] = v
    return out


def launch_configuration(name: str, start: str, file: str | None = None) -> dict:
    """Configuration ``name`` as the flags ``debug`` runs with; ``file`` is the FILE given, for ``${file}``."""
    path = find_launch_json(start)
    if not path:
        raise AgentError("no .vscode/launch.json at or above %s" % start, "give the file and its flags instead, or pass --cwd inside the workspace")
    try:
        with open(path, encoding="utf-8") as fh:
            doc = parse_jsonc(fh.read())
    except (OSError, ValueError) as exc:
        raise AgentError("%s is not readable JSON: %s" % (path, exc)) from None
    configs = [c for c in (doc.get("configurations") if isinstance(doc, dict) else None) or [] if isinstance(c, dict)]
    config = next((c for c in configs if c.get("name") == name), None)
    if config is None:
        names = ", ".join(json.dumps(c.get("name")) for c in configs)
        raise AgentError("%s has no configuration named %s" % (path, json.dumps(name)), "its configurations: %s" % names if names else "it lists no configurations")
    if config.get("type") not in PYTHON_TYPES:
        raise AgentError("configuration %s is type %s" % (json.dumps(name), json.dumps(config.get("type"))), "Pyokka debugs Python: type debugpy or python")
    if (config.get("request") or "launch") != "launch":
        raise AgentError("configuration %s attaches to a running process" % json.dumps(name), "Pyokka starts the program itself: use a launch configuration")
    workspace = os.path.dirname(os.path.dirname(path))
    current = os.path.abspath(file) if file else None

    def sub(value: Any) -> str:
        def one(m: re.Match) -> str:
            key = m.group(1)
            if key in ("workspaceFolder", "workspaceRoot") or key.startswith("workspaceFolder:"):
                return workspace
            if key == "workspaceFolderBasename":
                return os.path.basename(workspace)
            if key == "userHome":
                return os.path.expanduser("~")
            if key == "cwd":
                return os.getcwd()
            if key in ("pathSeparator", "/"):
                return os.sep
            if key.startswith("env:"):
                return os.environ.get(key[4:], "")
            file_key = key.startswith("file") or key in ("relativeFile", "relativeFileDirname")
            if current and file_key:
                rel = os.path.relpath(current, workspace)
                return {
                    "file": current, "fileDirname": os.path.dirname(current), "fileBasename": os.path.basename(current),
                    "fileBasenameNoExtension": os.path.splitext(os.path.basename(current))[0], "fileExtname": os.path.splitext(current)[1],
                    "fileWorkspaceFolder": workspace, "relativeFile": rel, "relativeFileDirname": os.path.dirname(rel),
                }.get(key, m.group(0))
            if file_key:
                raise AgentError("configuration %s uses %s, which needs the FILE argument" % (json.dumps(name), m.group(0)), "pass the file as well as --configuration")
            raise AgentError("configuration %s uses %s, which needs VS Code to resolve" % (json.dumps(name), m.group(0)), "replace it in launch.json, or give the flags directly")

        return _VAR.sub(one, str(value))

    def absolute(p: str, base: str) -> str:
        return p if os.path.isabs(p) else os.path.normpath(os.path.join(base, p))

    cwd = absolute(sub(config["cwd"]), workspace) if isinstance(config.get("cwd"), str) else None
    env: dict[str, str] = {}
    env_file = config.get("envFile")
    # the Python extension reads ${workspaceFolder}/.env when envFile is not set
    env_path = absolute(sub(env_file), workspace) if isinstance(env_file, str) else os.path.join(workspace, ".env")
    if os.path.isfile(env_path):
        env.update(dotenv(env_path))
    for k, v in (config.get("env") or {}).items():
        if v is not None:
            env[str(k)] = sub(v)
    raw_args = config.get("args")
    args = [sub(a) for a in raw_args] if isinstance(raw_args, list) else sub(raw_args).split() if isinstance(raw_args, str) else []
    python = config.get("python")
    python = None if not isinstance(python, str) or python.strip() == WINDOW_PYTHON else sub(python)
    return {
        "file": path,
        "name": name,
        "program": absolute(sub(config["program"]), cwd or workspace) if isinstance(config.get("program"), str) else None,
        "module": sub(config["module"]) if isinstance(config.get("module"), str) else None,
        "args": args,
        "cwd": cwd,
        "env": env,
        "python": python,
        "stopOnEntry": config.get("stopOnEntry") is True,
        "libraryCode": config.get("justMyCode") is False,
        "ignored": [k for k in config if k not in MAPPED and k not in HARMLESS],
    }


def apply_configuration(args: Any) -> None:
    """Fill what the command line left out from ``--configuration NAME``; flags given win over it.

    The configuration's program or module wins over FILE (FILE still resolves ``${file}``).
    """
    name = getattr(args, "configuration", None)
    if not name or getattr(args, "_configuration", None):
        return
    program = getattr(args, "program", None)
    start = os.path.dirname(os.path.abspath(program)) if program else os.path.abspath(args.cwd) if getattr(args, "cwd", None) else os.getcwd()
    c = launch_configuration(str(name), start, program)
    if c["module"]:
        args.module, args.program = c["module"], None
    elif c["program"]:
        args.program = c["program"]
    if not (args.program or getattr(args, "module", None)):
        raise AgentError("configuration %s names no program or module" % json.dumps(c["name"]), "pass the file as well as --configuration")
    if not getattr(args, "args", None):
        args.args = c["args"]
    args.cwd = getattr(args, "cwd", None) or c["cwd"]
    args.python = getattr(args, "python", None) or c["python"]
    args.env = ["%s=%s" % kv for kv in c["env"].items()] + list(getattr(args, "env", None) or [])
    if c["stopOnEntry"]:
        args.stop_on_entry = True
    if c["libraryCode"]:
        args.library_code = True
    args._configuration = c


def configuration_line(c: dict) -> str:
    ignored = " (not applied: %s)" % ", ".join(c["ignored"]) if c.get("ignored") else ""
    return "configuration %s from %s%s" % (json.dumps(c["name"]), c["file"], ignored)


__all__ = ["parse_jsonc", "find_launch_json", "launch_configuration", "apply_configuration", "configuration_line"]
