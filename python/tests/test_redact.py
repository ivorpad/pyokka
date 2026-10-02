from __future__ import annotations

import json
from pathlib import Path

import pytest

from pyokka_runtime.redact import REDACTED, redact, redact_value

FIXTURE = Path(__file__).resolve().parents[2] / "test" / "unit" / "fixtures" / "redact.json"
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("given,expected", CASES, ids=[c[0][:30] for c in CASES])
def test_fixture_cases(given, expected):
    assert redact(given) == expected


def test_source_lines_keep_calls_but_not_literals():
    # a call is code, not a secret; a literal or a bare value still goes
    assert redact('api_key = getenv("OPENAI_API_KEY")') == 'api_key = getenv("OPENAI_API_KEY")'
    assert redact("self.api_key = os.environ.get('X')") == "self.api_key = os.environ.get('X')"
    assert redact('api_key = "sk-proj-abcdefghijklmnopqrstuvwx"') == 'api_key = "%s"' % REDACTED
    assert redact("password=hunter2") == "password=%s" % REDACTED


def test_redact_is_idempotent():
    for given, expected in CASES:
        assert redact(expected) == expected


def test_redact_value_walks_text_fields_only():
    event = {
        "type": "log",
        "text": "sk-abcdefghijklmnopqrstuvwxyz012345",
        "runtimeKey": "AKIAIOSFODNN7EXAMPLE",
        "steps": "AKIAIOSFODNN7EXAMPLE",
        "valueBag": {"data": {"value": "password=hunter2", "props": [{"name": "k", "value": "ghp_abcdefghijklmnopqrstuvwxyz0123456789"}]}},
    }
    redact_value(event)
    assert event["text"] == REDACTED
    assert event["runtimeKey"] == "AKIAIOSFODNN7EXAMPLE" and event["steps"] == "AKIAIOSFODNN7EXAMPLE"
    assert event["valueBag"]["data"]["value"] == "password=" + REDACTED
    assert event["valueBag"]["data"]["props"][0]["value"] == REDACTED
