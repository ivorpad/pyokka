"""The skill (``skills/pyokka``) names everything an agent can drive.

Every command with each of its flags in that command's own synopsis, the MCP tools with their
arguments and actions, the band's keys and tool actions, and every ``PYOKKA_`` variable a user
or agent can set. A flag added without a line in the skill fails here. The frontmatter must load
under a strict YAML parser, and the skill must start only when the user asks, in Claude Code and
in Codex.

A synopsis is a line of a reference that starts ``pyokka VERB`` (``$ `` allowed before it), with
its continuation lines indented eight spaces or more under it, or a bold inline span
``**`pyokka VERB ...`**``.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

from pyokka_runtime.__main__ import build_parser
from pyokka_runtime.agent.mcp_tools import DEBUG_ACTIONS, MAP_ACTIONS, MOVES, VALUE_ACTIONS, tool_definitions

ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / "skills" / "pyokka"
REFS = sorted((SKILL / "references").glob("*.md"))
REFERENCE = "\n".join(p.read_text(encoding="utf-8") for p in REFS)
ALL = (SKILL / "SKILL.md").read_text(encoding="utf-8") + "\n" + REFERENCE

#: flags every command over a run shares, documented once
SHARED = {"-h", "--help", "--json", "--live", "--session"}
#: variables the build and the test harness set, not a user or an agent
INTERNAL_VARS = {"PYOKKA_REEXEC", "PYOKKA_E2E", "PYOKKA_BUILD"}


def synopses(text: str, name: str) -> str:
    out: list[str] = []
    lines = text.split("\n")
    head = re.compile(r"^\s*(?:\$ )?pyokka %s(?=\s|$)" % re.escape(name))
    i = 0
    while i < len(lines):
        if head.match(lines[i]):
            out.append(lines[i])
            while i + 1 < len(lines) and re.match(r"^\s{8,}\S", lines[i + 1]) and re.search(r"--|\[", lines[i + 1]):
                i += 1
                out.append(lines[i])
        i += 1
    out += re.findall(r"\*\*`pyokka %s [^`]*`\*\*" % re.escape(name), text)
    return "\n".join(out)


def has(text: str, word: str) -> bool:
    return re.search(r"(^|[^\w-])%s(?![\w-])" % re.escape(word), text) is not None


def commands() -> dict[str, argparse.ArgumentParser]:
    sub = next(a for a in build_parser()._actions if isinstance(a, argparse._SubParsersAction))
    return dict(sub.choices)


def test_every_command_has_a_synopsis_with_each_of_its_flags():
    missing: list[str] = []
    for name, parser in commands().items():
        syn = synopses(REFERENCE, name)
        if not syn:
            missing.append("%s: no synopsis" % name)
            continue
        for action in parser._actions:
            for flag in action.option_strings:
                if flag not in SHARED and not has(syn, flag):
                    missing.append("%s %s" % (name, flag))
    assert missing == []


def test_the_shared_flags_are_documented():
    assert [f for f in SHARED if not has(REFERENCE, f)] == []


def test_the_mcp_tools_their_arguments_and_actions_are_in_mcp_md():
    mcp = (SKILL / "references" / "mcp.md").read_text(encoding="utf-8")
    missing: list[str] = []
    for tool in tool_definitions():
        if not has(mcp, tool["name"]):
            missing.append(tool["name"])
        for prop in tool["inputSchema"]["properties"]:
            if "`%s`" % prop not in mcp:
                missing.append("%s.%s" % (tool["name"], prop))
    for action in (*MAP_ACTIONS, *VALUE_ACTIONS, *MOVES, *DEBUG_ACTIONS):
        if "`%s`" % action not in mcp:
            missing.append("action %s" % action)
    assert missing == []


def test_the_band_keys_and_tool_actions_are_named():
    keys = (ROOT / "claude-plugin" / "pyokka-band" / "hooks" / "keys.ts").read_text(encoding="utf-8")
    letters = sorted(set(re.findall(r"key: '([a-z])'", keys)))
    assert len(letters) > 8, letters
    tool_actions = re.search(r"TOOL_ACTIONS: Record<string, string> = \{([^}]*)\}", keys)
    assert tool_actions and "enum: ['show', 'hide', 'step', ...Object.keys(TOOL_ACTIONS)]" in keys, "the band tool's enum changed shape: update this test"
    actions = ["show", "hide", "step", *re.findall(r"(\w+):", tool_actions.group(1))]
    missing = ["/pk %s" % k for k in letters if "/pk %s" % k not in ALL]
    missing += ["band action %s" % a for a in actions if '"%s"' % a not in ALL]
    assert missing == []


def test_every_pyokka_variable_is_named():
    names: set[str] = set()
    for path in [*(ROOT / "python" / "pyokka_runtime").rglob("*.py"), *(ROOT / "src").rglob("*.ts")]:
        names.update(re.findall(r"PYOKKA_[A-Z0-9_]*[A-Z0-9]", path.read_text(encoding="utf-8")))
    names -= INTERNAL_VARS
    assert len(names) >= 8, sorted(names)
    assert sorted(n for n in names if not has(ALL, n)) == []


def test_the_frontmatter_is_strict_yaml():
    """A plain value holding ": " is a YAML error that a strict loader (Ruby's Psych) rejects."""
    head = (SKILL / "SKILL.md").read_text(encoding="utf-8").split("\n---")[0].split("\n")[1:]
    for line in head:
        m = re.match(r"^([a-z-]+): (.*)$", line)
        if not m:
            continue
        value = m.group(2)
        if value[:1] in (">", "|"):
            continue
        if value[:1] == "'":
            assert value.endswith("'") and "'" not in value[1:-1].replace("''", ""), "%s: a single-quoted value doubles its inner quotes" % m.group(1)
            continue
        if value[:1] == '"':
            assert value.endswith('"'), m.group(1)
            continue
        assert ": " not in value and not value.endswith(":"), "%s: a plain value may not hold ': '; quote it or write it as a >- block" % m.group(1)


def test_the_skill_starts_only_when_the_user_asks():
    head = (SKILL / "SKILL.md").read_text(encoding="utf-8").split("\n---")[0]
    assert re.search(r"^disable-model-invocation: true$", head, re.M), "Claude Code: /pyokka only"
    policy = (SKILL / "agents" / "openai.yaml").read_text(encoding="utf-8")
    assert re.search(r"^policy:\n\s+allow_implicit_invocation: false\s*$", policy, re.M), "Codex: $pyokka only"


def test_skill_md_maps_every_mcp_tool():
    """SKILL.md's table is where an agent picks a tool; a tool missing from it is one it never calls."""
    skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")
    assert [t["name"] for t in tool_definitions() if "`%s`" % t["name"] not in skill] == []
