"""Which VS Code window ``pyokka debug`` and ``pyokka review`` were invoked from (``src/agent/windowFile.ts``).

``code --open-url`` gives the URI to the focused window, which is the wrong one as soon as the person has
clicked into another window while the agent works. VS Code routes a URI carrying ``windowId=N`` to window N,
and every window with Pyokka active writes ``$PYOKKA_HOME/windows/<extension host pid>.json`` with its N and
its folders. The window, in order:

1. ``terminal``: ``$PYOKKA_VSCODE_PID``, which the window puts in its integrated terminals' env.
2. ``process``: an ancestor of this process is a window's extension host (an agent an extension spawned).
3. ``folder``: the one window whose deepest folder holds the program (or the cwd of a module launch).

None of them: no ``windowId``, and VS Code picks the focused window as before.

No VS Code running at all: ``launch_window`` opens the program's repository (or the launch cwd) in VS Code
and waits for that window's file, so the URI has a window to go to; each way that can fail is said.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from typing import Any

from ..home import pyokka_home
from .live import pid_alive

WINDOWS_ENV = "PYOKKA_WINDOWS_DIR"
WINDOW_PID_ENV = "PYOKKA_VSCODE_PID"


def windows_dir() -> str:
    return os.environ.get(WINDOWS_ENV) or os.path.join(pyokka_home(), "windows")


def list_windows(directory: str | None = None) -> list[dict]:
    """The window files whose extension host is alive."""
    directory = directory or windows_dir()
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return []
    out = []
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(directory, name), "r", encoding="utf-8") as fh:
                doc = json.load(fh)
        except (OSError, ValueError):
            continue
        if isinstance(doc, dict) and pid_alive(doc.get("pid")):
            out.append(doc)
    return out


def ancestor_pids(pid: int | None = None) -> list[int]:
    """This process's parent, its parent, and so on; empty where ``ps`` cannot say."""
    if os.name != "posix":
        return []
    try:
        listing = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], check=False, capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    parent: dict[int, int] = {}
    for line in listing.splitlines():
        fields = line.split()
        if len(fields) == 2 and fields[0].isdigit() and fields[1].isdigit():
            parent[int(fields[0])] = int(fields[1])
    out: list[int] = []
    current = os.getpid() if pid is None else pid
    while current in parent and parent[current] > 1 and len(out) < 64:
        current = parent[current]
        out.append(current)
    return out


def _holds(folder: str, target: str) -> int:
    """How deep ``folder`` is when it holds ``target`` (a longer path is a nearer folder), else -1."""
    try:
        folder, target = os.path.realpath(folder), os.path.realpath(target)
    except (OSError, ValueError):
        return -1
    if target == folder or target.startswith(folder.rstrip(os.sep) + os.sep):
        return len(folder)
    return -1


def invoking_window(launch: dict, *, directory: str | None = None, ancestors: list[int] | None = None) -> tuple[dict | None, str | None]:
    """``(window, how)``: the window this command was invoked from, and which rule found it; ``(None, None)`` if none did."""
    windows = [w for w in list_windows(directory) if isinstance(w.get("pid"), int)]
    if not windows:
        return None, None
    by_pid = {w["pid"]: w for w in windows}
    env_pid = os.environ.get(WINDOW_PID_ENV, "")
    if env_pid.isdigit() and int(env_pid) in by_pid:
        return by_pid[int(env_pid)], "terminal"
    for pid in ancestor_pids() if ancestors is None else ancestors:
        if pid in by_pid:
            return by_pid[pid], "process"
    target = launch.get("program") or launch.get("cwd")
    if not target:
        return None, None
    depth: dict[int, int] = {}
    for w in windows:
        folders: Any = w.get("folders")
        best = max([_holds(str(f), str(target)) for f in folders] if isinstance(folders, list) else [-1], default=-1)
        if best >= 0:
            depth[w["pid"]] = best
    if not depth:
        return None, None
    deepest = max(depth.values())
    nearest = [pid for pid, d in depth.items() if d == deepest]
    return (by_pid[nearest[0]], "folder") if len(nearest) == 1 else (None, None)


#: how long a VS Code started from cold has to open its window and activate Pyokka
LAUNCH_TIMEOUT_S = 30.0
POLL_INTERVAL_S = 0.2


def vscode_running() -> bool:
    """Whether a VS Code process runs; True when ``ps`` cannot say, so nothing is launched on a guess."""
    if os.name != "posix":
        return True
    try:
        proc = subprocess.run(["ps", "-A", "-o", "comm="], check=False, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return True
    if proc.returncode != 0:
        return True
    for line in proc.stdout.splitlines():
        name = line.strip()
        if ".app/Contents/MacOS/" in name and "Visual Studio Code" in name:
            return True  # macOS: the app's own binary (Electron, or Code in newer builds), not its helpers' names
        if os.path.basename(name) == "code":
            return True  # Linux
    return False


def project_folder(launch: dict) -> str:
    """The folder to open for a launch: the git repository holding the program, else the program's directory or the cwd."""
    start = os.path.dirname(str(launch["program"])) if launch.get("program") else str(launch.get("cwd") or os.getcwd())
    try:
        top = subprocess.run(["git", "-C", start, "rev-parse", "--show-toplevel"], check=False, capture_output=True, text=True, timeout=5)
        if top.returncode == 0 and top.stdout.strip():
            return top.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        pass
    return start


def launch_window(command: str, launch: dict, *, timeout: float | None = None, directory: str | None = None) -> dict:
    """Start VS Code on the launch's folder and return the window file it writes; raise saying what went wrong."""
    from .source import AgentError

    folder = project_folder(launch)
    try:
        proc = subprocess.run([command, folder], check=False, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise AgentError("no VS Code window is open, and starting VS Code failed: cannot run %s: %s" % (command, exc), "open VS Code on %s yourself, or set PYOKKA_CODE to a working VS Code launcher, then start again" % folder) from None
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()[-400:]
        raise AgentError("no VS Code window is open, and `%s %s` failed (exit %d)%s" % (command, folder, proc.returncode, ": " + detail if detail else ""), "open VS Code on %s yourself, or set PYOKKA_CODE to a working VS Code launcher, then start again" % folder)
    timeout = LAUNCH_TIMEOUT_S if timeout is None else timeout
    target = launch.get("program") or folder
    deadline = time.time() + timeout
    while time.time() < deadline:
        window, how = invoking_window({"program": target}, directory=directory, ancestors=[])
        if window is not None:
            return window
        time.sleep(POLL_INTERVAL_S)
    raise AgentError(
        "no VS Code window was open, so Pyokka started VS Code on %s, but no window with Pyokka active appeared within %ds" % (folder, int(timeout)),
        "look at VS Code: a first start may ask whether to trust the folder, and Pyokka activates only once it is trusted; check that the Pyokka extension is installed and enabled, then start again",
    )


__all__ = ["LAUNCH_TIMEOUT_S", "WINDOWS_ENV", "WINDOW_PID_ENV", "ancestor_pids", "invoking_window", "launch_window", "list_windows", "project_folder", "vscode_running", "windows_dir"]
