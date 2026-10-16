"""The MCP side of review mode: the ``pyokka_review`` tool (its schema and its call) and the ``review`` prompt.

The tool's fields are the CLI's names; a call goes down the same ``actions.run`` as the CLI, so the
text is the one ``pyokka review`` prints, a refusal included (``isError``). The prompt is the method
in about fifteen lines: the first section of ``skills/pyokka/references/review.md`` when the
checkout has it (an installed extension ships no ``skills/``), else the built-in text below.
"""

from __future__ import annotations

import json
import os
from typing import Any

from .state import ACTIONS, SEVERITIES, SURFACES

PROMPT_NAME = "review"
PROMPT_TITLE = "Review a change as a guided debug session"
REVIEW_MD = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "skills", "pyokka", "references", "review.md"))

BUILTIN_PROMPT = """\
A review is a conversation whose sequence the tool owns, and you are the person's peer in it: you read before you answer, you say where you are going before you go, and every claim rests on a value from a run. Every answer starts with the review's header and ends with `next:`, the one command to run, or `wait for the person`.
1. `start --base REF` (`--repo DIR`, `--entry FILE` or `--test FILE::NAME`, `--pr FILE`) records base and head, compares the two runs and plans the stops: an agenda the person reorders. Read the paragraph of what changed, the stops, the unreached lines and the edge candidates.
2. `stop N --say TEXT` shows one stop, then you wait. It prints the lines this block ran, not the function: read the function first, then say what happens there and why it matters, naming a value the tool printed (a local's text, the fact's before or after text, or the step number); a say that names none is refused and the refusal lists the values. The next `stop` needs `--go-on`, your word that they said next.
3. What the person says decides what you do before you answer. Right, enough, correct? Read the whole function, then `try --expr EXPR` or `--code FILE` with inputs that test the claim (the boundary, an empty value, the other branch), and answer with the try's result. What is X, where did it come from? `look --expr EXPR` at the current step, or `pyokka origin DIR/head.json STEP EXPR`, and quote the chain's root. Why is it like this? `git blame` and the PR text; say which answered. A line that is not a stop? `ask FILE:LINE --say TEXT`. None of these needs `--go-on`; `skip N --why TEXT` sets a stop aside with their reason.
4. `finding add --file F --line L --severity blocker|major|minor --title T --step N --repro ID|CMD --fix TEXT` records what the two of you concluded: it needs the head step that shows it (in F, near L) and a reproduction, a try id or a command with `--expect`; without them it is refused. A changed line head never ran has no step: file it with a try that reaches it as the reproduction.
5. `fix --patch FILE.diff --tests CMD`: the patch goes to a copy of head, never to the repository; the tool runs the tests there, records the copy and checks each finding's NAME=VALUE expectation as `verify` does.
6. `report`: the tool re-runs every reproduction and refuses when the tree changed since start, a finding lacks a reproduction, or one no longer reproduces; then it writes the markdown, what you looked at together first.
Rules: nothing is written inside the repository. A claim without a value from a run is a guess: say so, or do not make it. Before each look, one line saying what you are about to look at; end each answer with what you have not verified. One stop per message, then their turn. Rank findings blocker, major, minor; list the edge candidates skipped and what you did not verify.
Write to the person, in chat and in a `--say`, in short sentences: one idea each, 20 words or fewer, active voice, present tense, the actor named; the imperative for what they should do; the same word for the same thing (stop, step, value, try, finding, the person; never breakpoint, experiment, repro, variable, user); no -ing verb as a noun; no label with a colon; a list for parallel items, never a table; the answer first, then the step and value that show it, then what is not verified.
"""


# -- the tool -------------------------------------------------------------------------------------------------------

def tool_definition() -> dict:
    props = {
        "action": {"type": "string", "enum": list(ACTIONS), "description": "start, stop, ask, skip, look, try, finding (add), fix, report, state, close"},
        "base": {"type": "string", "description": "start: the base commit, a ref the repository resolves (required for start)"},
        "repo": {"type": "string", "description": "start: the git checkout under review (default: the server's working directory); absolute path"},
        "entry": {"type": "string", "description": "start: the file both trees run (default main.py at the repo root)"},
        "test": {"type": "string", "description": "start: one test to run instead, FILE::NAME (a pytest node id or a unittest name)"},
        "pr": {"type": "string", "description": "start: the PR text file (default pr.md at the root, else the commit messages base..head)"},
        "python": {"type": "string", "description": "start: the interpreter that runs the trees (default: as pyokka_run picks it)"},
        "dir": {"type": "string", "description": "the review directory (default: the current review, the one start last made)"},
        "args": {"type": "array", "items": {"type": "string"}, "description": "start: arguments for the program"},
        "n": {"type": "integer", "description": "stop, skip: the stop's number in the plan (any remaining one: the plan is an agenda the person reorders)"},
        "say": {"type": "string", "description": "stop, ask: the explanation at the stop; it must name one of the stop's values, the fact's before or after text, or the step number"},
        "go_on": {"type": "boolean", "description": "stop: the person said next since the last stop; every stop after the first needs it (ask, look and try never do)"},
        "why": {"type": "string", "description": "skip: the reason the person gave"},
        "surface": {"type": "string", "enum": list(SURFACES), "description": "start: what to open for the person (auto and vscode record the entry in VS Code, which needs the pyokka.agentAccess setting on and the code command; page serves the browser page on a free port, refused before recording when the port is taken; chat opens nothing); start's view: line says what opened. stop, ask: where the person watches. vscode needs a live session on the entry, best a finished recording (pyokka_debug {action: \"start\", file, record: true, cwd}); page needs a Pyokka page on the entry with one browser tab on port; either is refused when nothing answers, the stop stays unshown and next: names the command that starts it. chat moves nothing: your text is the review. auto takes the first that answers and reports chat, not moved, when none does"},
        "port": {"type": "integer", "description": "start, stop, ask, try: the page's port (default $PYOKKA_PORT, else 4777)"},
        "session": {"type": "string", "description": "stop, ask: the VS Code session's file name, when more than one is open"},
        "line": {"type": ["string", "integer"], "description": "ask: FILE:LINE; finding: the line number L"},
        "code": {"type": "string", "description": "try: the Python code to run, the text itself; a `result` variable is shown (the CLI's --code takes a file instead)"},
        "expr": {"type": "string", "description": "try: one expression, run as result = (EXPR) in the sandbox; look: a pure expression evaluated over the values recorded at the step"},
        "inputs": {"type": "string", "description": "try: a file of Python assignments bound before the code runs"},
        "mocks": {"type": "string", "description": "try: a file holding one Python dict of {target: value}, applied with unittest.mock"},
        "edge": {"type": "string", "description": "try: the edge candidate this try covers (E1, E2, …)"},
        "title": {"type": "string", "description": "try, finding: a title"},
        "file": {"type": "string", "description": "finding: the file F of the finding"},
        "severity": {"type": "string", "enum": list(SEVERITIES), "description": "finding"},
        "step": {"type": "integer", "description": "finding: a step of head.json in F, within 3 lines of L or in the same function (left out only for a changed line head never ran, with a try as repro); look: the step to read (default: the last stop shown or line asked)"},
        "repro": {"type": "string", "description": "finding: a try id, or a shell command run from the repo root whose output must contain expect"},
        "expect": {"type": "string", "description": "finding: what the reproduction's output contains (required with a command); NAME=VALUE is checked by fix as verify does"},
        "fix": {"type": "string", "description": "finding: the fix, in words"},
        "patch": {"type": "string", "description": "fix: a unified diff file against head (a/ and b/ paths, as git diff writes them)"},
        "tests": {"type": "string", "description": "fix: a shell command run in DIR/fixed"},
        "out": {"type": "string", "description": "report: where the markdown goes (default DIR/report.md)"},
        "page": {"type": ["string", "boolean"], "description": "report: also write the review as a code-history page (history.json for the skill's render-code-history.cjs), one checkpoint per stop shown or line asked with the say as its text and base's value beside head's, then the tries: a path outside the repository, or true for DIR/page.json"},
        "tour": {"type": ["string", "boolean"], "description": "report: also write the review as a tour of head.json (tour.json for the skill's render-tour.cjs): the stops shown as its picks in run order, the says as its prose, a say the tour's check rejects falling back to the fact: a path outside the repository, or true for DIR/tour.json"},
        "json": {"type": "boolean", "description": "the raw JSON shape instead of the text form"},
    }
    return {
        "name": "pyokka_review",
        "title": PROMPT_TITLE,
        "description": (
            "Review a change as a conversation whose sequence the tool owns: the person reads along while you step and explain, they ask, you both figure it out. "
            "start records base and head (entry or test), opens the entry recorded in the person's VS Code (surface page serves the browser page instead), compares the two runs and plans the stops (raises, type changes, sign flips, None, prints, values that differ), with the unreached changed lines and the edge candidates beside them; the plan is an agenda the person reorders. "
            "stop shows one stop: it moves the person's view (the page on port, a VS Code session, or chat; surface vscode or page with nothing answering is refused and next: names the command that starts one), refuses a say that names none of the stop's values, and then you wait for them; the next stop needs go_on: true, your word that they said next. "
            "ask is their question at FILE:LINE, look evaluates a pure expression at the current step, try runs a reproduction in the Scratchpad's sandbox (the page's when one is open on the entry, else headless) and keeps it as a try id; none of them needs go_on. skip sets a stop aside with their reason. "
            "finding needs the head step that shows it and a reproduction (a try id, or a command with expect). fix applies a unified diff to a copy of head, runs tests there, records it and checks NAME=VALUE expectations as verify does. "
            "report re-runs every reproduction and refuses when the tree changed, then writes the markdown, what you looked at together first, and stops the page server start opened (close does that alone). state lists the agenda: shown, skipped, remaining. "
            "Every answer starts with `review <id> · <phase> · stops K/N shown · findings F · tries T` and ends with `next:`, the one command to run (or `wait for the person`), in the CLI's words: call it as fields, {action: \"stop\", n: 2, say: TEXT, go_on: true} for `review stop 2 --say TEXT --go-on`; a refusal is an error result with the same lines. "
            "Nothing is written inside the repository; the review lives in dir (default $PYOKKA_HOME/reviews/<repo>-<base7>), and dir can be left out after start."
        ),
        "inputSchema": {
            "type": "object",
            "properties": props,
            "required": ["action"],
            "allOf": [
                {"if": {"properties": {"action": {"const": "start"}}, "required": ["action"]}, "then": {"required": ["base"]}},
                {"if": {"properties": {"action": {"enum": ["stop", "ask"]}}, "required": ["action"]}, "then": {"required": ["say"]}},
                {"if": {"properties": {"action": {"const": "skip"}}, "required": ["action"]}, "then": {"required": ["n", "why"]}},
                {"if": {"properties": {"action": {"const": "look"}}, "required": ["action"]}, "then": {"required": ["expr"]}},
                {"if": {"properties": {"action": {"const": "finding"}}, "required": ["action"]}, "then": {"required": ["repro"]}},
            ],
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": True},
    }


def call_review(arguments: dict) -> tuple[str, bool]:
    """A ``pyokka_review`` call: the text ``pyokka review`` prints; a refusal's text with ``isError``."""
    from ...redact import redact
    from .actions import run
    from .render import text
    from .state import Refusal

    fields = dict(arguments)
    fields.setdefault("what", "add")
    fields["code_is_text"] = True  # `code` is the Python text itself here; the CLI's --code names a file
    as_json = bool(fields.pop("json", False))
    try:
        answer = run(fields)
    except Refusal as exc:
        return redact(json.dumps(exc.to_json(), ensure_ascii=False, indent=1) if as_json else exc.text.rstrip("\n")) + "\n", True
    return redact(json.dumps(answer, ensure_ascii=False, indent=1) + "\n" if as_json else text(answer)), False


# -- the prompt -----------------------------------------------------------------------------------------------------

def first_section(text: str) -> str:
    """The text before the second heading: a leading ``#`` title is skipped, the first section kept with its own heading."""
    lines = text.splitlines()
    i = 0
    while i < len(lines) and (not lines[i].strip() or lines[i].startswith("# ")):
        i += 1
    body: list[str] = []
    for line in lines[i:]:
        if line.startswith("#") and any(l.strip() for l in body):
            break
        body.append(line)
    return "\n".join(body).strip()


def prompt_text(path: str | None = None) -> str:
    path = REVIEW_MD if path is None else path
    try:
        with open(path, "r", encoding="utf-8") as fh:
            section = first_section(fh.read())
    except OSError:
        section = ""
    return section + "\n" if section else BUILTIN_PROMPT


def prompts_list() -> list[dict]:
    return [{"name": PROMPT_NAME, "title": PROMPT_TITLE, "description": "The review method in about fifteen lines: start, the stops with --say, ask, try, finding add, fix, report; what each refuses and why.", "arguments": []}]


def prompts_get(params: Any) -> dict | None:
    """The ``prompts/get`` result for ``review``; None for any other name."""
    name = params.get("name") if isinstance(params, dict) else None
    if name != PROMPT_NAME:
        return None
    return {"description": PROMPT_TITLE, "messages": [{"role": "user", "content": {"type": "text", "text": prompt_text()}}]}


__all__ = ["tool_definition", "call_review", "prompt_text", "first_section", "prompts_list", "prompts_get", "PROMPT_NAME", "REVIEW_MD", "BUILTIN_PROMPT"]
