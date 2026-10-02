"""Secret masking: provenance by name and by environment value, never by value shape."""

from __future__ import annotations

import os

from pyokka_runtime import secrets
from pyokka_runtime.protocol import LogLimitSet
from pyokka_runtime.secrets import MASK, SecretFilter, is_secret_name
from pyokka_runtime.serialize import serialize

LIMITS = LogLimitSet(5, 50, 100)
KEY = "sk-or-v1-2df2eb5c0ffee0ffee0ffee0ffee0ffee"


def props(node):
    return {p["name"]: p for p in node.get("props", [])}


def test_secret_names_by_word_not_by_substring():
    for name in ["api_key", "apiKey", "ADMIN_API_KEY", "OPENAI_API_KEY", "webhook_secret", "password", "PASSWD", "auth_token", "Authorization", "x-api-key", "client_secret", "private_key", "aws_secret_access_key", "DATABASE_DSN", "credentials"]:
        assert is_secret_name(name), name
    for name in ["key", "keys", "primary_key", "author", "keyword", "tokenizer", "authored_by", "name", "model", "", None, 3]:
        assert not is_secret_name(name), name


def test_extra_names_from_settings():
    f = SecretFilter(True, ["licence", "PIN_CODE"])
    assert f.secret_name("user_licence") and f.secret_name("pin") and f.secret_name("code")
    assert not SecretFilter(True).secret_name("licence")


def test_env_value_is_masked_wherever_it_appears(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", KEY)
    monkeypatch.setenv("HOME_TOWN", "Lisbon")  # not a secret name
    monkeypatch.setenv("EDITOR_TOKEN", "abc")  # too short to be worth masking
    f = SecretFilter(True)
    f.refresh_env()
    assert f.scrub("Client(base_url='https://x', key='%s')" % KEY) == "Client(base_url='https://x', key='%s')" % MASK
    assert f.scrub("Bearer " + KEY + " for Lisbon abc") == "Bearer " + MASK + " for Lisbon abc"
    assert f.scrub("nothing here") == "nothing here"


def test_variables_added_during_the_run_are_picked_up(monkeypatch):
    f = SecretFilter(True)
    f.refresh_env()
    assert f.scrub(KEY) == KEY
    monkeypatch.setenv("LATE_SECRET", KEY)  # what load_dotenv() does
    assert f.scrub_event({"text": KEY})["text"] == MASK


def test_kwarg_and_dict_item_literals_under_secret_names_are_masked_in_reprs():
    f = SecretFilter(True)
    assert f.scrub("OpenAI(api_key='sk-123', organization=None, model='gpt')") == "OpenAI(api_key='%s', organization=None, model='gpt')" % MASK
    assert f.scrub('{"password": "hunter2", "user": "ann"}') == '{"password": "%s", "user": "ann"}' % MASK
    assert f.scrub("Token(value=b'abc')") == "Token(value=b'abc')"  # `value` is not secret
    assert f.scrub("Auth(bearer=b'abc')") == "Auth(bearer=b'%s')" % MASK
    assert f.scrub("x == 'y'") == "x == 'y'"


def test_scrub_event_copies_on_write_and_flags_value_nodes(monkeypatch):
    monkeypatch.setenv("API_TOKEN", KEY)
    f = SecretFilter(True)
    ev = {"type": "log", "text": "k=" + KEY, "valueBag": {"data": {"type": "str", "value": KEY, "length": 3}}, "steps": KEY, "n": [1, KEY]}
    out = f.scrub_event(ev)
    assert out is not ev and ev["text"] == "k=" + KEY
    assert out["text"] == "k=" + MASK
    assert out["valueBag"]["data"] == {"type": "str", "value": MASK, "length": 3, "secret": True}
    assert out["steps"] == KEY  # trace step buffer: never text
    assert out["n"] == [1, MASK]
    plain = {"type": "log", "text": "hi"}
    assert f.scrub_event(plain) is plain


def test_disabled_filter_is_transparent(monkeypatch):
    monkeypatch.setenv("API_TOKEN", KEY)
    f = SecretFilter(False)
    f.refresh_env()
    assert f.scrub("api_key='x' " + KEY) == "api_key='x' " + KEY
    assert not f.secret_name("password")


def test_serializer_masks_string_leaves_under_secret_names():
    secrets.install(True)

    class Client:
        def __init__(self):
            self.api_key = "sk-hardcoded"
            self.admin_api_key = None
            self.password = b"pw"
            self.retries = 3
            self.headers = {"Authorization": "Bearer x", "Accept": "json"}

    node = serialize(Client(), LIMITS)
    p = props(node)
    assert p["api_key"]["type"] == "str" and p["api_key"]["value"] == MASK and p["api_key"]["secret"] is True
    assert p["admin_api_key"]["type"] == "None"  # a missing key stays visible
    assert p["password"]["value"] == MASK and p["password"]["secret"] is True
    assert p["retries"]["value"] == "3" and "secret" not in p["retries"]
    h = props(p["headers"])
    assert h["Authorization"]["value"] == MASK and h["Accept"]["value"] == "json"
    assert "sk-hardcoded" not in str(node)


def test_serializer_masks_a_root_named_like_a_secret():
    secrets.install(True)
    assert serialize("sk-1", LIMITS, expression_root="client.api_key")["value"] == MASK
    assert serialize("sk-1", LIMITS, expression_root="cfg['token']")["value"] == MASK
    assert serialize("sk-1", LIMITS, expression_root="name")["value"] == "sk-1"
    assert serialize(3, LIMITS, expression_root="token")["value"] == "3"


def test_run_masks_hover_text_locals_prints_and_previews(run, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", KEY)
    out = run(
        """
        import os
        class Client:
            def __init__(self, api_key, timeout):
                self.api_key = api_key
                self.timeout = timeout
            def __repr__(self):
                return "Client(api_key=%r, timeout=%r)" % (self.api_key, self.timeout)
        secret_from_env = os.environ["OPENAI_API_KEY"]
        client = Client(secret_from_env, 5)
        token = "literal-secret"
        header = "Bearer " + secret_from_env
        print(client)
        print(header)
        """,
        config={"autoLog": True, "recordLocals": True},
    )
    assert KEY not in str(out.events)  # not even inside the trace or the instrumented source
    shown = [ev for ev in out.events if ev["type"] in ("log", "locals")]  # the source itself contains the literal
    assert "literal-secret" not in str(shown)
    logs = {l["text"] for l in out.logs}
    assert "'%s'" % MASK in logs  # secret_from_env, token
    assert "'Bearer %s'" % MASK in logs
    assert "Client(api_key='%s', timeout=5)" % MASK in logs
    assert any(l["text"] == "5" for l in out.logs)  # non-secret values untouched


def test_run_with_masking_off_shows_everything(run, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", KEY)
    out = run(
        """
        import os
        api_key = os.environ["OPENAI_API_KEY"]
        """,
        config={"autoLog": True, "secrets": {"mask": False}},
    )
    assert KEY in str(out.events)
