"""``PYOKKA_HOME``: one directory for sessions, the relaunch memory and the cache."""

from __future__ import annotations

import os

from pyokka_runtime import cache
from pyokka_runtime.agent import live, relaunch
from pyokka_runtime.home import pyokka_home


def test_unset_or_empty_is_dot_pyokka_in_the_user_home():
    default = os.path.join(os.path.expanduser("~"), ".pyokka")
    assert pyokka_home({}) == default
    assert pyokka_home({"PYOKKA_HOME": ""}) == default


def test_set_is_used_as_an_absolute_path_with_tilde_expanded(tmp_path):
    assert pyokka_home({"PYOKKA_HOME": str(tmp_path)}) == str(tmp_path)
    assert pyokka_home({"PYOKKA_HOME": "~/pk-home"}) == os.path.join(os.path.expanduser("~"), "pk-home")
    assert pyokka_home({"PYOKKA_HOME": "rel/home"}) == os.path.abspath("rel/home")


def test_sessions_memory_and_cache_follow_it(tmp_path, monkeypatch):
    monkeypatch.setenv("PYOKKA_HOME", str(tmp_path))
    monkeypatch.delenv("PYOKKA_SESSIONS_DIR", raising=False)
    monkeypatch.delenv("PYOKKA_CACHE_DIR", raising=False)
    assert live.sessions_dir() == str(tmp_path / "sessions")
    assert relaunch.memory_path() == str(tmp_path / "last-debug.json")
    assert cache.cache_dir() == str(tmp_path / "cache")


def test_the_narrower_variables_still_win(tmp_path, monkeypatch):
    monkeypatch.setenv("PYOKKA_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("PYOKKA_SESSIONS_DIR", str(tmp_path / "s"))
    monkeypatch.setenv("PYOKKA_CACHE_DIR", str(tmp_path / "c"))
    assert live.sessions_dir() == str(tmp_path / "s")
    assert cache.cache_dir() == str(tmp_path / "c")
