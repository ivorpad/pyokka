"""Narration: one batched model call adds a sentence of gloss per walkthrough moment (never automatic).

The prompt is ``narrate_prompt.md`` (shared with the host) filled with the walkthrough JSON
(values redacted) and the source of the user functions the moments touch. The backend is a
command that reads the prompt on stdin: ``pyokka.explain.command`` / ``--command`` when set,
else ``claude -p --output-format json`` when ``claude`` is on the PATH, else ``codex exec``
with its last message written to a file. The answer must be a JSON object ``{id: sentence}``;
anything else keeps ``gloss: null`` and reports the error once. No API keys anywhere.
"""

from __future__ import annotations

import copy
import json
import os
import shlex
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ..redact import redact, redact_value
from .decisions import file_map
from .source import AgentError, display_path
from .walkthrough import is_user_file

if TYPE_CHECKING:
    from .source import SavedRun

PROMPT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "narrate_prompt.md")
GLOSS_MAX = 140
SOURCE_LINES_MAX = 200
SOURCE_FUNCTIONS_MAX = 20
TIMEOUT_S = 180.0
CLAUDE_ARGS = ["-p", "--output-format", "json", "--tools", "", "--no-session-persistence"]
CODEX_ARGS = ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--color", "never", "-o"]


class NarrationError(Exception):
    def __init__(self, message: str, hint: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint


@dataclass
class Backend:
    name: str  # claude | codex | custom
    argv: list[str]
    output_file: str | None = None  # codex writes its last message here
    cwd: str | None = None


def resolve_backend(command: str | None = None, *, which: Any = shutil.which) -> Backend | None:
    """The command to run: the explicit one, else ``claude``, else ``codex``; ``None`` when neither exists."""
    if command and command.strip():
        return Backend("custom", shlex.split(command))
    if which("claude"):
        return Backend("claude", ["claude", *CLAUDE_ARGS])
    if which("codex"):
        out = os.path.join(tempfile.mkdtemp(prefix="pyokka-narrate-"), "last-message.md")
        return Backend("codex", ["codex", *CODEX_ARGS, out, "-"], output_file=out)
    return None


def run_backend(backend: Backend, prompt: str, *, timeout: float = TIMEOUT_S, run: Any = subprocess.run) -> str:
    """The model's answer text (``claude``'s ``result`` field, ``codex``'s last message, a custom command's stdout)."""
    cwd = backend.cwd or (tempfile.mkdtemp(prefix="pyokka-narrate-") if backend.name != "custom" else None)
    try:
        proc = run(backend.argv, input=prompt, capture_output=True, text=True, timeout=timeout, cwd=cwd)
    except FileNotFoundError:
        raise NarrationError("%s is not on the PATH" % backend.argv[0], "install it, or set pyokka.explain.command / --command to a command that reads the prompt on stdin") from None
    except subprocess.TimeoutExpired:
        raise NarrationError("%s took longer than %d s" % (backend.argv[0], int(timeout)), "try again, or a faster model in --command") from None
    if proc.returncode != 0:
        raise NarrationError("%s exited with %s: %s" % (backend.argv[0], proc.returncode, redact((proc.stderr or proc.stdout or "").strip()[-400:])), "run the command by hand to see why")
    if backend.output_file:
        try:
            with open(backend.output_file, "r", encoding="utf-8") as fh:
                return fh.read()
        except OSError:
            raise NarrationError("%s wrote no last message" % backend.argv[0], "check `codex exec --help` for the -o flag") from None
    text = proc.stdout or ""
    if backend.name == "claude":
        try:
            doc = json.loads(text)
        except ValueError:
            return text
        if isinstance(doc, dict):
            if doc.get("is_error"):
                raise NarrationError("claude reported an error: %s" % redact(str(doc.get("result") or ""))[:300], "run `claude -p` by hand to see why")
            if isinstance(doc.get("result"), str):
                return doc["result"]
    return text


def extract_json_object(text: str) -> dict:
    """The first JSON object in ``text`` (models wrap answers in fences and prose); ``ValueError`` when none parses."""
    start = text.find("{")
    while start >= 0:
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(text)):
            c = text[i]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
                continue
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    try:
                        doc = json.loads(text[start : i + 1])
                    except ValueError:
                        break
                    if isinstance(doc, dict):
                        return doc
                    break
        start = text.find("{", start + 1)
    raise ValueError("no JSON object in the answer")


def parse_glosses(answer: str, ids: list[str]) -> dict[str, str]:
    """Strict: a JSON object whose values are strings; unknown ids dropped, sentences cut at 140 chars."""
    try:
        doc = extract_json_object(answer)
    except ValueError as exc:
        raise NarrationError("the model did not answer with a JSON object (%s)" % exc, "the answer started: %s" % redact(answer.strip()[:120])) from None
    wanted = set(ids)
    out: dict[str, str] = {}
    for key, value in doc.items():
        if key not in wanted:
            continue
        if not isinstance(value, str):
            raise NarrationError("the gloss for %s is not a string" % key, "the model must answer {id: sentence}")
        s = " ".join(value.split())
        if s:
            out[key] = s if len(s) <= GLOSS_MAX else s[: GLOSS_MAX - 1] + "…"
    if not out:
        raise NarrationError("the answer glossed none of the %d moments" % len(ids), "the keys must be the moment ids (m0, m1, …)")
    return out


# -- the prompt --------------------------------------------------------------------------------------------------

def prompt_template() -> str:
    with open(PROMPT_FILE, "r", encoding="utf-8") as fh:
        return fh.read()


def build_prompt(template: str, walkthrough: dict, sources: list[dict]) -> str:
    """Fill the template: the moments (redacted) and ``[{"file", "function", "line", "text"}]`` source blocks."""
    doc = redact_value(copy.deepcopy({"moments": [{k: v for k, v in m.items() if k in ("id", "step", "kind", "text", "values", "location")} for m in walkthrough["moments"]]}))
    for m in doc["moments"]:
        loc = m.get("location") or {}
        m["location"] = {"file": os.path.basename(str(loc.get("file") or "")), "line": loc.get("line"), "function": loc.get("function")}
    # source is code, but a literal typed under an innocent name must not reach a model either
    blocks = ["### %s: %s (line %d)\n\n```python\n%s\n```" % (s["file"], s["function"], s["line"], redact(s["text"])) for s in sources] or ["(no user source available)"]
    return template.replace("{{walkthrough}}", json.dumps(doc, ensure_ascii=False, indent=1)).replace("{{sources}}", "\n\n".join(blocks))


def collect_sources(run: "SavedRun", moments: list[dict]) -> list[dict]:
    """The user functions the moments touch (≤ 200 lines each, ≤ 20 functions), the module first."""
    main = str(run.meta.get("file") or "")
    seen: set[tuple[int, str]] = set()
    out: list[dict] = []
    maps: dict[int, dict] = {}

    def add(fid: int, function: str) -> None:
        if fid < 0 or (fid, function) in seen or len(out) >= SOURCE_FUNCTIONS_MAX:
            return
        path = run.file_path(fid)
        if not is_user_file(path, run.workspace_root, main):
            return
        lines = run.source_lines(fid)
        if not lines:
            return
        if fid not in maps:
            maps[fid] = file_map("\n".join(lines))
        if function == "<module>":
            start, end = 1, min(len(lines), SOURCE_LINES_MAX)
        else:
            fn = next((f for f in maps[fid]["functions"].values() if f["name"] == function), None)
            if fn is None:
                return
            start, end = fn["line"], min(fn["end"], fn["line"] + SOURCE_LINES_MAX - 1)
        seen.add((fid, function))
        out.append({"file": display_path(path, run.workspace_root), "function": function, "line": start, "text": "\n".join(lines[start - 1 : end])})

    for m in moments:
        loc = m.get("location") or {}
        add(int(loc.get("fileId", -1)), str(loc.get("function") or "<module>"))
        callee = m.get("callee") or {}
        if callee:
            add(int(callee.get("fileId", -1)), str(callee.get("function") or ""))
    return out


# -- the command -------------------------------------------------------------------------------------------------

def narrate_saved(run: "SavedRun", *, command: str | None = None, dry_run: bool = False, backend: Backend | None = None) -> dict:
    from .walkthrough import walkthrough

    result = walkthrough(run)
    ids = [m["id"] for m in result["moments"]]
    if not ids:
        raise AgentError("nothing to narrate: the run recorded no moments", "see `pyokka state`")
    prompt = build_prompt(prompt_template(), result, collect_sources(run, result["moments"]))
    if dry_run:
        return {"prompt": prompt, "moments": len(ids)}
    backend = backend or resolve_backend(command)
    if backend is None:
        raise AgentError("no narration backend: neither claude nor codex is on the PATH", "install one, or pass --command 'your-model-cli' (prompt on stdin, JSON on stdout)")
    try:
        glosses = parse_glosses(run_backend(backend, prompt), ids)
    except NarrationError as exc:
        raise AgentError("narration failed: %s" % exc.message, exc.hint) from None
    run.meta["walkthroughGloss"] = glosses
    write_meta(run)
    return {"path": run.path, "backend": backend.name, "moments": len(ids), "glossed": len(glosses), "gloss": glosses}


def write_meta(run: "SavedRun") -> None:
    tmp = run.path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"meta": run.meta, "events": run.events}, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    os.replace(tmp, run.path)


__all__ = ["Backend", "NarrationError", "resolve_backend", "run_backend", "extract_json_object", "parse_glosses", "build_prompt", "collect_sources", "narrate_saved", "prompt_template", "GLOSS_MAX"]
