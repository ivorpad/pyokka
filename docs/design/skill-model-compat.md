# The pyokka skill against GPT-6, Claude Opus 5.5 and Claude Fable 5.1 (2026-10-16)

Read, not run. The skill was set against the vendors' own pages on 2026-10-16 and edited where a
page gave a reason. No model was run on it for this change, and the 0.5.0 reader-turn runs used
Sonnet 5.5, so every statement below about how a model behaves is the vendor's. The last section
lists ten minutes of checks that would show where a reading is wrong.

## Sources

OpenAI: [Using GPT-6](https://developers.openai.com/api/docs/guides/latest-model), which holds the
prompting best practices and the migration quickstart, [Reasoning](https://developers.openai.com/api/docs/guides/reasoning)
and [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra). The Codex pages moved
from developers.openai.com/codex to learn.chatgpt.com (the old addresses redirect):
[skills](https://learn.chatgpt.com/docs/build-skills), [models](https://learn.chatgpt.com/docs/models),
[config reference](https://learn.chatgpt.com/docs/config-file/config-reference),
[subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents),
[AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md),
[non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) and
[MCP](https://learn.chatgpt.com/docs/extend/mcp). OpenAI's own
[openai-docs skill](https://github.com/openai/codex/tree/main/codex-rs/skills/src/assets/samples/openai-docs)
in the Codex repository carries its GPT-6 upgrade method.

Anthropic: [Prompting Claude Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5),
[Prompting Claude Fable 5.1](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1),
[Prompting Claude Fable 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5),
[What's new in Claude Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5),
its [migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide),
[What's new in Claude Fable 5.1](https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1),
the [prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices),
[Agent Skills best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices),
Claude Code's [skills](https://code.claude.com/docs/en/skills) and
[model configuration](https://code.claude.com/docs/en/model-config) pages, and the
[Agent Skills specification](https://agentskills.io/specification).

## The models

| | Claude Opus 5.5 | Claude Fable 5.1 | GPT-6 family |
|---|---|---|---|
| ID | `claude-opus-5-5` | `claude-fable-5-1` | `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`, `gpt-6-sol` |
| runs the skill in | Claude Code, `/model opus` (2.1.280 or later) | Claude Code, `/model fable` (2.1.257 or later, not any plan's default) | Codex, `-m` or `/model` |
| default effort | medium | high | medium for Sol and Luna, none stated for Astra |
| thinking | always on, cannot be disabled | always on, cannot be disabled | effort `low` to `max`; Astra and 6.1 Sol reject `none` |
| context | 1M | 1M | 1.05M |

Codex's models page recommends `gpt-6.1-sol` for complex coding and agentic work and says to start
with Light for Astra (`low` in `config.toml`) and High for Luna. OpenAI says its GPT-6 prompts
"address behavior observed with GPT-6 Astra", so what follows about GPT-6 may differ on Sol and Luna.

## What the pages say that reaches a skill

| the page says | where | where it meets the skill |
|---|---|---|
| GPT-6 "can be more sensitive to instructions contained in skills and other files, such as `AGENTS.md`", and "unclear or conflicting guidance in a skill file may cause the model to pause and block work early. Make the priority of user instructions and skills explicit." | Using GPT-6 | The audit below. SKILL.md now says the person's instruction beats it. |
| Early stops. GPT-6 "likes to ask non-blocking questions". Fable 5.1 "describes what it would do next instead of doing it" or asks "Shall I apply this?". Opus 5.5 ends some turns with text instead of a tool call. The vendors' fix is an autonomy paragraph in the system prompt. Anthropic says to leave it out of human-in-the-loop applications, to name the stops you do want, and that it "can also make the model less likely to ask about ambiguous requests". | Using GPT-6, Prompting Claude Fable 5.1, Prompting Claude Opus 5.5 | "How a turn ends" in SKILL.md, which names the four turns that do end early. Check 4. |
| On the API Opus 5.5 returns the text between tool calls as `thinking` blocks, empty at the default display, so "an application that streams that text to its users as progress updates goes quiet between tool calls". Fable 5.1 does the same and "writes fewer user-facing updates". | Opus 5.5 migration guide, What's new in Fable 5.1 | `explain` leans on that text when asked for several stops (the 0.5.0 changelog). Unchanged. Check 1. |
| At `low` effort Fable 5.1 "is less likely than Claude Fable 5 to call a search or retrieval tool, and more likely to answer from memory". | Prompting Claude Fable 5.1 | One sentence at the end of "The two products": say what the program did only after a command printed it. Check 5. |
| Prompts, skills and tool descriptions that ask a model to write out its reasoning "may be declined with the `reasoning_extraction` category". | the Opus 5.5, Fable 5.1 and Fable 5 guides | No such wording in the skill (grepped). `test_skill_coverage.py` keeps it that way. |
| GPT-6 "tends to use lists, tables and Markdown", and the page says to state a preference for prose. Fable 5.1 writes denser prose with fewer paragraph breaks and reaches for headers and lists less. | Using GPT-6, Prompting Claude Fable 5.1 | One line in `explain.md`, Words: plain sentences, no headings, bullets or tables unless Visuals calls for one. |
| GPT-6 can write "broader tests than the task requires". Fable 5.1 may "commit more test files than the change warrants". | the same two pages | Already covered by "Stay out of the user's project" in SKILL.md. |
| GPT-6 "may delegate less often than desired". Codex spawns subagents "after a direct request or applicable project or skill instruction". Fable 5 "dispatches parallel subagents more readily than prior models". | Using GPT-6, Codex subagents, Prompting Claude Fable 5 | The skill never tells an agent to delegate. A second agent driving the same `--live` session would move the first one's cursor. Check 6. |
| After compaction Claude Code keeps "the first 5,000 tokens" of an invoked skill and says to "put the most important instructions near the top of `SKILL.md`". | Claude Code, Skills | The turn rules live in SKILL.md, not in a mode file, and a test keeps SKILL.md small. The page does not say what happens to files a skill points to. They are ordinary tool output, so compaction can summarize them away. That is my reading, not the page's. |
| Codex gives an MCP tool 60 seconds (`tool_timeout_sec`) and server start 10 seconds (`startup_timeout_sec`) unless the config sets them. | Codex config reference | `mcp.md` says so beside the Codex config. |

## Where the skill stood

It had no model IDs, no wording that asks for reasoning, a firm rule to stay out of the person's
repository, and pauses that are real blockers: two modes fit, a database no test reaches, a prompt
only the person can answer. Six gaps:

- Nothing said which turns end on purpose. The reader-turn rules lived in `explain.md` and
  `review.md` only.
- `debug.md` offers the page in one line after a finding. A blanket rule against offers would
  contradict it, and contradiction is what the GPT-6 page says the model stalls on.
- SKILL.md said "Read only that file up front", while its Read-next table sent `explain` to
  `sessions.md` "before the first `--live` command" and `explain` starts with `state --live`.
- `explain.md` limited the length of a message but not its shape.
- `AGENTS.md` listed three modes, not four.
- `mcp.md` gave Codex's config block without the two timeouts.

## What changed

| file | change |
|---|---|
| `skills/pyokka/SKILL.md` | "How a turn ends": run the next command, end on the deliverable, and the four cases that end a turn early. The person's explicit instruction beats the skill. A sentence that says what the program did comes from a command. "Read only that file up front" became "Read that file first; the Read-next table below says when to open another." |
| `skills/pyokka/references/explain.md` | Words: plain sentences, no headings, bullets or tables unless Visuals calls for one. |
| `skills/pyokka/references/review.md` | Rules: the same turn rule, in one line. |
| `skills/pyokka/references/mcp.md` | Codex's config block names `tool_timeout_sec` and `startup_timeout_sec`. |
| `AGENTS.md` | The `review` mode. |
| `python/tests/test_skill_coverage.py` | No file of the skill asks for reasoning to be written out. SKILL.md stays under 500 lines and 15,000 characters and its description under 1,024 characters. SKILL.md has the "How a turn ends" heading. |

One choice in "How a turn ends" is deliberate. Its first bullet says "one stop per message, or as many
as they ask for", because `explain.md` already tells the agent to explain each stop before the next
move when the person asks for several. A flat "one stop per message" would have contradicted it.

## Left alone

No `model:` or `effort:` in the frontmatter. Claude Code lets a skill set both for its turn, but the
person picks the model, and the defaults differ (Opus 5.5 medium, Fable 5.1 high) with Anthropic
telling you to test the other levels against your own evals. No `compatibility:` field either: the
spec allows 500 characters of it and Claude Code accepts it without acting on it. `agents/openai.yaml`
already has the shape Codex documents. `evals/evals.json` is as it was, since nothing was run.

Not added for want of a failure: a one-driver-per-session line for subagents, a hint to batch
independent reads, and a trim of the process rules for Fable. Anthropic's Fable 5 page says skills
written for earlier models "are often too prescriptive" and to remove instructions if the default
does better. Most of this skill is tool facts a model cannot know, so a trim would start with the
process rules, not the flags, and only after a run shows the default doing as well.

`pyokka narrate` and `pyokka tour` call `claude -p` and `codex exec` with no model or effort flag.
They now take whatever the person's CLI defaults to, a larger and slower model than a one-sentence
gloss needs. Passing a model or effort there is a separate change.

## Checks for a person

About ten minutes, each with the edit that answers it.

1. In Claude Code run `/model opus`, then `/pyokka explain examples/rrf/demo.py`, then say "keep
   going, three more stops". Repeat with `/model fable`. Are three explanations on screen, in order,
   each before its move? If not, move them into the last message of the turn, one short paragraph per
   stop with its `#step`. That gives up explaining before each move, which 0.5.0 chose on purpose, so
   do it only if the text really is hidden.
2. In Codex on `gpt-6-astra` run `$pyokka explain examples/rrf/demo.py`. Does it pause or ask
   before the first stop? Put the transparency prompt from "Instruction following" on the GPT-6 page
   in a scratch `AGENTS.md` and it names the SKILL.md line behind the pause. Reword that line.
3. Run `/pyokka debug create_design` in VS Code on both Claude models and `$pyokka debug` in Codex.
   Does it ask before starting the debugger? The new block should have ended that. If it did not,
   the line it cites is the one to change.
4. Try a request that fits two modes ("walk me through why C ranks first") and one for code that needs
   a service no test reaches. Both should still get a question. Anthropic warns the autonomy wording
   can silence questions about ambiguous requests. If it did, narrow "Run the next command" and add
   nothing.
5. Run `/effort low` on `/model fable`, then `/pyokka show why is contribution 0.0159`. Does it run
   `pyokka why` or work the number out from the source? If it works it out, move the evidence
   sentence up into "How a turn ends".
6. Watch for a run that hands `--live` commands to a subagent while another agent drives. If one
   does, add a line saying one agent drives a session.

## When the next model ships

Read its prompting page and Claude Code's model configuration page (for the alias and the default
effort), run the checks above, and change the skill only for what fails. OpenAI's upgrade skill
puts it the same way: no "blind model-string replacement", and "a surgical prompt edit tied to that
failure" instead of a rewrite of a working prompt.
