# In Claude Code: the band

Read this when the `band` tool (`mcp__pyokka-band__band`) is in your tool list; the last paragraph
is for a Claude Code session without it.

When `printenv CLAUDECODE` prints `1`, you run inside Claude Code, and the Pyokka band can show
the person what the Time Machine shows: the code around the current step, its recorded values, the
call stack, a two-sentence explanation and the bugs found in the run, above their prompt. It reads
the same `--live` session your commands drive.

- Call the `band` tool (`mcp__pyokka-band__band`) with `{"action": "show"}` when you start to step
  through a run with the person, and with `{"action": "hide"}` when the work moves on (planning,
  editing other code).
- Pass `--session NAME` on every `--live` command. The band follows the session the last command
  named; give the tool the same `session` when several are live.
- On a step with a bug, call the tool with `{"action": "origin"}` to show where the bad value came
  from. It runs `pyokka origin` on that step, draws the chain under the bug (newest step first, the
  root marked `▶`, each step a button that moves the Time Machine there), and returns the same
  chain to you. Fix the root, not the line that raised, and check a link marked `inferred` with
  `step --into` before a fix rests on it.
- To leave a fix plan for a bug on the current step, call the tool with `{"action": "fix"}`. The
  plan aims at the root of the origin chain. It writes
  `<program dir>/.pyokka/findings/<file>-<finding>-<where>.md` with the reproduce commands, the
  diff and a check on a patched copy, and marks it `status: fixed` once a fresh run no longer
  shows the finding. The plan is a local file for the person and stays out of commits
  (`.pyokka/findings/` is gitignored). Give the person the plan's path.
- Applying a fix is the person's choice. Point them to `/pk a` to write the planned edit to the
  file (it records the run again) and `/pk u` to put the original back, and leave the source file
  as it is yourself.
- `{"action": "explain"}` and `{"action": "bugs"}` pick the band's view, and
  `{"action": "step", "step": N}` moves the Time Machine to step N.
- Tell the person the keys once: `/pk n` next step, `/pk w` where from, `/pk f` plan a fix,
  `/pk x` the bugs, and bare `/pk` for the rest. The rest: `/pk b` back, `/pk i` into, `/pk o`
  out, `/pk p` prose on or off, `/pk r` record again (or record from the pause); in the bugs view
  `/pk j` and `/pk k` next and previous bug, `/pk g` go to its step, `/pk e` back to the
  explanation, `/pk r` rescan; on a fix plan `/pk a` apply, `/pk u` undo, `/pk f` try again,
  `/pk d` dismiss.
- At a plain `pyokka debug FILE --at NAME` pause, show the band too. It reads the pause from the
  debugger: the place, the code, the frame's variables with their shape, the stack and the prose,
  marked `paused · no recording`. `/pk n`, `i` and `o` step the program. For history (back, bugs,
  where from, fix plans) point the person to `/pk r`, which runs the program again and records from
  the paused line ([debug.md](debug.md)).

When the `band` tool is not in your tool list, the band is not installed. Say once that
`claude plugin marketplace add ivorpad/pyokka` and `claude plugin install pyokka-band@pyokka` add
it (README, "In Claude Code"), and carry on with the CLI.
