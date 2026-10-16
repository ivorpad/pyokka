# review: a change as a guided debug session

A review is a debug session whose sequence the tool owns. `review start --base REF [--repo DIR]
[--entry FILE | --test NODEID] [--pr FILE]` records the base and head trees through the entry
(`main.py` at the repo root when it exists), diffs the runs and plans the stops: the head steps
where behaviour changed (a raise, a type, a sign, a None, a print, a value), the changed lines no
run reached, and edge candidates `E1..En` with what to try. Every result opens with `review <id> ·
<phase> · stops K/N shown · findings F · tries T` and ends with `next:` and one command. `review
stop N --say TEXT` moves the person's view (page, VS Code or chat) to stop N and prints it as
`context` prints a step; TEXT has to name a value of the stop, and the refusal lists them.
One stop per message, then wait: the next `stop` needs `--go-on`, passed only after the person said
next; `review skip N --why TEXT` drops an agenda item they do not care about. The person asks, you
answer from the pause or the recording (`review look --expr EXPR`, `context`, `eval`, `peek`,
`locals`); `review ask FILE:LINE --say TEXT` is their question at a line outside the plan and never
needs `--go-on`. Before any claim,
`review try --code FILE | --expr EXPR [--edge E3]` reproduces it in the Scratchpad's sandbox, on the
page when one is open on the entry. `review finding add --file F --line L --severity
blocker|major|minor --title T --step N --repro ID|CMD --fix TEXT` needs a head step near L and a
try id, or a command whose output must contain `--expect`. `review fix --patch FILE.diff [--tests
CMD]` tries the patch on a copy of head, never in the repo. `review report [--out FILE]` opens with "What we looked at together" and refuses
while a finding lacks a reproduction, one no longer reproduces, or the tree changed since `start`;
`review state` is the plan with the shown stops marked. Through MCP the tool is `pyokka_review`,
`action` and the flags as fields.

## Surfaces

`--surface auto`, the default, takes the first that answers; `--port P` (default `$PYOKKA_PORT`,
else 4777) names the page, `--session NAME` the VS Code session. The page, open on the review's
entry, follows every stop as a `goto` with the `--say` text in its bubble, and a `try` runs as its
Scratchpad experiment, where the person sees it. A live debug session in VS Code gets `break
FILE:LINE --when COND` then `continue` per stop, COND from up to two locals of the stop whose text
is a literal, a plain breakpoint with none; a live recording session gets `step --live --to STEP`.
Only a session on the review's entry counts (`--session NAME` names another). When the person
watches VS Code and no session is open on the entry, start one before the first stop: `pyokka debug
ENTRY --record --cwd REPO` (MCP `pyokka_debug` `start` with `record`), let it finish, and the stops
move its Time Machine in any order; a debug session without `--record` runs forward only, so a stop
behind the pause ends the program and the view line says what reaches it. In chat nothing moves:
the stop's context prints and you explain it in that message; the view line of a stop that found no
page and no session names the command that opens one.

## Rules

- One stop per message while the person watches, then their turn; explain it from what the move
  printed. Finish clean (SKILL.md): remove the breakpoints `review stop` set; `pyokka stop --live`.
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
