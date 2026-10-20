# Pyokka playbook

Eight situations, each with a prompt to paste into Codex or Claude Code, what the agent will do,
the lines you should see, and what passes or fails. Run them from the repository root against the
example programs in `examples/`, or swap in your own file and test.

What "observed" means here: every quoted line marked **observed** was copied from a real run on
2026-10-20 (Pyokka 0.5.4, Codex gpt-6.1-sol, a langchain clone) or from this repository's tests.
A line marked **shape** is the renderer's format with your names filled in; it was not seen in that
run. The numbers in the examples (`2 breakpoints`, `_policy.py:210`) are from that run; yours
differ.

## Before you start

- The extension is installed and `pyokka.agentAccess` is on; `code` is on PATH (on a Mac
  `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`).
- `~/.local/bin/pyokka -h` prints the usage. The agent reaches Pyokka through the MCP tools when
  registered (`claude mcp add pyokka -- ~/.local/bin/pyokka mcp`, `codex mcp add pyokka --
  ~/.local/bin/pyokka mcp`), else through that CLI.
- The skill is installed: `~/.claude/skills/pyokka` for Claude Code, `~/.agents/skills/pyokka` or
  `.agents/skills/pyokka` in the repository for Codex. Codex invokes it with `$pyokka`, Claude Code
  with `/pyokka`. Without the skill the agent still has the tools; it just plans less.
- Paths: the agent must pass absolute paths over MCP. In the prompts below, repository-relative
  paths are fine, since the agent resolves them from the repository root.

Every Pyokka answer ends with a `next:` line naming one command. A review answer also opens with
`review <id> · <phase> · stops K/N shown · findings F · tries T`. A refusal is one line starting
with `refused:` or `error:`, then the `next:`; it changes nothing.

## 1. A program under the debugger

Pause in one function of a program and read the frame.

Codex:

```
$pyokka debug examples/rrf/demo.py: pause in reciprocal_rank, tell me the first stop and leave it paused.
```

Claude Code:

```
/pyokka debug examples/rrf/demo.py: pause in reciprocal_rank, tell me the first stop and leave it paused.
```

Steps. The agent runs `pyokka debug examples/rrf/demo.py --at reciprocal_rank` (MCP `pyokka_debug
{"action": "start", "file": "<abs>/examples/rrf/demo.py", "at": ["reciprocal_rank"]}`). VS Code
opens the file and pauses at the first statement of the function. The agent reports the stop in
chat and stops there, since you said to leave it paused.

Observable result, **shape** (seen on another file in the run; the structure is the same):

```
paused at examples/rrf/demo.py:LINE (breakpoint)
not recording yet: nothing before this pause was kept; `record --live` records from here (a `--record-from` run starts by itself at its pause)
stack: reciprocal_rank examples/rrf/demo.py:LINE ← rrf examples/rrf/demo.py:LINE ← main examples/rrf/demo.py:LINE ← <module> examples/rrf/demo.py:LINE
block reciprocal_rank  examples/rrf/demo.py
  49  def reciprocal_rank(rank: int, k: int = 60) -> float:
> LINE     ...
locals:
  rank = 1
  k = 60
output: start of the program's prints so far
```

Pass: VS Code shows the pause arrow on the line the `>` marks, and `pyokka state --live` prints
`debug  demo.py  running, paused at demo.py:LINE (breakpoint)   [this]`.

Fail: `finished: exit 0, N steps` means the function never ran under the debugger (a wrong name, or
see situation 8 for the project-folder cause). `cannot find the `code` command` means the launcher
is missing; the skill's `references/setup.md` has the fix. If the pause lands on an unexpected line,
a breakpoint from an earlier run is still set in VS Code: situation 3 says how to clear them.

## 2. A test under the debugger

Pause inside the code a test exercises. Use one of your own tests; this repository's examples have
none.

Codex:

```
$pyokka debug tests/test_x.py::test_y: pause in FUNCTION and show me its values.
```

Claude Code:

```
/pyokka debug tests/test_x.py::test_y: pause in FUNCTION and show me its values.
```

Steps. The agent runs `pyokka debug tests/test_x.py --test tests/test_x.py::test_y --at FUNCTION`
(MCP `pyokka_debug` with `file`, `test` and `at`). The test runs through pytest under the
debugger, with no recording, and pauses in FUNCTION.

Observable result, **observed** for a langchain test, the stack line in particular:

```
paused at libs/core/langchain_core/_security/_policy.py:210 (breakpoint)
not recording yet: nothing before this pause was kept; `record --live` records from here (a `--record-from` run starts by itself at its pause)
stack: validate_resolved_ip libs/core/langchain_core/_security/_policy.py:210 ← test_scoped_and_compatible_ipv6_blocked libs/core/tests/unit_tests/test_ssrf_policy_transport.py:59 ← … 30 library frames in _pytest/python.py, pluggy/_callers.py, …
block validate_resolved_ip  libs/core/langchain_core/_security/_policy.py
 ...
>210          addr = ipaddress.IPv6Address(int(addr))
 ...
locals:
  ip_str = 'fd00:ec2::254%eth0'
  policy = SSRFPolicy(allowed_schemes=frozenset({'http', 'https'}), block_private_ips=True, ...)
  addr = IPv6Address('fd00:ec2::254%eth0')
output: nothing new since the last stop
```

Pass: the stack's second frame is your test function, and the locals are the test's values.

Fail: `error:` naming `No module named pytest` means the interpreter has no pytest; tell the agent
which Python to use and it passes `--python`. `finished: exit 0` with no pause means the test never
called FUNCTION.

## 3. Breakpoints

Add one, reach it, list, remove.

Codex:

```
$pyokka debug examples/rrf/demo.py: start paused on entry, add a breakpoint at line 95 (inside print_ranking), continue to it, list the breakpoints, then remove it and continue to the end.
```

Claude Code: the same text after `/pyokka`.

Steps. `pyokka debug examples/rrf/demo.py --stop-on-entry`, then `pyokka break --live
examples/rrf/demo.py:95` (MCP `pyokka_debug {"action": "break", "add": ["<abs>/examples/rrf/demo.py:95"]}`),
`pyokka continue --live`, `pyokka break --live` (the list), `pyokka break --live --remove
examples/rrf/demo.py:95`, `pyokka continue --live`.

Observable result, **observed** for the list and the continue:

```
2 breakpoints
  libs/core/langchain_core/_security/_policy.py:129  (not resolved yet)
  libs/core/langchain_core/_security/_policy.py:210  (not resolved yet)
exceptions: uncaught
```

```
paused at libs/core/langchain_core/_security/_policy.py:210 (breakpoint)
```

and at the end, **observed** on the failing test of situation 9: `finished: exit 1, 8 steps`.

Pass: the continue stops at the added line, inside `print_ranking` (the `block` line names it), the
list shows it, and after the removal the list no longer does.

Fail: a pause at a line nobody added. VS Code keeps every breakpoint an agent adds, across sessions
and restarts, so a run broken off yesterday leaves its breakpoints behind. `pyokka break --live
--clear` empties the list; a review then needs `review view vscode` to set its own again.

## 4. Locals and long values

Read the frame at a pause, including a value too long for one line.

Codex:

```
$pyokka debug: at the current pause, list the locals, then show NAME whole.
```

Claude Code: the same text after `/pyokka`.

Steps. `pyokka locals --live` (MCP `pyokka_debug {"action": "locals"}`), then `pyokka locals --live
--name NAME --text-len 0` (MCP `{"action": "locals", "names": ["NAME"], "text_len": 0}`). At a
live pause the agent's reads carry up to 2,000 characters per value; the editor's own hover and
Variables view keep 200.

Observable result, **observed**: a 256-character dataclass arrived whole, where 0.5.3 cut it at 200
with `…(+56 chars)`:

```
locals:
  ip_str = 'fd00:ec2::254%eth0'
  policy = SSRFPolicy(allowed_schemes=frozenset({'http', 'https'}), block_private_ips=True, block_localhost=True, block_cloud_metadata=True, block_k8s_internal=True, allowed_hosts=frozenset(), additional_blocked_cidrs=())
  addr = IPv6Address('fd00:ec2::254%eth0')
```

A value still over the limit, **shape** (from the unit tests):

```
  big = SSRFPolicy(allowed_schemes=frozenset({'https', 'http'}), ... allowed_hosts=('h000.example.com', ...…(+1,135 chars)
    .allowed_schemes = frozenset({'https', 'http'})
    .block_private_ips = True
    .allowed_hosts = ('h000.example.com', 'h001.example.com', ...…(+2,801 chars)
    .api_token = '••••••••'
hint: a value was cut: `pyokka locals --live --name NAME --text-len N` shows more of it, 0 all of it (MCP: pyokka_debug {"action": "locals", "names": ["NAME"], "text_len": N}), and a slice such as `pyokka eval --live 'NAME[2000:4000]'` the rest of a long string
```

Pass: either the whole value, or a cut value with its fields listed under it and the `hint:` line at
the end of the answer. A field named like `api_token` shows as `'••••••••'`.

Fail: a value cut at 200 characters with no fields and no hint means the window runs an extension
older than 0.5.4; situation 8 says how to tell which build answered.

## 5. Exceptions

Stop where a program raises.

Codex:

```
$pyokka debug test/e2e/fixtures/debug_raise.py: run it and stop where it raises; then tell me the value that caused it.
```

Claude Code: the same text after `/pyokka`.

Steps. `pyokka debug test/e2e/fixtures/debug_raise.py` (uncaught exceptions pause by default; `pyokka
break --live --on-exception raised` also pauses on the caught `ValueError` in `parse`). The program
prints `start` and `-1`, then `check(3)` raises `ValueError("too big: 3")` at line 6, uncaught.

Observable result, **shape**:

```
paused at test/e2e/fixtures/debug_raise.py:6 (exception)
ValueError: too big: 3
stack: check test/e2e/fixtures/debug_raise.py:6 ← <module> test/e2e/fixtures/debug_raise.py:21
block check  test/e2e/fixtures/debug_raise.py
   4  def check(n):
   5      if n > 2:
>  6          raise ValueError("too big: %d" % n)
   7      return n
locals:
  n = 3
```

Pass: the pause reason is `(exception)`, the type and message are on the next line, and `n = 3`
is in the locals.

Fail: `finished: exit 1, N steps` followed by `error: ValueError: too big: 3 (debug_raise.py:6)`
means the run ended without pausing: exception pausing was turned off (`pyokka break --live
--on-exception uncaught` turns it back on).

## 6. Invalid inputs

Each wrong call gets one refusal and changes nothing. Try them deliberately.

A review started on a test file instead of a test, **observed**:

```
review (none) · no review started · stops 0/0 shown · findings 0 · tries 0
refused: --test needs the test file: FILE::NAME, or --entry FILE beside it
next: review start --base REF --test tests/test_x.py::test_name
```

Several skips where one number is not in the plan, **shape** from the code: `items 9, 12 are not
in the plan; nothing was skipped`, then the plan. A skip of a shown item: `item 2 was shown
already; nothing to skip`.

A stop without a say, **shape**: `stop records the pause the debugger is at: `review stop [N] --say
TEXT`, naming a value of the frame`, and the next line says to continue in the debugger instead.

A bad argument over MCP, `pyokka_debug {"action": "locals", "scope": "bogus"}`, **shape**:

```
error: unknown scope 'bogus'
one of local, global, all
```

`--only` with a recorded review (`--full`, or surface page or chat), **shape**: `--only narrows the
agenda of a review in the debugger; this start is the recorded review …`, with the fix on the next
line.

Pass: one refusal, the `next:` names the fix, and `review state` shows the same agenda as before.
Fail: a traceback, or a changed agenda after a refused call.

## 7. Large results and the spill

A wide review plan does not land in the model's context whole.

Codex (in a repository with a large diff; the langchain clone's `f40f58d` range had 66 files):

```
$pyokka review the changes since f40f58d; start the whole agenda, no narrowing, and tell me where the full plan went.
```

Claude Code: the same text after `/pyokka`.

Steps. The agent calls `pyokka_review start` without `only`. The result is over 8,000 characters
(`PYOKKA_MCP_MAX_CHARS` changes the limit), so the server writes it to a file and replies with the
first lines, two marker lines and the last lines.

Observable result, **shape** from the module's own run on the recorded 65,050-character plan (not
yet seen from a live client):

```
review langchain-f40f58d · stops · stops 0/58 shown · findings 0 · tries 0
langchain: f40f58d → working tree at d670a3a, entry ...
...
  32. change  libs/langchain_v1/langchain/agents/middleware/summarization.py:297 __init__  changed lines 297, 366-406, 435-436, 460-469  (pending)
[… 254 of 300 lines left out (38 to 291); the whole result, 65,050 characters, is in /Users/you/.pyokka/tool-results/20261020-083440-pyokka_review-start.txt]
[read them with sed -n '38,291p' /Users/you/.pyokka/tool-results/20261020-083440-pyokka_review-start.txt or your file tool]
  E225 [...] ...
next: continue in the debugger to the next item (pyokka continue --live; MCP pyokka_debug {"action": "continue"}), then review stop --say TEXT at the pause
```

The file is the complete text, byte for byte, so the `sed` range is exact. When the home is not
writable, as in Codex's `workspace-write` sandbox, the file goes to `pyokka-tool-results` under the
system temp directory. A JSON answer over the limit comes back as a small JSON object instead:
`spilled`, `path`, `characters`, `lines`, `head`, `read`.

Pass: the reply stays under about 8,000 characters, its last line is `next:`, and `ls
~/.pyokka/tool-results/` (or the temp directory) shows the file. Fail: the full plan inline means
the `pyokka mcp` the client runs is older than 0.5.4; `which pyokka` and `pyokka -h` say which one
the client starts. In the 2026-10-20 run the agent narrowed with `only` on its own, so the spill
did not fire; the unit tests in `python/tests/test_mcp_spill.py` are its evidence so far.

## 8. Session lifecycle and recovery

Know what is open, end it cleanly, and recover from the three common breaks.

Codex:

```
$pyokka debug: what sessions are open? Stop the one on demo.py and confirm nothing is left.
```

Claude Code: the same text after `/pyokka`.

Steps. `pyokka_session` (CLI `pyokka state --live`), `pyokka stop --live` (MCP `pyokka_debug
{"action": "stop"}`), `pyokka_session` again. A review ends with `review close` or `review report`.

Observable result, **observed**:

```
{
 "kind": "session",
 "mode": "list",
 "ready": true,
 "vscode": {"code": "/usr/local/bin/code", "extension": "0.5.4", "agentAccess": true, "closedSessions": 0},
 "sessions": [{"session": "/Users/you/.pyokka/sessions/13832-d1.json", "kind": "debug", "file": "...", "displayName": "-m pytest", "pid": 13832, "started": "2026-10-20T06:35:13Z", "recording": false}],
 "notes": ["Descriptors show published sessions, not confirmed pauses or visible editors. Pass live: true or session to read one's state."]
}
```

`stop`, **observed**: `stopped: exit None, 5 steps` (a run ended by the stop has no exit code). `review close`, **shape** from the code:
`breakpoints: removed the review's 2 from VS Code, one per item on the agenda; the debug session
stays open`.

Pass: after the stop, the session list is empty and `ready` is false with the note `No live
session: …`.

Recovery. The signatures, what each means and the one command it asks for are the agent's own
reference, `skills/pyokka/references/recovery.md`, which the skill loads when a command refuses or
nothing pauses. The person's checklist is the signatures alone:

- `the VS Code debug session of this review is gone (the window closed, or the program was stopped)`
  and `the program ended (exit N); no pause to record`: the review recovers with `review view vscode`.
- `Pyokka activating (build …); runtime dir …/ivor.pyokka-0.5.4/dist/python` (**observed**) is the
  first line of the Pyokka output log under `~/Library/Application Support/Code/logs/` on a Mac; an
  older build there means the window never reloaded after an install.
- `finished: exit 0` right after `start`, with breakpoints set, on a repository that is not an open
  folder: fixed in 0.5.4; an older build shows it.
- A pause on a line nobody set: breakpoints kept from an earlier run; `pyokka break --live --clear`.

## 9. Vague prompts

The skill is meant to take a request with no mode word and no file and work out the rest from the
repository: inspect first, plan in proportion to what it finds, ask only what nobody but the
person can answer, run through the tools, and answer with recorded or paused values. The person
needs no debugger vocabulary. Three bare prompts were run on 2026-10-20 with Codex gpt-6.1-sol
against the project below; the calls each one made are listed, so you can compare your run.

The project. Paste into an empty directory, then `python3 -m venv .venv && .venv/bin/pip install
pytest`, `git init`, commit, and make the regression as an uncommitted change (drop
`.replace(",", "")`), so `.venv/bin/pytest -q` ends in `1 failed, 2 passed`:

```python
# calc.py, the committed version
"""Money parsing for a small shop: strings from invoices into floats."""


def parse_money(text: str) -> float:
    """'$1,200.50' -> 1200.5. Symbols and spaces are stripped; a thousands separator is kept out."""
    t = text.strip().lstrip("$€£").replace(",", "").strip()
    return float(t)


def total(lines: list[str]) -> float:
    return round(sum(parse_money(line) for line in lines), 2)
```

```python
# tests/test_calc.py
from calc import parse_money, total


def test_plain_amount():
    assert parse_money("$12.50") == 12.5


def test_thousands_separator():
    assert parse_money("$1,200.50") == 1200.5


def test_total():
    assert total(["$1.25", "€2.75"]) == 4.0
```

`pytest.ini` holds `[pytest]` and `pythonpath = .`. For Codex, copy the skill to
`.agents/skills/pyokka` with `allow_implicit_invocation: true` in `agents/openai.yaml`, so a bare
prompt may use it, and give the MCP server the project's interpreter
(`mcp_servers.pyokka.env.PYOKKA_PYTHON = "<dir>/.venv/bin/python"`). A new directory first gets
Codex's own "Trust this folder?" dialog, which is the harness, not Pyokka. For Claude Code the
installed skill triggers on its description; `/pyokka` forces it.

### "why does this test fail?"

Precise form, for comparison:

```
$pyokka show tests/test_calc.py::test_thousands_separator: record it and show me the value that makes it fail.
```

Expected behaviour, **observed** (39 s, five tool calls, no question asked):

1. Read `SKILL.md`, picked `show`, read `references/show.md`.
2. Listed the files, read `calc.py`, the test and `pytest.ini`, ran `git status --short`.
3. `pyokka_run` on the test file with `test: "test_thousands_separator"`, saved to `/tmp`:
   `saved /tmp/vague-test-failure-20261020.json: 8 steps, 2 files, exit 1`.
4. `pyokka_map walkthrough`: `7 moments over 8 steps`, with `raised = ValueError` at the call.
5. `pyokka_value values` on `calc.py:6` (`text = '$1,200.50'`) and `calc.py:7` (`t = '1,200.50'`).
6. The answer: `parse_money()` leaves the comma, `float(t)` raises `ValueError` at `calc.py:7`, the
   fix is `return float(t.replace(",", ""))`, "I haven't changed the code."

Pass: the answer rests on a recorded value (`t = '1,200.50'`), names the line, proposes the fix
without applying it, and `git status` is unchanged. Fail: an answer from reading alone with no
`pyokka_` call, a question before any inspection, or an edit to `calc.py`.

### "review this issue with Pyokka"

Precise form:

```
$pyokka review the uncommitted change against HEAD: test_thousands_separator fails; watch in VS Code; findings only.
```

Expected behaviour, **observed** (37 s, no tool call yet, by design):

1. Read `SKILL.md` and `references/review.md`, ran `git status --short` and `git diff`, read the
   files.
2. Said what the change does: it removes the comma removal from `parse_money`, and an existing test
   expects `"$1,200.50"` to parse.
3. Asked, in one message, the four things `review.md` names: is this pending change the issue,
   what behaviour it should have and which areas first or left out, where to watch (chat, VS Code,
   the browser page), and whether to report findings or also fix. Then it stopped: "No runtime
   behavior is verified yet."

A review begins twice on purpose (`SKILL.md`, "How a turn ends"): the questions are the ones only
the person can answer, and the answer decides the plan. The turns after that are situation 7 and
situation 8's lifecycle: the plan with its sessions, then `start`, `continue`, `stop`.

Pass: the diff is read before the question, the questions come in one message, and nothing starts
before the answer. Fail: a `review start` before asking, or a question the diff already answers
("which file changed?").

### "debug this"

Precise form:

```
$pyokka debug tests/test_calc.py::test_thousands_separator: pause in parse_money, step to the float call and show me t.
```

Expected behaviour, **observed** (56 s, ten tool calls, no question asked):

1. Read `SKILL.md`, picked `debug`, read `references/debug.md` and `references/sessions.md`;
   listed and read the files, ran `git status --short`, then `pyokka_session`.
2. `pyokka_debug start` on the test file with `test` and `at: ["parse_money"]`: VS Code opened
   `calc.py` and answered `paused at calc.py:4 (breakpoint)`, the stack ending in
   `test_thousands_separator tests/test_calc.py:9 ← … 30 library frames in _pytest/python.py, …`.
3. `pyokka_step` over, twice: `paused at calc.py:7 (step over)` with `t = '1,200.50'` in the
   locals; once more: `finished: exit 1, 8 steps`.
4. Clean-up as the skill asks: the first removal of its breakpoint answered `error: no live session
   for …`, since the program had ended; it started the session again, removed `parse_money` from
   the list, read the list back (two breakpoints left, both from the earlier review in another
   repository, which it left alone), then `stopped: exit None, 5 steps`, and `pyokka_session`
   showed no debug session of its own.
5. The answer: the debugger shows `t = '1,200.50'`, so `float(t)` raises `ValueError` at
   `calc.py:7`; the fix is `return float(t.replace(",", ""))`; "Source remains unchanged. I removed
   my stop and ended the debugger."

The inference it made: "this" with no file meant the one failing test and the function it calls,
found by reading the tests and running nothing else first.

Pass: a real pause in VS Code (the editor shows the arrow in `parse_money`), the answer names the
paused value and line, the source is unchanged, and `pyokka_session` lists no session of the
agent's afterwards. Fail: a guess from reading with no pause, a question about which file before
reading the repository, or a breakpoint left in the list (`pyokka break --live` shows it).

## Untested in the 2026-10-20 run

Situation 5 (the exception pause) and situation 7 (a live client receiving a spilled result) are
shapes from the renderer and the unit tests, not observed that day; so is the `review close`
line of situation 8. Observed: situations 1 to 4, the review refusal of 6, the session listing,
`finished:` and `stopped:` lines of 8, and all three vague prompts of 9. Run 5 and 7 first when
you check a new build.
