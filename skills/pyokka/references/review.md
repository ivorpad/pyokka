# review: a change as a guided debug session

A review is a debug session whose sequence the tool owns, and you are the person's peer in it: you read
before you answer, you say where you are going before you go, and every claim rests on a value from a run.
`pyokka review start --base REF [--repo DIR] [--entry FILE | --test NODEID] [--only PATH...] [--pr FILE]`
plans one item per changed function from the diff and the untracked files (module-level and test-file
changes set aside, no breakpoint; `--only`'s files, directories or globs limit the diff read, and the
plan lists the changed files outside as not read), each with `uses:`, the repository code its changed
lines call (no breakpoint), and edge candidates `E1..En`, and starts the entry (`main.py` at the repo
root, or the test) under the debugger in the person's VS Code, paused on entry with a breakpoint on each
item; nothing of base runs. Its answer names the interpreter (`python:`; `--python` overrides it) and the
debug session (`session:`, the file `pyokka_debug` takes as `session`). Then the debugger is yours as in debug mode: `pyokka continue --live` (MCP `pyokka_debug continue`) reaches the next item; `step`,
`locals`, `eval` and `break` read and move the pause. `--full` is the recorded review instead: base and
head run to their ends, the stops planned where the runs differ, the view a recording in VS Code, the page
or chat (`--surface page|chat` implies it). Every result opens with `review <id> · <phase> · stops K/N
shown · findings F · tries T` and ends with `next:` and one command. Through MCP the tool is
`pyokka_review`, `action` and the flags as fields; in a shell every command below starts with `pyokka`.

Before `start`, read the change yourself (`git diff --stat BASE..HEAD`, `git log --format=%s
BASE..HEAD`, the hunks) and write one paragraph of what it does, by area. Then ask the person in
one call through the harness's question tool when it has one (Claude Code's AskUserQuestion, four
questions at most, the options drawn from the diff), else in the conversation, and their turn:
what the change is for, which areas first or left out, where to watch (VS Code, the page or chat),
and whether a finding ends the review or a fix in the repository does; confirm what the PR text
already answers. Then the plan: the changed functions by area, each with an exerciser (a test that
imports the module or names the function, `main.py` when it does, or none: read and `try` only),
ranked by their priorities and then by risk (an except path, a new parameter, a comparison
boundary, size). Items that share an exerciser form a session. Show the plan with that split and
wait: one session now or several is their word, and each session is a `start` with its exerciser
in its own `--dir`, since a second `start` in the same directory removes the first session's work.
The plan lives in your message and your scratch directory, never in the repository or the review directory.

`pyokka review stop [N] --say TEXT` records the pause the debugger is at as a stop: the item it belongs to
(an uncaught exception or a breakpoint of your own becomes an item), the frame's values, your text. It
prints the item's `change:` (base's removed lines, head's added ones, `>` at the pause), its `uses:`
line, the values on those lines and the other locals, and removes the item's breakpoint. Read the function first (`cat -n
FILE` on the head tree), then say what happens at the pause; TEXT has to name a value of the frame, and
the refusal lists them. One stop per message, then wait: the next `stop` needs `--go-on`, passed only
after the person said next, and reaching the next item is `pyokka continue --live`, not a review command.
`pyokka review skip N [N...] --why TEXT` drops agenda items they do not care about, all or none, and
removes their breakpoints. When the program ends, the items never paused at are the plan's unreached
lines; `pyokka review view vscode` starts it again with their breakpoints. In a `--full` review `stop N
--say TEXT` moves the person's view to the recorded step instead and prints it as `context` prints a step.

What the person says decides what you do, before you answer them:

- They ask whether something is right, enough or correct: read the whole function, then
  `pyokka review try --expr EXPR` or `--code FILE` with inputs that test the claim (the boundary,
  an empty value, the other branch). Answer with the try's result and the step that shows it.
- They ask what a value is or where it came from: `pyokka eval --live EXPR` at the pause (`review look
  --expr EXPR` in a `--full` review), `origin --live STEP EXPR` for its chain (quote the root), and for
  a recorded value cut to `…(+N chars)` or `{...}`, `why --live STEP NAME --rerun` (it runs the program again).
- They ask why the code is like this: `git log -L L,L:FILE` or `git blame` on the line, and the
  PR text; say which source answered.
- They ask about a line that is not a stop: `pyokka break --live FILE:LINE` then `pyokka continue
  --live`, and record the pause with `review stop --say TEXT` (`pyokka review ask FILE:LINE --say
  TEXT` in a `--full` review). Neither that, `eval` nor `try` needs `--go-on`.
- They say next: `pyokka continue --live` to the next item, then `review stop --say TEXT --go-on`.

Before each look, one line saying what you are about to look at. End each answer with what you
have not verified.

How you write to the person, in chat and in a `--say`: one idea per sentence, 20 words or fewer, active
voice, present tense, the actor named ("subtotal returns 0.0", not "0.0 is returned"). Tell them what to
do in the imperative ("Say next"). The same word for the same thing, always: stop, step, value, try,
finding, the person; never breakpoint, experiment, repro, variable or user for those. No -ing verb used as
a noun, no idiom, no "simply" or "obviously". A label with a colon is not a sentence. Numbers, names and
texts as the tool printed them, in code font. A list for parallel items, never a table. The answer first,
then the step and the value that show it, then what is not verified. A caution before the detail it
concerns. Six sentences per paragraph at most.

`pyokka review finding add --file F --line L --severity blocker|major|minor --title T --step N --repro
ID|CMD --fix TEXT` needs a head step near L and a try id, or a command whose output must contain
`--expect`. `pyokka review fix --patch FILE.diff [--tests CMD]` tries the patch on a copy of head, never
in the repo. `pyokka review report [--out FILE] [--page [FILE]] [--tour [FILE]]` opens with "What we
looked at together" and refuses while a finding lacks a reproduction, one no longer reproduces, or the
tree changed since `start`. `--page` writes the same as a code-history page (`history.json` for
`render-code-history.cjs`, [show.md](show.md)): one checkpoint per stop shown or line asked, the say as
its text, base's value beside head's in its note, a chain for a value that changed, a finding's severity
as its tag, then the tries as `try` cards. `--tour` writes it as a tour of head.json (`tour.json` for
`render-tour.cjs`): the stops as its picks in run order, the says as its prose, a say the tour's check
rejects falling back to the fact. `pyokka review state` is the plan with the shown stops marked.

## Surfaces

Where they want to watch is one of the questions before `start` (the method above), in one call
with the rest. `start` opens the view, and its answer says which in a `view:` line. The default is
the debugger in VS Code: the entry paused on entry with a breakpoint on each item, the debugger's
recording on for a program, and the person sees every pause in the editor. The rest of this section
is the `--full` review, the recorded one, whose view is a recording session on the entry in the
person's editor, run to its end with the head recording's interpreter, arguments and cwd, so each
stop moves its Time Machine. VS Code needs the `pyokka.agentAccess` setting on and the `code` command (on a Mac
`/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`); the first launch also asks
the person to let VS Code open the `ivor.pyokka` URI. An explicit `--surface vscode` with no live
Pyokka session and no `code` command is refused before recording. `--surface page` serves `pyokka web` on
`--port` and opens the browser tab; `start` checks the port before it records and refuses a taken
one. The review stops that server at `report` or `review close` (the VS Code recording stays).
`--surface chat`, or `$PYOKKA_REVIEW_SURFACE=chat`, opens nothing. A `--full` review of one `--test` stays in
chat whatever surface was asked: a VS Code session or a page runs a file as a program and not a
test, and a debug session of the test is another run, which the review does not move; a `stop
--surface vscode` or `page` on it is refused with `next:` the same stop in chat. When the view the
person asked for cannot open (a review of one test, a VS Code or page that does not answer), the
`view:` line says so. Tell them in one sentence, then go on in chat, where each stop prints the
same context, or ask which they prefer; their answer decides, not a workaround of yours. A test
file as `--entry` is refused: run as a program it defines its tests and runs none.

For `stop` and `ask`, `--surface auto`, the default, takes the first that answers; `--port P` (default `$PYOKKA_PORT`,
else 4777) names the page, `--session NAME` the VS Code session. The page, open on the review's
entry, follows every stop as a `goto` with the `--say` text in its bubble, and a `try` runs as its
Scratchpad experiment, where the person sees it. A live debug session in VS Code gets `break
FILE:LINE --when COND` then `continue` per stop, COND from up to two locals of the stop whose text
is a literal, a plain breakpoint with none; a live recording session gets `step --live --to STEP`.
Only a session on the review's entry counts (`--session NAME` names another).

`--surface vscode` or `--surface page` with nothing answering is refused: the stop stays unshown,
`--go-on` is not spent, and `next:` names `review view vscode` (or `page`) and the same stop to run
after it. `pyokka review view --surface vscode|page|chat` opens the view after `start`, when `start`
opened none or the person moved: `vscode` records the entry in VS Code as the review's run, and the
stops then move its Time Machine in any order; `page` serves the browser page, whose URL the person
opens in one tab; `chat` closes the page. A recording session on the entry whose step count is not
the head recording's is another run (other arguments or cwd, a changed file) and is refused the same
way, never moved: the review's step numbers mean nothing in it. A debug session of the person's own,
without `--record`, runs forward only, so a stop behind the pause ends the program and the view line
says what reaches it. `auto` with nothing answering shows the stop in chat: the `view:` line says
`chat (not moved)` and `next:` says the person saw it only in chat, with `review view vscode` for the
next one. In chat, explain the stop's printed context in your message.

## Rules

- One stop per message while the person watches, then their turn; explain it from what the move
  printed. Finish clean (SKILL.md): `review close` or `report` removes the review's breakpoints while its
  debug session answers and stops the page server `start` opened; in a `--full` review remove the
  breakpoints `review stop` set yourself; `pyokka stop --live`.
- A review waits for the person where SKILL.md's "How a turn ends" says to, chiefly after a shown
  stop, for their `next`. Everything else is the next command, not a question.
- Nothing is written inside the repository. The review lives in `--dir`, default
  `$PYOKKA_HOME/reviews/<repo-name>-<base7>/`; a patch or repro script of your own goes in your
  scratch directory.
- Through MCP, pass absolute paths (`repo`, `entry`, `pr`, `code`, `patch`, `out`, `dir`). The tool
  keeps the current review in `$PYOKKA_HOME/reviews/current`; `dir` can be left out after `start`.

## Gotchas

- A bug read off the diff is a guess until the program paused there (a `review stop`, or a step of
  the recording) and it has a reproduction; `finding add` refuses it without both, however handy the
  checklist of changed functions is. A line the run never paused at takes a try once the program
  ended.
- The review does not run the program: `review stop` without `--say` is refused, and reaching the
  next item is `pyokka continue --live`. A `--test` entry runs through its runner with no recording,
  so a passed item needs `review view vscode` to run again.
- `review try` puts the head tree on the sandbox's `sys.path`. A repro script you record yourself
  from outside the repo sees the project as library code and records nothing of it: `pyokka run
  SCRATCH/repro.py --cwd REPO --save SCRATCH/repro.json`.
- A command reproduction says what to look for: `--repro CMD` without `--expect TEXT` is refused.
  Write `--expect` as `NAME=VALUE` when `fix` should mark the finding PASS or FAIL.
- A second `start` on the same base in the same `--dir` removes the first session's recordings,
  tries and findings. One `--dir` per session, such as `$PYOKKA_HOME/reviews/<repo>-<base7>-<k>`,
  and the plan itself in your scratch directory: a directory with content and no `review.json`
  is refused by `start`.
- A session whose files hold no changed function (constants, imports, module-level code, tests)
  still starts, with an empty agenda. Put your plan's lines on it with `pyokka break --live
  FILE:LINE`, reach each with `pyokka continue --live` and record it with `review stop --say TEXT`,
  or read the change and `review try`.
