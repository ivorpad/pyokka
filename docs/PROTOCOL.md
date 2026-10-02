# Pyokka runtime protocol

The extension host spawns one **runner** per Python interpreter:
`python -m pyokka_runtime serve`. Messages are NDJSON: one JSON object per
line, host → runner on the runner's stdin, runner → host on the runner's
stdout. The runner never lets user code touch that stdout: each run executes
in a forked/spawned **child** whose fds 1/2 are pipes that the runner reads and
forwards as `output` events.

Every host request carries `id`; the runner answers with a message that
carries the same `id` (`ok`, `error`, or a typed reply). Run events carry
`runId` and a monotonically increasing `seq`.

Positions: lines are 1-based, columns are 0-based (Python `ast` convention).
A **range** is `[startLine, startCol, endLine, endCol]`.
Range ids (`rid`) are **global** across files within a run: each
`file.instrumented` event declares `rangeBase`, and its local ranges occupy
`rangeBase .. rangeBase + ranges.length - 1`. Range ids are assigned in source
order within a file.

## Host → runner

| type | fields | reply |
|---|---|---|
| `hello` | `version` | `ready {pythonVersion, executable, platform, capabilities: string[], runtimeVersion, protocolVersion}`. `capabilities[0]` is `fork` or `spawn`: how this runner makes its run children (see the runtime notes). |
| `run` | see below | `ok`, then a stream of run events |
| `expand` | `runId, valueId, queryPath: string[], limits?: {depth, elements, stringLength}` | `value {node}` or `error`. A `loadActionNode` has `id = <parent id> + " +"`; expanding it returns the parent with up to 100k elements. Served by the finished child from its registry until the next run. |
| `evaluate` | `runId, expression, limits?, frameId?` | `evaluated {text, valueBag}` or `error`. Evaluates a pure expression against the finished run's `__main__` namespace in the still-alive child, or, while a debug run is paused, in the paused frame (locals over globals). `frameId` picks a frame of the pause (`0`, the default, is the paused frame); a `frameId` the pause does not have is an `error` (`LookupError: no frame N in this pause`). It is ignored after the run, where there is no frame. Pure is names, attributes, subscripts, operators, comprehensions, the builtins in `PURE_BUILTINS` (`len`, `type`, `sorted`, `isinstance`, ... , still bound to the real builtin where the expression runs) and the non-mutating methods of an exact builtin type (`dict.get` / `keys` / `values` / `items` / `copy`, `list.copy` / `count` / `index`, the set queries, any public method of `str`, `bytes`, the number types, `tuple`, `frozenset`, `range`); a user function, `list.append`, `dict.pop`, a method of a user object, a lambda, an await, a yield and the walrus are refused, one line saying which and what is allowed. No statement of the program is re-run; attribute access may still invoke properties and a subscript `__getitem__`. |
| `exec` | `runId, source, frameId?` | `executed {text, valueBag?, modified: true, exception?: {type, message, traceback}}` or `error`. Runs `source` in the paused frame: anything `compile(source, "<pyokka-exec>", "exec")` accepts, so assignments, calls, imports, `del` and multi-line blocks. Served only while a debug run is paused, in either mode, and refused otherwise: `the program is running; pause it first` while it runs, `the run has ended; there is no frame to execute in` after it. `frameId` picks a frame of the pause as it does for `evaluate`. When the last statement is an expression it is evaluated in the same namespaces as the statements before it, so `x = 2` then `x * 3` answers `6` and `items.pop()` shows what it returned: its `text` is masked like any value and comes with a `valueBag` for `expand`. A block whose last statement is not an expression answers `text: ""` and no bag. A statement that raises is reported in `exception` and the session stays paused; only a request that cannot be served at all is an `error`. Capability `exec`. See the runtime notes for how the write reaches the frame and what `modified` means. |
| `complete` | `runId, expression, limit?, frameId?` | `completed {prefix, items: [{label, kind, type?}], error?}` or `error`. Completions for a watch expression typed so far: `expression` is the text before the caret, `prefix` the identifier at its end (what a chosen label replaces). After a dot, the balanced expression before it (`payload`, `rows[0]`, `self.items`) is evaluated under `evaluate`'s side-effect rule and the object's attributes are listed, classified with `inspect.getattr_static` so no property runs; otherwise locals, then globals, then builtins and the constant keywords, sorted, underscored names only once the prefix starts with `_` (`_pk_*` never). Same namespace as `evaluate`: the paused frame, or the finished run's `__main__`. `kind` is `variable`, `attribute`, `function`, `method`, `property`, `class`, `module`, `builtin` or `keyword`; `type` is the value's type name for a variable or attribute. An object that cannot be evaluated (a call, an unknown name) gives `items: []` and `error` rather than `error`. `limit` caps the list (default 100). Capability `complete`. Refused like `evaluate` while the program runs. |
| `shadow` | `runId, source` | `evaluated {kind, context, text, valueBag}` or `error`. What one edited statement would show, computed from the finished run's state: `print(a, b)` (rendered like print, kind `log`), a bare expression, or `name = expr` (kind `value`, `context` = the target). Same side-effect rules as `evaluate`; the namespace is not modified. |
| `source` | `runId, fileId` | `source {fileId, instrumentedSource}` or `error`. The instrumented source of one file of the finished run. `file.instrumented` omits it for library files (4-8 MB per run for `openai`), so hosts ask for it when someone wants to see it. |
| `bindings` | `source` | `bindings {statements: [{line, col, assigns: string[], reads: string[], loop?: number, calls?: string[]}]}` or `error` (a `SyntaxError`). What each statement of `source` assigns (names or attribute paths; a `def` lists its parameters, bound by the call that enters it; a subscript store binds its container) and reads (`Name` loads of the header, builtins, comprehension variables and lambda parameters excluded), from the AST alone: stateless, served by the runner itself at any time, no run involved. `line`/`col` are the statement's start, which is where its range starts, so a host keys them by range id. `loop` is the last line of a `for`/`while` whose header steps once before the loop and once per iteration. `calls` is the source text of each `Call` in the header (outermost first, whitespace collapsed, at most 8 of at most 80 characters, `def`/`class` statements excluded), absent when there is none; a statement that only calls (`print("hi")`) is listed for it. Feeds the variable history and the provenance tree. |
| `debug` | `runId, action` plus, per action: `breakpoints {set: [{path, line, condition?} | {function, condition?}]}` (replaces them all; each is resolved to a statement when its file is instrumented, a blank line to the next statement, a `def` line to the function's entry), `watches {set: [{id, exp, breakWhen: "change" | "true"}]}` (pause when the expression's text changes, or when it turns true), `exceptions {mode: "off" | "uncaught" | "raised"}` (where the run pauses on an exception, replacing `config.breakOnException` for the run in flight; it applies while the program runs and while it is paused), `pause` (at the next statement), `locals {frameId?}` (the variables of one frame of the pause, the paused frame by default), `continue`, `step {kind: into | over | out}`, `record` (record from this pause on, in a `recordFrom` run; see "A debug run that records from a pause") | `debug.result {id, ...}`: `breakpoints` echoes them with `rid, fileId, resolvedLine` once resolved (and `error` for a condition that does not compile); `watches` echoes them; `locals` is `{locals: [{name, text, valueBag}], modified?}`; `pause` is `{ok, paused}`; `exceptions` is `{ok: true, mode}`; the rest `{ok: true}`. `error` when no run is in progress, the run has no debugger (`config.debug` false and no `breakpoints`), `continue` / `step` / `locals` arrive while the program runs, the step kind or the exception mode is unknown, or the pause has no such `frameId`. Only a run started with `config.debug` or `breakpoints` listens: its child reads control requests on a thread from the start, so breakpoint and watch changes and a `pause` apply while the program runs; `evaluate` while it runs is refused. A breakpoint spec carries either `path` and `line` or `function: NAME`, the name of a function to pause at the entry of (see the runtime notes for how a name is resolved); the echo reports where it landed, and `error` when the name is defined in more than one file. |
| `stop` | `runId` | `ok` (child killed; a final `run.finished` with `stopped: true` follows) |
| `shutdown` | | process exits |

### `run`

```jsonc
{
  "type": "run", "id": 12, "runId": "r-42",
  "file": { "path": "/abs/scratch.py", "displayName": "scratch.py", "content": "..." },
  // "module": "app.server",   // instead of `file`: a `python -m` launch (see "The module launch")
  "workspaceRoot": "/abs/project", "cwd": "/abs/project",
  "argv": [], "env": { "A": "1" },
  "projectFiles": [ { "path": "/abs/project/lib.py", "content": "..." } ],   // unsaved buffers
  "config": {
    "logLimit": 100, "maxConsoleMessages": 1000,
    "logLimits": { "inline": { "depth": 5, "elements": 5000 },
                    "values": { "default": { "stringLength": 8192 },
                                 "autoExpand": { "depth": 10, "elements": 5000, "stringLength": 8192 } } },
    "maxLogEntrySize": 16384, "resolveGetters": false, "autoLog": false,
    "maxTraceSteps": 999999, "timeoutMs": 30000, "recordLocals": false,
    "libraryCode": false, "libraryPackages": [],   // instrument third-party packages (never the stdlib); list narrows to names / dotted globs
    "exclude": [], "only": [],  // optional: modules or paths left out of the recording / the only ones recorded (see "Recording limits")
    "maxValueChars": null,      // optional: characters one recorded value keeps; null 120 (local) / 200 (logged value), 0 the 1,000,000 ceiling
    "hints": { "ignoreCoverage": "ignore coverage|pragma: no cover", "ignoreCoverageForFile": "ignore file coverage" },
    "plugins": [],
    "secrets": { "mask": true, "names": [] },  // mask secrets in the child (see "Secrets" below); names adds words
    "http": "off",              // "off" | "record" | "replay": record the HTTP layer, or answer from the recording (see "HTTP record and replay")
    "httpObserve": true,        // false leaves the HTTP clients untouched: no `http.exchange` rows, no HTTP view
    "debug": false,             // true: the run can pause, step and break (see `debug`), paused before its first statement
    "record": true,             // false: a debugger that records nothing (see "A debug run without a recording"); read only when `debug` is true
    "stopOnEntry": true,        // with debug: false runs to the first breakpoint (or the end) instead of pausing at the first statement
    "breakOnException": "uncaught"  // "off" | "uncaught" | "raised": where a debug run pauses on an exception (see `debug.paused`); read only when a debugger is attached
  },
  "markers": [ { "id": "m1", "kind": "value", "range": [12, 4, 12, 9], "exp": null,
                 "autoExpand": false, "context": "total", "changeId": "c-7" } ],
  "expressionsToEvaluate": { "17": { "_p_items": { "_p_0": {} } } },   // runtimeKey -> queryPath tree
  "watch": [ { "id": "w1", "exp": "obj.a.b", "range": [30, 8, 30, 15] } ],
  "traceContext": { "step": 1234, "prefetch": 10 },
  "breakpoints": [ { "path": "/abs/project/lib.py", "line": 12, "condition": "n > 3" } ],   // pause there; resolved when the file is instrumented
  "mode": "normal"            // "normal" | "profile" | "snaps"
}
```

Marker kinds: `value` (Show Value / selection / live comment inserted by the
host), `time`, `logpoint` (from a VS Code logpoint; `logMessage` may hold text
with `{expr}` interpolations), `autoLog` is not a marker but a config flag.
Live comments written in the source (`# ?`) are discovered by the runtime
itself; they need no marker.

`file.content` absent means read the file from disk. A debug session never sends
buffer content, so what runs is what is saved.

### The module launch

`module` replaces `file` and runs the name the way `python -m` does. Capability
`module`.

- `sys.argv` is `[<the module's resolved file>, *argv]`, and `cwd` goes on the
  front of `sys.path` (a file launch puts the file's directory there instead)
- the module runs as `__main__`, and a package `M` runs `M.__main__`
- the module and everything it imports are instrumented as a file launch's
  imports are, so `file.instrumented` arrives per file and a breakpoint set on a
  line of the module resolves when it loads. The parent packages of a dotted
  name are imported while the name is resolved, so they are instrumented first
  and their `fileId` comes before the module's.
- `SystemExit`, `KeyboardInterrupt` and an uncaught exception end the run
  exactly as they do for a file
- a name that cannot be imported is one `runner.error` (`cannot run -m NAME:
  ...`) and exit code 1. Anything else a parent package raises on the way is the
  program's own uncaught exception, with its `error` event and its traceback.
- `module` and `file` together is a `runner.error` (`run.module and run.file are
  both set; running the module NAME`) and the module runs

### A debug run without a recording

`config.record: false` with `config.debug: true` is the Debugger: the program
runs at full speed, stops at a breakpoint or an exception, and nothing is
recorded. `record` is read only when `debug` is true, so a run-all run records
whatever the host sends. Capability `record`.

These events, and nothing else: `run.started`, `file.instrumented` (the host
still needs the rid tables for breakpoints and locations), `output`,
`debug.paused` / `debug.resumed`, the typed replies (`debug.result`,
`evaluate.result`, `complete.result`, `exec.result`, `source.result`,
`expand.result` and their `.error` twins), one `error` for the exception that
ended the run, with its
`traceback`, `runner.error`, and `run.finished`. No `trace`, partial or final;
no `coverage`, no `log` of any kind, no `locals`, no `time`, no `watch`, no
`http.exchange`, and no caught-exception group (those are aggregated over a whole
run, which is a recording).

Whatever the request says, the runtime forces `recordLocals` and `autoLog` off,
`http` to `"off"` with `httpObserve` false (the HTTP plugin keeps a row per
request in memory, which grows without bound in a server), and `mode` to
`"normal"`; `markers`, `watch`, `expressionsToEvaluate`, `traceContext` and
`maxTraceSteps` are ignored. All of them describe a recording.

A `print` is Python's own print: it reaches `sys.stdout`, which is the stream the
runtime turns into `output` events, so the program's output arrives as `output`
rather than as a `log`. `step` on those events is the statement the write came
from, as it is in a recording run.

`run.finished.stepCount` is the statement counter: how many statements the
program executed, across threads. `output.step` and `debug.paused.step` count
the same way. Nothing can navigate to such a step: there is no trace.

A breakpoint inside a library module's import-time body never pauses, because
that body is coverage-only (see the runtime notes). A breakpoint in a library
*function* pauses when stepped code calls it, with `libraryCode: true`.

A problem inside the debugger itself is a `runner.error` (`debugger hook failed
in <where>: <Type>: <msg>`, once per message), because a `log` event would be a
recording, and the program runs on.

### A debug run that records from a pause

`config.recordFrom` with `config.debug: true` and `record` true (the default)
runs like the Debugger up to a pause and records from that pause on. Values:
`"pause"` (the first pause), `{function: NAME}` or `{path, line}` (the first
pause whose statement is that breakpoint's: a function's entry, or the line).
Other pauses before it are ordinary `record: false` pauses: the statement
counter as `step`, the frame-chain `stack`. The `debug` action `record` starts
the recording at whichever pause is being served. Capability `recordFrom`.

At the switch the runtime builds a scope for every instrumented frame on the
paused stack, parent before child, swaps the recording hooks in and records the
paused statement as step 0 (flag 4 when the pause is a function's entry). The
`debug.paused` of that pause carries `recordingStarted: true`, `step: 0` and
the scope-chain `stack`; at a `record` action the runtime flushes the trace and
sends that `debug.paused` again for the same pause, then the `debug.result`
`{ok: true, recording: true, step: 0}` (`already: true` when the run records
already). From then on the run is a recording run: partial and final `trace`,
`log`, `locals`, `time`, `coverage`, caught exceptions. Every `trace` event of
such a run has `midRun: true`, and over the bridge the context slice of its step 0
carries `recordingStart: true`.

Nothing from before step 0 is recoverable: its steps, values, parameters and
caught exceptions were never kept. Coverage is the exception: the debugger's
hooks count hits from the start in such a run, so `coverage` covers the whole
run (about 1.2x the `record: false` cost of a statement, against about 9x for a
recording). A recorded local that existed before the switch is not reported as
a change: the switch takes a silent snapshot of every frame on the stack, so the
next change is the first one the recording saw. A frame entered before the
switch that the stack walk did not see (a generator or coroutine suspended at
the switch, another thread) gets its scope when it next runs, with whoever
resumed it as parent. A `print` whose name was looked up before the switch (the
paused statement's own call) prints as `output`, not as a `log`.

## Runner → host run events

| type | fields |
|---|---|
| `run.started` | `pid` |
| `file.instrumented` | `fileId, path, rangeBase, ranges: Range[], statements: rid[], functions: [{rid, name, bodyRange}], magic: [{rid, kind}], instrumentedSource?, instrumentMs?`. `instrumentedSource` is omitted for library files (ask with `source`). `instrumentMs` is the time spent instrumenting the file or loading it from the cache; the runner adds it to the run's `timeoutMs` deadline, so instrumenting a large package never counts as the program running. |
| `output` | `stream: "stdout"|"stderr", text, step?` (`step` is present for Python-level writes through `sys.stdout`/`sys.stderr`; fd-level writes arrive without it) |
| `log` | see below |
| `error` | `fileId, rid, step, message, errorType, stack: [{fileId, line, col, rid?, function, path}], handled, handledAt?, count?, lastStep?, traceback?` (innermost frame first; `fileId: 0` for frames outside instrumented files). One per exception, all emitted when the run ends: the uncaught one (`handled: false`, `traceback`), then the caught ones aggregated per raise site and handler with where they were caught; see below. Syntax errors in the scratch file arrive as `errorType: "SyntaxError"` with `rid = rangeBase`. |
| `coverage` | `fileId, states: number[]` (index = local rid; 0 not run, 1 covered, 2 partial, 3 error source, 4 error path, 5 ignored by an ignore hint), `hits: number[]`. Ignored statements are also dropped from `file.instrumented.statements`. |
| `time` | `rid, n, total, min, max` (ms, floats) |
| `trace` | `steps: base64(Int32Array quads [rid, scopeId, depth, flags]), scopes: [{scopeId, rid, name, parent, depth, first, last, returned?, returnedTruncated?, returnedLength?, raised?}], truncated`. `returned` is the text of the value the function returned (a bounded repr cut like a `locals` change: `config.maxValueChars` characters, unset 120, then `…(+N chars)` and `returnedTruncated: true`, `returnedLength` as `truncated`/`length` on a change, see "Recording limits"; secrets masked; taken when the frame exits, so a `finally` that returns again wins), `null` when the body ran off its end; `raised` is the exception type the frame left by. A module body has neither; a scope of the final `trace` carries them, a partial delta may not yet. During runs longer than a second the child also sends `trace {partial: true, offset, steps, scopes}` deltas about once a second: the steps since the previous delta (`offset..`) and only the scopes created since then (`last` of earlier scopes is not re-sent; a host assembling deltas derives it from the steps). No deltas are sent once `maxTraceSteps` is reached. The final `trace` without `partial` is complete and authoritative, hosts may ignore the deltas. Scope 0 is the module (`rid` 0 = the whole-file range); imported project modules get their own scope at depth 1, library modules get none (their body is coverage-only, see the runtime notes). A scope's `parent` is the scope of the frame that called, awaited or iterated it (read from the caller frame, see the runtime notes), not the scope that last recorded a step: a task resumed by the event loop or a thread's target has the module as parent (depth 1), so gathered coroutines sit side by side and never under each other. `depth` is `parent`'s depth + 1, for display; the moves (step over / out and their back variants) follow the parent chain, not `depth`. Function entry is a step on the `def` header range with flag 4. Loops record one step on the header per iteration. `midRun: true` on every `trace` of a run whose recording began at a pause (`config.recordFrom`): step 0 is that pause and the ancestors' scopes have `first: 0` with no call site recorded. The final `trace` of a run cut at `maxTraceSteps` also has `cap` (the setting), `stepsRun` (statements the program executed, the same number as `run.finished.stepCount`) and `spentBy: [{path, steps}]`, the five files with the most statement hits over the whole run (see "Recording limits"). |
| `locals` | `entries: [{step, scopeId, changes: [{name, text, truncated?, length?}]}]` (only when `recordLocals`; `truncated`/`length` as on a `log`, see "Recording limits") |
| `watch` | `watchId, step, valueBag` |
| `debug.paused` | `step, rid, fileId, line, scopeId, depth, reason: "start" | "breakpoint" | "step" | "watch" | "pause" | "exception", thread: {name, ident}, stack` (innermost first), plus `kind` for a step, `breakpoint` (as echoed by `debug`) and `conditionError?` for a breakpoint, `watch: {id, exp, text}` for a watch, `exception: {type, message, uncaught}` for an exception, `recordingStarted: true` at the pause a `recordFrom` run started recording at. `stack` has two shapes, told apart by which members are present: with a recording `[{scopeId, name, rid, depth}]` from the scope parent chain, without one `[{frameId, name, fileId, line, rid?, scopeId?}]` from the frame chain (see below). `thread` is on every pause in both shapes and names the thread that stopped. Emitted before the statement at `step` executes (at an `exception` pause that statement is the one that raised), after the recording so far went out: a partial `trace` up to this step, `time`, and the `locals` entries not sent yet. The run is off the timeout clock until it resumes. While paused, `evaluate` answers in the paused frame and `expand` opens the values it and `locals` returned. `config.breakOnException` (and the `debug` action `exceptions`) says where an exception pauses: `off` never; `uncaught` on the one that ends the run, before the `error` event, with the traceback's innermost user frame as the paused frame, so `evaluate` and `locals` answer from it although it has returned; `raised` there and at every first sighting of an exception in a user file, with the raising frame live and `uncaught: false`, since whether anyone catches it is not known yet (one that nobody catches pauses again at the top, `uncaught: true`). `step`, `rid`, `line` and `stack` are the user statement that raised, which for a raise inside a library or a C call is the statement that made the call. `StopIteration`, `GeneratorExit`, `SystemExit` and `KeyboardInterrupt` never pause, nor does a library frame. After the uncaught pause resumes, the run ends as it would have: exit code 1 and the `error` event with its traceback. |
| `debug.resumed` | `step, action: "continue" | "step", kind?` |
| `http.exchange` | `n, client, method, url, status, reason, bytes, ms, recordedMs?, source, rid, step` — one per HTTP request the program made, see "HTTP record and replay" (Rows) |
| `run.finished` | `exitCode, durationMs, timedOut, stopped, stepCount, logCount, profile?: {path}, replayed?: true, http?: {mode, requests, recorded, served, misses, file, exists, recordedAt, entries}` (`profile.path` is the `.cpuprofile` written in `mode: "profile"`; `exitCode` is `null` when killed; `replayed` and `http` come from the HTTP plugin, see "HTTP record and replay") |
| `runner.error` | `message, detail?` (runner-level problem, not user code) |

Step flags: `1` log at this step, `2` error raised here, `4` first step of a
scope (function entry), `8` no code mapping (file not open / not instrumented
with source), `16` exception unwinding through this step.

### `debug.paused` with `record: false`

```jsonc
{ "type": "debug.paused", "runId": "r-1", "seq": 12,
  "step": 1403,                      // the statement counter, not a navigable index
  "rid": 88, "fileId": 2, "line": 42, "scopeId": 7, "depth": 2,
  "reason": "breakpoint",
  "breakpoint": { "path": "/abs/project/app.py", "line": 42, "rid": 88, "fileId": 2, "resolvedLine": 42 },
  "thread": { "name": "Thread-3 (process_request_thread)", "ident": 6108209152 },
  "stack": [
    { "frameId": 0, "name": "do_GET",             "fileId": 2, "line": 42, "rid": 88, "scopeId": 7 },
    { "frameId": 1, "name": "handle_one_request", "fileId": 0, "line": 427, "path": "/opt/python3.12/http/server.py" },
    { "frameId": 2, "name": "<module>",           "fileId": 1, "line": 31, "rid": 3, "scopeId": 0 }
  ] }
```

A frame with `fileId: 0` runs in a file that is not instrumented and carries `path`, its own file.
A stop slice has no source to show for it, so it folds runs of them into one marker and names the
files from these paths (`4.3`); without `path` the marker still counts them.

- `step` is the statement counter: how many statements this run had executed
  when it stopped, across threads, starting at 0. It is not a trace index.
- `scopeId` is a per-call id, so recursion is exact and the field means the same
  thing as it does with a recording. `depth` is `len(stack) - 1`.
- `stack` walks `frame.f_back` from the paused frame, up to 64 frames, dropping
  the runtime's own frames and ending at the frame running the program's
  top-level code. A thread's chain has no such frame and ends at the
  `threading` frames that started it. Each entry carries the frame's own line,
  so a caller points at the call rather than at its `def`; the one exception is
  frame 0 at a function-entry pause, which carries the `def` line the pause
  reports rather than the first body statement, so the Call Stack and the editor
  agree. `fileId` is `0` for a frame whose file is not instrumented, and then
  there is no `rid`, no `scopeId` and no path. An exception pause takes each
  frame's line from the traceback, because a frame that has unwound reports the
  last line it ran.
- `frameId` is the index into that chain, `0` is the paused frame, and it is
  what `evaluate`, `complete`, `exec` and the `locals` action address.
- `modified: true` says an `exec` (or a `setVariable`, which is an `exec`)
  has written in this run: the values are no longer the program's own. Any
  `exec` sets it. It is not on the `debug.paused` that served the exec, which
  went out before it; it is on every stop from the next one on, and on any
  `locals` reply taken after the exec, the one at the same pause included. It
  is absent while false and is reset by a new run.

The pause flush is `sys.stdout.flush()` and `sys.stderr.flush()` and nothing
else: there is no partial trace, no `time` and no `locals` to send.

**One thread at a time.** A second instrumented thread that hits a reason while
another is paused blocks before emitting anything and pauses with the reason it
computed once the first resumes, so `debug.paused` and `debug.resumed` stay
strictly sequential and `continue`, `step` and `locals` need no thread argument:
they address the thread being served. `pause` sets one flag, so every
instrumented thread stops at its next statement, one after the other, each
reported with its own `thread`. A thread blocked in `accept()` or any other C
call does not stop until a statement runs: `pause` answers `{"ok": true,
"paused": false}` and the stop arrives when the next request does.

### `log`

```jsonc
{ "type": "log", "runId": "r-42", "seq": 9,
  "logId": "l-9", "kind": "log",               // log | value | autoLog | autoExpand | time | logpoint | system | error
                                                // autoExpand: a `# ?+` marker (the value, expanded further than a `# ?`)
                                                // error: a `# ? $.code` or `{expr}` evaluation raised; valueBag holds the exception
  "fileId": 1, "rid": 17, "hit": 1, "step": 88,
  "context": "quokka",                          // expression text or print label
  "text": "{'isAwesome': True, 'v': '3.14'}",  // one-line inline rendering
  "runtimeKey": "17",                           // stable across runs, used for stickiness and expand
                                                // str(rid) for values; "t:<rid>" timing logs; "<rid>:<param>" def-line logpoints; "w:<watchId>" watches
  "changeId": "c-7",                            // marker-supplied, for sticky values
  "markerId": "m1",
  "valueBag": { "data": { /* value node */ }, "runtimeKey": "17" } }
```

### `error`

One event per exception the run saw in instrumented code, all emitted when the run ends:
the uncaught one first, then the caught ones in first-raise order.

```jsonc
{ "type": "error", "fileId": 1, "rid": 21, "step": 12,   // where it was raised: the statement, the first raise's step
  "errorType": "KeyError", "message": "'b'",              // of the first raise
  "stack": [ { "fileId": 1, "line": 21, "col": 0, "rid": 21, "function": "lookup", "path": "/abs/main.py" } ],
  "handled": true,
  "handledAt": { "fileId": 1, "line": 68, "rid": 40, "function": "<module>", "broad": true },
  "count": 3, "lastStep": 47 }
```

- `handled: false` is the exception that ended the run; it also carries `traceback` (the
  formatted traceback, last 4000 chars) and has no `handledAt`, `count` or `lastStep`. It is
  never also emitted as caught: the instrumenter's own `try/finally` around every function
  body handles and re-raises it on the way out, which does not count (below).
- `handledAt` is where a caught exception was finally handled: the `except` clause that
  matched (`line` is the clause's own line; `rid` is the range id of the `try` statement that
  owns the clause, resolved from the `try`'s own line since a compound statement's range
  covers only its header), or the `with` statement whose `__exit__` swallowed it
  (`contextlib.suppress`; `rid` is the `with`'s). A `finally`, a `with` cleanup that re-raises, a non-matching
  clause and a handler that re-raises (`raise`, `raise e`) are not handlers: the runtime
  takes `sys.monitoring`'s EXCEPTION_HANDLED as a tentative handler and clears it on a later
  RERAISE or RAISE of the same exception object; the handler line comes from the code object
  and the byte offset of the event (the frame's `f_lineno` is still the raising line there),
  and when an `except` block has several clauses the one that matched is the clause whose
  body owns the first step recorded after the event. `function` is the handler frame's
  `co_name` (`<module>` at top level). `broad` is true for a bare `except:` and for a clause
  whose type is `Exception` or `BaseException`, alone or in a tuple (`ast.ExceptHandler.type`
  of the file's AST). Absent when the exception was caught outside instrumented files (C code
  such as `getattr(obj, name, default)`, the stdlib, a library without library stepping): it
  was caught, nobody knows where.
- Caught exceptions are aggregated per (`errorType`, origin `rid`, handler `rid` or none): one
  event per group with `count` (exception objects), `step` (the first raise), `lastStep` (the
  last), and the first raise's `message` and `stack`. At most 50 groups per run, in
  first-raise order (groups beyond the cap still count, they are just not emitted).
  Exceptions handled inside library files are never emitted (libraries raise and catch
  constantly), nor are exceptions raised in a library and caught by code that was not
  instrumented (C code, the stdlib); one raised in a library and caught in user code is, with
  the library origin when library stepping is on and attributed to the calling statement when
  it is off. A `NotImplementedError` raised by a compiler-generated `__annotate__` is ignored
  (Python 3.14's annotation protocol: a caller such as pydantic asks `annotationlib` for the
  STRING format, the generated function refuses it and `annotationlib` catches the refusal,
  one per class).
  Aggregation needs the whole run, so caught exceptions reach the host only when the run
  ends.

### Value node

```jsonc
{ "type": "dict",              // str number bool None list tuple dict set frozenset bytes function class module <ClassName>
  "value": "…",                // primitives: literal text; others: repr preview (bounded)
  "length": 3,                 // str/list/tuple/dict/set/bytes
  "capped": "first 8192 chars",// strings: the truncated prefix (value holds the same prefix, length the full size); containers: true when not expanded at this depth
  "cappedProps": true, "cappedElements": true,
  "props": [ { "name": "a", "keyRepr": "'a'", "type": "number", "value": "1" } ],
  "id": "17 0 2", "queryPath": ["17", "_p_a", "_p_0"], "expressionPath": "obj['a'][0]",
  "expandable": true, "circular": false,
  "nan": true, "positiveInfinity": true, "negativeInfinity": true,
  "loadActionNode": true,      // synthetic "…" child; click -> `expand`
  "secret": true               // the runtime replaced the value with "••••••••" (see "Secrets")
}
```

### Secrets

With `config.secrets.mask` (default) nothing that looks like a secret leaves the
child process; the host and the panel only ever see `••••••••`. There is no
value-shape detection (no `sk-` prefixes, no entropy): two provenance rules,
implemented in `python/pyokka_runtime/secrets.py`.

- *Value provenance*: the value of every environment variable whose name is
  secret-looking (`OPENAI_API_KEY`, `DB_PASSWORD`, `AUTH_TOKEN`) and at least 8
  characters long is replaced wherever it appears in any outgoing event: reprs,
  print output, exception messages, URLs, headers, watch and hover results.
  `os.environ` is re-scanned when its size changes, so variables set by
  `load_dotenv()` inside the program are picked up.
- *Name provenance*: a `str`/`bytes` value under a secret-looking name is
  replaced whatever it is: an attribute (`client.api_key`), a dict key
  (`{"password": ...}`), a keyword or item literal inside a repr
  (`OpenAI(api_key='...')`), a hovered or watched expression ending in such a
  name, a recorded local. `None` and numbers stay visible.

A name is secret when one of its words (split on `_`, `-`, camelCase) or an
adjacent pair is one of: api key, access / secret / private / signing /
encryption / session / master / licence key, secret(s), password, passwd,
passphrase, credential(s), token(s), auth, authorization, bearer, dsn, plus
`config.secrets.names`. Bare `key` is not (loop variables). Masked value nodes
carry `secret: true`; text fields are replaced in place. `steps` (the trace
buffer) is never scanned.

### Plugins

`config.plugins` names Python modules (imported from the file's directory, the
workspace root or `sys.path`). Each may define, all optional and all called
with the raw `config` dict:

- `before(config)`: once per runner process. In fork mode it runs in the runner
  before the child is forked, so whatever it imports is inherited un-instrumented
  by every run; import clients lazily (see the HTTP plugin) rather than here.
- `before_each(config)`: in the run process, before the file is instrumented and
  executed. The runtime's import finder is already first on `sys.meta_path`; a
  finder the plugin inserts at position 0 sees every import before it.
- `after(config) -> dict | None`: in the run process once the program has finished
  (return, uncaught exception or `sys.exit`), before `run.finished`. A dict it
  returns is merged into `run.finished`; the runtime's own fields win.
- `pyokka_runtime.execute.current` is the running `Execution` from `before_each`
  to `after` (its `spec.file_path` and `spec.workspace_root` say what runs where);
  `None` in the runner process. `pyokka_runtime.execute.runner_error(message)`
  emits a `runner.error` for the current run from plugin code (a no-op outside a
  run).

A hook that raises produces a `runner.error` (`plugin NAME failed in STAGE: …`) and
the run goes on without it.

### HTTP record and replay

`config.http` (`"off"` default) loads the runtime plugin
`pyokka_runtime.plugins.http_record` (appended to `config.plugins` by the runtime
when it is not listed). `record` lets every request through and writes each
exchange down; `replay` answers every request from the recording and never
touches the network, so a re-run of API-driven code costs nothing and returns
the same values. The setting is per session in the panel ("HTTP" in Settings),
`pyokka.http` as a default, `--http record|replay` on `pyokka run`.

**Clients.** The plugin patches, on import (a `sys.meta_path` hook) or at once
when the module is already loaded: `httpx.Client._transport_for_url` and
`httpx.AsyncClient._transport_for_url`, which wrap whatever transport the client
picked (custom ones included, such as litellm's `AiohttpTransport`) so its
`handle_request` / `handle_async_request` is recorded (also the `httpx2`
package, the same classes under another name); `aiohttp.ClientSession._request`
with the body taken from `aiohttp.StreamReader.feed_data` as it arrives, so a
streamed response reaches the program at network speed in record mode, and an
aiohttp session that an httpx transport drives is not counted twice (a
ContextVar); `requests.adapters.HTTPAdapter.send`; and, as
the fallback for `urllib.request`, `urllib3` and raw `http.client`,
`http.client.HTTPConnection` (`send`, `getresponse`, `connect`, plus
`HTTPSConnection.connect`): the request bytes are collected from `send` and
parsed (start line, headers, body de-chunked) when `getresponse` is called. A
request already handled by a higher-level hook (requests over urllib3 over
http.client) passes through the fallback untouched (a thread-local depth). In
replay mode `connect` is a no-op, so no DNS or TCP happens.

**The recording.** One file per source file:
`<workspaceRoot>/.pyokka/replay/<hash>.jsonl`, `hash` = the first 16 hex digits
of sha256 of the file's real path (edits keep the file; a moved file starts a
new one). When `<workspaceRoot>/.pyokka` is a regular file (the Quokka-style
config file) the directory is `<workspaceRoot>/.pyokka-replay/` instead. Replay
reads the first file found in `<workspaceRoot>`, then the file's directory and
each of its ancestors (a run recorded by `pyokka run`, whose workspace root is
the file's directory, replays in the panel and the other way round). A record
run *replaces* the file when its first exchange is written; a record run that
made no request leaves the previous recording alone. Lines:

```jsonc
{ "pyokka": "http", "version": 1, "file": "/abs/agent.py", "recorded": "2026-09-11T10:12:03Z", "python": "3.14.6" }
{ "n": 1, "key": "3f2a…",                              // n: request order; key: see below
  "client": "httpx",                                   // httpx | aiohttp | requests | http.client
  "request": { "method": "POST", "url": "https://openrouter.ai/api/v1/responses",
               "headers": { "content-type": "application/json", "user-agent": "OpenAI/Python 3.11.0" },
               "body": "{\"model\": …}" },
  "response": { "status": 200, "reason": "OK",
                "headers": { "content-type": "application/json" },
                "body": "{\"id\": \"resp_…\"}",         // or "chunks" when streamed
                "streamed": false, "chunks": null },
  "elapsedMs": 1834 }
```

Bytes fields (`request.body`, `response.body`, each element of `chunks`) are a
UTF-8 string, or `{"base64": "…"}` when the bytes are not UTF-8, or `null` when
there is no body. `streamed: true` means the body arrived in more than one chunk;
`chunks` then lists them with their boundaries (an SSE consumer sees the same
events in the same pieces) and `body` is `null`. Bodies are stored *decoded*:
`content-encoding` (gzip, deflate, and br / zstd when a decoder is importable),
`content-length` and `transfer-encoding` are dropped from the stored response
headers, and the replayed response carries the stored headers. A compressed body
that could not be decoded is kept as received, header included. Request headers
`authorization`, `proxy-authorization`, `cookie`, response `set-cookie`, and any
header whose name is secret under the "Secrets" rules (`x-api-key`, `api-key`)
are dropped; every stored header value and text body goes through the secret
filter (`secrets.current.scrub`), so an env-sourced key that appears in a body
is stored as `••••••••` (and replayed masked). Header names are lower-cased.

`key` = sha256 of `METHOD\nURL\n<body>` where `<body>` is the request body
normalised: canonical JSON (sorted keys, no spaces) when it parses as JSON, else
UTF-8 text with whitespace runs collapsed to one space, else the raw bytes.
Headers are not part of the key (they carry credentials and dates). Multipart
bodies with a random boundary therefore get a new key per run.

**Replay.** The transport answers a request with the entries of its `key` in `n`
order, one per request; when they are used up the last one is served again. A
key with no entry is a *miss*: the plugin emits
`runner.error` `no recorded response for POST https://…/responses; run once in
record mode (<file>)` (once per key per run) and the transport raises
`ConnectionError("pyokka replay: no recorded response for POST https://…")` in
the program (an SDK's retry logic sees a connection error). Replay is fast, so
`# ?` timings, coverage and the Time Machine reflect the recorded results, not the
network. In record mode a request that fails (no response) is not written.

**Modes.** The plugin loads for every run. `off` (the default) *observes*: the
clients are patched, every request is listed as a row (below), nothing is written
and the program sees exactly the response it would have seen (no body is read,
buffered or rebuilt; sizes come from `content-length` or a pass-through count, `null`
when unknown). `record` and `replay` are described above. `config.httpObserve:
false` with `off` leaves the clients untouched: no plugin, no rows, no HTTP view
(`record` and `replay` need the patches and keep listing rows).

**Rows.** One `http.exchange` event per request, emitted from the plugin when the
exchange completes (httpx: when the program closes or exhausts the response stream,
or at the end of the run for a stream it never finished; requests and http.client:
when the response is returned; replay and miss: when the transport answers):

```jsonc
{ "type": "http.exchange",
  "n": 3,                                 // request order in the run; in record mode the recording line's n
  "client": "httpx",                      // httpx | aiohttp | requests | http.client
  "method": "POST", "url": "https://api.openai.com/v1/responses?key&v=1",  // query values stripped: names stay, values go
  "status": 200, "reason": "OK",          // both null for a miss
  "bytes": 6812,                          // response body bytes as the client layer received them; null when unknown
  "ms": 1834,                             // request start → body complete (live, recorded); → answered (replayed, miss)
  "recordedMs": 1834,                     // replayed rows only: the recording's elapsedMs
  "source": "live",                       // live | recorded | replayed | miss
  "rid": 17, "step": 88 }                 // the innermost user statement running when the request started; -1 when none
```

`rid` comes from a walk up the frames at request start to the innermost frame of an
instrumented, non-library file (a request from a worker thread or from inside an
instrumented library still names the user's statement); `step` is the most recent
step recorded for that statement, the Time Machine's target. A request made before
the tracer is installed or from a frame with no user statement carries `rid: -1`.
A miss is one row per attempt (an SDK's retries show as rows) while
`run.finished.http.misses` counts distinct keys. The full URL lives only in the
recording; `url` is a redacted text field for agents.

**`run.finished`.** `http: {mode, requests, recorded, served, misses, file, exists,
recordedAt, entries}` for every run the plugin loads in (absent with `httpObserve:
false` and `off`): `requests` the rows emitted, in request order, `recorded` the
exchanges written, `served` the responses answered from the file, `misses` the
keys without one, `file` the recording found for the source file (or the path a
record run would write), `exists`/`recordedAt`/`entries` whether it is on disk
after the run, its header's timestamp and its number of exchanges (`null` when
absent); plus `replayed: true` when the mode was `replay`.

**HTTP table** (`pyokka http RUN`, `--live`, bridge `http`, the panel's HTTP view),
built from the rows by one pure function per language and pinned by a shared
fixture (`test/unit/fixtures/http-table*.json`):

```jsonc
{ "runId": "r-42", "running": false, "count": 3, "truncated": false,   // 500 rows at most
  "totals": { "requests": 3, "bytes": 68123, "ms": 1201, "misses": 0, "missAttempts": 0 },
  "finished": { /* run.finished.http */ } | null,
  "requests": [ { "n": 1, "client": "httpx", "method": "POST", "url": "https://api.openai.com/v1/responses", "name": "responses",
                  "status": 200, "reason": "OK", "bytes": 6812, "ms": 1834, "recordedMs": null, "source": "recorded", "step": 88,
                  "location": { "file": "/abs/agent.py", "line": 16, "col": 0, "fileId": 1 } | null } ] }
```

`name` is the URL's last non-empty path segment, else its host, cut at 60
characters. Text form: a header `3 requests · 68 kB · 1.2 s · recorded to
3f2a….jsonl (2026-09-11 10:12Z)` (or `· replayed from …, 2 missing (3 attempts)`,
`· HTTP off`), then one line per row `#1  POST  200  responses  agent.py:16  6.8 kB
1.8 s  recorded  https://api.openai.com/v1/responses` cut at 100 characters; a miss
shows `MISS` and `—`.

**Hosts.** The panel's HTTP view (rail button `globe`) lists the table live while
the run progresses, with the initiator as a `file:line` link (click: Time Machine to
`step`), a footer with the totals and the recording's name and date, the mode
dropdown, and "Open recording" (the JSONL in an editor). While the mode is `record`
or `replay` the rail button carries a badge and the status bar reads `· HTTP record`
/ `· HTTP replay` (with `, N recorded` / `, N missing` when the last run had that
mode; `· last run replayed` / `recorded N` when it had the other; never "replayed"
and "HTTP replay" in one text); with the mode `off` the status bar keeps the last
run's `· recorded N` / `· replayed`. When the mode is `off` and a recording exists
for the file, the view's footer says `A recording from <date> (N requests) exists ·
Replay`. On the first recording in a git workspace the host offers once to add
`.pyokka/replay/` to the workspace `.gitignore`.

## Runtime notes (python/pyokka_runtime)

- Hooks are installed as builtins named `_pk_s`, `_pk_c`, `_pk_f`, `_pk_x`,
  `_pk_v`, `_pk_t`, `_pk_print`, `_pk_logpoint`, `_pk_time`,
  `_pk_snap_error`, plus the markers `_pk_u` and `_pk_end`; the per-function
  scope local is `_pk_scope_`. A `__pk_`
  prefix is impossible: Python mangles `__name` identifiers inside class
  bodies, methods included. `instrumentedSource` shows these names.
- Return values: a function body starts with `_pk_rv_ = _pk_u`, every
  `return value` becomes `return (_pk_rv_ := value)` (a bare `return` gets
  `_pk_rv_ = None` before it and stays bare, as an async generator requires),
  the end of the body sets `_pk_rv_ = _pk_end`, and the exit hook in the
  `finally` is `_pk_x(_pk_scope_, _pk_rv_)`. Still `_pk_u` there means an
  exception is leaving the frame (`sys.exception()` names it). A return costs
  a local store, not a hook call; the text is made once per call at exit.
- Compound statements (`if`, `for`, `def`, `class`, ...) have a *header*
  range (up to the end of the test / iterator / signature), not the whole
  block. `functions[].bodyRange` is the whole `def`.
- Print output is not echoed to stdout; the `log` event (kind `log`) is the
  record. `print(..., file=sys.stderr)` logs with `context: "stderr"`. Other
  `file=` targets pass through untouched.
- `time` events are emitted for every timed range at the end and every 250 ms
  while running; `log` events of kind `time` carry the running aggregate in
  `time`.
- `watch` events are emitted for steps `traceContext.step <= s <
  traceContext.step + prefetch`; each has either `valueBag` or `error`.
- Coverage-ignore hints on a compound statement ignore the whole block.
- Scope parents: `_pk_f` reads the caller's `_pk_scope_` by walking up to four
  `f_back` frames from the entered function's frame (a decorator wrapper or a
  `sorted(key=...)` callback sits between caller and callee; a task resumed by
  the event loop or a thread's target has no instrumented caller within reach and
  gets the module, parent 0). A module frame ends the walk: an imported project
  module's global `_pk_scope_`, else 0. Only frames whose code has `_pk_scope_`
  among its variable names have `f_locals` read, so uninstrumented frames cost an
  attribute lookup (on 3.12 `f_locals` snapshots the frame's locals; 3.13+ hands
  out a proxy). Measured on a 100k-call loop this costs 5–9 % over the previous
  "current scope" rule, 11–16 % when every call comes from another instrumented
  function; a frame-id map keyed at entry and cleared at exit was slower.
- `libraryCode`: a library module's body is coverage-only, and so is everything
  it calls while importing. The module body is wrapped in `_pk_f(<module rid>)`
  / `_pk_x`, which make the tracer *quiet* until the import finishes: hits are
  counted, steps, scopes and handled exceptions are not. Steps and scopes are
  recorded for library functions called afterwards from stepped code (pydantic
  building its models at import time was 1.7 M steps otherwise). No scope is
  created past `maxTraceSteps`.
- Instrumented library files are cached under `~/.pyokka/cache/`
  (`PYOKKA_CACHE_DIR` overrides the directory, an empty value disables the
  cache), keyed by runtime version, interpreter bytecode magic, real path,
  mtime, size and instrumentation options. The code object is stored compiled
  at a sentinel range base and its range-id constants are rebased on load
  (`instrument.relocate`). Project files are never cached. Entries not
  rewritten for 30 days are swept. `pyokka cache` reports the directory, entry
  count and size; `pyokka cache --clear` and the extension's "Clear Library
  Cache" command remove the entries (`cache.clear`; the directory stays).
- The debugger (`debugger.py`, `control.py`): a run started with `config.debug` or
  `breakpoints` can pause at its frontier. The statement and function-entry hooks call
  `Debugger.on_step` only while a debugger is attached, so other runs pay nothing. A pause
  blocks the program thread inside the control channel, which serves requests against the
  live frame until `continue` or `step`; a stop while paused goes through the usual SIGTERM
  flush. Step semantics are the Time Machine's, computed from the scope parent chain (into:
  the next step; over: the next step in this scope or an ancestor; out: in an ancestor), so
  recursion is exact and a step over an awaited gather skips the gathered tasks. `locals`
  entries flushed at a pause are not re-sent at the end (`locals_flushed`).
- No run with `config.debug` is on the timeout clock, recording or not: the host
  sends `timeoutMs: 0` and `Runner.handle_run` arms no timer for a debug run
  whatever the request says. A debug run that looks busy may be a server waiting
  for a request, and a stale host must not be able to kill a paused program.
  `stop` is how a debug run ends early.
- A debug run with `config.record: false` installs a second hook set
  (`hooks_debug.py`) instead of the recorder's. Per statement it increments one
  integer and reads one list cell; while a reason is armed it also reads the
  breakpoint index. No list append, no tuple, no dict write, no frame fetch, no
  attribute lookup on the tracer, no clock read, and no call into the debugger
  unless a breakpoint matched or a reason other than a breakpoint is armed.
  `Debugger.on_step` fetches the frame itself (`sys._getframe(2)`) and only once
  a reason needs one, so a breakpoint without a condition touches no frame until
  it pauses. Step Over and Step Out keep no per-call state either: `_pk_f` hands
  out a per-call id from a counter, and the `_pk_x` the instrumenter already
  calls from a `finally` tells the debugger when the frame it is stepping in has
  returned, which re-arms the step in the nearest instrumented ancestor of that
  frame, the module body included. When the frame has no such ancestor within
  four frames, because it was called from code that is not instrumented (a thread
  target, a request handler under a web framework, a library callback) or from
  nothing at all, the step becomes the next statement of the program's own code
  wherever it runs, which is what a debugger with "just my code" does: a handler
  that unwound into the framework has no frame of ours to come back to, and
  waiting for one means the next request is served with the client still waiting
  for its stop. The pause reports the kind that was asked for, so a Step Over
  that degraded still says `over`. A frame that suspends (a `yield`, an `await`) runs no `finally`, so
  the step belongs to that frame and lands where it resumes; a frame that never
  resumes leaves the step armed and the run goes on to the next reason. Frame 0
  of the stack reports the line the pause reports, which differs from the
  frame's own `f_lineno` at a function entry: the pause is on the `def` line and
  the frame is about to run the first body statement. A server running for an
  hour holds one integer, one pending tuple and the breakpoint index.
- `exec` (`dbgexec.py`) is the only place the runtime writes into a running
  program; everything else that reads a paused frame goes through `pure.py` and
  cannot have an effect. How the write reaches the frame's own variables depends
  on the interpreter: at module level the frame's globals are the module dict,
  so an assignment is already in place; on 3.13+ `f_locals` is the write-through
  proxy of PEP 667 and the exec lands in the fast locals directly; on 3.12
  `f_locals` is a snapshot dict cached on the frame, so the exec writes into the
  snapshot and `ctypes.pythonapi.PyFrame_LocalsToFast` pushes it back. That is
  the one thing here that needs `ctypes`, and a build without it refuses the
  request (`cannot write to a frame on Python 3.12 without ctypes`) before
  running anything rather than after. A name the function itself declares reaches
  the program's own code on both branches; a brand-new name stays in the frame's
  locals mapping, so a later `exec`, `evaluate` or `locals` sees it but the
  compiled code does not, because it has no slot for it. Any `exec` attempt sets
  `modified`, successful or not, because the runtime cannot know what a statement
  did and one that raised halfway may already have written; from then on it rides
  on every `debug.paused` and on every `locals` reply, until a new run.
- A `function: NAME` breakpoint (`dbgbreakpoints.py`) is resolved by the runtime,
  not the host: a module imported later gets its breakpoint when it loads, which
  an AST scan of the program cannot do for an arbitrary `sys.path` module, and
  the instrumenter already built the table. `info.function_names` maps the rid of
  a `def` to its name, and that rid is the one `_pk_f` is called with, so the
  breakpoint pauses at every call, before the function's first statement. The
  table holds bare names, so a dotted NAME matches on its last segment
  (`Ranker.rank` finds `rank`). With a `path` only that file is searched; without
  one, every instrumented non-library file, in the order they were instrumented,
  and inside a file in source order. Another file that defines the same name does
  not move the breakpoint: the first match keeps it and the echo carries
  `also defined in lib/rank.py:12; give FILE:LINE to pick one`.
- Exception tracking with `config.record: false` keeps nothing per exception but
  its identity: `ErrorMixin.seen` holds the last 256 exception objects by
  `id(exc)` so a first sighting stays a first sighting, and no `ErrorRecord`
  survives the callback. With `breakOnException: "off"` a non-recording run
  installs no `sys.monitoring` callbacks at all; the `exceptions` action installs
  them when it switches away from `off` and removes them when it switches back.
- `mode: "profile"` runs the plain (uninstrumented) file under `cProfile`; the
  `.cpuprofile` is a flat profile (every function under `(root)`, self time as
  samples).
- `mode: "snaps"`: `"""{{ ... }}"""` fences anywhere in the file; every
  top-level statement and every snap statement runs in its own try/except, so
  errors are reported (as `error` events, coverage 3/4) and execution
  continues. Snap values are logged with kind `value`.
- Awaitables: a coroutine that is the value of a bare expression statement
  logged by `# ?` is run to completion (`asyncio.run`, or scheduled on the
  running loop); Tasks/Futures are logged on completion; a coroutine bound to a
  name is shown as `<coroutine ...>` and left alone.
- Child mode (`pyokka_runtime/forksafety.py`): a run child is a fork of the
  runner on Linux and a fresh interpreter (spawn) on macOS and Windows;
  `PYOKKA_SPAWN=1` forces spawn anywhere, `PYOKKA_FORK=1` forces fork on macOS.
  `ready.capabilities[0]` says which. Forking on macOS died after the first
  run: the parent has threads once a run finished (the pipe readers, the
  waiter, the timeout timer), which arms Apple's `objc_initializeAfterForkError`
  check in every later child, and the first Objective-C class the child
  initialises that the parent had not aborts it (SIGABRT, exit -6). User code
  gets there through Apple frameworks: building an `httpx` client (its proxy
  lookup runs `urllib.request.getproxies()`, SystemConfiguration,
  `+[NSCharacterSet initialize]`), `getproxies()` itself (`+[NSNumber
  initialize]`), a TLS handshake verified by `truststore`; the openai SDK does
  the first when the client is constructed, before any request. A spawned child
  costs about 35 ms more than a fork (interpreter start plus the runtime's
  imports; user imports are cold either way) and has no such rule. Whoever forks
  on macOS must set `OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES` for the runner;
  the runner's own threads never enter Objective-C, so the check is a false
  positive there. A child that dies from a signal without a `child.done` (a
  negative exit code that is not a timeout or a stop) produces a `runner.error`
  naming the signal, with a hint, before `run.finished`; the runner never
  re-runs it.


## Agent access: saved runs, the context slice, the bridge

Agents (Claude Code, Codex exec, scripts) read a run through the `pyokka` CLI
(`python -m pyokka_runtime`, a stdlib argparse program with a `pyokka` console
script). Two sources feed the same commands: a **saved run** file, and the
**bridge** of a live VS Code session (`--live`). Both produce the same JSON
shapes; the CLI renders them as bounded text (`--json` prints them raw). Every
string that leaves the runtime or the extension goes through **redaction**.

### Saved run (`pyokka run FILE --save run.json`)

`run.json` is the NDJSON event stream of `run` as a JSON array (`events`), plus
`meta`: `{"runtimeVersion", "python", "file", "workspaceRoot", "argv",
"config", "started", "durationMs", "files": [{"fileId", "path", "sha256"}]}`.
`sha256` is of the file content that ran (the buffer content for the main
file). Commands that read a saved run compare the hashes with the files on
disk and print `stale: <path> changed since the run` before their output.
`--keep` leaves the runner serving after the run and records `"keep": {"pid",
"socket"}` in `meta`, so `eval`/`expand` can reach the finished child; without
it those commands say the run must be repeated with `--keep` or `--live`.

### Context slice (one JSON shape for every stop)

```jsonc
{ "step": 113, "count": 2143,
  "location": { "file": "/abs/openai/_client.py", "line": 159, "col": 4, "function": "__init__", "fileId": 2 },
  "stale": false,                       // saved run: hashes differ; live: the document changed since the run
  "stack": [ { "file": "...", "line": 159, "function": "__init__", "step": 113 },
             { "file": "/abs/agent.py", "line": 16, "function": "<module>", "step": 112 } ],   // innermost first
  "block": { "file": "/abs/openai/_client.py", "function": "__init__", "scopeId": 3,
             "lines": [ { "line": 159, "text": "def __init__(self, *, api_key=None, ...):", "step": 113 },
                        { "line": 204, "text": "    if api_key is None:", "step": 114, "current": true } ] },
  "values": [ { "line": 205, "context": "api_key", "text": "None", "step": 115, "hit": 1, "runtimeKey": "4021" } ],
  "coverage": { "notRun": [206, 207] },   // lines of the block that never ran, when known
  "moves": { "into": 114, "over": 114, "out": 2143, "back": 112, "backOver": 112, "backOut": 112 },  // null when impossible
  "errors": [ { "line": 16, "type": "OpenAIError", "message": "Missing credentials...", "step": 2143 } ] }
```

### Variable history (`pyokka var RUN NAME`, bridge `var`)

```jsonc
{ "name": "api_key", "total": 2, "truncated": false, "recordedLocals": true,
  "changes": [
    { "step": 2112, "file": "/abs/openai/_client.py", "fileId": 2, "line": 159, "function": "__init__", "scopeId": 3,
      "name": "api_key", "text": "None", "source": "locals" },
    { "step": 2133, "file": "/abs/openai/_client.py", "fileId": 2, "line": 250, "function": "__init__", "scopeId": 3,
      "name": "api_key", "text": "None", "source": "assign", "unchanged": true,
      "reads": [ { "name": "os" } ] } ] }
```

Every recorded change of one name, ascending by step, capped at 200 (`--limit`, `limit`;
`truncated` says when the cap cut). `name` in a change is the matched name: the query itself,
or a path under or above it (`acct.deposit(amount)` and `acct.balance` for `acct`; `self` for
`self.balance`). `step` is the statement that made the change, where the Time Machine should
land; `text` the new value. Three sources, in order of trust: `locals` (a `recordLocals` entry;
the runtime observes locals at the start of each step, so the change is attributed to the
scope's previous step when that statement binds the name, and to the iteration step itself for a
loop header, whose per-iteration step fires after the target is bound), `value` (a `log` of kind
`value`, `autoLog` or `autoExpand` whose `context` is the name; `logId` names the entry), and `assign` (the
statement binds the name per the AST bindings and nothing recorded the value: `text` is absent,
or, when the run recorded locals under the cap and the scope's next step saw no change, the
value it kept, with `unchanged: true`). A loop header contributes `assign` rows only for its
iteration steps. `reads` lists the names the statement loaded (at most 8) with the latest value
recorded before the step in the step's scope or its module, and the step that recorded it, one
level, so the reader walks backwards by asking for that name. A recorded local that is a
definition (`<function …>`, `<class …>`) carries its text but no step: `def` and `class`
statements are never steps, so the recorder saw the binding at whatever statement ran next. `file` (path suffix or basename)
and `scope` (function name) narrow the list. Text form: one line per change,
`#step file:line function name = text`, the reads after `←`.

`block` is the enclosing scope's Code Story block (the lines that ran, in
order, plus the header), capped at 60 lines around the current step; `values`
are the log entries of those lines, capped at 20, `text` only (`valueBag` on
request). `scope: true` lifts both caps; `block.capped: true` /
`valuesCapped: true` appear only when a cap cut something. `errors[]` carry
`file` too, values carry `logId`. `state.nav.step` is `null` while the Time
Machine is inactive. Source lines in `block.lines[].text` are code and are not
redacted; every value, context, error message and eval result is. The same shape answers "context for
`file:line`" (the first step on that line) and every `step` move.

### Provenance (`pyokka why RUN STEP [NAME]`, bridge `why`)

```jsonc
{ "name": "label", "step": 24, "depth": 5, "nodes": 7, "truncated": false, "recordedLocals": true,
  "conclusion": "label is 'total/35.0' at #24 (main.py:29). helper.describe(total, os.sep) returned 'total/35.0'.",
  "root": {
    "name": "label", "text": "'total/35.0'", "source": "locals", "logId": "l-12",
    "step": 24, "file": "/abs/main.py", "fileId": 1, "line": 29, "function": "<module>", "scopeId": 0,
    "statement": "label = helper.describe(total, os.sep)",
    "reads": [
      { "name": "helper" },
      { "name": "total", "text": "35.0", "source": "locals", "step": 23, "file": "/abs/main.py", "fileId": 1, "line": 28,
        "function": "<module>", "scopeId": 0, "statement": "total = sum(a.balance for a in [acct, Account(\"guest\", 5)])",
        "reads": [ { "name": "acct", "text": "Account(owner='ivor', balance=30.0)", "source": "value", "step": 22, "cut": true, "…": "location, statement" },
                   { "name": "Account" } ],
        "calls": [], "opaque": [ "sum(a.balance for a in [acct, Account(\"guest\", 5)])", "Account(\"guest\", 5)" ] },
      { "name": "os" } ],
    "calls": [ { "name": "describe", "scopeId": 5, "entryStep": 25, "returnStep": 27, "file": "/abs/helper.py", "fileId": 2, "line": 1,
                 "inputs": [ { "name": "value", "text": "35.0" }, { "name": "sep", "text": "'/'" } ], "result": "'total/35.0'" } ],
    "opaque": [] } }
```

The tree of what produced one value ("why is this here"). The root is the value `name` had
after `step` when the statement at `step` made it (the change `var` lists at that step, with its
`text`, `source`, `logId`, `unchanged`; when several matched names have a row there the exact
name wins, then the first); else the value `name` had when `step` ran (`var`'s read rule: the
latest value recorded before the step in the step's scope or its module, `source` `locals` or
`value`, `step` the statement that made it); else a leaf (`{name}` alone: nothing recorded; `{name, beforeRecording: true}` in a `midRun` recording, whose chain ends at step 0). A
dotted `name` with nothing recorded falls back to its first segment by the read rule (`self` for
`self.balance`), and the node says so by its `name`. An empty `name` explains the statement at
`step` itself (`{name: "", step, …}`). A `locals` node carries the `logId` of the entry its
statement logged for the name, when there is one: a value is logged when its statement completes,
so the entry sits at the last step the statement ran (inside a callee when it called one); the
entry whose range is the statement's, at or after the step and before the scope's next step, is
the statement's (the `# ?` on `area = scale(width, base)` is logged at `scale`'s last step and
belongs to `area`'s node).

A node with a `step` carries the producing statement: its location (`file`, `fileId`, `line`,
`function`, `scopeId`, as a `var` change), `statement` (the first source line, trimmed, ` …`
appended when the step's range ends on a later line, so a loop header is never marked; absent
without the source) and, when expanded, its inputs, in this order:
- `reads`: the names the statement loaded (the bindings' `reads`, at most 8, in order), each
  resolved like `var`'s reads (the latest value recorded before the step in the step's scope or
  its module: `text`, `source` `locals` or `value`, `step` the statement that made it, `logId`)
  and expanded in turn while its step is earlier than its parent's (a name read from itself, or
  a loop variable, ends there);
- `calls`: the functions the statement called whose body was stepped: every scope whose parent
  is the step's scope and whose call site (the last step of the parent scope before the scope's
  first step, the walkthrough's rule) is the step, in entry order, at most 8: the scope's `name`
  and `scopeId`, `entryStep`/`returnStep` (its first and last step), the `def` header's location,
  `inputs` (the arguments as the walkthrough's call moment lists them: the parameters recorded
  at entry, `self`/`cls` left out, at most 8) and `result` (the value the walkthrough's call
  moment reports as `out`, when it has one); each call is looked up on its own, so an entry the
  walkthrough spent on an earlier call is not withheld from this one;
- `opaque`: the calls the statement makes per the AST (the bindings' `calls`) that no stepped
  scope claimed: a scope claims the first unclaimed text whose callee (the last dotted name
  before the parenthesis) equals its name, or, for an `__init__` scope, starts with an uppercase
  letter. Leaves: builtins, library code that was not stepped, dataclass constructors.

Expansion is breadth-first, level by level, `depth` levels below the root (default 5, at most 8)
and at most 60 nodes in all (`PROVENANCE_NODES`; the root counts): a node at the last level, or
one whose reads would take the count past the budget, keeps its location and statement and is
marked `cut: true` (no `reads`, `calls`, `opaque`); `truncated: true` says the budget cut.
`nodes` counts the nodes of the tree, `recordedLocals` is `var`'s flag, and the CLI adds
`stale`/`staleFiles` like `var`. Values in `text`, `inputs` and `result` are redacted like every
value; `statement` and `opaque` are source and are not.

`conclusion` is the answer in words, one or two sentences built from the root and its first
level by fixed rules, so it never guesses (`python/pyokka_runtime/agent/why_text.py`,
`provenanceConclusion` in `src/shared/provenanceText.ts`; the fixture cases pin both to the same
strings). The first sentence is the value and where: `NAME is VALUE at #STEP (file.py:LINE)`
(the file's base name, values one line cut at 60 characters). The second is the first rule that
applies, in this order: a conditional expression whose arm is known (`The else arm ran: TEST is
VALUE` when the test is a name with a recorded value, `The else arm ran: TEST was false, since A
is X` when the produced value is the arm's literal, `since` naming up to two recorded reads of the
test); a stepped call with a recorded return (`f(args) returned VALUE`, plus `with P = None` for
the first parameter recorded as None or empty); a plain copy of one recorded read (`It copies y,
which has been VALUE since #STEP (file.py:LINE)`); a `.get(...)` or subscript that produced None
from a recorded container (`EXPR is None: the key is not in CONTAINER (N keys)`, the count only
when the recorded text is a whole dict); otherwise `It reads a = X, b = Y` for up to three
recorded reads. It is `""` for a leaf, for a statement query (empty name) and for a root whose
value was not recorded. The text forms (`pyokka why`, the panel) print it as the last line.

Text form (`pyokka why`, the panel's Details pane; `src/shared/provenanceText.ts` is the
reference, `render_why` its twin): `why NAME at #STEP` (`why #STEP` without a name), then one
line per node, depth-first, two spaces of indent per level: `← name = text   #step
file:line function   statement` (no arrow on the root; `name = ?` for a leaf without a value, `name = ?   made before #0, where the recording started` for a `beforeRecording` leaf;
`name  assigned here (value not recorded)` for an `assign` node without one; `  (unchanged)`
after an unchanged value; `  …` after a cut node), its reads first (each with its own subtree),
then its calls as `↳ name #entry–#return file:line   in a = 1, b = 2   out text`, then `· call
text   not stepped` per opaque call. Values are cut to 100 characters, statements and results to
80, inputs to 60. A truncated tree ends with `… more inputs than 60 nodes show; ask why for a
node's name at its step`. `pyokka why --live [STEP] [NAME]` takes the Time Machine's step when
`STEP` is left out.

### Bridge (live session)

The extension listens on a Unix socket per session when `pyokka.agentAccess`
is on (default off): `~/.pyokka/sessions/<pid>-<n>.sock`, described by a
sibling `<pid>-<n>.json`: `{"socket", "token", "pid", "kind": "run", "workspace",
"file", "displayName", "runtimeVersion", "started"}`. Both are removed on
dispose. `kind` is new and additive: a Debugger session writes its own
descriptor with `kind: "debug"` and a `launch` object (see "The Debugger's
socket"), and the CLI picks between the two per verb. An older descriptor
without `kind` is a run-all session.
Wire: NDJSON both ways. First client line `{"token": "..."}`; a bad token
closes the connection. Requests carry `id` and `type`; replies are `{"id",
"ok": true, ...}` or `{"id", "ok": false, "error", "hint"}`. Every request is
logged in the Pyokka output channel. `file` fields accept an absolute path, a
workspace-relative path or the display name; a missing `file` means the
session's main file. `context`/`values` include `valueBag`s only with
`valueBag: true` (`eval` always does, so `expand` has a `valueId`).

| request | fields | reply |
|---|---|---|
| `state` | | `{kind: "run", runId, running, finished, stale, nav: {active, step, count}, location?, displayName, file, http, debug, others}` (`http` is the session's HTTP mode; `debug` is `{active, paused: PausedInfo | null, frontier: number | null, exceptions, modified}` while a debug run exists, else `null`; `others` lists the debug sockets of the same file as `{kind, displayName, descriptor, running, paused}`; see "Debugging over the bridge") |
| `step` | `kind: into|over|out|back|backOver|backOut` or `to: N`, `count?` | the context slice of the new step; the editor reveals it before the reply. `count` (clamped to 1..1000) takes that many stops in a row with an executing `kind` and replies with the last one; a stop that is not this step's wins and the reply carries `stoppedEarly: {after, reason}`, and a program that ended mid-count replies `{finished, stepped: N}` with the stops it made. When the Time Machine is not active, `kind` starts it at the run's start step and then moves (the first `into` lands on step 1); `to` starts and jumps. While a debug run is paused and the position is the frontier, `into`, `over` and `out` execute the program to its next stop and the reply arrives then: the slice with `paused`, or `{finished}` when the run ended; the backward kinds replay as ever; `to` past the frontier is an error with the hint "continue or step to get there" |
| `context` | `step?` or `file, line, endLine?`; `scope?` | context slice; while a debug run is paused, the frontier's slice (no `step`, or `step` = the frontier) also carries `paused`, `locals` and `output`. With no `step`, no Time Machine and no pause of its own, the run socket answers with the pause of a `record: false` debug session of the same file when one is paused: that socket's stop reply, `recording: false` (docs/design/live-pause-context.md); else the error `context needs step or file/line while the Time Machine is not active` |
| `values` | `file, line` | `{values: [...]}` every value logged on that line, by hit |
| `var` | `name, file?, scope?, limit?` | the variable history above (`file` narrows to one file of the run, `scope` to a function) |
| `why` | `step, name?, depth?` | the provenance tree above (`name` empty or absent: the statement at `step`; `depth` 1..8, default 5) |
| `eval` | `expression`, `frameId?` | `{text, valueBag?}` via `evaluate` (no statement of the program is re-run; pure calls run, a user function is refused, see the `evaluate` row); in the paused frame, locals over globals, while a debug run is paused. `frameId` names a frame of the pause, innermost 0; absent means 0 |
| `expand` | `valueId, queryPath` | `{node}` |
| `select` | `file, line, endLine?` | `{ok}`; moves the editor selection and reveals it |
| `watch` | | streams `{"event": "step", "step", "location", "values"}` on every navigation, `{"event": "stopped"}` when the Time Machine stops, `{"event": "rerun", "runId"}` on a re-run, and for a debug run `{"event": "paused", "step", "location", "reason", "kind"?, "breakpoint"?, "conditionError"?, "watch"?, "values"}` at every stop, `{"event": "resumed"}` and `{"event": "finished", "exitCode"}`, until `unwatch` or disconnect |
| `unwatch` | | `{ok}` |
| `walkthrough` | `file?, scope?, from?, to?, all?` | the walkthrough shape below, glosses from the session's last Narrate included |
| `graph` | `all?, scope?, expand?: string[] | string, statements?: boolean` | the execution graph shape below (`expand`: package names to unroll; `statements: false` leaves the statement nodes out) |
| `exceptions` | | the exceptions report shape below |
| `http` | | the HTTP table ("HTTP record and replay"); answers while a run is in flight with the rows so far (`running: true`) |
| `recording` | | the session's run as a saved run, `{meta, events}` ("Saved run"): `file.instrumented`, `coverage`, `log` (the host's own `live-` and `shadow-` evaluations left out), one `locals`, `error`, `http.exchange`, the final `trace` (`steps` base64 as the runtime sent them, `scopes`, `truncated`, `midRun?`) and `run.finished`; `meta` is `{runId, file, workspaceRoot, exitCode, durationMs, stepCount, files: [{fileId, path, source?}], live: true}`, `source` being the lines the host has for the file. Text values, URLs and sources go through `redact`. Waits for an idle session like `walkthrough`; a `kind: "debug"` socket refuses it. `pyokka tour --live` reads it (`docs/TOUR.md`) |
| `debug` | `stopOnEntry?`, `launch?` | starts a debug session of the program inside a VS Code debug session, so the standard debug views open with the panel. `launch` is optional and every field inside it is optional (`{program, module, args, cwd, env, python, stopOnEntry, breakOnException, libraryCode, record, recordFrom}`, as `parseLaunch` reads them; `recordFrom` is `FILE:LINE` or a function name and implies `record`): `program` defaults to this session's file, and `libraryCode` and `record` default to false. `libraryCode: true` is `pyokka debug FILE --library-code`: the run instruments third-party packages, so a breakpoint in a library function hits and `step --into` enters it. Without `record` the host creates a `record: false` Debugger session of its own (nothing is recorded, this run-all session is untouched) and the reply is that session's first stop; with `record: true` it starts today's recording run on this run-all session and the reply is its first stop. The run stops at the first breakpoint; with none that can hit, or with `stopOnEntry: true`, it pauses before the first statement instead. When this session is already paused the reply is its current frontier and nothing is started |
| `stop` | | ends the debug run and leaves debug mode: `{stopped: true, runId, finished: {exitCode, stepCount, durationMs}}`. The session, its recording and the Time Machine stay, and so does the run to read; the VS Code debug session showing it ends. With no debug run in flight the reply is `{stopped: false, hint}`, not an error |
| `restart` | `stopOnEntry?` | stops the debug run and starts a fresh one of the same file inside the same VS Code debug session; the reply is the first stop of the new run, by the `debug` rule, or `{finished}` when it ended without pausing. With no debug run in flight it does what `debug` does |
| `continue` | `noWait?`, `until?`, `to?: {file, line}` | resumes; replies at the next stop, or `{finished}` when the run ended. `noWait: true` answers `{"ok": true, "resumed": true}` at once instead: a server may not stop again for minutes. `until: EXPR` runs to the first statement where the expression is true, through a break-when watch with the id `until` that the host installs before the resume and removes after the stop (and when the run ends instead); the stop carries `paused.reason: "watch"` with `watch: {id: "until", exp, text}`. `to` runs to a line through the transient run-to-line breakpoint. `until` and `to` are mutually exclusive |
| `pause` | `noWait?` | asks the running program to pause at its next statement; replies at the pause. `noWait: true` answers `{"ok": true, "requested": true, "paused": false}` at once: a program blocked in `accept()` pauses only when the next request arrives |
| `break` | `set?: [{file, line, condition?}]`, `add?: [...]`, `remove?: [{file, line}]`, `at?: "NAME" \| "FILE:LINE"`, `list?: true`, `exceptions?: "off" \| "uncaught" \| "raised"` | `{breakpoints: [{file?, line?, function?, condition?, rid?, fileId?, resolvedLine?, error?}], exceptions}` after the change (`set` replaces them all); the bridge mirrors them into VS Code's breakpoint list, so the gutter shows them, and sends them to the run in progress. `at` with a bare (or dotted) name is a function breakpoint: it goes on the session's own list as `{function: NAME}` and into the Breakpoints view as a function breakpoint, and the **runtime** resolves the name, so a module imported later gets its breakpoint when it loads. An unresolved spec is echoed as `{path: "", line: 0, function: NAME}`, so an empty `rid` is not a failure; once resolved the echo carries `path, line, rid, fileId, resolvedLine` all filled, and `error: "also defined in lib/rank.py:12; give FILE:LINE to pick one"` when another file defines the name (the run still pauses at the first, and resolution can arrive late, in `debug.paused.breakpoint`). A dotted name (`Ranker.rank`) matches on its last segment; the class is not verified. `at` with `FILE:LINE` is an ordinary breakpoint. `exceptions` sets where an exception pauses the run (`uncaught` by default: only one nobody caught, at the top; `raised`: every raise in user code; `off`: never); a run in flight learns at once, and every reply reports the mode |
| `watches` | `set?`, `add?: [{id?, exp, breakWhen?: "change" | "true"}]`, `remove?: [id]`, `list?: true` | `{watches: [...]}`: an item with `breakWhen` is a break-when watch `{id, exp, breakWhen, error?}` (ids `w1`, `w2`, … when absent), sent to the run in progress; an item without it is a displayed watch expression `{id, exp, kind: "display", text?, error?}`, the panel's LOGS-pane watch evaluated at the current step (in the paused frame at the frontier; `text` is the value when the evaluation lands within 1.5 s). `remove` takes either kind's id; `set` replaces both kinds. |
| `locals` | `valueBag?`, `frameId?` | `{locals: [{name, text, type?, length?, valueBag?}], modified?}`: the variables of frame `frameId` of the pause (innermost 0, the default), each with the `type` of its value node and `length` for a sized value (both left out for a masked value); an error while the program runs |
| `record` | | records from the current pause on, in a run started with `launch.recordFrom` (`pyokka debug FILE --record-from X`) that has not started recording yet: the reply is the same pause as step 0, a stop reply with `already: false` and `paused.recordingStarted`. A session that records already answers `already: true` with its current stop. An error while the program runs and when no debug run is paused; a `kind: "debug"` socket refuses it (a `record: false` session has no run-all session to hold a trace). A pause of a `recordFrom` run before its recording started has no trace: its stop reply is built like a `record: false` one (`block`, frame `stack`, no `moves`) and carries `recording: false`; `state.debug` carries `recordFrom` and `recording` |
| `exec` | `source`, `frameId?` | `{text, modified, valueBag?, exception?: {type, message, traceback?}}`: runs `source` as a statement in frame `frameId` of the pause (innermost 0, the default). Anything `compile(source, "<pyokka-exec>", "exec")` accepts: an assignment, a call, an import, a `del`, a multi-line block, a bare expression. `text` is the last statement's value when that statement is an expression (with a `valueBag` to expand), else `""`. A statement that raised answers `exception` and the session stays paused: the request succeeded, the statement did not. A `source` that does not compile is an **error** reply (`SyntaxError: invalid syntax`), not an `executed` with an `exception`. `modified` is true on every `executed`, because a statement that raised halfway may already have written, and from then on every stop, the Debugger view and the status bar tooltip say the values are no longer the program's own; it is not on the `debug.paused` that served the exec (that event went out before it) but it is on any `locals` reply taken afterwards, the one at the same pause included. An error while the program runs (`the program is running; pause it first`), after it ended or with no run at all (`the run has ended; there is no frame to execute in`), and for a `frameId` the pause does not have (`LookupError: no frame N in this pause`). Hovers, displayed watches, break-when watches, `eval`, completions and `shadow` never reach it: they stay on `evaluate`, which is pure |

A save while an agent navigates re-runs and re-anchors (Time Machine rules);
`state.stale` and a `{"event": "rerun", "runId"}` line on watch streams say so.

### Debugging over the bridge

A debug run is an ordinary run whose frontier can pause (the runtime's `debug` request and
`debug.paused` event above; `docs/HANDOFF-debugger.md`). Over the bridge, every reply that
reports a stop is the context slice of the frontier step, exactly what `step` and `context`
return, plus `paused`, `locals` and `output`, so a stop answers "where, with what, after what
was printed" without a second call:

```jsonc
"paused": { "step": 412, "rid": 88, "fileId": 2, "file": "/abs/project/lib.py", "line": 12,
            "scopeId": 7, "depth": 1,
            "reason": "breakpoint",            // start | breakpoint | step | watch | pause | exception
            "kind": "over",                    // with reason step
            "breakpoint": { "file": "lib.py", "line": 12, "condition": "n > 3", "rid": 88, "fileId": 2, "resolvedLine": 12 },
            "conditionError": "NameError: …",  // a condition that failed to evaluate pauses and says why
            "watch": { "id": "w1", "exp": "payload is None", "text": "True" },   // with reason watch
            "exception": { "type": "ValueError", "message": "too big: 3", "uncaught": true },   // with reason exception
            "stack": [ { "scopeId": 7, "name": "build", "rid": 80, "depth": 1 }, { "scopeId": 0, "name": "<module>", "rid": 0, "depth": 0 } ] }
```

`file` is absolute; the CLI prints it workspace-relative like every other path. `locals` is the
paused frame's variables, the same list the `locals` request answers (`valueBag` per the request).
`output` is `{"text", "truncated"}`: the last 4000 characters of what the program printed, in
arrival order, redacted like every value. That is the `print` output the runtime reports as `log`
entries plus the raw writes it forwards as `output` events, one line per write; `truncated` is true
when the head was cut, and `text` is `""` when nothing has been printed. When the
program ends instead of stopping, the reply is `{"finished": {"exitCode", "stepCount",
"durationMs"}}` and `state.debug.active` turns false.

With `reason: "exception"` the run stopped where the exception was raised: `line` and `stack`
are the user statement that raised it (the statement that made the call, for a raise inside a
library), and `exception.uncaught` says whether it reached the top. In `uncaught` mode, the
default, that is the only exception pause, the innermost user frame is live for `eval` and
`locals`, and `continue` (or a step) ends the run with exit 1. In `raised` mode the run also
pauses at the first sighting of every exception in user code, before it unwinds, with
`uncaught: false`; one that nobody catches pauses again at the top with `uncaught: true`. Behind the frontier the recording is
navigated as on a finished run (`step` backward kinds, `context N`, `why`, `var`); at the
frontier `eval` and `locals` read the live frame. The CLI: `pyokka debug --live
[--stop-on-entry]`, `restart --live [--stop-on-entry]`, `stop --live`, `continue --live`,
`pause --live`, `break --live [FILE:LINE ...] [--when EXPR] [--remove
FILE:LINE] [--list] [--on-exception off|uncaught|raised]`, `watches --live [--add EXPR [--break-when change|true]] [--remove ID]
[--list]` (`--add EXPR` alone is a displayed watch expression, printed as `id  EXPR  = value`;
`--break-when` makes it pause the run), `locals --live`; a stop prints as `paused at file:line (reason)` over the usual
slice, with the frame under `locals:` and, under `output (last N lines):`, the last 20 lines of
`output.text` indented by two (200 with `--scope`, nothing when it is empty);
the end as `finished: exit N, K steps`, and `stop` as `stopped: exit N, K steps` or
`nothing to stop: <hint>`. Reasons print as `start`, `breakpoint [if
EXPR][, condition failed: …]`, `step into|over|out`, `watch EXP: TEXT`, `pause`, `uncaught
ValueError: too big: 3` / `raised ValueError: too big: 3`. `break --live` ends its listing with
`exceptions: uncaught`. `--stop-on-entry`
pauses before the first statement even with a breakpoint set, which is where break-when watches
and breakpoints are placed before anything runs. A saved run
refuses the debugging commands with the hint "debugging needs a live session (`--live`)".

### Replay debug session (the Time Machine in VS Code's debug views)

The Time Machine is a VS Code debug session of type `pyokka` while it navigates
(`src/debug/replaySession.ts`, `dapReplay.ts`). Opening it on a finished run (the panel, `Shift+F5`,
the Code Story, or the bridge's `step`) starts this launch, and closing it stops the
session; Stop in the debug toolbar closes the Time Machine:

```jsonc
{ "type": "pyokka", "request": "launch", "name": "Pyokka Time Machine: demo.py",
  "program": "/abs/demo.py", "replay": "<session key>", "internalConsoleOptions": "neverOpen" }
```

It is started with `suppressSaveBeforeStart`, since a save under On Save would re-run the file. A
session already shown in a debug session (a `record: true` debug run, or a debug run in flight)
gets no replay launch: that debug session replays behind its frontier itself.

`initialize` answers `supportsStepBack: true` for a replay launch and for `record: true`, and
`false` for `record: false`, which has nothing recorded. Requests while the Time Machine
navigates:

| request | Time Machine move |
|---|---|
| `next`, `stepIn`, `stepOut` | `over`, `into`, `out`; at the frontier of a paused debug run the program takes the step |
| `stepBack` | `backOver` |
| `continue` | the next step on an enabled breakpoint, else the frontier (paused run) or the last step; at the frontier the run continues |
| `reverseContinue` | the previous step on an enabled breakpoint, else step 0, the first recorded step (a recording may start mid-program) |
| `pause` | none (replay only) |
| `restart` | step 0 (replay only); a `record: true` session restarts its run as before |

Each move, whoever made it (these requests, the panel, the Code Story, the bridge), emits the
session's `navChanged`; the adapter answers with one `stopped` event, `reason: "step"`, description
`Time Machine at step N, file.py:L`, a macrotask later (after the response, one per burst). A move
that hits a dead end still answers with a `stopped` at the same step. Arriving back at the live
pause of a debug run re-posts that pause's own `stopped`.

While the step shown is a recorded one (not the live pause):

- `stackTrace` is `TraceModel.callStack(step)`: innermost first, frame id `i + 1`, each caller at
  the step that called it, `column` 1-based.
- `scopes` has one scope, `Locals at step N`. Its `variables` are the frame's values as of the
  step (`ReplayIndex` in `src/session/replayFrames.ts`): recorded locals (`recordLocals`, an entry
  at step S is the state at the start of S) and log entries of kind `value`, `autoLog` or
  `autoExpand` whose `context` is a bare name, both taken at steps up to and including N within
  that one scope instance; the later step wins, a recorded local on a tie. A logged value keeps its
  value tree, so it expands.
- `evaluate` (every context, the Debug Console included) answers a recorded name and its members
  (`.attr`, `[0]`, `['key']`) from that list, and fails with `X is not in the recording at step N`
  otherwise. Nothing runs. `setVariable` fails. `completions` offers the innermost frame's recorded
  names.
- `stackTrace` honours `startFrame` and `levels` (VS Code may ask for the top frame alone first).
- The `stopped` event carries no `preserveFocusHint`: with it VS Code focuses no frame and the
  Variables view stays empty, so the editor takes the focus at each move as at any debugger stop.
- A frame focused in the Call Stack (`vscode.debug.onDidChangeActiveStackItem`, frame id > 1)
  moves the Time Machine to that frame's step.

The Variables view's context menu has `pyokka.whyVariable` (Why This Value) while the Time
Machine navigates: the why tree for the row's `evaluateName` at the current step.

### The Debugger's socket (`kind: "debug"`)

A Debugger session (`config.record: false`) is not a run-all session: it has no document, no
recording and no Time Machine, and when the program exits it is gone. It publishes its own socket
and its own descriptor, behind the same `pyokka.agentAccess` setting and in the same directory:

```jsonc
{ "socket": "/Users/x/.pyokka/sessions/4711-d1.sock", "token": "…", "pid": 4711,
  "kind": "debug",
  "workspace": "/abs/project", "file": "/abs/project/app.py", "displayName": "app.py",
  "launch": { "program": "/abs/project/app.py", "module": null, "args": ["--port", "8000"],
              "cwd": "/abs/project", "python": "/abs/project/.venv/bin/python", "record": false },
  "runtimeVersion": "0.1.0", "started": "2026-09-15T09:12:03.114Z" }
```

For a module launch `displayName` is `-m app.server`, `launch.program` is `null`, and `file` is the
launch's `cwd` until the run reports its first instrumented file, at which point the host rewrites
the descriptor once with the real `file`. With the setting off the session runs normally and
publishes nothing: F5, the toolbar, the panel and the Debug Console all work and no agent can reach
it. Turning the setting on while it runs opens the socket then; turning it off closes it and removes
the descriptor while the session keeps running.

It serves `state`, `context`, `step` (`into` / `over` / `out` only), `continue`, `pause`, `stop`,
`restart`, `debug`, `break`, `watches`, `locals`, `eval`, `exec`, `expand`, `select`, `watch` and
`unwatch`, with the same fields as above. `noWait`, `until` and `to` on `continue`, `count` on
`step`, `at` on `break`, and `frameId` on `locals`, `eval` and `exec` work here too. What it
refuses:

| requests | error | hint |
|---|---|---|
| `var`, `why`, `walkthrough`, `graph`, `exceptions`, `http`, `values`, `story`, `find`, `steps`, `recording` | `<verb> needs a recording` | start the debug session with recording (`pyokka debug FILE --record`), or read a run-all session of the file |
| `step` with `back`, `backOver`, `backOut` or `to` | `this debug session records nothing, so there is nothing behind the pause to replay` | into, over and out execute; `--record` gives you the backward moves |

`break` here goes into VS Code's own breakpoint list, so the gutter shows it and the host pushes it
to the program in flight, exactly as the run socket's `break` does. `watches --add EXPR` without
`--break-when` is a displayed watch the Debugger view shows at every stop, evaluated in the paused
frame; with `--break-when` it is a watch the runtime holds and pauses on.

`debug` on this socket answers the current pause when it is paused. A session that has not paused
yet is a start in flight, so it waits for the first stop: that is what a cold `pyokka debug FILE`
reads after the URI route. A session that has already paused and run on is refused while the
program runs (`the debug session of app.py is running`, with the hint that `pause --live` stops it
at its next statement and `restart --live` starts it again from the top): an agent that says "start
the debugger" twice must not lose the pause it is reading, and killing a running server is worse.

**The stop.** A stop reply is the same shape as a run-all stop with the recording fields left out:

```jsonc
{ "step": 1403,                       // the statement counter, not a navigable index
  "location": { "file": "/abs/project/app.py", "line": 42, "col": 4, "function": "do_GET", "fileId": 2 },
  "stale": false,                     // the program's file has unsaved changes, or changed on disk since the start
  "stack": [ { "file": "/abs/project/app.py", "line": 42, "function": "do_GET", "frameId": 0 },
             { "file": "/abs/project/app.py", "line": 31, "function": "<module>", "frameId": 2 } ],
  "block": { "file": "/abs/project/app.py", "function": "do_GET",
             "lines": [ { "line": 41, "text": "        payload = parse(self.path)" },
                        { "line": 42, "text": "        total = 0", "current": true } ] },
  "values": [],
  "errors": [],
  "paused": { "…": "as above, plus thread and modified" },
  "locals": [ { "name": "payload", "text": "{'q': 'a'}", "type": "dict", "length": 1 } ],
  "output": { "text": "listening on 8000\n", "truncated": false },
  "recording": false,                 // nothing behind this pause was kept
  "modified": false,
  "thread": { "name": "Thread-3", "ident": 6108209152 } }
```

`count`, `moves` and `coverage` are absent: there is no trace to count, to move through or to
colour. `recording: false` says so in one field, the same field a `recordFrom` run's pause before
its recording carries. `values` is always empty; `locals` carries the frame's variables with `type`
and `length`. A run socket of the same file answers `context` with this reply too when it has no
step of its own (see the `context` row). `block` is the enclosing function's source, its `def` line to its
last line, read from the open document or from disk, capped at 60 lines and centred on the paused
line when capped (`scope: true` lifts the cap); no line carries a step. `stack` is the frame chain
with each frame's real line, and frames outside instrumented files are left out of it (they are in
`paused.stack` with `fileId: 0`). `errors` is empty until the uncaught exception that ends the run
arrives, and then holds that one entry. The end of the program is
`{"finished": {"exitCode", "durationMs", "stepCount"}}`, where `stepCount` is the statement
counter, and the socket closes right after.

**`state`** on this socket:

```jsonc
{ "ok": true, "kind": "debug",
  "running": true, "paused": true, "record": false, "modified": false,
  "displayName": "app.py", "file": "/abs/project/app.py",
  "launch": { "program": "/abs/project/app.py", "module": null, "args": ["--port", "8000"],
              "cwd": "/abs/project", "env": { "PORT": "8000" },
              "python": "/abs/project/.venv/bin/python",
              "stopOnEntry": false, "breakOnException": "uncaught", "libraryCode": false, "record": false },
  "debug": { "active": true, "paused": { "…": "pausedReply" }, "frontier": null,
             "exceptions": "uncaught", "modified": false },
  "thread": { "name": "Thread-3", "ident": 6108209152 },
  "output": { "text": "listening on 8000\n", "truncated": false },
  "others": [ { "kind": "run", "displayName": "app.py", "descriptor": "/Users/x/.pyokka/sessions/4711-1.json",
                "running": false, "steps": 1240 } ] }
```

`frontier` is `null` (nothing to navigate), `nav` is absent, and there is no `finished`: a finished
debug session no longer exists. `others` lists the other sessions on the same file so the CLI can
print both without a second directory scan.

**The watch stream** on this socket: `paused` (as above, with `thread` and `modified`), `resumed`,
`output` and then `finished`, after which the socket closes.

```jsonc
{ "event": "output", "stream": "stdout", "text": "GET /health 200\n" }
{ "event": "finished", "exitCode": 0 }
```

`output` is throttled to at most one event every 100 ms with the text accumulated in between: a
debug session has no other way to follow a server's log as it runs. There are no `step` events (no
Time Machine) and no `exited` event (`finished` says it).

**Which socket a verb uses.** A file may have both, so the CLI prefers by verb and the host never
picks: `debug`, `continue`, `pause`, `stop`, `restart`, `break`, `watches`, `locals` and
`step --into/--over/--out` prefer `kind: "debug"`; `why`, `var`, `story`, `walkthrough`, `graph`,
`exceptions`, `http`, `values`, `find` and `steps` prefer `kind: "run"`; `state`, `context`, `eval`,
`expand`, `select`, `watch` and `shell` take the debug socket when one exists (it is the live
thing) and a run socket otherwise. With none of the preferred kind the other kind is used; with
several, the CLI prints "N live sessions; say which" and their descriptor paths.
`--session <descriptor path>` selects exactly that socket, whatever the verb.

**How the CLI reaches a window.** `pyokka debug FILE` tries three routes and stops at the first
that applies: a `kind: "debug"` descriptor whose launch matches (connect and read the pause); else a
`kind: "run"` descriptor for the file (send `debug` with the launch over that socket, so no URI is
needed and the focused-window problem does not arise); else the URI
`vscode://ivor.pyokka/debug?program=…&args=…&cwd=…&env=…&python=…&stopOnEntry=1&at=app.py:42`,
handed to `<code> --open-url` (`$PYOKKA_CODE` if set, else `code` on PATH), after which the CLI
polls `~/.pyokka/sessions` every 100 ms for up to 20 s for the descriptor the window writes. Every
value is percent-encoded; `args` is a JSON array of strings and `env` a JSON object of strings.
**The URI handler obeys `pyokka.agentAccess`**: with the setting off the window starts nothing and
shows a warning with an Open Settings action, because a paused program nobody can continue is worse
than a refusal. That is why the timeout message names the setting first.

`pyokka shell --live [--session NAME] [--json]` runs many of them in one process: it reads one
command line per stdin line (the same words without `--live`), holds a single bridge connection
so the token handshake happens once, and prints every result the way the one-shot command would,
with a blank line after it, or as one JSON line per result with `--json` (an error is `error:`
plus the hint on stderr, or the `{"error", "hint"}` document on stdout in JSON mode). `exit`,
`quit` or EOF end it; `watch` is refused there because it streams until Ctrl-C. A one-shot
command spends about 70 ms starting Python for an answer the session gives in 1 to 4 ms, which
is what the shell saves per command.

### Walkthrough (what happened, in order)

`pyokka walkthrough run.json [--file F] [--scope NAME] [--from N --to M] [--all] [--json]`,
`--live` through the bridge request above, the WALKTHROUGH section of the panel and the top
of the Code Story all show the same list: one moment per line in execution order, derived
from the recording by `python/pyokka_runtime/agent/walkthrough.py` (saved runs) and
`src/session/walkthrough.ts` (live sessions); `test/unit/fixtures/walkthrough-*.json` pins
both to identical output. Deterministic and instant; a model only ever fills `gloss`.

```jsonc
{ "count": 4108,                          // steps in the run
  "total": 37, "shown": 37,               // moments before and after the window / cap
  "capped": false, "truncated": false,    // the 400-moment cap collapsed or cut the list
  "file": "/abs/run.py", "exitCode": 1, "stale": false, "staleFiles": [],
  "moments": [
    { "id": "m12", "step": 63,            // the step to land on: the call site of a call, the entry of a tool callback
      "kind": "call",                     // start | end | call | tool | decision | value | print | error
      "location": { "file": "/abs/run.py", "line": 47, "function": "run_session", "fileId": 1 },
      "text": "call 1 of 4 to Runner.run (openai-agents) from run_session, 23 nested calls",
      "values": [ { "role": "in", "name": "input", "text": "'Book me a flight to Paris next month.'" },
                  { "role": "out", "name": "return", "text": "RunResult(final_output=…)" } ],
      "scopeId": 7, "entryStep": 64, "endStep": 700,                  // calls and tool callbacks only; endStep is the last step of the call or anything under it
      "callee": { "file": "/abs/agents/run.py", "line": 120, "function": "Runner.run", "fileId": 9 },
      "durationMs": null,                 // reserved: no step timestamps yet
      "gloss": null } ] }                 // one sentence from `narrate`, else null
```

What becomes a moment, in step order:

- `start` (step 0, "module X starts") and `end` (the last step: exit code and duration, or
  "killed by the timeout" / "stopped").
- `call`: every scope entry. Library scopes (files under `site-packages`, opt-in with
  `--library-code`) are merged into one moment per user-code call site and package
  ("call to OpenAI.__init__ (openai) from <module>, 3 nested calls") unless `--all`. Repeated
  calls of the same function from the same site are numbered ("call 2 of 4"). Values: the
  parameters (recorded locals at entry, so `pyokka run --save` has them by default and a
  live session needs `pyokka.timeMachine.recordLocals`; `def` logpoints; `self`/`cls`
  skipped, ≤ 20) as `in`; the last value logged on a `return` line of the callee, else the value the call
  statement produced, else the local a bare `return name` returned, as `out return` / `out
  <name>`; an uncaught exception raised inside as `out raised`.
- `tool`: a user function entered from library code (the SDK calling back into the
  program): "openai-agents calls back into lookup_weather (Runner.run)"; its step is the
  entry step. When the library is not recorded, a user function is a callback when the
  statement that was running in its caller has a call but does not name it (dunders, lambdas,
  comprehensions and generators excepted): "callback into classify from ask". Its recorded
  parent can be too shallow (the runtime looks a few frames up for a caller, and the library's
  frames use them up, so a LangGraph node's parent is the module); the caller is then the
  latest-entered scope under that parent that records a step after the callback entered.
  `callerScopeId` names the caller on every `tool` moment.
- `decision`: each `if` / `elif` header a step hit ("if x > 2 took True": the next step of
  the scope landed in the body) and each `match` ("match total took case _"); a value logged
  on the header (a `# ?`, Auto Log does not log tests) is the `took` value. Loops are one
  moment per execution of the loop statement: "for i in items ran 3 times" (header hits
  minus the entry step). Statement kinds come from the source (`ast` in Python, indentation
  and the statement ranges in the host).
- `value`: `value` / `autoLog` / `logpoint` entries on user files not already used as a call's
  `in` / `out` or a decision's `took` ("total = 6"; the full text under `values` with role
  `value`). `print`: `log` entries ("prints hello", "prints to stderr …", ≤ 120 chars).
- `error`: every `error` event once ("raised ValueError: too small: 6, handled at
  main.py:49" names where execution resumed; "… uncaught"); the location is the innermost
  user-code frame.
- `http` and `return` are reserved (HTTP capture, per-return moments) and not produced.

Bound: 400 moments. Beyond it, repeated calls from the same site collapse into their first
moment with `more: N` (the moments inside the dropped calls go too), then repeated values
of the same statement; what is still over the cap is cut with `truncated: true`. `--from
N --to M`, `--scope NAME` (moments inside calls of that function, and its call moments)
and `--file F` select a window without the cap. Ids are assigned before windowing, so a
window shows the same ids as the full list.

Text form: `#step  text`, values indented (`in name = text`, `out …`, `took …`), the gloss
indented under the sentence, `≡ 12 more calls like this` for collapsed groups, ≤ 100 chars
per line.

### Execution graph (the diagram of a run)

`pyokka graph run.json [--all] [--scope NAME] [--expand PKG ...] [--no-statements] [--json | --dot]`, `--live`
through the bridge request `graph`, the host's `buildExecutionGraph`
(`src/session/executionGraph.ts`) and the panel's Execution Diagram view all show the same
picture: where the run started, which functions were called from where and how often, which
decisions were taken, what went into each call and what came out, where it raised. It is a
projection of the walkthrough: `python/pyokka_runtime/agent/graph.py` and
`src/session/executionGraph.ts` build it from the (uncapped) moments of the walkthrough with
the same `all` / `scope` options; `test/unit/fixtures/execution-graph.json` pins both to
identical output. Deterministic and instant, no model.

```jsonc
{ "count": 4108,                                // steps in the run
  "nodes": [
    { "id": "n0", "kind": "module",             // module | function | package | decision | statement
      "label": "<module>", "file": "/abs/run.py", "line": 1, "fileId": 1, "function": "<module>",
      "calls": 1, "firstStep": 0, "spans": [[0, 4107]],   // one [entry, end] per call, ≤ 50 (`calls` has the true count)
      "rows": [ { "kind": "raised", "name": "OpenAIError", "text": "Missing credentials…", "step": 2142 } ] },
    { "id": "n3", "kind": "function", "label": "Account.withdraw", "file": "/abs/example.py", "line": 12, "fileId": 1, "function": "Account.withdraw",
      "calls": 1, "firstStep": 40, "spans": [[41, 47]],
      "rows": [ { "kind": "in", "name": "amount", "text": "30", "step": 41 },        // in | out | raised | took
                { "kind": "out", "name": "return", "text": "55.5", "step": 47 } ] },  // ≤ 12 rows: the first call's values
    { "id": "n7", "kind": "package", "label": "openai", "package": "openai",
      "calls": 3, "firstStep": 2111, "spans": [[2112, 2142]], "rows": [], "nested": 320 },
    { "id": "n4", "kind": "decision", "parent": "n3", "label": "if amount > self.balance", "file": "/abs/example.py", "line": 14, "fileId": 1,
      "text": "if amount > self.balance took False", "taken": "False", "firstStep": 42, "hits": 1, "notRun": [15], "rows": [] },
    { "id": "n5", "kind": "statement", "parent": "n0", "label": "response = client.responses.parse(model=\"gpt-5.6-luna\", input=[{\"role\": …", "file": "/abs/run.py", "line": 20, "fileId": 1,
      "text": "response = client.responses.parse(model=\"gpt-5.6-luna\", input=[ … ], text_format=CalendarEvent)",
      "targets": ["response"], "reads": ["client", "CalendarEvent"], "firstStep": 2143, "hits": 1,
      "rows": [ { "kind": "out", "name": "response", "text": "ParsedResponse(…)", "step": 2143 } ] } ],   // out | print | raised rows land on the statement
  "edges": [
    { "id": "e0", "from": "n0", "to": "n3", "kind": "call",        // call | tool | data
      "count": 1, "firstStep": 40, "steps": [40], "momentIds": ["m12"] },
    { "id": "e5", "from": "n3", "to": "n9", "kind": "data", "label": "amount", "firstStep": 41 },
    { "id": "e6", "from": "n2", "to": "n5", "kind": "data", "label": "client", "firstStep": 2143 } ],   // `client = OpenAI(…)` feeds the statement that reads `client`
  "moments": [ { "id": "m12", "kind": "call", "step": 40, "nodeId": "n3", "edgeId": "e0" } ],   // walkthrough moment -> node (and edge)
  "scopes": { "0": "n0", "7": "n3" },            // trace scopeId -> node id (the call stack of a step maps through it)
  "capped": false, "truncated": false }
```

Nodes, from the moments (`call`, `tool`, `decision`, `value`, `print`, `error`, `start`,
`end`) in step order:

- `module`: the `<module>` scope of the main file (`label` `<module>`, `spans` `[[0,
  count-1]]`) and every imported project module (its "module x.py runs" call moment; `label`
  is the display path). `function`: one per distinct user-code callee, keyed by
  `callee.fileId` + `callee.function` (recursion is one node with a self edge); `label` is
  the qualified name. `calls` counts its call and tool moments; `firstStep` is the first
  moment's step (the call site, or the entry step of a tool callback); `spans` their
  `[entryStep, endStep]`, in order, ≤ 50.
- `package`: one per library package, from the merged library call moments (`package` from
  the callee's `site-packages` path): `calls` and `spans` of the calls that enter it from
  outside, `nested` the number of scopes entered inside those spans (from the trace), no
  `file`/`line`/`fileId`/`function`. `--all` gives one `function` node per library function
  instead, with `package` set and no package nodes. `expand: [PKG…]` (the panel's unrolling;
  the bridge and the CLI take package names) unrolls only those packages: the moments are
  built with `all` and the functions of every other package fold back into its package node
  (calls between two functions of one folded package are not edges; calls between two
  packages are).
- `decision`: one per decision statement (`fileId` + `line`) that a decision moment hit:
  `if`/`elif`, `match`, and loops (`label` "for i in items"). `parent` is the node of the
  function the statement lives in (`location.function` → the function node; `<module>` →
  the file's module node). `text` and `taken` ("True" / "False" / "case _"; absent for
  loops) are the first moment's; `hits` counts the moments (loops: the iterations, summed);
  `notRun` is the first line of the arm that never ran over all hits: the body's first line
  when an `if` only took False, the `else` arm's first line (the `elif` header for a chain)
  when it only took True, the untaken arms of a `match`; `[]` for loops and for a decision
  that took both arms. The file maps (`decisions.py` / `decisions.ts`) carry the else arm as
  `orelse: [first, last]` (`[0, 0]` without one) for this.
- `statement`: for user-code scopes only (the modules and the user functions; never library
  functions, unrolled or not), one per simple statement a step ran, keyed by `fileId` +
  start line, with `parent` the node of the scope the statement lives in. Not statements:
  the headers of compound statements (a code line ending in `:`: `if`/`for`/`while`/`match`
  are decision nodes, `try`/`except`/`else`/`with`/`def`/`class` are nothing), `import` /
  `from … import`, `pass`/`break`/`continue`/`global`/`nonlocal`, and a bare string
  (a docstring). `label` is the statement's source (the range, lines joined by a space,
  whitespace collapsed, cut at 60), `text` the same cut at 200, `hits` the number of steps
  on the statement over the whole run, `firstStep` the first. `targets` are the names the
  statement assigns (`a, b = …`, `x += …`, an annotated `x: int = …`; `obj.attr = …` and
  `d[k] = …` assign no name), `reads` the names it uses: the identifiers of its source
  outside string literals (the `{…}` parts of an f-string count), not attribute names after
  a `.`, not keywords, not keyword-argument names inside a call, minus `targets` unless the
  assignment is augmented. Statements are bounded at 60 per parent in `firstStep` order
  (`truncated`); `statements: false` (`--no-statements`) leaves them out and the graph is
  what it was before them.
- `rows` (≤ 12): the values of the node's first call moment — `in` at `entryStep`, `out` at
  `endStep`, an `out raised` value as `{kind: "raised", name: <type>, text: <message>}` — and
  every `error` moment located in the function as a `raised` row at the error's step; a
  decision's `took` value as a `took` row. With statement nodes, the `value` moment of a
  statement is its `out` row (the moment's name and text), a `print` moment its `print` row
  (`name` `stdout` or `stderr`), and an `error` moment whose location has a statement node
  puts its `raised` row there instead of on the function. Duplicates (same kind, name and text) are kept
  once, in step order; over 12, `in` rows go first (from the end), so a long parameter list
  never hides the result or the exception.
- Ids are `n<index>` in `firstStep` order (a module or function before the decisions and
  statements under it, then by label), stable for a run and a set of options.

Edges:

- `call`: one per (caller node, callee node) over the call moments; the caller node is the
  statement node of the call site when there is one, else the node of `location` (the call
  site's function). `count`, the call-site `steps` (≤ 50),
  `momentIds`, `firstStep`. `tool`: from the package (or, unrolled, the library function)
  node of the caller to the user function, over the tool moments, same fields.
- `data`: a value produced in one node and passed into a call of another. For every call
  moment with an `in` value (`name` p, `text` t), the producers are the `out` values of
  earlier calls (at their `endStep`, produced by the callee node) and the `value` moments
  (produced by the node of their location) recorded inside the caller's scope span before
  the call; the most recent one whose `name` is p or whose `text` is t and whose node is not
  the caller's own node gives an edge from that node to the callee, `label` p, `firstStep`
  the call's `entryStep`. One per (from, to, label); ≤ 100 in all.
- `data`, from statements: for every statement or decision node C and every name in its
  reads (a decision's reads are the identifiers of its condition, a loop's the iterable's;
  a loop assigns its target), the producer is the latest statement or loop node under the
  same parent with a smaller `firstStep` whose targets hold the name, else the parent
  function node when the name is one of its `in` rows; an edge producer → C labelled with
  the name, `firstStep` C's. All data edges together are deduplicated on (from, to, label),
  sorted like the other edges and cut at 100 (`truncated`).
- Ids are `e<index>` in `firstStep` order (call and tool edges before data edges on a tie).

`moments` maps each moment that has a node: `start`/`end` → the main module; `call`/`tool`
→ the callee node and its edge; `decision` → its decision node; `value`/`print`/`error` →
the statement node at the moment's location when there is one, else the node of its
function. The ids are those of the walkthrough with the same
`all` option (`expand` implies `--all` ids); `kind` + `step` identify the moment across the
two lists. `scopes` maps every trace scope to the node it belongs to (library scopes to
their package node when folded).

Bound: `cap` (200) module, function and package nodes; decisions and statements do not
count. Beyond it,
keep the modules, the packages, every decision's parent, then the most called functions
(ties: earliest first) until the cap; the rest is dropped with `capped: true` and one
placeholder node per file, `{"kind": "package", "label": "N more functions", "file",
"fileId", "calls": <sum>, "firstStep": <min>, "spans": [], "rows": [], "more": N}`. Edges
to dropped nodes and their `moments` entries go too. `truncated: true` says a `spans`,
`steps`, `rows` or data-edge cap cut something. `--scope NAME` applies the walkthrough's
scope window before building.

Text form (`pyokka graph run.json`): a header line (`12 nodes, 9 edges over 33 steps`),
then one line per node in `firstStep` order (`n3 Account.withdraw example.py:12  ×1  in
amount = 30 · out 55.5`; `out` omits the name `return`; `raised Type: message`; a package
`n7 openai  ×3  320 nested`), decisions and statements indented under their parent in
`firstStep` order (`   n4 if amount > self.balance took False  ×1  not run: 15`, `   n5
response = client.responses.parse(…)  ×1  out response = ParsedResponse(…)`), then the edges (`n0 → n3  ×1  #40`; a tool edge
`n7 → n2  tool ×1  #12`; a data edge `n3 ⇢ n9  amount`), ≤ 100 chars per line. `--dot`:
Graphviz, nodes as records with their rows, decisions as diamonds, data edges dashed,
edges labelled `×N`.

### Exceptions report (`pyokka exceptions`, the EXCEPTIONS section)

`pyokka exceptions run.json [--json]`, `--live` through the bridge request `exceptions`, the
host's `buildExceptionReport` (`src/session/exceptionReport.ts`) and the EXCEPTIONS section of
the panel's Output view all show the same list: every exception the run raised, where it was
raised, where it was caught, how often, with the broad handlers flagged. Built from the
`error` events, the file table and the trace by `python/pyokka_runtime/agent/exceptions.py`
(saved runs) and `src/session/exceptionReport.ts` (live sessions);
`test/unit/fixtures/exceptions.json` pins both to identical output over the fixture run
`test/unit/fixtures/exceptions-run.json` (program: `test/unit/fixtures/exceptions/`).
Deterministic and instant.

```jsonc
{ "count": 412,                                 // steps in the run
  "file": "/abs/main.py", "exitCode": 1, "stale": false, "staleFiles": [],
  "total": 8,                                   // rows
  "raises": 11,                                 // exception objects the rows stand for (sum of count)
  "uncaught": 1, "caught": 7, "broad": 2,       // rows per kind; rows whose handler is broad
  "rows": [
    { "id": "x0", "kind": "uncaught",           // uncaught | caught
      "errorType": "ZeroDivisionError", "message": "division by zero",   // the first raise's message, ≤ 200 chars
      "count": 1, "step": 410, "lastStep": 410, // raises this row stands for; the first and the last raising step
      "raisedAt": { "file": "/abs/main.py", "line": 92, "function": "<module>", "fileId": 1, "rid": 60 },
      "handledAt": null },                      // uncaught, or caught outside instrumented code
    { "id": "x1", "kind": "caught", "errorType": "KeyError", "message": "'b'", "count": 3, "step": 31, "lastStep": 47,
      "raisedAt": { "file": "/abs/main.py", "line": 21, "function": "lookup", "fileId": 1, "rid": 12 },
      "handledAt": { "file": "/abs/main.py", "line": 68, "function": "<module>", "fileId": 1, "rid": 40, "broad": true } } ] }
```

Rules, identical on both sides:

- One row per (`kind`, `errorType`, `raisedAt.rid`, `handledAt.rid` or none) over the run's
  `error` events (the runtime already aggregates; the builder folds again, for older runs).
  `count` sums the events' `count` (1 when absent); `step` is the smallest `step`, `lastStep`
  the largest `lastStep` (the event's `step` when absent); `message` (cut at 200 chars) and
  `raisedAt.function` come from the event with the smallest `step`.
- `kind` is `uncaught` for `handled: false`, else `caught`.
- `raisedAt`: `fileId` and `rid` of the event; `line` is the first line of `rid`'s range (the
  statement that raised, or the calling statement when the raise happened in code that was
  not stepped; 0 when the rid is unknown); `function` is the `function` of the innermost
  stack frame whose `rid` is the event's `rid`, else the innermost frame's, else `<module>`;
  `file` is the file's path (`null` when the file is unknown).
- `handledAt`: the event's `handledAt` with the file's path added; `null` when absent.
- Order: `uncaught` rows first, then `caught`, each by `step` (ties by `errorType`); ids
  `x0…` in that order. `total`, `raises`, `uncaught`, `caught` and `broad` count the rows.
- Paths are absolute in the JSON; the CLI's text and the panel show display paths.

Text form (`render_exceptions` and `renderExceptionLines`, identical): a summary line, `8
exceptions over 412 steps: 1 uncaught, 7 caught (10 raises), 2 by a broad handler`, where
`(N raises)` appears only when the caught rows stand for more raises than rows, `, N by a
broad handler` only when N > 0, `1 exception` in the singular, and `no exceptions over 412
steps` when there are no rows; then per row `#step  kind [×count] errorType: message` and
under it `raised file:line function`, followed for caught rows by `· caught file:line
function [broad handler]` or `· caught outside stepped code`, and by `· last #lastStep` when
the last raise is a different step; ≤ 100 chars per line, every message redacted. The panel
section lists the same rows, uncaught first, a click moves the Time Machine to the row's
`step`, the locations open the file, and "broad handler" is a badge on the row.

### Narration (`pyokka narrate`, the panel's Narrate button)

Never automatic. `pyokka narrate run.json [--command "…"] [--dry-run]` builds the
walkthrough, fills `python/pyokka_runtime/agent/narrate_prompt.md` with it (values and
source redacted) and the source of the user functions the moments touch (≤ 200 lines each,
≤ 20 functions), sends the prompt on stdin to one command, and expects a JSON object
`{"<moment id>": "<one sentence>"}` back (fences and prose around it are tolerated; unknown
ids are dropped, sentences are cut at 140 chars; anything else fails once and keeps every
`gloss: null`). The glosses are written to `meta.walkthroughGloss` of the saved run, so
`walkthrough` shows them from then on. The backend is `--command` / the setting
`pyokka.explain.command` when set, else `claude -p --output-format json --tools ""
--no-session-persistence` when `claude` is on the PATH (its `result` field is the answer),
else `codex exec --skip-git-repo-check --ephemeral --sandbox read-only -o FILE -` (the last
message is read from FILE), and inside VS Code `vscode.lm.selectChatModels({vendor:
"copilot"})` when neither CLI exists. No API keys anywhere. In the host the glosses are
cached per `runId` and reach the panel, the Code Story and `walkthrough` replies of the
bridge.

### Redaction

Applied to every `text`, value node `value`, output chunk and error message
before it is written to a saved run, printed by the CLI, or sent by the
bridge (the panel and hovers are not redacted: they are the user's own
screen). Rules, identical in `pyokka_runtime/redact.py` and
`src/util/redact.ts`, checked by `test/unit/fixtures/redact.json`: whole
tokens `sk-…` (16+), `AKIA…` (16 upper/digits), `ghp_…` (30+), `xox[abp]-…`,
JWTs, `Bearer <token>`; and the value of any key whose name contains
`api_key`/`apikey`/`secret`/`token`/`password`/`passwd`/`authorization`
(case-insensitive) in `key=value`, `key: value`, `'key': 'value'` and
`key='value'` forms. Replacement is `«redacted»`. `None`, numbers and short
words are never redacted.

Two layers, then. Provenance masking (under "Secrets" above) runs first, in
the child, for every consumer including the panel, and needs no value shapes;
by the time redaction sees an event, env-sourced values and strings under
secret-looking names are already `••••••••`. Redaction adds the shape rules
for what provenance cannot know: a literal typed into the source under an
innocent name. It applies to agent-facing output only.

## Recording limits

Nothing a recording leaves out is dropped silently.

- **Step cap.** `config.maxTraceSteps` (default 999,999; `pyokka run --max-steps`) bounds the
  recorded trace. Past it the program runs on, unrecorded; the final `trace` carries
  `truncated: true, cap, stepsRun, spentBy`. A saved run copies that into `meta.recording`
  (`{truncated, cap, kept, stepsRun, spentBy: [{path, steps}], exclude}`, paths as the CLI prints
  them, `exclude` the pattern that leaves the busiest non-program file out); every CLI verb over it
  prints `note: truncated recording: ...` first and its `--json` gets the same object as
  `recording`. The bridge's `state` reply carries `recording` for a capped live run, and the
  Time Machine shows the sentence under its timeline.
- **Leaving code out.** `config.exclude` and `config.only` are lists of patterns: a dotted module
  name or glob (`pkg.flash` also covers `pkg.flash.parser`), or a path glob, absolute or relative to
  the workspace root, where a directory covers what is under it (`pkg/flash`, `*/parser.py`); a
  bare file or directory name matches anywhere. An excluded module is not instrumented: it runs at
  full speed and records no steps, values or coverage. With `only`, just the matching modules are
  instrumented, library ones included without `libraryCode`. `exclude` wins over `only`, and
  neither applies to the program file itself. VS Code: `pyokka.timeMachine.exclude`.
- **Value text.** A `log` text, a `locals` change text and a scope's `returned` are bounded `repr`s:
  `config.maxValueChars` characters (unset: 120 for a local or a return, 200 for a logged value; 0, or more
  than the ceiling, is 1,000,000). A cut text ends in `…(+N chars)`, N being what the full `repr`
  had beyond the shown text, or `…(cut)` when the full length is unknown (an object whose `repr` is
  not a builtin's), and the event or change carries `truncated: true` and `length` (the full
  `repr`'s length, when known); a scope carries them as `returnedTruncated` and `returnedLength`,
  since a `trace`'s own `truncated` means the step cap. A masked secret carries neither. Raising `maxValueChars` raises the
  value bag's string length and `maxLogEntrySize` to match, so the expandable value holds as much.
  The CLI's own line cuts keep the mark and add what they cut: `…(+N chars)` counts both, and
  `--json` adds `truncated`/`length` to any `text` that ends in the mark. VS Code: `pyokka.maxValueChars`.
