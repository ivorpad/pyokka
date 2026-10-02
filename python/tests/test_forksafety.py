"""forksafety: the child-mode policy per platform and the signal-death message."""

from __future__ import annotations

import signal

from pyokka_runtime import forksafety as fs


def test_macos_spawns_by_default_and_forks_only_on_request():
    assert fs.use_fork({}, "darwin") is False
    assert fs.use_fork({"PYOKKA_FORK": "1"}, "darwin") is True
    assert fs.use_fork({"PYOKKA_FORK": "1", "PYOKKA_SPAWN": "1"}, "darwin") is False  # spawn wins


def test_linux_forks_unless_spawn_is_forced():
    assert fs.use_fork({}, "linux") is True
    assert fs.use_fork({"PYOKKA_SPAWN": "1"}, "linux") is False


def test_no_fork_where_the_platform_has_none():
    assert fs.use_fork({}, "linux", can_fork=False) is False
    assert fs.use_fork({"PYOKKA_FORK": "1"}, "win32", can_fork=False) is False


def test_signal_death_names_the_signal_and_hints_by_situation():
    message, detail = fs.signal_death(-signal.SIGABRT, environ={}, platform="darwin", use_fork=True)
    assert message.startswith("run child killed by SIGABRT (exit -6)")
    assert "PYOKKA_FORK" in detail and fs.OBJC_VAR in detail
    message, detail = fs.signal_death(-signal.SIGSEGV, environ={}, platform="linux", use_fork=True)
    assert "SIGSEGV" in message and "PYOKKA_SPAWN=1" in detail
    _, detail = fs.signal_death(-signal.SIGABRT, environ={}, platform="darwin", use_fork=False)
    assert "python directly" in detail and "PYOKKA_SPAWN" not in detail
    message, _ = fs.signal_death(-99, environ={}, platform="linux")
    assert "signal 99" in message
