# review: a change as a guided debug session

A review is a debug session whose sequence the tool owns, and you are the person's peer in it:
you read before you answer, you say where you are going before you go, and every claim rests on
a value from a run. `pyokka review start --base REF [--repo DIR] [--entry FILE | --test NODEID]
[--pr FILE] [--surface vscode|page|chat]` records the base and head trees through the entry
(`main.py` at the repo root when it exists), opens the person's view (below), diffs the runs and
plans the stops: the head steps where behaviour changed (a raise, a type, a sign, a None, a
print, a value), the changed lines no run reached, and edge candidates `E1..En` with what to try.
Every result opens with `review <id> · <phase> · stops K/N shown · findings F · tries T` and ends
with `next:` and one command. Through MCP the tool is `pyokka_review`, `action` and the flags as
fields; in a shell every command below starts with `pyokka`.

`pyokka review stop N --say TEXT` moves the person's view (page, VS Code or chat) to stop N and
prints it as `context` prints a step: the lines this block ran, not the function. Read the
function first (`cat -n FILE` on the head tree), then say what happens at the stop; TEXT has to
name a value of the stop, and the refusal lists them. One stop per message, then wait: the next
`stop` needs `--go-on`, passed only after the person said next; `pyokka review skip N --why TEXT`
drops an agenda item they do not care about.

What the person says decides what you do, before you answer them:

- They ask whether something is right, enough or correct: read the whole function, then
  `pyokka review try --expr EXPR` or `--code FILE` with inputs that test the claim (the boundary,
  an empty value, the other branch). Answer with the try's result and the step that shows it.
- They ask what a value is, or where it came from: `pyokka review look --expr EXPR` at the
  current step, or `pyokka origin DIR/head.json STEP EXPR` for the chain back to its source;
  quote the chain's root.
- They ask why the code is like this: `git log -L L,L:FILE` or `git blame` on the line, and the
  PR text; say which source answered.
- They ask about a line that is not a stop: `pyokka review ask FILE:LINE --say TEXT`. Neither
  `ask`, `look` nor `try` needs `--go-on`.
- They say next: the next stop, with `--go-on`.

Before each look, one line saying what you are about to look at. End each answer with what you
have not verified.

How you write to the person, in chat and in a `--say`: one idea per sentence, 20 words or fewer,
active voice, present tense, the actor named ("subtotal returns 0.0", not "0.0 is returned").
Tell them what to do in the imperative ("Say next"). The same word for the same thing, always:
stop, step, value, try, finding, the person; never breakpoint, experiment, repro, variable or
user for those. No -ing verb used as a noun, no idiom, no "simply" or "obviously". A label with a
colon is not a sentence. Numbers, names and texts as the tool printed them, in code font. A list
for parallel items, never a table. The answer first, then the step and the value that show it,
then what is not verified. A caution before the detail it concerns. Six sentences per paragraph
at most.

`pyokka review finding add --file F --line L --severity blocker|major|minor --title T --step N
--repro ID|CMD --fix TEXT` needs a head step near L and a try id, or a command whose output must
contain `--expect`. `pyokka review fix --patch FILE.diff [--tests CMD]` tries the patch on a copy
of head, never in the repo. `pyokka review report [--out FILE] [--page [FILE]] [--tour [FILE]]`
opens with "What we looked at together" and refuses while a finding lacks a reproduction, one no
longer reproduces, or the tree changed since `start`. `--page` writes the same as a code-history
page (`history.json` for `render-code-history.cjs`, [show.md](show.md)): one checkpoint per stop
shown or line asked, the say as its text, base's value beside head's in its note, a chain for a
value that changed, a finding's severity as its tag, then the tries as `try` cards. `--tour`
writes it as a tour of head.json (`tour.json` for `render-tour.cjs`): the stops as its picks in
run order, the says as its prose, a say the tour's check rejects falling back to the fact.
`pyokka review state` is the plan with the shown stops marked.

## Surfaces

Ask the person where they want to watch before `start`. `start` opens the view, and its answer says
which in a `view:` line. The default is VS Code: a recording session on the entry in the person's
editor, run to its end with the head recording's interpreter, arguments and cwd, so each stop moves
its Time Machine. VS Code needs the `pyokka.agentAccess` setting on and the `code` command (on a Mac
`/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`); the first launch also asks
the person to let VS Code open the `ivor.pyokka` URI. An explicit `--surface vscode` with no live
Pyokka session and no `code` command is refused before recording. `--surface page` serves `pyokka web` on
`--port` and opens the browser tab; `start` checks the port before it records and refuses a taken
one. The review stops that server at `report` or `review close` (the VS Code recording stays).
`--surface chat`, or `$PYOKKA_REVIEW_SURFACE=chat`, opens nothing. A review of one `--test` stays in
chat, since VS Code records files. When a view did not open, the `view:` line says why and names
both commands that open one.

For `stop` and `ask`, `--surface auto`, the default, takes the first that answers; `--port P` (default `$PYOKKA_PORT`,
else 4777) names the page, `--session NAME` the VS Code session. The page, open on the review's
entry, follows every stop as a `goto` with the `--say` text in its bubble, and a `try` runs as its
Scratchpad experiment, where the person sees it. A live debug session in VS Code gets `break
FILE:LINE --when COND` then `continue` per stop, COND from up to two locals of the stop whose text
is a literal, a plain breakpoint with none; a live recording session gets `step --live --to STEP`.
Only a session on the review's entry counts (`--session NAME` names another).

`--surface vscode` or `--surface page` with nothing answering is refused: the stop stays unshown,
`--go-on` is not spent, and `next:` names the command that starts the view and the same stop to run
after it. To start VS Code yourself run `pyokka debug ENTRY --record --cwd REPO` (MCP: `pyokka_debug`
`{"action": "start", "file": ENTRY, "record": true, "cwd": REPO}`) and let it finish; the stops then
move its Time Machine in any order. For the page run `pyokka web ENTRY --cwd REPO` (MCP:
`pyokka_page` `{"action": "open", "file": ENTRY, "cwd": REPO}`) and have the person open its URL in
one browser tab. A debug session without `--record` runs forward only, so a stop behind the pause
ends the program and the view line says what reaches it. `auto` with nothing answering shows the
stop in chat: the `view:` line says `chat (not moved)` and `next:` says the person saw it only in
chat, with the command that starts VS Code. In chat, explain the stop's printed context in your
message.

## Rules

- One stop per message while the person watches, then their turn; explain it from what the move
  printed. Finish clean (SKILL.md): remove the breakpoints `review stop` set; `pyokka stop --live`. `review report` stops the page server `start` opened.
- A review waits for the person where SKILL.md's "How a turn ends" says to, chiefly after a shown
  stop, for their `next`. Everything else is the next command, not a question.
- Nothing is written inside the repository. The review lives in `--dir`, default
  `$PYOKKA_HOME/reviews/<repo-name>-<base7>/`; a patch or repro script of your own goes in your
  scratch directory.
- Through MCP, pass absolute paths (`repo`, `entry`, `pr`, `code`, `patch`, `out`, `dir`). The tool
  keeps the current review in `$PYOKKA_HOME/reviews/current`; `dir` can be left out after `start`.

## Gotchas

- `start` has already recorded both trees and the stops come from its plan. A bug read off the
  diff is a guess until it has a step of `head.json` and a reproduction; `finding add` refuses it
  without both, however handy the checklist of changed functions is.
- `review try` puts the head tree on the sandbox's `sys.path`. A repro script you record yourself
  from outside the repo sees the project as library code and records nothing of it: `pyokka run
  SCRATCH/repro.py --cwd REPO --save SCRATCH/repro.json`.
- A command reproduction says what to look for: `--repro CMD` without `--expect TEXT` is refused.
  Write `--expect` as `NAME=VALUE` when `fix` should mark the finding PASS or FAIL.
