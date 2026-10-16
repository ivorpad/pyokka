"""``pyokka web``: the browser page (docs/WEB.md) from this runtime's own install, so an agent needs no checkout.

The page's bridge is ``web/server.js``, which esbuild writes next to the runtime: ``<ext>/dist/web``
beside ``<ext>/dist/python`` in an installed extension, ``<repo>/dist/web`` after ``node esbuild.mjs``
in a checkout. It runs under ``node``, else under the Node inside VS Code (its Electron binary with
``ELECTRON_RUN_AS_NODE=1``, as VS Code's own ``code`` command runs); every argument goes to the bridge:

    pyokka web FILE [--port N] [--cwd DIR] [--open] [--no-watch] [--verbose] [--python PATH]
    pyokka web ctl [--port N] state | step over --say TEXT | debug start | ...

The bridge prints its own JSON; this module adds only the errors an agent hits before the bridge
can answer: no build, no ``node``, a taken port, nothing served on the port, and a sandbox that
blocks the connection (which would otherwise look like nothing served).
"""

from __future__ import annotations

import os
import plistlib
import shutil
import socket
import sys

from .source import AgentError

DEFAULT_PORT = 4777
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # .../pyokka_runtime


def server_candidates(runtime_dir: str = HERE) -> list[str]:
    """An installed extension's ``dist/web`` (the runtime is ``dist/python/pyokka_runtime``), then a checkout's build (``python/pyokka_runtime``)."""
    dist = os.path.dirname(os.path.dirname(runtime_dir))
    return [os.path.join(dist, "web", "server.js"), os.path.join(dist, "dist", "web", "server.js")]


def find_server(runtime_dir: str = HERE) -> str:
    found = next((p for p in server_candidates(runtime_dir) if os.path.isfile(p)), None)
    if found:
        return found
    root = os.path.dirname(os.path.dirname(runtime_dir))
    if os.path.isfile(os.path.join(root, "web", "server.ts")):
        raise AgentError("the browser page is not built in this checkout", "run `node esbuild.mjs` in %s; it writes dist/web/server.js" % root)
    raise AgentError("this pyokka install has no browser page (no web/server.js next to %s)" % os.path.dirname(runtime_dir), "update the Pyokka extension, or run `node <checkout>/dist/web/server.js FILE` from a built checkout")


def port_of(args: list[str], env: dict | None = None) -> int:
    """``--port N``, else ``$PYOKKA_PORT``, else 4777: the bridge's own rule."""
    env = os.environ if env is None else env
    if "--port" in args:
        i = args.index("--port")
        try:
            return int(args[i + 1])
        except (IndexError, ValueError):
            raise AgentError("--port wants a number", "e.g. `pyokka web demo.py --port 4790`") from None
    return int(env.get("PYOKKA_PORT") or DEFAULT_PORT)


VSCODE_APPS = ("/Applications/Visual Studio Code.app", os.path.expanduser("~/Applications/Visual Studio Code.app"))
NO_NODE = ("the page's bridge runs under node, and neither node on PATH nor VS Code's own Node was found", "install Node.js 20 or newer (https://nodejs.org), or put its bin directory on PATH")


def vscode_node(env: dict | None = None) -> str | None:
    """The Electron binary of the VS Code that ``$PYOKKA_CODE`` (the ``pyokka`` script sets it), ``code`` on PATH or
    the usual app folders name: it runs as Node with ``ELECTRON_RUN_AS_NODE=1``.

    macOS: the launcher is ``<App>.app/Contents/Resources/app/bin/code`` and the binary is ``Contents/MacOS/``
    plus ``CFBundleExecutable`` (``Code``, ``Cursor``, ``Code - Insiders``). Linux: ``<root>/bin/code`` beside ``<root>/code``.
    """
    env = os.environ if env is None else env
    launchers = [env.get("PYOKKA_CODE"), shutil.which("code", path=env.get("PATH"))]
    launchers += [os.path.join(app, "Contents", "Resources", "app", "bin", "code") for app in VSCODE_APPS]
    marker = os.path.join(os.sep + "Contents", "Resources", "app", "bin") + os.sep
    for launcher in launchers:
        if not launcher or not os.path.exists(launcher):
            continue
        real = os.path.realpath(launcher)
        i = real.find(marker)
        if i >= 0:
            contents = real[: i + len(os.sep + "Contents")]
            try:
                with open(os.path.join(contents, "Info.plist"), "rb") as fh:
                    name = plistlib.load(fh).get("CFBundleExecutable")
            except (OSError, ValueError, plistlib.InvalidFileException):
                name = None
            exe = os.path.join(contents, "MacOS", name) if isinstance(name, str) and name else None
        else:
            exe = os.path.join(os.path.dirname(os.path.dirname(real)), os.path.basename(real))
        if exe and exe != real and os.path.isfile(exe) and os.access(exe, os.X_OK):
            return exe
    return None


def node_command(env: dict | None = None) -> tuple[str, dict[str, str]]:
    """What runs the bridge, and the environment it adds: ``node`` on PATH, else VS Code's Electron as Node."""
    env = os.environ if env is None else env
    node = shutil.which("node", path=env.get("PATH"))
    if node:
        return node, {}
    electron = vscode_node(env)
    if electron:
        return electron, {"ELECTRON_RUN_AS_NODE": "1"}
    raise AgentError(*NO_NODE)


BLOCKED = "the connection to 127.0.0.1:%d was refused by the system (%s), not by a server: a sandbox without network access blocks it, whether or not a page is open"
BLOCKED_HINT = "run this outside the sandbox (in Codex, with network access); inside it every port looks closed"


def listening(port: int, timeout: float = 1.0) -> bool:
    """Whether something answers on 127.0.0.1:``port``. A connection the system itself refuses
    (``PermissionError``: a sandbox without network access) raises instead, since "no page" would be a guess."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except PermissionError as exc:
        raise AgentError(BLOCKED % (port, exc.strerror or "Operation not permitted"), BLOCKED_HINT) from None
    except OSError:
        return False


def web_main(args: list[str]) -> int:
    """Run the bridge with ``args``; serving replaces this process, so Ctrl+C stops the bridge."""
    try:
        server = find_server()
        node, node_env = node_command()
        if args[:1] in (["-h"], ["--help"]):
            sys.stdout.write("pyokka web is the browser page's bridge, %s; `pyokka-web` below is the same command.\n" % server)
            sys.stdout.flush()
        elif args[:1] == ["ctl"]:
            port = port_of(args)
            if not listening(port):
                raise AgentError("no Pyokka page is served on 127.0.0.1:%d" % port, "start one with `pyokka web FILE`%s" % ("" if "--port" in args else ", or pass the --port it was started with"))
        elif args:
            port = port_of(args)
            if listening(port):
                raise AgentError("port %d is taken, most likely by another page" % port, "`pyokka web ctl --port %d state` names its file; pass --port N, or set PYOKKA_PORT" % port)
    except AgentError as exc:
        sys.stderr.write("error: %s\n%s\n" % (exc.message, exc.hint or ""))
        return 2
    sys.stdout.flush()
    os.execve(node, [node, server, *args], {**os.environ, **node_env})
    return 0  # not reached


__all__ = ["web_main", "find_server", "server_candidates", "port_of", "listening", "node_command", "vscode_node", "DEFAULT_PORT"]
