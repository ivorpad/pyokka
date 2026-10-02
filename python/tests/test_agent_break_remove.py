"""`break --remove` takes a line or the name `--at NAME` set."""
from __future__ import annotations

import pytest

from pyokka_runtime.agent.commands import _remove_item
from pyokka_runtime.agent.source import AgentError


def test_a_line_and_a_function_name():
    assert _remove_item("demo.py:82") == {"file": "demo.py", "line": 82}
    assert _remove_item("rrf") == {"function": "rrf"}
    assert _remove_item("Ranker.rank") == {"function": "Ranker.rank"}


def test_anything_else_is_refused_with_both_forms_named():
    with pytest.raises(AgentError) as err:
        _remove_item("not a name")
    assert "FILE:LINE or a function name" in err.value.message
