"""How a run child is made per platform, and what to say when one dies from a signal.

The runner (``runner.py``) makes a child per run: ``os.fork`` on POSIX, so the child starts
warm, or a fresh interpreter (``subprocess``, "spawn"). On macOS the default is spawn.
Forking there worked once per runner: after a run the parent has threads (the pipe readers,
the waiter, the timeout timer), and macOS then aborts any later fork child the moment it
initialises an Objective-C class the parent had not (``objc_initializeAfterForkError``,
SIGABRT, exit -6). User code gets there at once: building an ``httpx`` client (its proxy
lookup runs ``urllib.request.getproxies()``, SystemConfiguration, ``+[NSCharacterSet
initialize]``), ``getproxies()`` itself (``+[NSNumber initialize]``), a TLS handshake verified
by ``truststore``. The openai SDK does the first when the client is constructed, so a file
that called an API ran once and every later run died with nothing to show, HTTP Replay
included. A fresh interpreter per run costs about 35 ms more than a fork (interpreter start
plus the runtime's imports; user imports are cold either way) and has no such rule.

``PYOKKA_SPAWN=1`` forces spawn everywhere. ``PYOKKA_FORK=1`` forces fork on macOS for whoever
wants the warm child back; that is only safe with ``OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES``
in the runner's environment (the objc runtime reads it at process start). The runner's own
threads never enter Objective-C, so the check is a false positive for this parent, but
switching Apple's check off is the user's call, not the default.
"""

from __future__ import annotations

import os
import signal
import sys
from typing import Mapping

FORK_VAR = "PYOKKA_FORK"
SPAWN_VAR = "PYOKKA_SPAWN"
OBJC_VAR = "OBJC_DISABLE_INITIALIZE_FORK_SAFETY"


def use_fork(environ: Mapping[str, str], platform: str, can_fork: bool = hasattr(os, "fork")) -> bool:
    """Fork on Linux and the other POSIX platforms; a fresh interpreter on macOS (and where there is no fork)."""
    if not can_fork or environ.get(SPAWN_VAR) == "1":
        return False
    if platform == "darwin":
        return environ.get(FORK_VAR) == "1"
    return True


def signal_death(exit_code: int, *, environ: Mapping[str, str] | None = None, platform: str | None = None, use_fork: bool = True) -> tuple[str, str]:
    """Message and detail of the ``runner.error`` for a child that died from a signal (a negative
    exit code) without reporting ``child.done``; never for a timeout or a stop."""
    env = os.environ if environ is None else environ
    plat = sys.platform if platform is None else platform
    try:
        name = signal.Signals(-exit_code).name
    except ValueError:
        name = "signal %d" % -exit_code
    message = "run child killed by %s (exit %d) before it finished: no values, trace or error were recorded" % (name, exit_code)
    if plat == "darwin" and use_fork and env.get(OBJC_VAR) != "YES":
        detail = "The runner was forced into fork mode (%s=1) and macOS aborts a forked child that initialises an Apple framework class once the parent has had threads. Unset %s, or set %s=YES for the runner." % (FORK_VAR, FORK_VAR, OBJC_VAR)
    elif use_fork:
        detail = "The program or a C extension it uses crashed (os.abort(), a segmentation fault, an assertion in native code). Run the file with python directly to see the native error; %s=1 runs every file in a fresh interpreter if it happens only under Pyokka." % SPAWN_VAR
    else:
        detail = "The program or a C extension it uses crashed (os.abort(), a segmentation fault, an assertion in native code). Run the file with python directly to see the native error."
    return message, detail
