# Handoff: the debugger (pause at the frontier, navigate behind it, agents drive it)

Self-contained: a new session executes this file alone. Read `docs/HANDOFF.md` first for
decisions, commands and quirks (`command cat` / `command grep`; absolute paths in
parallel Bash calls, `uv run --directory /abs/python` for pytest; never read or print the
example project's `.env`; runs of `agent.py` cost tokens, use `examples/demo.py`, the pytest
fixtures or scratches under `$TMPDIR/`). The wire contract is `docs/PROTOCOL.md`
("debug" request, `debug.paused` / `debug.resumed` events, runtime notes).

## Status (2026-09-15, round 3): the Debugger as its own product

The design of this round is `docs/design/debugger-product.md` (2205 lines, written by a
planner, reviewed and frozen before anything was built; its section 9 lists the fourteen
decisions and why). The model: Pyokka is two products that share the runtime, the runner and
VS Code's gutter breakpoints, and nothing else. **Run-all** stays exactly as it was. **The
Debugger** is a normal debugger: a `DebugSession` (`src/debug/debugSession.ts`, its registry
`debugSessionManager.ts`, the pure decisions `debugSessionState.ts`) holds the launch
configuration, owns one runner child, runs the program at full speed, pauses, steps, and is gone
when the program exits or Stop is pressed. **Recording is the optional bridge**: `record: true`
is today's Session-based debug run behind the facade `DebugTarget` (`debugTarget.ts`), so the
DAP translator, the bridge and the panel see one shape for both; `record: false` (the default)
creates no run-all `Session` at all. Two decisions the code depends on: Step Over and Step Out
without a recording use frame exits (`_pk_x` tells the debugger when the frame it steps in has
returned, `Debugger.on_leave` re-arms in the caller), so nothing is stored per call; and one
thread is paused at a time (`pause_lock`), so no command takes a thread argument.

Wave 1 (built 2026-09-15 by two Opus implementers on disjoint files, runtime in a worktree,
host in main): runtime `config.record` with the hook set `hooks_debug.py`, the frame chain
`dbgframes.py`, the exception half `dbgexceptions.py`, the module launch `module_run.py`, no
timer for any debug run in `Runner.handle_run`, `frameId` on `evaluate` / `complete` /
`locals`, `thread` on every pause; host `DebugSession`, the `kind: "debug"` socket
(`src/agent/bridgeDebugSocket.ts`, behind `pyokka.agentAccess`), the Debugger view
(`src/views/debuggerView.ts`, `webview/components/DebuggerView.tsx`), the status bar item, the
URI handler (`src/debug/debugUri.ts`, activation `onUri`), the context-key arbiter
(`debugContext.ts`); CLI `pyokka debug FILE|--module` with its three routes
(`agent/debug_start.py`), the descriptor preference (`agent/sessions.py`), the text forms
(`agent/render_debug.py`), `--no-wait`, `--frame`. Tests: pytest 371 → 423 (+1 skipped), vitest
516 → 563, e2e 96 passing over twenty specs (`debug-session`, `debug-server`,
`debug-cli-cold` new); the only failures in a full run are `cli-live.test.js` and
`walkthrough.test.js` when the user's own window has the example project's `demo.py` open (the
"2 live sessions match demo.py" collision, environmental).

Measured with `scripts/bench-debug.py` on the 500,000-iteration loop (1,000,003 statements),
median of 3, wall time with process start. Before (at `ea3ea51`, Python 3.14.6 / 3.12.9): plain
0.05 / 0.03 s, run-all in-process 0.60 / 0.40 s, run-all through the runner 1.17 / 0.96 s, today's
debug run as the extension sent it (recordLocals and autoLog on) 2.50 / 2.22 s. After: plain 0.05
/ 0.03 s, in-process run-all 0.64 / 0.44 s, runner run-all 1.53 / 1.01 s, the debugger with one
breakpoint set in a function nobody calls (the per-statement lookup runs and never hits) 0.28 /
0.19 s, the recording debug run 2.59 / 2.37 s. The runner-driven rows are the comparison; an
in-process row is never compared with a runner-driven one (the child spawn and the event pipe are
a fixed cost). The user's original "run-all 0.51 s" was the in-process row.

Wave 2 (built 2026-09-15 by the same two implementers, the runtime in a worktree on wave 1's tree,
the host in main): runtime `exec` in `dbgexec.py` (the statement runs in the paused frame; a
trailing expression is split off and shown the way a REPL shows it, with a value bag `expand` can
open; the write reaches the frame through the module dict at module level, PEP 667's write-through
`f_locals` on 3.13+ and `PyFrame_LocalsToFast` on 3.12; a raise is reported inside the reply and
the session stays paused; any attempt sets `modified`, which then rides on every later stop and
every `locals` reply until a new run), `{function: NAME}` breakpoints resolved as each file is
instrumented in `dbgbreakpoints.py` (which also took the path-and-line resolution out of
`debugger.py`), and `exec` on the runner (`executed` reply, capability `exec`, served only while
paused, refused with the child's own two sentences otherwise). Host `src/debug/debugExec.ts`
(`ExecResult`, the `until` / `to` / `count` driver over a `StopRunner`), the Debug Console as
`exec` (`context: "repl"` only; every other context stays on the pure `evaluate`), `setVariable`,
`setFunctionBreakpoints` with the CLI's function breakpoints mirrored into VS Code's list, `pyokka
exec --live`, `continue --until` / `--to`, `step --count`, `--at NAME` on `debug` and `break`, the
recording command `pyokka.debugCurrentFileRecording` and `--record` with `args`, `cwd`, `env` and
`python` honoured for a recording launch (a `module` launch with `record: true` is refused), and
the skill `skills/pyokka-debug/SKILL.md`, which `AGENTS.md` and the agent skill point at. Two
decisions worth knowing: `Ranker.rank` matches the method `rank` on its last segment because the
instrumenter's `function_names` table holds bare names, and `stoppedEarly` is reported only while
moves remained, so a breakpoint on the last requested step is a completed count. A wave-1 test
asserted `textwrap.indent`'s generator frame (`prefixed_lines`), which 3.13+ inlines; it now
accepts both shapes.

Final numbers: tsc clean; vitest 62 files / 580 tests; pytest 449 passed and 1 skipped on 3.12.9
(the venv) and 450 passed on 3.14.2 (a fresh `uv run` builds 3.14 because nothing pins
`.python-version`, by choice); e2e 104 passing over 21 specs (`debug-recording` new), 8 pending
(the UI pass), and the 8 `cli-live` / `walkthrough` failures that appear whenever the user's own
window has the example project's `demo.py` open. Bench after wave 2 with the machine at load
average 13 to 18 (a first run at load 23 was slower on every row, the 3.14 in-process one by
half): 3.14.6 plain 0.05 s, in-process run-all 0.63 s, runner run-all 1.24 s, debugger 0.29 s,
recording debug run 2.65 s; 3.12.9: 0.03 / 0.41 / 1.00 / 0.19 / 2.62 s. Wave 2 touched no hook, so
the debugger row is wave 1's within noise, still well under the runner run-all row on both
interpreters.

Live QA the same afternoon, on the RRF demo and a FastAPI service added to the example project
(`api/main.py`, module launch, a sync handler): three gaps, all closed the same day. VS Code asks
the user to allow an extension to open a URI the first time, so a cold `pyokka debug FILE` timed
out while the question was on screen and the session started a minute later when Open was clicked;
the CLI hint, the README, the skill and DBG-16 now say so, and `ivor.pyokka` in
`extensions.confirmedUriHandlerExtensionIds` skips the question. Nothing revealed the Debugger
view when a session started (a run-all start reveals the panel through
`pyokka.showOutputOnStart`); `DebugSessionManager` now reports its context keys before emitting
`sessionStarted`, and `extension.ts` shows the Debugger view one macrotask later under that
setting, with the caret left in the editor (`debug-session.test.js` asserts it). `pyokka debug`
had no flag for the `libraryCode` launch attribute although the URI and `launch.json` carried it;
`--library-code` exists now, and the launch line in `state --live`, the status bar tooltip and the
view header name the interpreter the session actually runs (`DebugSession.resolvedLaunch`) instead
of a `python3` default. The Debugger view was then redesigned twice, the second time against
screenshots: `scripts/preview-debugger-view.mjs` bundles `test/visual/debuggerPreview.tsx` (three
fixture states) into the scratchpad with the panel's CSS, the codicon font and a `:root` block of
Dark Modern variables, and headless Chrome renders it (`--headless=new --virtual-time-budget=3000
--screenshot`; without the budget the shot is taken before Preact mounts and comes out blank). The
result is laid out like VS Code's debug panes: status row with reason icon and chips, pane headers
with counts, 22 px rows with hover and one actions column, the current frame highlighted and
consecutive library frames folded, locals with expandable members, the watch input behind a `+`,
breakpoint dots, the pause-on dropdown in the header, banners for a console write and an
exception. Uninstrumented frames still carry no path on the wire (`fileId: 0`), so the fold shows
`line 1100 · library code`; one runtime line (`entry["path"] = code.co_filename` in
`dbgframes.frame_stack`, plus `path?` on `DebugFrame`) would give them their file, and is open.
Under FastAPI, a Step Over on the `raise` in a handler hung the client forever: the frame exited
into Starlette, `on_leave` re-armed the step for a caller scope that never runs another statement,
and the server kept serving. `dbgframes.step_target` now hands the step to the nearest
instrumented ancestor within four frames, the module body included, and when there is none the
step degrades to the next statement of the program's own code (`test_debug_step_leave.py`, four
cases, two of them thread targets); the pause keeps the kind that was asked for. Frame 0 of an
entry pause now carries the pause's `def` line (`dbgframes.top_line`).

Open after round 3: the class of a dotted `--at` is not checked (a new instrumenter table would be
needed); the `--count` early exit on a breakpoint is covered by `debugExec.test.ts` only, because
a step that lands on a breakpoint line reports `reason: "step"`, so no deterministic e2e program
exists for it; `exec` sets `modified` even for source that does not compile, over-reporting on
purpose. The section before this one describes rounds 1 and 2, whose recording path is unchanged.

Found on 2026-09-15 while building `pyokka history --live --pause` against the example project's
FastAPI service:

- **A cold start goes to the focused window, and a window whose workspace does not contain the
  file starts the program without instrumenting it.** With a different project frontmost,
  `pyokka debug --module api.main --cwd <example> --stop-on-entry` started the server and served
  requests, but `--stop-on-entry` did not pause, a breakpoint on the handler stayed
  `(not resolved yet)` however it was spelled, `pause --live --no-wait` never landed, and `stop
  --live` reported `exit None, 0 steps`. The descriptor confirmed it:
  `workspace:` pointed at another project. Focusing the window that has the example
  project open and running the identical command worked at once. So the module launch is fine;
  the failure is that a wrong-workspace window accepts the launch and instruments nothing, and
  the run looks alive while nothing an agent asks for can work. Two candidates: refuse the URI in
  a window whose workspace does not contain the program, or say so in the reply.
- **The 20 s timeout message does not name the likeliest cause.** It lists `pyokka.agentAccess`
  and the URI dialog; the actual cause here was the wrong window being focused, with
  `~/.pyokka/sessions` staying empty and no dialog ever appearing. Worth a line in the hint.
- **`--at FILE:LINE` on a cold start resolved the spec against the program's directory**, so
  `pyokka debug <abs>/api/main.py --at api/main.py:52` registered `<abs>/api/api/main.py:52`,
  which never resolved. Observed once, against the wrong-workspace window above, so confirm it
  against a correctly focused window before chasing it. An absolute path in `--at` worked, and
  `break --live FILE:LINE` on an already-started session matches by suffix and is fine.

## Status (2026-09-14, evening): built, all four deliverables

Runtime (deliverable 1): `python/pyokka_runtime/debugger.py`, `control.py`, seams in
`tracer.py`, `execute.py`, `child.py`, `runner.py`; `python/tests/test_debug.py`.
Host (2): `src/session/debugState.ts`, `debugController.ts`, seams in `session.ts`,
`runnerClient.ts`, `protocol.ts`, `navigator.ts` (attach at the frontier, execute at it,
replay behind it, watches and hovers through `evaluate` while paused), `features/debugBreakpoints.ts`
(gutter to run), `views/statusText.ts`, `api.ts`, commands `pyokka.debugCurrentFile` /
`debugContinue` / `debugPause` / `debugStop`, context keys `pyokka.debugActive` /
`pyokka.debugPaused`; `test/unit/debugState.test.ts`, `test/e2e/debugger.test.js` on
`test/e2e/fixtures/debug_target.py`. Panel: `src/views/debugPanel.ts`, `webview/debugView.ts`,
`webview/components/DebugFrontier.tsx`, `webview/debug.css`, title menus; `test/unit/webview/debugView.test.tsx`.
Values as a table: `webview/valueTable.ts`, `webview/components/ValueTable.tsx`, wired in
`Details.tsx` and in STEP VARIABLES at the frontier. Why conclusion: `python/pyokka_runtime/agent/why_text.py`,
`src/shared/provenanceText.ts`, `conclusion` on the provenance result, twin fixtures.
Agents (3): `src/agent/bridgeDebug.ts` and the bridge cases, Python `agent/live.py`,
`commands.py`, `render.py`; `test/e2e/debug-live.test.js` drives the real CLI against a host;
`docs/PROTOCOL.md` "Debugging over the bridge"; README and `skills/pyokka-agent/SKILL.md`.
DAP (4): `src/debug/dapTypes.ts`, `dapTranslator.ts`, `dapAdapter.ts`, `contributes.debuggers`
type `pyokka`; `test/unit/dapTranslator.test.ts`. QA cases DBG-01 to DBG-12 in `docs/QA.md`.

Completion for watch expressions (2026-09-14, night): `python/pyokka_runtime/complete.py`
behind the `complete` request (control channel and runner; capability `complete`),
`RunnerClient.complete`, `Session.completeExpression` (the paused frame, else the finished
run), the panel's dropdown in `webview/components/WatchInput.tsx` with the pure half in
`webview/watchComplete.ts` (`watch.complete` / `watch.completions` messages, `PanelState.completions`),
DAP `completions` with `supportsCompletionsRequest` and `.` as trigger, `PyokkaApi.complete`;
`python/tests/test_complete.py`, `test/unit/webview/watchInput.test.tsx`, the completions case
in `test/unit/dapTranslator.test.ts` and `test/e2e/debugger.test.js`.

One door (2026-09-14, night): `debugDocument` in `src/debug/dapAdapter.ts` is the only way a
debug run starts. The command "Pyokka: Debug Current File", F5 (with or without a launch
configuration) and the bridge's `debug` request all open a VS Code debug session over the
pause, so the standard views appear with the panel; a file already shown in a debug session
re-runs inside it (`attached` registry, one debug session per Pyokka session). Stop in the
toolbar stops the run and leaves debug mode, like the command; the Pyokka session stays; when
the run ends, VS Code's disconnect turns debug mode off too. The launch label lost its "(DAP)".
The command, the panel's Debug button and F5 launch with `stopOnEntry: false` (run to the first
breakpoint, to the end with none, what VS Code users expect; the first live demo paused at line 1
and read as "did not go to the breakpoint"). A morning's attempt (2026-09-15) to give them the
bridge's entry-pause rule was taken back the same day: the user wants a debug run to pause where
the breakpoints are and nowhere else, so the rule stays the agent's (`entryPause` in
`debugState.ts`, used by `bridgeDebug.ts` only). Runtime: `config.stopOnEntry` (default true) gates `Debugger.start_paused`. `PyokkaApi.startDebug`
stays the low-level, panel-only start, paused at the first statement.

Stop, restart, and where a run pauses (2026-09-14, night): the bridge's `debug` no longer always
pauses at entry. `entryPause(req, breakpoints, files)` in `src/agent/bridgeDebug.ts` (pure,
vscode-free) says when it does: an explicit `stopOnEntry: true`, or no enabled breakpoint in the
session's file or the files of its last run. Otherwise the run goes to the first breakpoint, as F5
does, so an agent that set one gets the stop it asked for instead of line 1 and a `continue`;
`--stop-on-entry` on `debug` and `restart` is how break-when watches and breakpoints are placed
before anything runs. Two bridge requests join it: `stop` (`{stopped, runId, finished}`, or
`{stopped: false, hint}` with nothing in flight, a reply and never an error) and `restart`, both
over `stopDebugging` / `restartDebugging` in `src/debug/dapAdapter.ts`, which the toolbar's Stop
and Restart share. A restart is in place: the `restarting` map holds the run being replaced so
`wrapSession.onFinished` skips its finish and VS Code keeps the debug session, and
`supportsRestartRequest` in `CAPABILITIES` is what makes VS Code send `restart` at all instead of
terminating and relaunching, which raced the old run's shutdown against the new one. The bridge's
`restart` registers its wait for the first stop only once the old run is gone, because
`waitForPause` settles with `finished` on that run's end. Starting a debug run sets
`internalConsoleOptions: 'neverOpen'` (in `debugDocument`, and in `resolveDebugConfiguration` when
the user's configuration is silent), so the Debug Console stops hiding the Pyokka panel's tab; a
blank `evaluate` answers `''` in the translator instead of reaching the runtime as a
`SyntaxError`. CLI: `debug --live [--stop-on-entry]`, `restart --live [--stop-on-entry]`,
`stop --live`; `stopped: exit N, K steps` and `nothing to stop: <hint>` are the text forms. The
five new cases of `test/e2e/debug-live.test.js` cover the bridge path and the in-place restart,
`test/unit/dapTranslator.test.ts` the DAP `restart` request; `test/e2e/debug-stop.test.js` drives
F5 on a file without a session and then VS Code's own Stop (`workbench.action.debug.stop`), which
ends the run and the debug session through the adapter; the toolbar's Restart button itself is
not covered end to end, it needs a live window. `pyokka shell --live` (`agent/shell.py`) reads a command per stdin line over one
bridge connection and prints each result as the one-shot command would: 0.5 ms per `state`
against 64 ms one-shot, measured in the twelfth case of `debug-live.test.js`.

F5 and the file's breakpoints (2026-09-14, night): the two Quokka bindings on `F5`
(`pyokka.reexecute`, `pyokka.playTraceForwardToSelection`) carry
`!pyokka.activeFileHasBreakpoints` (`scripts/gen-manifest.py` post-processes the keys), so with an
enabled breakpoint in the active file the key falls through to VS Code's Start Debugging and the
configuration provider in `dapAdapter.ts` turns the empty launch into a debug run to that
breakpoint. `DebugBreakpoints` (`src/features/debugBreakpoints.ts`) keeps the key from
`fileHasBreakpoints` in `debugState.ts` (enabled, file scheme, not a logpoint: logpoints never
pause, which is why `hasAnyEnabledBreakpointsInActiveEditor`, which counts them, is not reused) on
activation, on every breakpoint change and on every active editor change.
`test/unit/manifest.test.ts` pins the two clauses; the last case of `test/e2e/debugger.test.js`
drives `workbench.action.debug.start` with a gutter breakpoint and expects the pause there. The
five states of F5 are listed in the README under "Commands and keys". The panel's title has a Debug
button (`pyokka.debugCurrentFile`, `!pyokka.debugActive`) and Stop Debugging at `navigation@1`
next to Continue and Pause (at `@11` it fell into the overflow menu of a narrow panel: the user's
"cannot stop" of 2026-09-15, together with a stale `uvx` cache that rejected `pyokka stop`);
the status bar's menu (`quickPicks.ts`) offers Debug and Stop debugging too. Housekeeping from the same
night: the Time Machine's watch machinery lives in `src/timeMachine/watches.ts` (`Watches`, behind
the same `TimeMachine` methods; navigator.ts went from 694 to 550 lines), and `Session.evaluateLive`
answers nothing for a blank expression.

Pause on exceptions and pure calls (2026-09-15, runtime half): `config.breakOnException` is
`off | uncaught | raised` (default `uncaught`), changed live by the `debug` action `exceptions
{mode}`; only a run with a debugger reads it. `uncaught` pauses in execute.py's uncaught branch
before `tracer.finish`, through `Debugger.on_uncaught(exc)`, with the traceback's innermost user
frame as the live frame (a returned frame still answers `f_locals`); `raised` also pauses in
`errors.py` `_on_raise` at the first sighting of an exception object in a user file, before it
unwinds, with a reentrancy guard, never for `_IGNORED` types, library frames or a quiet library
import. The event is `debug.paused` with `reason: "exception"` and `exception: {type, message,
uncaught}`, `step`/`rid`/`line`/`stack` at the user statement that raised; `continue` or a step
after the top pause ends the run as before (exit 1, the `error` event with its traceback).
`python/pyokka_runtime/pure.py` is the one rule for `Tracer.evaluate`, `Debugger.evaluate` and
`complete`: pure builtins (`PURE_BUILTINS`, checked against the real builtin at evaluation time)
and non-mutating methods of exact builtin types run; user functions, mutating methods, lambdas,
awaits and the walrus are refused with one line; comprehensions run; the receiver of a method
call is evaluated once, and locals are laid over globals in one namespace so a comprehension's
scope sees the frame. Tests: `test_debug.py` (the modes against the shape of
`test/e2e/fixtures/debug_raise.py`, the mid-run `exceptions` action, a paused-frame `len`),
`test_pure.py`; not covered: an exception inside an instrumented library file with library
stepping on, and a raise in a second thread.

Host half of the same round: `DebugState.exceptions` (`off | uncaught | raised`, fresh `uncaught`,
kept across runs and Stop) through `DebugController.setExceptions`, `Session.setDebugExceptions`,
`PyokkaApi.setDebugExceptions`; `requestExtras` sends `breakOnException`, a run in flight gets the
`exceptions` action. DAP: `exceptionBreakpointFilters` (Uncaught Exceptions default on, Raised
Exceptions) and `supportsExceptionInfoRequest`; `setExceptionBreakpoints` during configuration
with VS Code's default selection is read as "untouched" and leaves the session's mode alone, any
other selection or a change after `configurationDone` applies (`DEFAULT_EXCEPTION_MODE`, the
`configured` flag in dapTranslator.ts), because VS Code re-sends its stored checkboxes at every
launch and a mode set by `break --on-exception` must survive it; there is no channel back to the
view, so it can read "Uncaught Exceptions" while the run is in `raised`. The `stopped` event
carries reason `exception`, `text` `Type: message`; `exceptionInfo` the banner. Bridge: `break`
takes and reports `exceptions`, `state.debug.exceptions`, `pausedReply` passes `exception`;
every stop reply (`debug`, `continue`, `pause`, `step`, `restart`, `context` at the frontier) now
carries `locals` and `output: {text, truncated}` (the last 4000 characters of `state.output`,
redacted) through `contextExtras`, one extra control round trip per stop. CLI: `break --live
--on-exception MODE`, the listing's `exceptions:` line, `stop_reason` prints `uncaught ValueError:
too big: 3`, `render_context` prints `output (last N lines):` (20 lines, 200 with `--scope`).
Three findings from the e2e: VS Code 1.137 sends `setExceptionBreakpoints {filters: []}` during
configuration for a debug type it has not shown yet and never a second one, so an empty list or the
bare default before `configurationDone` is read as "nothing asked"; the runtime reports `print` as `log`
entries and only raw fd writes as `output` events, so `Session.handleEvent` appends `log` entries to
`state.output` in arrival order (last 64 KB, `OUTPUT_KEPT`); a `disconnect` that arrives after its run
ended is ignored by `wrapSession` once `session.debug.runId` names a newer run. Panel header, status bar and `debugView.ts` print the same text. Tests: `test/e2e/debug-exceptions.test.js`
on `fixtures/debug_raise.py` (uncaught, raised, off), `debug-live.test.js` (the stop's `locals`
and `output`), unit cases for `outputTail`, `exceptionMode`, the DAP filters and `exceptionInfo`.

Known gaps, none blocking: break-when watches have no panel UI (CLI and bridge only);
the table view gets no `markIndex` because locals carry no loop index; the alias line uses a
text-and-type heuristic (the runtime object-identity hint is not sent yet); DAP caller frames
point at their `def` line; `DebugController.setWatches` discards the runtime echo so the bridge
sends the set twice to a run in flight; `startDebug` on a fresh document runs the file once
normally before the debug run supersedes it; the panel's "Debug: running…" shows only once
the Time Machine view has attached. The text below is the design as approved; the sections
marked (open) were built as written unless the status above says otherwise.

## Why this and not debugpy

Pyokka already controls execution: every statement runs through a hook the runtime compiled
in, so it knows the step, the scope and the depth at every moment, and the child has a control
channel. A second debugger would trace the same code through `sys.monitoring`, fight the
instrumentation on stepping, and know nothing about steps, HTTP rows, replay, masking or
library scopes. And an agent cannot drive DAP, an editor protocol; the bridge it can drive
already exists. A DAP adapter over the runtime protocol can come later (deliverable 4) for the
standard Variables and Call Stack views. On Windows the debugger works today through the
child's control pipe, where the Unix-socket bridge does not.

## The model

A debug run is an ordinary run whose frontier can pause. Behind the frontier is the recording
so far, navigated like the Time Machine: values follow the step, backward moves replay,
nothing runs. At the frontier the frame is live: hover and watches evaluate in the real frame,
locals are real objects, expandable in full. Ahead is the future: Continue, Step Into, Step
Over and Step Out execute, and the recording grows, HTTP exchanges included, recorded or
replayed per the mode. The hook runs before the statement executes, so a pause on
`total += i` sees `total` before the addition, as in any debugger. When the run ends it is a
normal finished run the Time Machine owns. Debug is its own mode with its own state (running,
paused at step N); the Time Machine's state machine is untouched.

Preview (2026-09-14): `docs/design/debugger-preview.html`, rendered to `debugger-preview.png`
next to it. It shows the paused frontier in the editor with values as of the step, the panel
with the timeline band, STEP VARIABLES, watches and the why tree with its conclusion, and the
agent's terminal below. Two presentation ideas in it come from the user's PyCharm screenshot
of 38 truncated dicts and are part of the deliverables below: homogeneous collections render
as a table (a list of dicts or same-length tuples becomes columns, the current row marked,
"31 of 38 have an empty entry" as the footer), and a name bound to the same object as another
says so ("item = candidate, same object") instead of repeating the repr.

## Deliverable 1 (built): the runtime

- Attach: `config.debug: true` (pause at the first statement, reason `start`) or a non-empty
  `breakpoints: [{path, line, condition?}]` in the run request. Either starts a reader thread
  in the child (`control.py`) so breakpoint and watch changes and `pause` apply while the
  program runs. Runs without either pay nothing: `Tracer.dbg` stays `None` and the hooks skip.
- Pause reasons: `start`, `breakpoint` (condition holds, or the condition failed to evaluate,
  reported in `conditionError`), `step` (`kind` into / over / out), `watch` (`breakWhen:
  "change"` fires when the expression's text changes after a first observation, `"true"` on
  the rising edge; a name not in scope is silent), `pause` (requested while running).
- Resolution: breakpoints are kept by real path and line and resolved in `Debugger.file_added`
  when the file is instrumented; an exact line, else the next statement in the file, else the
  nearest earlier one; a `def` line is the function's entry step, so it pauses at every call.
- Step semantics from the scope parent chain: `into` any next step; `over` the next step in
  the paused scope or an ancestor; `out` the next step in an ancestor (at module level this
  runs to the end). Recursion is exact because scopes are per call.
- At a pause, before `debug.paused`: `sys.stdout` / `sys.stderr` flushed, a partial `trace` up
  to this step, `time`, the `locals` entries not sent yet (`tracer.locals_flushed`, also
  honoured by `finish`, so nothing is sent twice).
- While paused: `evaluate` (side-effect-free, locals over globals), `expand`, `source`,
  `debug locals`, `debug breakpoints`, `debug watches`, `debug continue`, `debug step`. A `stop`
  from the runner goes through the usual SIGTERM flush; the paused thread waits on the queue
  in half-second slices so the handler runs. The runner holds the timeout while paused
  (`Child._hold_timeout` / `_release_timeout`).
- Decisions: the reader thread exists only in debug runs (a program that forks itself
  inherits the control descriptor; keeping the thread out of ordinary runs keeps them exactly
  as before). Pausing stops the instrumented thread at its next statement, so a thread blocked
  in a network call pauses when the call returns, as every Python debugger does; other
  instrumented threads pause at their own next statement only if they hit a reason of their
  own (a `pause` request is one flag, so they do).

## Deliverable 2 (open): the host

- Command "Pyokka: Debug Current File" (F5 while the session is in debug mode): starts a
  session in a new run mode `debug` that sends `config.debug: true`, `recordLocals: true` by
  default (the tree for "why" needs values at every level) and the VS Code breakpoints of the
  session's files (`navigator.breakpointTargets` already maps them; send paths and lines, plus
  the breakpoint condition). `onDidChangeBreakpoints` sends `debug breakpoints` to a run in
  progress. Logpoints stay markers.
- Session state: `paused: {step, rid, fileId, line, scopeId, reason, stack} | undefined` from
  `debug.paused` / `debug.resumed`; the partial trace at the pause already becomes
  `state.trace` (session.ts handles `partial`), so the Time Machine model exists at every
  pause. Attach the navigator at the frontier step on pause.
- Buttons: the Time Machine toolbar and keys (F10 / F11 / Shift+F11 / F5) move backward as
  replays when the position is behind the frontier, and send `debug step` / `debug continue`
  when the position is at the frontier. Add Pause (while running) and Stop. The strip marks
  the frontier; the status bar says "paused at demo.py:42 (breakpoint)".
- Values: behind the frontier as today (entries as of step). At the frontier: hover and Show
  Value evaluate through `evaluate` (the runner routes it to the paused frame); watches
  evaluate through `evaluate` too instead of a re-run; STEP VARIABLES lists `debug locals`
  when the position is the frontier. Wording: a statement ahead of the frontier is "not run
  yet", one behind it without an entry "not recorded".
- HTTP: rows stream during the run already; the HTTP view answers with `running: true`.
- Values presentation (from the preview): in STEP VARIABLES and the Value Explorer, a list
  or tuple of at least three dicts sharing the same keys, or of same-length tuples, renders
  as a table with one column per key (nested values collapsed to `{n keys}` / `[n]`), the
  current loop item marked when the list is being iterated, sortable by column, and a footer
  with the counts that matter (rows, how many have an empty or None value in a column).
  Aliases: two locals bound to the same object show `= other` on the second. Both are pure
  webview work over value bags plus one identity hint from the runtime (`locals` and value
  nodes may carry `objectId` = `id(obj)`).
- Why, the conclusion: the tree keeps its shape; add a deterministic closing sentence built
  from the first two levels ("None because the else arm ran: `is_preferred` is False, since
  `item.get("patron")` is None") so the answer reads without a model.
- Tests: `test/unit` for the state reducer and the button routing; an e2e spec that starts a
  debug run on `examples/demo.py` with a breakpoint, evaluates at the pause, steps, continues.

## Deliverable 3 (open): agents, the selling point

All over the existing bridge (`src/agent/bridge.ts`, `python/pyokka_runtime/agent/live.py`,
`commands.py`), one-shot commands with `--json`, every stop mirrored in the editor the way
`step --live` is today:

```
pyokka debug FILE --live                    start the session's file paused at its first statement
pyokka break --live file:line [--when EXPR]  add / list / remove breakpoints (VS Code's list is the source of truth)
pyokka watches --live --add EXPR [--break-when change|true]
pyokka continue --live | pyokka step --live --into|--over|--out   at the frontier these execute; behind it they replay
pyokka pause --live
pyokka context --live                       the slice, plus live locals and the output so far at a pause
pyokka eval --live EXPR                     in the paused frame
pyokka why --live [NAME]                    the provenance tree of NAME at the frontier, over the recording
pyokka watch --live                         one line per stop, whoever caused it
```

Why at the frontier is the feature to build first here. The complaint that started this
("the agent says it is null because of this or that, in prose") is answered by a tree, not a
sentence: `why` already exists over a recording (`agent/provenance.py`, bridge `why`) and the
recording behind a pause is exactly what it needs. The recipe for a null: a break-when watch
`payload is None` with `breakWhen: "true"` pauses the run at the first statement where it holds,
then `why payload` walks back through the assignments that produced it, the values they read
and the calls that returned them, to the entry point. Debug runs record locals by default so
every level has a value; the columnar "record everything" store (see the session notes of
2026-09-14 in `CHANGELOG.md` when it lands) makes the tree complete on long runs. MCP later
wraps the same commands.

## Deliverable 4 (optional): a DAP adapter

A `DebugAdapterDescriptorFactory` in the extension translating DAP requests to the runtime
protocol, so VS Code's Variables, Watch and Call Stack views and the debug toolbar work with
no debugpy involved. Only worth it if the standard views matter to users; the panel already
has its own.

## Acceptance

- A breakpoint inside a loop in an imported project module pauses on every hit with the
  values before the statement; `evaluate` and `locals` answer from the frame; Step Over from
  the last statement of a function lands on the caller's next statement; Step Out likewise;
  Continue runs to the next breakpoint or the end.
- A run paused for longer than `timeoutMs` does not time out; `stop` while paused ends it
  with `stopped: true` and a final trace.
- Behind the frontier the panel behaves exactly as the Time Machine does on a finished run;
  at the frontier hover shows live values; a program that ends becomes a normal finished run.
- An agent, through the CLI, sets a break-when watch for `x is None`, gets the stop with its
  context, asks `why x` and receives the tree; the human watched the editor follow.

## Out of scope here

Named pipes for the bridge on Windows (the debugger itself works there through the runner);
pausing uninstrumented C threads; attach to a running process; conditional breakpoints on
library files that are not instrumented (turn Step Into Library Code on).
