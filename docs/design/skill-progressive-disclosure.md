# The pyokka skill against the Claude Code and Codex skill guides (2026-10-16)

Sources read: Anthropic's skill-creator guidance (the three loading tiers: metadata always in context,
the SKILL.md body when the skill triggers, bundled resources as needed; keep SKILL.md under 500
lines; point at reference files with "read this when"; a table of contents for references over 300
lines; one reference per variant; a description that carries every "when to use"; imperative,
explain why), and OpenAI's "Build skills" page for ChatGPT and Codex (skills in `.agents/skills`
from the working directory up to the repository root, in `$HOME/.agents/skills`, `/etc/codex/skills`
and the bundled set; name and description, plus the path in Codex, are the only things in context
before use; the initial list is capped at 2% of the context window or 8,000 characters and
descriptions are shortened first, so trigger words go first; `$pyokka` invokes explicitly,
`agents/openai.yaml` sets `policy.allow_implicit_invocation`, `interface` fields for the app, and
`dependencies.tools` of type `mcp` over `streamable_http`; `name` and `description` are the only
frontmatter fields it documents).

## Where the skill stands

| tier | today | guide |
|---|---|---|
| metadata | 703-character description, modes named, trigger verbs late in the text; `argument-hint` and `disable-model-invocation` (Claude Code only); `agents/openai.yaml` with `allow_implicit_invocation: false` and nothing else | front-load the use case and the trigger words (Codex may shorten the text); add `interface.display_name` and `short_description` for the ChatGPT and Codex apps |
| SKILL.md body | 305 lines: mode table (tier 2 done right), the two products, then about 200 lines of operation detail: the MCP route and a 20-row CLI-to-tool table, runtime and editor discovery, sessions, the browser page, the Claude Code band, rules | under 500 is met; the detail blocks are read on every invocation whether or not they apply (the band block in Codex, the setup block when `pyokka -h` works, the page block in a VS Code session) and belong in tier 3 with a one-line pointer each |
| references | debug.md 207, explain.md 188, show.md 168, review.md (new), live-debugger.md 304, pyokka-cli.md 710, mcp.md 69, code-history.md 189, tour-prompt.md 88 | pyokka-cli.md and live-debugger.md need a table of contents at the top; mcp.md already holds the tool table SKILL.md repeats |
| scripts and assets | scripts/pyokka.sh, render-*.cjs, templates/ | fine: executed, never loaded |
| evals | evals/evals.json with four prompts | add the review mode's reader-turn cases |

## The restructure (stream D, after the review-mode text lands)

SKILL.md keeps about 120 lines:

1. Frontmatter. Description rewritten to lead with the triggers: "Debug, explain, review or show
   what Python code does, with a recording or a live debugger the person watches (Pyokka). Use it
   when asked to step, break, pause, walk through, review a PR or diff, or show why a value is
   what it is. Modes: debug, explain, show, review." Then the current sentences. Same meaning,
   trigger words first, under 700 characters.
2. "Pick the mode": the table with the four rows and the verb paragraph. Unchanged.
3. "The two products": unchanged, it is what every mode needs.
4. "Tools": six lines. MCP tools when present, else `mcporter`, else the CLI; absolute paths over
   MCP; the argument table is in references/mcp.md.
5. "Read next": one table, the only new section. `references/setup.md` when `pyokka -h` fails or the
   editor launcher is missing; `references/sessions.md` before the first `--live` command; the
   browser page section of pyokka-cli.md when the person is on the page; `references/band.md` when
   the `band` tool is in the tool list; live-debugger.md when a debug command fails; pyokka-cli.md
   for a JSON shape.
6. The rules, trimmed: stay out of the project, staleness and secrets, finish clean. These apply
   to every mode and are short.

New references, text moved not rewritten: setup.md (runtime discovery, the `code` launcher,
registering the MCP server), sessions.md (saved run, debug session is made, recording session is
the user's, keep the session, breakpoints outlive, look with reads, sandboxes), band.md (the Claude
Code band). The MCP table moves into mcp.md's existing table (merge, no duplicate rows). Tables of
contents at the top of pyokka-cli.md and live-debugger.md.

`agents/openai.yaml` gains `interface.display_name: Pyokka` and a `short_description`; no
`dependencies.tools` entry, since the page documents only `streamable_http` servers and ours is
stdio. README: the Codex symlink target becomes `~/.agents/skills/pyokka` (the documented user
location; `~/.codex/skills` is not on the page), with `.agents/skills/pyokka` inside a repository
as the project-local option; Claude Code keeps `~/.claude/skills` and gains `.claude/skills` for a
project.

Acceptance: `python/tests/test_skill_coverage.py` still green; a Codex session started in a
repository with `.agents/skills/pyokka` linked lists the skill with the new first sentence; a
`claude -p` run of the smoke's reader turns reaches the stops with SKILL.md plus review.md only,
no other reference loaded unless its trigger applies.
