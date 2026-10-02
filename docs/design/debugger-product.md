# Design: the Debugger as its own product

Round 3 of the debugger, designed 2026-09-15 on top of `ea3ea51`. Two implementers build this in
parallel without talking to each other: one owns the Python runtime, one owns the VS Code host and
the CLI. Every shape below is pinned. Where a choice existed it is made here with one sentence of
why; section 9 lists the choices a coordinator may overturn.

Read with: `docs/HANDOFF-debugger.md` (what the two earlier rounds built), `docs/PROTOCOL.md`
(the wire), `docs/HANDOFF.md` (build, quirks, decisions).

---

## 1. The two products and the invariants

Pyokka ships two things that share a runtime, a runner and VS Code's gutter breakpoints, and
nothing else.

**Run-all** is Quokka for Python: run the file on save, record every statement, show values
inline, navigate the recording in the Time Machine, read it as a Code Story, ask `why`. It is
finished and stays exactly as it is.

**The Debugger** is a normal debugger: start a program (a script, a FastAPI server, a module with
arguments), it runs at full speed until a breakpoint or an exception, you pause, step, inspect,
continue, stop. Nothing is recorded, nothing is "finished", nothing re-runs. Agents drive it
through the `pyokka` CLI, humans through F5, the toolbar and the panel, and both see the same
pause.

**Recording is the optional bridge.** `record: true` makes a debug session also record, and then
the Time Machine opens over that recording. Off by default, never required.

### What run-all keeps, byte for byte

- `Session.runNow` builds its request as it does today: no `debug`, no `breakpoints`, no `record`
  key at all for a run-all session (`record` absent means `true`). The only edits allowed in
  `runNow` are the three `??` overrides of section 3.7 (`argvOverride`, `cwdOverride`,
  `envOverride`), which are inert unless a recording debug start sets them. The fourth launch
  attribute a recording session needs, `python`, is not a `runNow` override: it reaches
  `SessionManager.start` as an option.
- `config.record` is **only read when `config.debug` is true**. A run-all run records whatever the
  host sends, so a host that sends `record: false` by mistake cannot silently produce an empty
  run.
- The run-all e2e suites pass untouched, with no edits to their files: `features.test.js`,
  `bridge.test.js`, `demo.test.js`, `code-story.test.js`, `http-replay.test.js`,
  `execution-diagram.test.js`, `why.test.js`, `exceptions.test.js`, `values-as-of.test.js`,
  `walkthrough.test.js`, `uipass.test.js`, `library-cache.test.js`, `cli-live.test.js`.
- `DebugController`, `requestExtras`, `blocksRun`, `Session.debug*`, `navigator.onDebugPaused` and
  the Time Machine's `DebugStatus` / `FrontierLocals` stay and keep their behaviour. They serve
  `record: true` from now on and nothing else.
- Run-all bridge descriptors gain one additive field, `"kind": "run"`. An older CLI ignores it.

### What the Debugger never does

With `record: false` (the default):

- no `trace` event, partial or final; no `coverage`; no `log` of any kind; no `locals`; no `time`;
  no `watch` event; no `http.exchange`
- no run timeout, ever, for any run with `config.debug: true`
- no implicit run: a debug session has no run loop, no debounce, no run modes, no save hook. An
  edit while paused is allowed and simply not applied until the next start.
- no Time Machine: nothing attaches, no navigator anchor, no `nav` state
- no finished run: when the program exits, the debug session is disposed, its bridge descriptor is
  removed and there is nothing left to read
- no run-all `Session` object anywhere in the path

A file may have a run-all session and a debug session at the same time. They share VS Code's
gutter breakpoints and nothing else: separate runner processes, separate children, separate bridge
sockets.

---

## 2. The runtime contract

### 2.1 `config.record`

```jsonc
"config": {
  "record": false,        // default true; read only when `debug` is true
  "debug": true,
  "stopOnEntry": false,
  "breakOnException": "uncaught",
  "timeoutMs": 0,
  "libraryCode": false
}
```

`RunConfig.record: bool = True`, `from_dict`: `record=bool(cfg.get("record", True))`.

With `record: false` the runtime also forces, whatever the request says, and says so in this
document rather than in an error:

| field | forced | why |
|---|---|---|
| `recordLocals` | `False` | `locals` events are a recording |
| `autoLog` | `False` | a `log` per statement is a recording |
| `markers`, `watch`, `expressionsToEvaluate`, `traceContext` | ignored | all three produce `log` / `watch` events |
| `maxTraceSteps` | ignored | no trace exists |
| `http`, `httpObserve` | `"off"` / `False` | the HTTP plugin patches the clients and keeps a row per request in memory, which grows without bound in a server; there is no HTTP view without a recording anyway |
| `mode` | `"normal"` | `profile` and `snaps` are recordings of a different shape |

`RunConfig.from_dict` implements the `http` part by not appending `HTTP_PLUGIN` when
`record is False and debug is True`; the rest is read at the point of use.

New runner capabilities in `runner.CAPABILITIES`: `"record"`, `"exec"`, `"module"`. The host
refuses to start a `record: false` session against a runtime that does not advertise `"record"`
and says the runtime in `dist/python` is older than the extension.

### 2.2 The events a `record: false` child emits

Exactly these, and nothing else:

| event | when |
|---|---|
| `run.started` | once, from the runner |
| `file.instrumented` | per instrumented file, unchanged (the host needs the rid tables for breakpoints and locations) |
| `output` | every write to `sys.stdout` / `sys.stderr` and every raw fd write |
| `debug.paused` / `debug.resumed` | per pause |
| `debug.result` / `debug.error` | per `debug` control action |
| `evaluate.result` / `evaluate.error` | per `evaluate` |
| `exec.result` / `exec.error` | per `exec` (section 2.7) |
| `complete.result` / `complete.error` | per `complete` |
| `source.result` / `source.error` | per `source` |
| `expand.result` / `expand.error` | per `expand` |
| `error` | **once**, for the exception that ended the run, with `traceback` |
| `runner.error` | a runtime-level problem, including what would have been a `system` log |
| `run.finished` | once, from the runner |

The uncaught `error` event stays because it is the program's crash, not a recording: the panel and
the CLI print its traceback. Caught-exception groups (`handled: true`) are never emitted: they are
aggregated over a whole run, which is a recording.

`error` with `record: false`:

```jsonc
{ "type": "error", "runId": "r-1", "seq": 87,
  "fileId": 1, "rid": 12, "step": 1403,        // step = the statement counter
  "errorType": "ValueError", "message": "too big: 3",
  "stack": [ { "fileId": 1, "line": 6, "col": 0, "rid": 12, "function": "check", "path": "/abs/app.py" } ],
  "handled": false,
  "traceback": "Traceback (most recent call last): …" }
```

`report_uncaught` with `record: false` builds the record from the traceback alone and skips every
`error_states` write (no `coverage` event is emitted, so the states have no reader).
`flush_unemitted_errors` returns at once. `Tracer.finish` emits nothing beyond that `error` event
and stays idempotent.

`Tracer.hook_error` with `record: false` emits `runner.error` with the message
`debugger hook failed in <where>: <Type>: <msg>`, deduplicated by message through the existing
`system_messages` set, because a `log` event is forbidden.

### 2.3 The hook in debugger mode

The instrumented code is identical in both modes. `Tracer.install` picks the hook set:

```python
def install(self) -> None:
    if not self.record and self.dbg is not None:
        from .hooks_debug import make_debug_hooks
        hooks = make_debug_hooks(self, self.dbg)
    else:
        hooks = self._make_hooks()
    ...
```

`python/pyokka_runtime/hooks_debug.py` (new) holds the set. The statement hook, exactly:

```python
def step(rid: int, scope: int = 0) -> None:
    try:
        count[0] += 1
        if cell[0]:
            bp = by_rid.get(rid)
            if bp is not None or cell[1]:
                dbg.on_step(count[0] - 1, rid, scope, bp)
    except Exception as exc:                      # a bug in the debugger must not break the program
        tracer.hook_error(exc, "step")
```

- `count` is a one-element list holding the statement counter. Closure cells beat attribute
  lookups, and a list cell is readable from the debugger.
- `cell` is a two-element list the debugger owns: `cell[0]` is 1 while any reason can fire and 0
  otherwise (including while a library module body imports); `cell[1]` is 1 while a reason that is
  not a breakpoint is armed (a pending step, a pause request, `start_paused`, any break-when
  watch).
- `by_rid` is the debugger's breakpoint index, **mutated in place** (`clear()` + `update()`) so the
  closure keeps the same dict object across `set_breakpoints`.
- `try/except` costs nothing when nothing raises on 3.11+, which 3.12+ guarantees.

The rule, concretely. Per statement, in debugger mode, there is: no list append, no tuple build,
no dict write, no frame fetch, no attribute lookup on the tracer, no clock read, no periodic
flush, and no call into the debugger unless a breakpoint matched or `cell[1]` is set. The only
allocation is the counter's integer, which CPython cannot avoid and which the pause payload needs.

**No frame is passed.** `Debugger.on_step` fetches `sys._getframe(2)` inline (2 because `on_step`
is called from `step`) and only when a reason needs a frame: a breakpoint with a condition, a
break-when watch, or the pause itself. A breakpoint without a condition never touches a frame
until it pauses.

The rest of the set:

| hook | debugger mode |
|---|---|
| `_pk_c(rid)` | `return None`. Coverage is a recording. |
| `_pk_f(rid)` | see 2.4 |
| `_pk_x(sid)` | see 2.4 |
| `_pk_v(rid, ctx, val, kind, ...)` | `return val`, nothing logged |
| `_pk_t(rid, ctx, t0, val, kind, ...)` | `return val`, nothing logged |
| `_pk_print(rid, *args, **kwargs)` | `tracer.real_print(*args, **kwargs)`: the program's print reaches `sys.stdout`, which is the `StepStream`, which emits `output` |
| `print` builtin | **not patched**. In debugger mode `print` is Python's own print. |
| `_pk_logpoint(...)` | `return None`. Logpoints are markers and never pause. |
| `_pk_time` | `time.perf_counter`, unchanged (it is only the clock `_pk_t` uses) |
| `_pk_snap_error(exc, rid)` | unchanged; only `mode: "snaps"` injects it and the debugger never runs that mode |

This is the answer to "the program's prints must reach the terminal-like stream": in record mode a
print is a `log` event and is not echoed; in debugger mode it is a real print into the
`StepStream`, so it arrives as `output` with the current `step`, which the panel's output pane and
the CLI's `output` tail both read.

**`output.step` reads the counter.** `StepStream._flush_locked` puts `tracer.cur_step` on the
event today, and the debugger-mode hook never writes `cur_step`, so every `output` event would
carry `0`. Pinned: `StepStream._flush_locked` reads `tracer.step_count()`, the new one-line reader
that returns the hook's `count[0]` in debugger mode and `n_steps` otherwise. One line in
`execute.py`, wiring only, and `output.step` then means "after this many statements" in both
modes.

### 2.4 Step Over and Step Out without a recording

No scope table, no depth counter, nothing that grows. `_pk_f` returns a per-call id from a
counter; the step rules use frame exits, which the instrumenter's `try/finally` already reports.

```python
def enter(rid: int) -> int:
    try:
        if rid in library_modules:
            tracer.quiet += 1
            dbg.rearm()                 # a library module body is not steppable: cell[0] = 0
            return LIB_MODULE
        if tracer.quiet:
            return NO_SCOPE
        sid = next_sid[0] = next_sid[0] + 1
        if cell[0]:
            bp = by_rid.get(rid)        # a breakpoint on a `def` line pauses at every entry
            if bp is not None or cell[1]:
                dbg.on_step(count[0], rid, sid, bp)
                count[0] += 1
                return sid
        count[0] += 1
        return sid
    except Exception as exc:
        tracer.hook_error(exc, "scope")
        return NO_SCOPE


def leave(sid: int) -> None:
    try:
        if sid == LIB_MODULE:
            tracer.quiet = max(0, tracer.quiet - 1)
            dbg.rearm()
        elif dbg.pending_sid == sid:
            dbg.on_leave(getframe(1))   # the frame we are stepping in has returned
    except Exception as exc:
        tracer.hook_error(exc, "scope")
```

`Debugger.pending_sid` is `-1` when no step is pending, so `leave` costs one attribute compare per
function exit.

The pending step is `(kind, target_sid, wait_exit)`:

| kind | armed as |
|---|---|
| `into` | `("into", -1, False)` |
| `over` | `("over", S, False)` where `S` is the paused frame's sid |
| `out` | `("out", S, True)` |

The predicate inside `on_step`, exactly, and nothing else about the pending step:

```python
# self.pending is (kind, target_sid, wait_exit) or None
if self.pending is not None:
    kind, target_sid, wait_exit = self.pending
    if kind == "into" or (not wait_exit and scope == target_sid):
        reason = "step"
        extra["kind"] = kind
```

`wait_exit` starts True only for `out` and only ever becomes False through `on_leave`'s re-arm, so
`out` can never stop in the frame it was armed in and `over` can.

`on_leave(frame)` fires only for the target frame (`_pk_x` compares `dbg.pending_sid == sid`). It
reads the caller's sid from the caller frame's `_pk_scope_` local, walking up at most
`PARENT_FRAMES` (4) frames exactly as `tracer._make_hooks().caller_scope` does today, and re-arms
`(kind, caller_sid, False)`. So a step over the last statement of a function lands on the next
statement of the nearest instrumented ancestor, and a step out walks up as the ancestors return.
At module level of the main file there is no `_pk_f` wrapper, so `_pk_x(0)` never fires and Step
Out runs to the end, which is today's behaviour.

**Suspension.** A `yield` or an `await` that suspends the frame does not run the frame's
`finally`, so `_pk_x` does not fire and the pending step stays armed on that frame. A step over a
suspending expression therefore lands where that frame resumes, which is the standard behaviour
(debugpy does the same: the step belongs to the frame, and the frame comes back). If the frame
never resumes (a generator nobody exhausts, a task nobody awaits), the pending step never matches
and the program runs on to the next reason: a breakpoint, a break-when watch, an exception pause,
a `pause` request, or the end of the run. Nothing leaks: the pending tuple is overwritten by the
next stop.

This reproduces today's scope-chain rules (`over`: this frame or an ancestor; `out`: an ancestor
only) without keeping anything per call. Nothing is reclaimed because nothing is stored: a server
running for an hour holds one int counter, one pending tuple and the breakpoint index.

Threads: the pending step is one slot, shared, as it is today. A step armed by the paused thread
stops at the next matching statement in whichever instrumented thread reaches it first; the stop
names its thread (2.6). Documented, not fixed: one pending step per program is what the control
channel can express.

### 2.5 `quiet` and `library_modules` with no recording

Both stay exactly as they are. `tracer.quiet` is still an int attribute (so `errors.py` needs no
change), still incremented by `_pk_f` on a library module body and decremented by `_pk_x`. Its two
remaining jobs with `record: false`: the exception callbacks skip a library import, and
`Debugger.rearm()` sets `cell[0] = 0` while `quiet` is non-zero so nothing pauses inside a library
module's import-time body.

Consequence, unchanged from run-all and documented in the README: a breakpoint inside a library
module's import-time body does not pause. A breakpoint in a library *function* pauses when stepped
code calls it, with `libraryCode: true`.

### 2.6 `debug.paused` with `record: false`

```jsonc
{ "type": "debug.paused", "runId": "r-1", "seq": 12,
  "step": 1403,                      // the statement counter, not a navigable index
  "rid": 88, "fileId": 2, "line": 42, "scopeId": 7, "depth": 2,
  "reason": "breakpoint",
  "breakpoint": { "path": "/abs/project/app.py", "line": 42, "rid": 88, "fileId": 2, "resolvedLine": 42 },
  "thread": { "name": "Thread-3 (process_request_thread)", "ident": 6108209152 },
  "stack": [
    { "frameId": 0, "name": "do_GET",            "fileId": 2, "line": 42, "rid": 88, "scopeId": 7 },
    { "frameId": 1, "name": "handle_one_request", "fileId": 0, "line": 427 },
    { "frameId": 2, "name": "<module>",          "fileId": 1, "line": 31, "rid": 3, "scopeId": 0 }
  ] }
```

- `step` is the statement counter: the index of this statement among all statements this run
  executed, across threads, starting at 0. It is free and it is what the CLI prints. It is not a
  trace index: nothing can navigate to it.
- `scopeId` is the per-call id `_pk_f` returned, kept so the field means the same thing in both
  modes. `depth` is `len(stack) - 1`.
- **The stack comes from the frame chain and carries real caller lines.** `dbgframes.frame_stack`
  walks `frame.f_back` up to 64 frames, skips frames whose code lives under the runtime directory,
  and emits `{frameId, name: code.co_name, fileId, line: f.f_lineno, rid?, scopeId?}`. `fileId` is
  `tracer.files[code.co_filename].file_id` when the file is instrumented, else `0` (and then no
  `rid`, no `scopeId`). `rid` is `tracer.rid_at(info, f.f_lineno)`.
- DAP uses it: `stackTrace` prefers `line`/`fileId` from the frame entry and only falls back to
  today's `locate(frame.rid)` approximation (the scope's `def` line) when they are absent, which
  is the `record: true` case. This removes the "DAP caller frames point at their `def` line" gap
  for non-recording sessions.
- `frameId` is the index into that chain and is what `locals`, `evaluate` and `exec` address
  (section 5).
- `thread` is `{name: threading.current_thread().name, ident: threading.get_ident()}`, on every
  pause in both modes.
- `modified: true` is added once any `exec` or `setVariable` has written in this run, and then on
  every later `debug.paused`. It is absent while false.

Where the frame `_pause` works from comes from, in each of the three paths:

| path | the frame |
|---|---|
| `on_step` (start, step, pause, breakpoint, watch) | `sys._getframe(2)`, fetched inline in `on_step` and only once a reason has fired, then passed to `_pause` |
| `on_raise` (mode `raised`) | the raising frame `errors.py` already has (`sys._getframe(1)` in `_on_raise`), passed through unchanged |
| `on_uncaught` | the traceback's innermost frame whose file is instrumented, which `on_uncaught` already walks to |

`Debugger.frames` is that frame's `f_back` chain, built by the same walk `frame_stack` does, and
set in `_pause` before the event goes out and cleared when the pause resumes. For the uncaught
path the frames have already returned, and they still answer `f_back` and `f_locals`: CPython
keeps the links between frame objects a traceback holds, which is why `evaluate` and `locals`
answer at that pause today.

With `record: true` the event keeps today's shape and gains `thread` and the optional `modified`.
The `stack` entries then keep `{scopeId, name, rid, depth}` and carry no `frameId`; both shapes
live in one array type whose members are optional (section 3.3).

`debug.resumed` is unchanged.

The pause flush with `record: false` is `sys.stdout.flush()` and `sys.stderr.flush()`, nothing
else. No partial trace, no `time`, no `locals`.

### 2.7 The `exec` request

A request type of its own on the control channel, not a `debug` action, because the runner gates it
exactly as it gates `evaluate` and the reply is a typed result.

```jsonc
// host -> runner
{ "type": "exec", "id": 41, "runId": "r-1", "source": "x = 3", "frameId": 0 }
```

```jsonc
// runner -> host, a statement
{ "type": "executed", "id": 41, "text": "", "modified": true }

// an expression statement
{ "type": "executed", "id": 42, "text": "3", "valueBag": { "data": { "type": "number", "value": "3", "id": "x:7" }, "runtimeKey": "x:7" }, "modified": true }

// the statement raised; the session stays paused
{ "type": "executed", "id": 43, "text": "", "modified": true,
  "exception": { "type": "KeyError", "message": "'b'", "traceback": "Traceback (most recent call last): …" } }

// the request cannot be served at all
{ "type": "error", "id": 44, "message": "the program is running; pause it first" }
```

Child-side the events are `exec.result` and `exec.error`; the runner forwards `exec.result` as
`{"type": "executed", "id": <host id>, ...}` and `exec.error` as a plain `error` reply, the same
mapping `evaluate.result` -> `evaluated` already uses. `runner.Child.on_child_line` adds
`"exec.result"` and `"exec.error"` to its forwarded kinds; `Runner.handle_evaluate` accepts
`"exec"` with a stricter gate: only when `child.paused` (never after the run finished, because
there is no frame).

What `exec` runs: anything `compile(source, "<pyokka-exec>", "exec")` accepts. Assignments, calls,
imports, `del`, multi-line blocks, a bare expression. `pure.py` is not involved and is unchanged.

How `text` is produced, pinned as code (a REPL's rule, so `items.pop()` shows what it returned):

```python
tree = ast.parse(textwrap.dedent(source).strip(), mode="exec")
last = tree.body[-1] if tree.body else None
if isinstance(last, ast.Expr):
    head = ast.Module(body=tree.body[:-1], type_ignores=[])
    if head.body:
        exec(compile(head, "<pyokka-exec>", "exec"), g, l)          # the statements before it
    value = eval(compile(ast.Expression(last.value), "<pyokka-exec>", "eval"), g, l)
    text = secrets.current.mask_text(expression_name(ast.unparse(last.value)), value, short_repr(value))
    bag = tracer._bag(value, key, 1, "value", ast.unparse(last.value))
else:
    exec(compile(tree, "<pyokka-exec>", "exec"), g, l)
    text, bag = "", None
```

`g` and `l` are the namespaces of the write-back branch below (`l` is absent at module level).
Both halves run in the same namespaces, so `x = 2; x * 3` answers `6`. `valueBag` accompanies a
value so the Debug Console and the CLI can expand it; a block whose last statement is not an
expression has `text: ""` and no bag.

Write-back, by interpreter:

```python
# module level: co_name == "<module>"; globals are the module dict, nothing to write back
exec(code, frame.f_globals)

# 3.13+ (PEP 667): f_locals is a write-through FrameLocalsProxy
exec(code, frame.f_globals, frame.f_locals)

# 3.12: f_locals is a snapshot dict cached on the frame; push it into the fast locals
import ctypes
d = frame.f_locals
exec(code, frame.f_globals, d)
ctypes.pythonapi.PyFrame_LocalsToFast(ctypes.py_object(frame), ctypes.c_int(0))
```

`sys.version_info >= (3, 13)` picks the branch; `ctypes` is imported inside the 3.12 branch only.
If `ctypes` is unavailable the reply is `exec.error` with
`cannot write to a frame on Python 3.12 without ctypes`.

A name the function itself declares reaches the program's own code on both branches. A brand-new
name is kept in the frame's locals mapping, so later `exec`, `evaluate` and `locals` see it, but
the function's compiled code does not, because it has no slot for it. Both branches behave the
same way and the README says so.

`modified`: the debugger sets `modified = True` on **any** `exec` attempt, successful or not,
because a statement that raised halfway may already have written. It is reported in the reply, on
every later `debug.paused`, and on the `debug.result` of `locals`:

```jsonc
{ "type": "debug.result", "id": 45, "locals": [ { "name": "x", "text": "3" } ], "modified": true }
```

It is reset only by a new run (a restart builds a new `Debugger`).

Where `exec` may be reached from: the control channel, while a frame is being served
(`frame is not None` in `handle_request`). Nowhere else.

- `ControlChannel._while_running` answers `exec.error` with
  `the program is running; pause it first`.
- `ControlChannel.serve_after_run` answers `exec.error` with
  `the run has ended; there is no frame to execute in`.
- Hovers, displayed watches, break-when watches, `eval`, `complete` and `shadow` keep going
  through `pure.py` and can never reach `exec`. The host must not route `evaluate` to `exec`: only
  the bridge's `exec` request and the DAP console's `context: "repl"` and `setVariable` do.

### 2.8 `frameId`

The pause keeps its frame chain: `Debugger.frames: list[FrameType]` is set in `_pause` (the same
walk `frame_stack` does) and cleared when the pause resumes. `frameId` is the index into it, `0`
is innermost, absent means `0`. `debug locals`, `evaluate` and `exec` all take it.
`dbgframes.frame_at(frames, frame_id)` returns the frame or raises
`LookupError("no frame <n> in this pause")`, which becomes the matching `.error` reply.

`Runner.Child.request_evaluate` forwards `frameId` alongside `expression`; `request_debug` already
forwards every field of the action.

### 2.9 The module launch

```jsonc
{ "type": "run", "id": 3, "runId": "r-1",
  "module": "app.server",
  "workspaceRoot": "/abs/project", "cwd": "/abs/project",
  "argv": ["--port", "8000"], "env": { "PORT": "8000" },
  "projectFiles": [],
  "config": { "record": false, "debug": true, "stopOnEntry": false, "breakOnException": "uncaught", "timeoutMs": 0 },
  "breakpoints": [ { "path": "/abs/project/app/server.py", "line": 42 } ] }
```

`run.module` and `run.file` are mutually exclusive; `module` wins if both arrive and the runtime
emits a `runner.error` saying so. `RunSpec.module: str | None`.

Semantics, equivalent to `python -m`:

- `sys.argv = [<the module's resolved file>, *argv]`
- `sys.path[0] = cwd` (a file launch keeps today's rule: `sys.path.insert(0, dirname(file))`)
- the module runs as `__main__`: `__name__ == "__main__"`, and a package `M` runs `M.__main__`
- implemented as `runpy.run_module(module, run_name="__main__", alter_sys=True)` in a new module
  `python/pyokka_runtime/module_run.py`, so `execute.py` takes a two-line branch. `runpy` imports
  through the normal machinery, so the runtime's `_Finder` instruments the module and its imports
  exactly as it instruments a file launch.
- `Execution.main_globals` is the globals dict the run used (the module dict for a file launch, what
  `run_module` returned for a module launch); `control.py` reads `execution.main_globals` where it
  reads `execution.module.__dict__` today.
- `SystemExit`, `KeyboardInterrupt` and an uncaught exception are handled exactly as for a file.

`run.file.content` absent means read the file from disk. This is already what `load_source` does;
it is stated here because a debug session never sends buffer content: what runs is what is on
disk, which is why an edit while paused is not applied.

### 2.10 The timeout

Two independent guards, because a paused server must not be killable by a stale host:

1. The host sends `timeoutMs: 0` for every debug session. The runner already treats
   `timeoutMs <= 0` as "never".
2. `Runner.handle_run` skips arming the timer whenever `cfg.get("debug")` is true, whatever
   `timeoutMs` says.

This makes a run with a debugger attached immune to `pyokka.runTimeout`, recording or not, which
changes today's behaviour for a recording debug run that is *running* (it used to be killable; only
a *paused* one held the clock). That is the brief's "no timeout while a debugger is attached".
`Child._hold_timeout` / `_release_timeout` stay for the case where a host still sends a timeout.

### 2.11 The two-thread rule

`Debugger.pause_lock = threading.Lock()`, held across the whole pause: the `debug.paused` emit,
`control.serve_paused`, and the `debug.resumed` emit.

A second instrumented thread that hits a reason while the first is paused blocks on
`pause_lock.acquire()` before emitting anything. When the first resumes, the second acquires the
lock and pauses with the reason it computed, without re-checking it (the user asked for that
breakpoint when it was hit). So:

- `debug.paused` and `debug.resumed` events stay strictly sequential
- exactly one thread is paused at any moment, so `continue`, `step` and `locals` need no thread
  argument: they address the thread that is being served. One at a time is the contract.
- `pause` sets one flag, so every instrumented thread pauses at its next statement, one after the
  other, each one reported with its own `thread`
- DAP reports one thread (`THREAD_ID = 1`), named from the pause's `thread.name`. A real DAP thread
  list would need per-thread pause state, which the control channel does not have.

`Debugger.serving` becomes **per thread** (`threading.local`), so the "nothing that runs inside a
pause may pause again" guard stays correct while another thread can still queue a pause of its own.

When the only thread is blocked in `accept()` (or any C call), nothing pauses until a statement
runs. `debug pause` answers `{"ok": true, "paused": false}` immediately, as it does today, and the
bridge's `pause` waits for the stop unless `noWait` is set. The README and the skill both say: a
server pauses when the next request arrives.

### 2.12 Exception pauses with `record: false`

`on_raise` (first sighting, mode `raised`) and `on_uncaught` (the exception that ends the run)
stay. Both move into `python/pyokka_runtime/dbgexceptions.py` as a mixin so `debugger.py` stays
under 500 lines.

`sys.monitoring` in debugger mode:

- installed only when `break_on_exception != "off"`. With `off` a `record: false` run pays nothing
  for exception tracking, which matters for a server.
- the `exceptions` action installs the callbacks when it switches away from `off` and removes them
  when it switches to `off`, mid-run.

What must not accumulate, and what replaces it:

- `self.records` is **not** written with `record: false`. `_on_raise` builds a transient
  `ErrorRecord`, hands it to `dbg.on_raise`, and drops it.
- "first sighting" then needs its own memory, because RAISE fires in every frame the exception
  propagates through. `ErrorMixin.seen: OrderedDict[int, BaseException]`, capped at 256 with FIFO
  eviction, keyed by `id(exc)` and holding the exception object so the id cannot be reused. A
  server raising for an hour holds 256 exceptions, the same order of magnitude as today's
  `MAX_RECORDS = 500`.
- `_on_reraise` and `_on_handled` return at once: there is no `handledAt` to report.
- `self.groups` stays empty; `flush_unemitted_errors` returns at once.

`on_uncaught` cannot use `t.records` or `t.step_for`, so with `record: false`:

- `frame` is the traceback's innermost frame whose file is instrumented, as today
- `rid` is `t.rid_at(t.files[frame.f_code.co_filename], frame.f_lineno)`
- `step` is the statement counter's current value (`t.step_count()`, a new one-line reader on the
  tracer that returns the hook's `count[0]` in debugger mode and `n_steps` otherwise)
- `line` is `frame.f_lineno`
- `stack` is `dbgframes.frame_stack` over the traceback's frames, so the pause shows the real
  raise site and its callers

`_IGNORED` (StopIteration, StopAsyncIteration, GeneratorExit, SystemExit, KeyboardInterrupt) and
the library-frame rule are unchanged.

### 2.13 `run.finished` and `stepCount`

```jsonc
{ "type": "run.finished", "runId": "r-1", "seq": 900,
  "exitCode": 0, "durationMs": 41230.5, "timedOut": false, "stopped": false,
  "stepCount": 1403, "logCount": 0 }
```

`stepCount` is the statement counter. It keeps its name and stays useful ("statements executed"),
so the CLI's `finished: exit 0, 1403 steps` text form needs no change.

---

## 3. The host: `DebugSession`

### 3.1 Modules

New files (`session.ts` 849, `extension.ts` 525, `bridge.ts` 501, `sessionManager.ts` 350 take
wiring lines only):

| file | holds |
|---|---|
| `src/debug/debugSession.ts` | the `DebugSession` class: the launch configuration, the `RunnerClient`, the run id, `DebugState`, the output buffer, `modified`, the state machine, the events, the control methods |
| `src/debug/debugSessionState.ts` | pure, vscode-free: `LaunchConfig` and its defaults, `parseLaunch`, `launchKey`, `parseDebugUri`, `stopSlice`, `descriptorFor`. It does **not** hold a descriptor picker: choosing between a run and a debug socket is the CLI's job and lives in `agent/live.py` (4.7). |
| `src/debug/debugSessionManager.ts` | the registry: `start`, `get`, `all`, `byKey`, `dispose`, the `sessionStarted` / `sessionEnded` events |
| `src/debug/debugTarget.ts` | the facade `DebugTarget` and `wrapDebugSession(ds)` |
| `src/debug/debugContext.ts` | the context-key arbiter (`pyokka.debugActive`, `pyokka.debugPaused` as the union of both products) |
| `src/debug/debugUri.ts` | the `vscode://ivor.pyokka/debug` handler |
| `src/agent/bridgeDebugSocket.ts` | the `kind: "debug"` socket: descriptor, dispatch, the watch stream |
| `src/views/debuggerView.ts` | the panel's Debugger view host |
| `src/views/debugStatusBar.ts` | the second status bar item |
| `src/session/outputBuffer.ts` | `OUTPUT_KEPT` and `appendOutput`, moved out of `session.ts` so both products share one buffer rule |
| `webview/components/DebuggerView.tsx` | the view |
| `webview/debuggerView.ts` | the view's pure helpers (frame labels, the reason line, the breakpoint list) |

### 3.2 The launch configuration

```ts
export interface LaunchConfig {
  program?: string;          // absolute path; exactly one of program / module
  module?: string;           // dotted name, run like `python -m`
  args: string[];            // default []
  cwd: string;               // default: the workspace folder of the program, else its directory
  env: Record<string, string>;  // default {}
  python?: string;           // interpreter path; default: resolveInterpreter(program)
  stopOnEntry: boolean;      // default false
  breakOnException: ExceptionMode;  // default 'uncaught'
  libraryCode: boolean;      // default false
  record: boolean;           // default false
}
```

`parseLaunch(raw: Record<string, unknown>, ctx: {activeFile?: string; workspaceRoot?: string}): LaunchConfig`
is pure and is what the DAP `launch` request, the commands, the URI handler and the bridge all go
through. It resolves `${file}` and `${workspaceFolder}` in `program` and `cwd`, makes `program`
absolute, rejects a launch with neither `program` nor `module`, and rejects `module` together with
`record: true` (section 3.7).

`launchKey(launch)` is `module ? "m:" + module : "f:" + realpath(program)` plus `"|" + cwd`. It is
the registry key and what the CLI matches on.

### 3.3 State, events, lifecycle

```ts
type DebugSessionStatus = 'starting' | 'running' | 'paused' | 'ended';
```

`DebugSession` fields: `id` (`debug-1`, `debug-2`, ... per window), `launch`, `runner: RunnerClient`,
`runId`, `status`, `state: DebugState`, `output: string`, `modified: boolean`, `record`,
`startedAt`, `mainFile` (the first instrumented file's path, undefined until it arrives),
`files: FileTable` (reused: `file.instrumented` events feed it, which is how `fileId` becomes a
path and how `rid` becomes a line), `thread`.

Events: `started [runId]`, `paused [PausedInfo]`, `resumed []`, `output [OutputEvent]`,
`changed []`, `finished [RunFinishedEvent]`, `ended []`.

`DebugState` gains one field and `DebugFrame` loosens three, in `src/session/debugState.ts`:

```ts
export interface DebugState {
  // … unchanged fields …
  /** an `exec` or a `setVariable` wrote in this run: the values are no longer the program's own */
  modified: boolean;
}

export interface DebugFrame {
  /** index into the pause's frame chain, innermost 0; `frameId` on locals / evaluate / exec */
  frameId?: number;
  name: string;
  scopeId?: number;
  rid?: number;
  depth?: number;
  /** the frame's own file and line at the pause (record: false carries the real caller line) */
  fileId?: number;
  line?: number;
}
```

`reduceDebugState` handles it: `run.started` sets `modified: false`, `debug.paused` sets
`modified: ev.modified ?? state.modified`. The same reducer serves both products, so one vitest
suite covers both.

Lifecycle:

- **Created** by `DebugSessionManager.start(launch)`, called from the DAP adapter's `resolve` (F5,
  the Run menu, `pyokka.debugCurrentFile`, the panel's Debug button), from the URI handler, and
  from the bridge's `debug` on a run-all socket. Every path goes through
  `vscode.debug.startDebugging` first (`startDebugSession` in `dapAdapter.ts`), so the standard
  debug views open with the panel. The "one door" rule of round 2 stands.
- `start()` resolves the interpreter, spawns a `RunnerClient`, waits for `ready`, checks the
  `record` capability, publishes the bridge descriptor, sends one `run` request, and moves to
  `running`.
- **Ends** on `run.finished`, on Stop, or when the runner exits. `dispose()` kills the child, shuts
  the runner down, removes the descriptor and the socket, drops itself from the registry, updates
  the context keys, and emits `ended`. There is no grace period and no finished run: a command that
  arrives after the program exited gets "no live session" with the hint
  `the debug session ended when the program exited; \`pyokka debug FILE\` starts another`.
- **Restart** (`supportsRestartRequest`, the toolbar, `restart --live`) replaces the child inside
  the same `DebugSession` and the same VS Code debug session: stop the run, wait for
  `run.finished`, send a fresh `run` with a new `runId` on the same `RunnerClient`. The launch
  configuration, the breakpoints, the break-when watches and the exception mode survive;
  `modified`, `output`, `files` and `mainFile` are reset. The bridge descriptor is not rewritten,
  so an agent's connection and `started` stay valid.

One `RunnerClient` per debug session, never shared with a run-all session: a runner serves one
child at a time (`Runner.handle_run` drops the previous child), so sharing would make a run-all
re-run kill the paused debug child. This is the mechanical reason a file can have both.

### 3.4 The registry

`DebugSessionManager` (its own object, not on `SessionManager`): a debug session is not keyed by a
document (a module launch has no document), may exist without one, and has no auto-start, trust or
recent-file rules. `SessionManager` stays about run-all documents.

One debug session per `launchKey`. A second start on the same key:

- in the same VS Code debug session: **restarts** it in place
- in a different VS Code debug session: refused with
  `app.py is already being debugged in another debug session: continue there, or stop it first`
  (today's message, kept)

A different `args`, `cwd` or `module` is a different key and runs side by side.

### 3.5 The interpreter

`launch.python` if set, else `resolveInterpreter(Uri.file(program ?? cwd))`, which is the Python
extension's environment, then `pyokka.python.interpreter`, then `python3` on PATH. No new
detection: the decision in `docs/HANDOFF.md` stands.

### 3.6 The facade

`src/debug/debugTarget.ts` defines one interface both products implement; `DebugSessionLike` in
`dapTranslator.ts` becomes an alias of it, so the translator, the bridge and the panel see one
shape:

```ts
export interface DebugTarget {
  readonly id: string;
  readonly kind: 'debug' | 'run';         // a DebugSession, or a run-all Session in debug mode
  readonly displayName: string;
  readonly record: boolean;
  readonly launch: LaunchConfig | undefined;   // undefined for a run-all recording run
  readonly debug: DebugState;
  readonly running: boolean;
  readonly output: string;
  readonly modified: boolean;
  readonly thread: { name: string; ident: number } | undefined;

  startDebug(opts?: { stopOnEntry?: boolean }): Promise<void>;
  stopDebug(): void;
  restart(opts: { stopOnEntry?: boolean }): Promise<void>;
  terminate(): void;

  debugContinue(opts?: { noWait?: boolean }): Promise<void>;
  debugStep(kind: StepKind, opts?: { count?: number }): Promise<void>;
  debugPause(opts?: { noWait?: boolean }): Promise<void>;
  debugLocals(opts?: { frameId?: number }): Promise<LocalVar[]>;
  evaluate(expression: string, opts?: { frameId?: number }): Promise<{ text: string; valueBag?: ValueBag } | undefined>;
  exec(source: string, opts?: { frameId?: number }): Promise<ExecResult>;
  complete(text: string): Promise<Completions>;
  expand(valueId: string, queryPath: string[]): Promise<ValueNode | undefined>;

  setDebugBreakpoints(specs: BreakpointSpec[]): Promise<DebugBreakpointEcho[]>;
  setDebugWatches(specs: BreakWatchSpec[]): Promise<void>;
  setDebugExceptions(mode: ExceptionMode): Promise<void>;
  runToLine(path: string, line: number): Promise<void>;

  pathForFileId(fileId: number): string | undefined;
  locate(rid: number): { path: string; line: number } | undefined;
  readSource(fileId: number): string | undefined;

  onPaused(fn: (info: PausedInfo) => void): () => void;
  onResumed(fn: () => void): () => void;
  onFinished(fn: (exitCode: number | null) => void): () => void;
  waitForPause(timeoutMs?: number): Promise<PausedInfo | 'finished'>;
}

export interface ExecResult {
  text: string;
  modified: boolean;
  valueBag?: ValueBag;
  exception?: { type: string; message: string; traceback?: string };
}
```

`wrapSession(session, mgr)` in `dapAdapter.ts` (today's function) gains the new members and reports
`kind: 'run'`, `record: true`, `launch: undefined`. `wrapDebugSession(ds)` reports
`kind: 'debug'`. `exec` works on both: the control channel serves it at any pause, recording or
not.

Both keep round 2's two findings:

- `setExceptionBreakpoints {filters: []}` before `configurationDone` is read as "nothing asked"
  (`DEFAULT_EXCEPTION_MODE`, the `configured` flag). Unchanged.
- a `disconnect` that arrives after its run ended is ignored once a newer run owns the session
  (`reported` / `superseded` in `wrapSession`; `DebugSession` gets the same guard keyed on
  `runId`).

### 3.7 `record: true`

`record: true` is today's behaviour, reached explicitly: the start path creates a run-all `Session`
on the program's document in debug mode, exactly as `debugDocument` does now, and wraps it as a
`DebugTarget` with `kind: 'run'`. The Time Machine attaches at every pause, the recording is
navigable, `why` and the Code Story work, and when the program exits it is a finished run the
session owns.

The launch attributes map onto it through three `??` overrides in `runNow` plus one option on
`SessionManager.start`, which are the only edits to `session.ts` and `sessionManager.ts` (wiring
lines):

| attribute | how |
|---|---|
| `program` | the document; required |
| `args` | `Session.argvOverride?: string[]`, used in `runNow` as `argv: this.argvOverride ?? this.config.argv` |
| `cwd` | `Session.cwdOverride?: string`, used as `cwd: this.cwdOverride ?? (this.workspaceRoot || path.dirname(this.filePath))` |
| `env` | `Session.envOverride?: Record<string,string>`, merged after `this.config.env` |
| `python` | `SessionManager.start(doc, {interpreter})`; with a session already running on the document and a different interpreter the start is refused with `stop the Pyokka session on app.py first: a recording debug session runs in its interpreter` |
| `stopOnEntry`, `breakOnException`, `libraryCode` | already expressible through `DebugController` |
| `module` | **refused**: `record: true` runs the file as a Pyokka run-all session, which has no module launch; use record: false, or a program launch |

All three overrides are `undefined` for every ordinary run-all run, so run-all's request is byte
for byte what it is today.

A `record: true` session keeps its single run-all bridge descriptor (`kind: "run"`) and publishes
no `kind: "debug"` descriptor: one socket per session stays the rule, every run-all verb answers on
it, and today's `debug-live.test.js` keeps passing. `record: false` is the only thing that creates
a `kind: "debug"` descriptor, and it creates no run-all `Session` at all.

**A recording debug session is presented exactly as it is today, and never in the new view.** It
shows in the Time Machine view (`ViewId` `'debugger'`) with its `DebugStatus` header and
`FrontierLocals`, in the run-all status bar item through `debugSegment` (` · Debug: paused at
demo.py:42 (breakpoint)`), and it is driven by the four existing title commands
(`pyokka.debugCurrentFile`, `debugContinue`, `debugPause`, `debugStop`). The new Debugger view
(`ViewId` `'debug'`), the second status bar item (`Debugger: …`), the four new title commands, the
`kind: "debug"` socket, `pyokka.debugSessionActive` and `api.debugSessions()` all belong to
`record: false` sessions only: `DebugSessionManager` holds nothing else, so a recording session
cannot reach any of them. Neither implementer wires the new view to the recording path.

Why this split and not "DebugSession always, feeding a RunState the Time Machine can attach to":
the Time Machine, the navigator anchors, `contextSlice`, the Code Story, `why`, the panel binding
and the decorator are all typed on `Session` and keyed by its document. Moving them behind an
interface is a refactor across every run-all path, which the brief forbids touching. The cost of
the split is the `module` + `record: true` hole above, which is documented and narrow.

### 3.8 The manifest (`scripts/gen-manifest.py`)

`contributes.debuggers[0].configurationAttributes.launch`:

```jsonc
{
  "required": [],
  "properties": {
    "program":          { "type": "string",  "default": "${file}", "description": "The Python file to run. Give this or \"module\"." },
    "module":           { "type": "string",  "description": "A dotted module name to run like `python -m`, instead of \"program\"." },
    "args":             { "type": "array",   "items": { "type": "string" }, "default": [], "description": "Arguments for the program (sys.argv[1:])." },
    "cwd":              { "type": "string",  "default": "${workspaceFolder}", "description": "Working directory the program runs in." },
    "env":              { "type": "object",  "default": {}, "additionalProperties": { "type": "string" }, "description": "Environment variables added to the program's environment." },
    "python":           { "type": "string",  "description": "Interpreter to run with. Default: the Python extension's environment, then pyokka.python.interpreter, then python3." },
    "stopOnEntry":      { "type": "boolean", "default": false, "description": "Pause before the first statement instead of running to the first breakpoint." },
    "breakOnException": { "type": "string",  "enum": ["off", "uncaught", "raised"], "default": "uncaught", "description": "Where the debugger pauses on an exception: never, on one nobody caught, or at every raise in your code." },
    "libraryCode":      { "type": "boolean", "default": false, "description": "Step into third-party packages (never the standard library)." },
    "record":           { "type": "boolean", "default": false, "description": "Also record the run, so the Time Machine, the Code Story and `why` open over it at every pause. Slower; needs \"program\"." }
  }
}
```

`required` becomes `[]` because a launch may name `module` instead of `program`; `parseLaunch`
reports a launch with neither.

**Reload mode.** `uvicorn --reload` and `flask --debug` spawn a worker process and watch the files
from the parent; the debugger runs the parent, so its breakpoints never hit and the panel shows a
program that does nothing. The launch must run without reload (`--args` without `--reload`), or
point at the worker command directly. The README's server paragraph and the skill's table both say
this, and the launch description of `args` in `launch.json` is not the place for it.

`initialConfigurations` (three entries, so `launch.json` shows the shapes):

```jsonc
[
  { "type": "pyokka", "request": "launch", "name": "Pyokka: Debug Current File", "program": "${file}" },
  { "type": "pyokka", "request": "launch", "name": "Pyokka: Debug Current File (Recording)", "program": "${file}", "record": true },
  { "type": "pyokka", "request": "launch", "name": "Pyokka: Debug Module", "module": "app.server", "args": [], "cwd": "${workspaceFolder}" }
]
```

`configurationSnippets`: the existing one, plus a recording snippet and a module snippet with the
same three bodies (`program` as `^"\${file}"`).

Commands (five new; `ADD_COMMANDS` in the generator):

| id | title | icon |
|---|---|---|
| `pyokka.debugCurrentFileRecording` | `Debug Current File (Recording)` | `$(debug-alt-small)` |
| `pyokka.debugStepOver` | `Step Over (Debug)` | `$(debug-step-over)` |
| `pyokka.debugStepInto` | `Step Into (Debug)` | `$(debug-step-into)` |
| `pyokka.debugStepOut` | `Step Out (Debug)` | `$(debug-step-out)` |
| `pyokka.debugRestart` | `Restart (Debug)` | `$(debug-restart)` |

`pyokka.debugContinue`, `pyokka.debugPause` and `pyokka.debugStop` are reused and route to the
active debug target (the debug session if one exists, else the run-all session as today), so the
four existing `view/title` entries keep their `when` clauses and their pinned groups.

Every one of the seven control commands dispatches through the facade and nowhere else:
`activeDebugTarget()` in `debugSessionManager.ts` returns `wrapDebugSession(ds)` when a
`record: false` session exists (the one of section 3.11's rule) and `wrapSession(session)` for the
active run-all session otherwise, and the command body is one call on the `DebugTarget`. So
`pyokka.debugRestart` on a `record: false` session reaches `DebugSession.restart`, which sends a
fresh `run` on the same runner (3.3), and on a recording session it reaches today's
`restartDebugging(session, opts)` in `dapAdapter.ts`. Neither command implementation branches on
`record` itself.

`view/title` additions, all gated on the Debugger view being the one showing so they never crowd
the Time Machine's buttons:

```jsonc
{ "command": "pyokka.debugStepOver", "when": "view =~ /pyokka.output/ && pyokka.panelView == debug && pyokka.debugPaused", "group": "navigation@2" },
{ "command": "pyokka.debugStepInto", "when": "view =~ /pyokka.output/ && pyokka.panelView == debug && pyokka.debugPaused", "group": "navigation@3" },
{ "command": "pyokka.debugStepOut",  "when": "view =~ /pyokka.output/ && pyokka.panelView == debug && pyokka.debugPaused", "group": "navigation@4" },
{ "command": "pyokka.debugRestart",  "when": "view =~ /pyokka.output/ && pyokka.panelView == debug && pyokka.debugActive", "group": "navigation@5" }
```

`commandPalette`: `pyokka.debugCurrentFileRecording` with no `when` (like `debugCurrentFile`); the
four control commands with `when: "pyokka.debugActive"`.

(Since 2026-10-01 the `view/title` entries above, and Continue, Pause and Stop, are removed: the VS
Code debug toolbar steps every Pyokka debug session. The palette entries stay. See section 5.)

Context keys:

- `pyokka.debugActive` and `pyokka.debugPaused` keep their meaning and become the **union** of both
  products, written only through `src/debug/debugContext.ts`:
  `updateDebugContext({runAll: {active, paused}, session: {active, paused}})`. `DebugController`
  and `DebugSessionManager` each report their half. Two writers to one `setContext` key otherwise
  race: a debug session ending would clear the key while a recording run is paused.
- `pyokka.debugSessionActive` (new): a `DebugSession` exists. Used by the panel view's `when`.
- `pyokka.panelView` (new): the panel's active `ViewId`, set from a new webview message
  `{type: 'viewChanged', view}`.

The panel view's `when` must grow, or a debug session with no run-all session has no panel:

```jsonc
"views": { "pyokka-output": [ { "id": "pyokka.output", "name": "Output", "type": "webview",
  "visibility": "visible", "when": "pyokka.hasActiveSession || pyokka.debugSessionActive" } ] }
```

`activationEvents` becomes `["onLanguage:python", "onStartupFinished", "onUri"]`. **The generator
must assign it instead of `setdefault`-ing it** (`pkg['activationEvents'] = base['activationEvents']`),
because `setdefault` leaves the existing `package.json` value in place and the URI handler would
never be registered.

`test/unit/manifest.test.ts` gains assertions for all of the above (section 8).

### 3.9 The URI handler

Registered in `extension.ts` with `vscode.window.registerUriHandler`, implemented in
`src/debug/debugUri.ts`. URL:

```
vscode://ivor.pyokka/debug?program=%2Fabs%2Fproject%2Fapp.py&args=%5B%22--port%22%2C%228000%22%5D&cwd=%2Fabs%2Fproject&env=%7B%22PORT%22%3A%228000%22%7D&python=%2Fabs%2F.venv%2Fbin%2Fpython&stopOnEntry=1&record=1&at=rrf
```

Encoding, pinned:

- every value is `encodeURIComponent`-ed; the handler reads `new URLSearchParams(uri.query)`
- `program`: an absolute, real path. `module`: a dotted name. Exactly one of the two.
- `args`: a JSON array of strings. `env`: a JSON object of strings. A value that does not parse is
  reported to the user and the start is refused.
- `cwd`, `python`: absolute paths
- `stopOnEntry`, `record`, `libraryCode`: `1` when set, absent when not
- `breakOnException`: `off` | `uncaught` | `raised`
- `at`: a bare function name (`rrf`) or `FILE:LINE` (`app.py:42`, the file relative to `cwd` or
  absolute)

`parseDebugUri(query: string): {launch: LaunchConfig; at?: string}` is pure and vitest-covered.

**The handler obeys `pyokka.agentAccess`.** The setting is what makes the window answer an agent at
all, and a debug session serves `exec` in the user's own process, so a URI that arrives while the
setting is off starts nothing:

```
Pyokka: an agent asked to debug app.py, but agent access is off.
Turn on "pyokka.agentAccess" to let the pyokka CLI start and drive a debug session.   [Open Settings]
```

The warning is shown with `showWarningMessage` and an `Open Settings` action, and the handler
returns without creating a session. Starting a paused program that nobody can reach is worse than
a refusal: the user would see a stopped process and no way to continue it.

What the handler does, in order: check the setting; parse; resolve `at`; create the debug session
through `startDebugSession` (so a VS Code debug session opens); return. The `--at` breakpoint is
set **before** the run starts:

- `at` = `FILE:LINE` becomes a `vscode.SourceBreakpoint`, so the human sees it in the gutter. This
  is the whole of `at` in wave 1.
- `at` = `NAME` becomes a runtime breakpoint spec `{function: NAME}` on the debug session's own
  list, and a DAP function breakpoint so the Breakpoints view shows it. **Wave 2.** In wave 1 the
  handler and the CLI both refuse a bare name with
  `--at NAME lands in the next wave; use FILE:LINE`.

The runtime resolves a function spec, not the host: a module imported later gets its breakpoint
when it loads, which an AST scan of the program cannot do for an arbitrary `sys.path` module, and
the runtime already has `info.function_names` (rid to name). Resolution rule, at `file_added`:
match `info.function_names` by exact name, or by the `Class.method` suffix when NAME contains a
dot; take the first match in source order; with `path`, only that file; without `path`, any
instrumented non-library file. When other files also define the name, the echo carries
`error: "also defined in lib/rank.py:12; give FILE:LINE to pick one"` and the run still pauses at
the first.

**The entry-pause rule for an agent start**, the same for the URI path and for the run-socket path
of 3.10 (b): `stopOnEntry` is true unless `--stop-on-entry` was given (then it is true anyway),
`at` was given, or an enabled gutter breakpoint exists in any file. So an agent that starts cold
with nothing set is guaranteed a stop rather than a finished program. F5 and every other human
start keep `stopOnEntry: false` (run to the breakpoint, or to the end), which is what VS Code
users expect. `entryPause` in `debugState.ts` is the one implementation, called with the launch's
`stopOnEntry`, the merged breakpoint list (function specs included) and the empty file list a
cold start has.

### 3.10 How the CLI reaches the window and waits

`pyokka debug FILE` tries three routes, in this order, and stops at the first that applies:

**(a) A `kind: "debug"` descriptor whose `launch` key matches.** Connect and answer as 4.8 says:
the current pause when it is paused, a refusal with the `pause` / `restart` hint when it is
running. No new session.

**(b) Else a `kind: "run"` descriptor for FILE.** Send `debug` over that socket with the launch
attached; the host starts the debug session. No URI, because the window is already answering,
which also sidesteps the focused-window problem of route (c) entirely. This is the route that runs
when the user has the file open in a Pyokka session, which is the common case.

```jsonc
{ "id": 3, "type": "debug",
  "launch": { "program": "/abs/project/app.py", "module": null, "args": ["--port", "8000"],
              "cwd": "/abs/project", "env": { "PORT": "8000" },
              "python": "/abs/project/.venv/bin/python",
              "stopOnEntry": false, "breakOnException": "uncaught",
              "libraryCode": false, "record": false } }
```

`launch` is optional on the run socket's `debug` request and every field inside it is optional:
`{"type": "debug"}` with no `launch` is today's request and keeps today's meaning (a debug run of
the session's file), and `{"type": "debug", "stopOnEntry": true}` keeps working. With `launch`
present the host runs `parseLaunch` over it, filling `program` from the session's file when the
launch names neither `program` nor `module`, and then:

- `launch.record` false or absent: a `record: false` `DebugSession` is created, exactly as the URI
  route creates one. The reply is its first stop.
- `launch.record: true`: today's recording run starts on that run-all session, with the three
  overrides of 3.7. The reply is its first stop. This is what makes 4.8's third row cover both
  kinds of start.

The entry-pause rule is the one 3.9 pins for an agent start, identical for (b) and (c).

**(c) Else the URI.**

1. build the URI above
2. run `<code> --open-url <uri>`, where `<code>` is `$PYOKKA_CODE` if set, else `code` on PATH.
   When neither exists:
   `error: cannot find the \`code\` command` /
   `install it from VS Code's Command Palette ("Shell Command: Install code command in PATH"), or set PYOKKA_CODE to the binary`
3. poll `~/.pyokka/sessions/*.json` (or `$PYOKKA_SESSIONS_DIR`) every 100 ms for up to 20 s for a
   descriptor with `kind == "debug"` whose `launch.program` (realpath) or `launch.module` matches
   and whose `started` is at or after the request time minus one second of clock slack
4. connect with the token and print the first stop, exactly as `debug --live` prints one today

On timeout:

```
error: the VS Code window did not start a debug session for app.py
check `pyokka.agentAccess` first: with it off the window refuses the request and shows a warning instead of starting anything. Then check that the folder is open in VS Code with the Pyokka extension active: the URI goes to the focused window, and a window that is not running Pyokka cannot answer. The Pyokka output channel logs every URI it received.
```

`pyokka.agentAccess` is named first because it is the one cause the user can see nothing of from
the terminal: the window shows a warning toast and the descriptor never appears. Routes (a) and
(b) need no such check, since a socket that answers at all only exists while the setting is on.

With several windows, every window with the extension active registers the same handler and **VS
Code picks the window** (the focused one, or a new one when none is open). The CLI passes `cwd` as
the launch's working directory, but it cannot choose the window by it. The skill and the README say
so; the fix for a mismatch is to focus the right window and retry, or to open the file so route
(b) applies.

Only user-writable paths are involved: `~/.pyokka/sessions` and the `code` binary the user already
has. No admin rights, no privileged step.

### 3.11 The status bar

A second status bar item, `pyokka.debugStatus`, created in `src/views/debugStatusBar.ts` at
alignment Left, priority 49 (just right of the session item at 50), shown only while a debug
session exists:

| state | text |
|---|---|
| paused | `Debugger: paused at app.py:42 (breakpoint)` |
| paused on an exception | `Debugger: paused at app.py:6 (uncaught ValueError: too big: 3)` |
| running | `Debugger: running` |
| no debug session | the item is hidden |

The text is built by a pure `debuggerStatusText(state, displayName, running)` added to
`src/views/statusText.ts`, next to `debugSegment`, which keeps serving the run-all item for a
`record: true` session (` · Debug: paused at …`). Tooltip: the launch line
(`python -m app.server --port 8000  ·  /abs/project`) plus `modified: values were changed from the
console` when `modified`. Command: show the Debugger view.

Which session, when several exist: the only one; else the one whose `program` is the active
editor's file; else the most recently started.

`pyokka.runTimeout` is not applied to debug sessions and the Settings view says so next to it.

---

## 4. The bridge contract for debug sessions

### 4.1 Descriptors

Run-all, additive (`src/agent/bridge.ts`, one line):

```jsonc
{ "socket": "/Users/x/.pyokka/sessions/4711-1.sock", "token": "…", "pid": 4711,
  "kind": "run",
  "workspace": "/abs/project", "file": "/abs/project/demo.py", "displayName": "demo.py",
  "runtimeVersion": "0.1.0", "started": "2026-09-15T09:10:00.000Z" }
```

Debug (`src/agent/bridgeDebugSocket.ts`):

```jsonc
{ "socket": "/Users/x/.pyokka/sessions/4711-3.sock", "token": "…", "pid": 4711,
  "kind": "debug",
  "workspace": "/abs/project", "file": "/abs/project/app.py", "displayName": "app.py",
  "launch": { "program": "/abs/project/app.py", "module": null, "args": ["--port", "8000"],
              "cwd": "/abs/project", "python": "/abs/project/.venv/bin/python", "record": false },
  "runtimeVersion": "0.1.0", "started": "2026-09-15T09:12:03.114Z" }
```

For a module launch, `displayName` is `-m app.server`, `launch.program` is `null`, and `file` is
the launch's `cwd` until the run reports its first instrumented file, at which point the host
**rewrites the descriptor once** with the real `file`. The CLI's `read_descriptor` requires a
non-empty `file`, and breakpoint path resolution and `context` both want a real main file; a plain
rewrite of a 300-byte JSON file is cheaper than a second descriptor shape.

**The debug socket obeys `pyokka.agentAccess`, exactly like the run-all socket.** It is the same
setting, the same default (off), the same scope lookup
(`setting('agentAccess', false, Uri.file(program ?? cwd))`), and the same sweep of dead
descriptors. A socket that serves `exec` in the user's process is opt-in, and the debugger is not
a reason to loosen that.

- With the setting off, a `record: false` debug session runs normally and publishes **no**
  descriptor and no socket: F5, the toolbar, the panel and the Debug Console all work, and no agent
  can reach it.
- Turning the setting on while a debug session is running opens its socket then, through the same
  `onDidChangeConfiguration` path `AgentBridge` already uses for run-all sessions; turning it off
  closes the socket and removes the descriptor while the session keeps running.
- The URI handler of 3.9 refuses outright when the setting is off, rather than starting a session
  nobody can reach.
- `pyokka debug --live` on a run socket (route (b) of 3.10) needs no check of its own: the socket
  it arrived on only exists while the setting is on.

### 4.2 Which requests a debug socket serves

Served: `state`, `context`, `step` (`into` / `over` / `out` only), `continue`, `pause`, `stop`,
`restart`, `debug`, `break`, `watches`, `locals`, `eval`, `expand`, `exec`, `select`, `watch`,
`unwatch`.

Refused, with a `BridgeError` that names recording:

| requests | error | hint |
|---|---|---|
| `var`, `why`, `walkthrough`, `graph`, `exceptions`, `http`, `values`, `story`, `find`, `steps` | `<verb> needs a recording` | ``start the debug session with recording (`pyokka debug FILE --record`, or "Pyokka: Debug Current File (Recording)"), or read a run-all session of the file`` |
| `step` with `back`, `backOver`, `backOut` or `to` | `this debug session records nothing, so there is nothing behind the pause to replay` | ``into, over and out execute; `--record` gives you the backward moves`` |

On a `record: true` session every one of them answers, because that session keeps its run-all
socket and is a run-all session with a pause. Nothing changes there.

### 4.3 The stop slice without a recording

`stopSlice` in `src/debug/debugSessionState.ts` builds it, pure, from the pause, the file table and
a source reader. Next to the run-all context slice:

```jsonc
{ "step": 1403,
  "location": { "file": "/abs/project/app.py", "line": 42, "col": 4, "function": "do_GET", "fileId": 2 },
  "stale": false,                                  // with "staleReason": "unsaved" | "disk" when true
  "stack": [ { "file": "/abs/project/app.py", "line": 42, "function": "do_GET", "frameId": 0 },
             { "elided": 3, "where": "library", "in": ["http/server.py", "socketserver.py"] },
             { "file": "/abs/project/app.py", "line": 31, "function": "<module>", "frameId": 2 } ],
  "block": { "file": "/abs/project/app.py", "function": "do_GET",
             "lines": [ { "line": 40, "text": "    def do_GET(self):" },
                        { "line": 41, "text": "        payload = parse(self.path)" },
                        { "line": 42, "text": "        total = 0", "current": true } ] },
  "values": [],
  "paused": { "step": 1403, "rid": 88, "fileId": 2, "file": "/abs/project/app.py", "line": 42,
              "scopeId": 7, "depth": 2, "reason": "breakpoint",
              "breakpoint": { "file": "app.py", "line": 42, "rid": 88, "fileId": 2, "resolvedLine": 42 },
              "thread": { "name": "Thread-3", "ident": 6108209152 },
              "stack": [ … ] },
  "locals": [ { "name": "self", "text": "<Handler …>" }, { "name": "payload", "text": "{'q': 'a'}" } ],
  "output": { "text": "served /\n", "since": "stop", "lines": 1, "earlier": 412, "truncated": false, "seq": 9412 },
  "modified": false,
  "thread": { "name": "Thread-3", "ident": 6108209152 } }
```

Field by field, against the run-all slice:

| field | with `record: false` |
|---|---|
| `step` | the statement counter |
| `count` | **absent** (there is no trace length) |
| `location` | from the pause's `fileId`/`line` and the innermost frame's `name` |
| `stale` | true when the document for `launch.program` has unsaved changes, or its on-disk mtime is later than the debug session's `started`. Edits are not applied until the next start. |
| `staleReason` | why, when it is: `unsaved` for edits in the editor, `disk` for a change under the run. Absent when `stale` is false. The two are separate warnings, not one. `readSource` serves a debug stop from the open document, so `unsaved` means the `block` a reader is shown is the editor's text, which has never run and whose line numbers can disagree with the ones in `stack`; `disk` means the block is the new text read against the old line numbers. The CLI prints one line per reason rather than a single "changed since the run", which was read as noise on a run that had just started and taught a reader to skip it (`handoffs/2026-09-15-debugger-streaming-output.md`, item 6). |
| `stack` | the frame chain with real lines. Frames outside instrumented files have no source to show, so a run of them is folded into one `{elided, where: "library", in}` entry where it stands, `in` naming up to three of their files (from the frame's `path`, `docs/PROTOCOL.md`). They used to be dropped outright, which turned `do_GET ← <module>` into a chain the program never had: an agent reading it saw a call that does not exist and no sign that seven frames were missing. Every frame is still in `paused.stack` with `fileId: 0`. |
| `block` | built from the source of the enclosing function: its `def` line to its last line, read from the open document or from disk. Over the 60-line budget it is cut on the code's own structure rather than on the count: the signature stays (the parameters are half of what the body means), and the rest of the budget goes to the *suite the pause is in* — the `for` or `if` header above the paused line and the lines under it — widened into the lines around it when there is room to spare. `totalLines` says how long the function is in full, and the pieces are far enough apart to see in the line numbers, so the CLI prints `… 299 lines` at each jump. A window of 60 lines centred on the pause could open on the tail of one statement and close on the head of another, and said only `capped`. No `step` on any line, no `firstStep`, `current: true` on the paused line. |
| `values` | `[]` |
| `coverage` | absent |
| `moves` | absent |
| `errors` | absent until the uncaught `error` event arrives, then the one entry it carries |
| `paused` | as today, plus `thread`, plus `modified` when set |
| `locals` | the paused frame's variables, `valueBag` only with `valueBag: true` |
| `output` | what the program printed **since the previous stop**, read from the session's `OutputLog` (already redacted line by line), plus the line still being written. `since: "stop"` for that delta, `"start"` for the whole window — the first stop, `scope: true`, or a delta whose start the log has already cut. `lines` is what `text` holds, `earlier` how many lines of the window are behind it, `seq` where `text` ends. The tail of the whole buffer at every stop meant an agent stepping ten times re-read the same 4 KB ten times and could never tell which line its own step produced; `state` still answers the window (4.5). The cursor lives on the session, not the connection (the CLI opens one per command), and a re-read of the stop it already answered repeats the same delta instead of consuming a new one. `truncated` when the head of `text` itself was cut, which happens to one move that printed more than 4000 characters, and the cut lands on a line boundary. |
| `modified` | the session's flag |
| `thread` | the paused thread |

The end of the program:

```jsonc
{ "finished": { "exitCode": 0, "durationMs": 41230.5, "stepCount": 1403 } }
```

`stepCount` is kept and is the statement counter, so `finished: exit 0, 1403 steps` reads the same
in both products.

### 4.4 The new request fields

`noWait` on `continue` and `pause` is **wave 1**: the server acceptance case needs an agent to
resume a handler without waiting for the next request, and it is one field on each. `until`, `to`,
`count` and `at` are **wave 2**.

```jsonc
// wave 1: resume without waiting for the next stop
{ "id": 7, "type": "continue", "noWait": true }
{ "id": 7, "ok": true, "resumed": true }
```

```jsonc
// wave 1: pause without waiting (a server blocked in accept() may never reach a statement)
{ "id": 15, "type": "pause", "noWait": true }
{ "id": 15, "ok": true, "requested": true, "paused": false }
```

`pause` without `noWait` keeps waiting for the stop, which is what an agent usually wants.
`noWait` exists because a server can sit in `accept()` for minutes and a ten-minute hang is worse
than a second call.

```jsonc
// wave 2: run until an expression turns true: a one-shot break-when watch
{ "id": 8, "type": "continue", "until": "rank == 3" }
```

The watch's id is `until`, which cannot clash with the generated `w<digits>` ids. It is installed
before the resume and removed after the stop, and also when the run ends instead of stopping (the
removal is in a `finally` around the wait and on the `finished` path). The stop reply reports
`paused.reason: "watch"` with `watch: {id: "until", exp: "rank == 3", text: "True"}`.

```jsonc
// wave 2: run to a line, through the existing transient run-to-line breakpoint
{ "id": 9, "type": "continue", "to": { "file": "app.py", "line": 82 } }
```

```jsonc
// wave 2: N stops in a row
{ "id": 10, "type": "step", "kind": "over", "count": 3 }
```

`count` is clamped to 1..1000. The reply is the last stop. Two early exits:

```jsonc
// something else stopped the program on the way: that stop wins
{ "id": 10, "ok": true, "step": 1408, "…": "…", "stoppedEarly": { "after": 2, "reason": "breakpoint" } }

// the program ended mid-count
{ "id": 10, "ok": true, "finished": { "exitCode": 0, "durationMs": 41230.5, "stepCount": 1403 }, "stepped": 2 }
```

```jsonc
// wave 2: a breakpoint at a function's entry
{ "id": 11, "type": "break", "at": "rrf" }
{ "id": 11, "ok": true,
  "breakpoints": [ { "function": "rrf", "file": "demo.py", "line": 41, "resolvedLine": 41, "rid": 88, "fileId": 1 } ],
  "exceptions": "uncaught" }
```

`--at FILE:LINE` is an ordinary breakpoint and goes through today's `break` path in wave 1;
`break --at NAME` and `--at NAME` are wave 2, and wave 1 refuses a bare name with
`--at NAME lands in the next wave; use FILE:LINE`.

```jsonc
// wave 2: run a statement in the paused frame
{ "id": 12, "type": "exec", "source": "x = 3", "frameId": 0 }
{ "id": 12, "ok": true, "text": "", "modified": true }

{ "id": 13, "type": "exec", "source": "items.pop()" }
{ "id": 13, "ok": true, "text": "'last'", "modified": true }

{ "id": 14, "type": "exec", "source": "1/0" }
{ "id": 14, "ok": true, "text": "", "modified": true, "exception": { "type": "ZeroDivisionError", "message": "division by zero" } }
```

`locals`, `eval` and `exec` all take `frameId` (default 0); `frameId` on `locals` and `eval` is
wave 1 (the Debugger view's frame clicks need it), `exec` is wave 2.

### 4.5 `state` on a debug socket

```jsonc
{ "id": 1, "ok": true,
  "kind": "debug",
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
  "others": [ { "kind": "run", "displayName": "app.py", "descriptor": "/Users/x/.pyokka/sessions/4711-1.sock" } ] }
```

`frontier` is `null` (nothing to navigate), `nav` is absent, `finished` is absent (a finished debug
session no longer exists). `others` lists the descriptors of other sessions on the same file so the
CLI can print both without a second directory scan.

### 4.6 The watch stream

On a debug socket: `paused` (as today, plus `thread` and `modified`), `resumed`, `output`, then
`finished`, and then the socket closes.

```jsonc
{ "event": "output", "stream": "stdout", "text": "GET /health 200\n" }
{ "event": "finished", "exitCode": 0 }
```

`output` is new and is throttled to at most one event every 100 ms with the text accumulated in
between: a debug session has no other way to follow a server's log as it runs. There are no `step`
events (no Time Machine) and no `exited` event (`finished` says it).

### 4.7 The CLI's session selection

This rule lives in Python and only in Python. `pick_session` in
`python/pyokka_runtime/agent/live.py` is the one implementation, and the host never picks a
descriptor: it writes them and answers on the socket it is asked on. There is no TypeScript twin
and no vitest suite for it; its tests are `python/tests/test_agent_debug.py` (8.2).

`pick_session` gains a kind preference, because a file may now have two descriptors:

| verbs | prefer |
|---|---|
| `debug`, `continue`, `pause`, `stop`, `restart`, `break`, `watches`, `locals`, `exec`, `step --into/--over/--out` | `kind: "debug"` |
| `why`, `var`, `story`, `walkthrough`, `graph`, `exceptions`, `http`, `values`, `find`, `steps` | `kind: "run"` |
| `state`, `context`, `eval`, `expand`, `select`, `watch`, `shell` | `kind: "debug"` when one exists (it is the live thing), else `run` |

When the preferred kind has exactly one match it is used, with no prompt. When it has none, the
other kind is used. When it has several, today's "N live sessions; say which" error lists them with
their descriptor paths. `--session NAME` narrows by file or display name first and then applies the
same preference; `--session <descriptor path>` always selects exactly that socket, whatever the
verb.

`state --live` prints both, debug first, and marks the chosen one:

```
debug  app.py   running, paused at app.py:42 (breakpoint)   [this]
run    app.py   finished, 1240 steps

app.py  paused at app.py:42 (breakpoint)
  launch: /abs/project/.venv/bin/python app.py --port 8000   (cwd /abs/project)
  record: off
  exceptions: uncaught
  locals: …
```

### 4.8 `debug --live` on each kind of socket

| socket | state | what `debug` does |
|---|---|---|
| debug | paused | answers the current pause (the stop reply). An agent that says "start the debugger" twice must not lose the pause it is reading. |
| debug | running | refused: `the debug session of app.py is running` / ``` `pause --live` stops it at its next statement; `restart --live` starts it again from the top ``` . Killing a running server on a repeated `debug` is the worse failure. |
| run | any | starts a session of that file through the host, with no URI, because the window is already answering (route (b) of 3.10). `launch` absent or `launch.record` false gives a **`record: false` debug session**; `launch.record: true` gives today's **recording run** on that run-all session. The reply is the first stop, by the agent entry-pause rule of 3.9. |

The third row is how `test/e2e/debug-live.test.js` keeps working with the smallest change. The
spec's `session` variable is the **run-all** session and is no longer where the pause lives: after
`pyokka debug --live` the pause belongs to a separate `DebugSession`. Its cases change as follows:

- every read of `api.debug(session)`, `session.nav`, `session.trace` or `session.state.runId` for
  the pause becomes `api.debugSessions()[0]` (and `.debug`, `.output`, `.launch` on it). The
  run-all `session` is still asserted, but now for what it must **not** have: no debug run, no
  `nav`, its own `state.runId` unchanged.
- cases 1, 3, 4, 5, 6, 7, 10, 11, 12 keep their assertions about stops, locals, output, watches and
  the shell, because the stop reply shape is unchanged for the fields they read. What changes is
  that they ask the **debug** descriptor for those verbs, which `pick_session`'s preference does
  for them.
- case 1 loses its two run-all assertions (`session.nav.active`, `trace.count === 1`) and gains
  their opposites: no Time Machine, and `api.manager.get(doc)` has no debug run of its own.
- case 4's second half (`step --live --back` replays, `--to` past the frontier) moves to the
  refusal wording of 4.2.
- case 5's `why --live` moves to `debug-recording.test.js`: `why` needs a recording.
- case 10 (`stop --live`) keeps `{stopped: true, runId, finished}` but the follow-up `state --live`
  now finds no debug descriptor, so it asserts the "no live session" error instead of
  `debug: null`.
- case 12 (the shell) is unchanged in shape: its `debug --stop-on-entry` line creates a debug
  session over the same connection, its `locals` line reads that session's frame, and its `stop`
  line ends that session. The latency assertions stand.

### 4.9 The CLI surface

Wave 1:

```
pyokka debug [FILE | --module M] [--args ...] [--cwd DIR] [--env K=V] [--python PATH]
             [--at FILE:LINE] [--stop-on-entry] [--session NAME|PATH]
pyokka continue --live [--no-wait]
pyokka pause --live [--no-wait]
pyokka step --live --into|--over|--out
pyokka locals --live [--frame N]
pyokka eval --live EXPR [--frame N]
pyokka break --live [FILE:LINE ...] [--when EXPR] [--remove FILE:LINE] [--list] [--on-exception MODE]
pyokka restart --live [--stop-on-entry] | pyokka stop --live | pyokka watch --live | pyokka shell --live
pyokka state --live | pyokka context --live | pyokka watches --live …
```

Wave 2 adds:

```
pyokka debug … [--at NAME] [--record]
pyokka continue --live [--until EXPR | --to FILE:LINE]
pyokka step --live --over [--count N]
pyokka break --live --at NAME
pyokka exec --live 'x = 3' [--frame N]
```

`debug` gains a positional `program` (`nargs="?"`), so it never collides with the `RUN` positional
the other commands use. **A positional FILE or `--module` implies `--live`**, so `pyokka debug
app.py` needs no flag; `--live` stays accepted and `pyokka debug --live` with no FILE keeps today's
meaning (a debug session of the open session's file). `--args` is `nargs=argparse.REMAINDER`:
everything after it goes to the program (`pyokka debug app.py --args --port 8000`). `--env` is
repeatable. In wave 1 `--at` accepts only `FILE:LINE` and refuses a bare name with
`--at NAME lands in the next wave; use FILE:LINE`; `--record` and `exec` are not offered at all
until wave 2 (an unknown flag is argparse's own error).

Two new CLI modules, because `python/pyokka_runtime/agent/live.py` is 451 lines and `render.py` is
472 and both are near the 500-line rule:

| module | holds |
|---|---|
| `python/pyokka_runtime/agent/debug_start.py` | the URI builder, the `code` / `PYOKKA_CODE` lookup, the descriptor poll and its timeout message, and the three-route order of 3.10 |
| `python/pyokka_runtime/agent/render_debug.py` | the stop and `state` text forms without a recording (the `paused at` line, `locals:`, `output (last N lines):`, the two-kind listing, `resumed`, `pause requested`, the `exec` forms) |

`live.py` keeps `LiveRun`, `list_sessions`, `pick_session` and the request methods; `render.py`
keeps its dispatch table and delegates the debug entries to `render_debug`.

Text forms, all existing shapes reused:

| result | text |
|---|---|
| a stop | `paused at app.py:42 (breakpoint)` over the slice, then `locals:` and the output header of 4.3: `output (2 new lines; 412 earlier):`, `output (last 20 lines):` for the window, or `output: nothing new since the last stop` when the move printed nothing |
| a folded chain | `stack: do_GET app.py:42 ← … 3 library frames in http/server.py … ← <module> app.py:9`; over eight entries it keeps the innermost six and the outermost one, which is where the program was started |
| a cut block | `block big  app.py (60 of 400 lines; --scope for all)`, with `… 299 lines` on the line where each piece of it ends |
| `continue --no-wait` | `resumed` |
| `pause --no-wait` | `pause requested: the program pauses at its next statement` |
| `exec` with a value | the repr, one line |
| `exec` with no value | `ok` |
| `exec` that raised | `ZeroDivisionError: division by zero` on stderr, exit 0, `still paused at app.py:42` |
| `exec` after a write | the stop lines gain ` (values modified from the console)` |
| the end | `finished: exit 0, 1403 steps` |

### 4.10 The skill

A new sibling skill, `skills/pyokka-debug/SKILL.md`, not a section of `skills/pyokka-agent`: the
existing skill's description and every example are about reading a finished recording, and a live
debugger is a different job with a different trigger. `skills/pyokka-agent/SKILL.md` gains two
lines pointing at it, and the new skill points back for `why`, `story` and `var`.

The phrase-to-verb table it carries:

| the human says | the agent runs |
|---|---|
| "start the debugger at `rrf`" | `pyokka debug demo.py --at rrf` |
| "start the server under the debugger" | `pyokka debug --module app.server --args --port 8000` (no `--reload`: a reloading server runs your code in a worker process the debugger does not see) |
| "run to line 82" | `pyokka continue --live --to demo.py:82` |
| "step over until `rank == 3`" | `pyokka continue --live --until 'rank == 3'` |
| "step over three times" | `pyokka step --live --over --count 3` |
| "step into that" / "step out" | `pyokka step --live --into` / `--out` |
| "what is in scope" | the stop's `locals:`, else `pyokka locals --live` |
| "what is `payload["q"]`" | `pyokka eval --live 'payload["q"]'` |
| "set `rank` to 3 and carry on" | `pyokka exec --live 'rank = 3'` then `pyokka continue --live` |
| "break when `payload` is None" | `pyokka watches --live --add 'payload is None' --break-when true` |
| "stop on every exception" | `pyokka break --live --on-exception raised` |
| "let it run, do not wait" | `pyokka continue --live --no-wait` |
| "pause it" | `pyokka pause --live` |
| "why is `contribution` None" | needs recording: `pyokka why --live <step> contribution` on a `--record` session |
| "start over" / "stop" | `pyokka restart --live` / `pyokka stop --live` |

The loop it teaches: open `pyokka shell --live` once (0.5 ms per command against 64 ms one-shot),
start at the function, one command per sentence the human says, read `locals` and `output` from the
stop rather than asking again, and say plainly that `why` needs `--record`. Two facts it states
before the table: the window answers only with `pyokka.agentAccess` on, and a server started with
`--reload` (uvicorn) or `--debug` (flask) runs the code in a worker the debugger never sees, so the
launch drops the flag or points at the worker command.

---

### 4.11 What a step costs

Measured with `test/e2e/measure-step-latency.test.js`, which is not in the CI list: run it with
`./node_modules/.bin/vscode-test --run test/e2e/measure-step-latency.test.js` and read the table.
It steps a 200 000-iteration loop whose body is four small assignments, and runs each case twice:
once with nothing else in the frame, once with a 2000-row list and a dict built from it. Medians,
darwin/arm64.

| | light frame | heavy frame |
|---|---|---|
| `pyokka step --live --over --count 50` | 195 ms (3.9 ms/step) | 15.0 s (300 ms/step) |
| `pyokka step --live --over --count 200` | 353 ms (1.8 ms/step) | 100.0 s (500 ms/step) |
| marginal per step, from the 50→200 slope | **1.1 ms** | **567 ms** |
| panel / F10 step over | **2 ms** | **296 ms** |
| `debugLocals()` on its own | 1 ms | **263 ms** |

Three things follow.

**A step costs what is in scope, not what it ran.** The light and heavy loops execute identical
statements; the only difference is what else the frame holds, and that is a 250× difference per
step. This was the open question after the first round of measurements, where a single suggestive
sample was taken from a session that died mid-run.

**Almost all of it is reading the locals, not stepping.** On the heavy frame a stop costs 296 ms
and `debugLocals()` alone costs 263 ms of it, so the stepping machinery is ~32 ms and the rest is
serialising the frame. The Debugger view asks for locals on every `paused` (`debuggerView.ts`,
`bind`), so every stop pays it whether or not anyone is reading the LOCALS section. Bounding or
deferring that read is where the time is, if it is ever worth taking.

**The panel path does not pay the CLI's fixed cost, and `--count` stops helping when the frame is
big.** F10 starts no process: 2 ms against the CLI's ~140 ms of interpreter start and socket setup
in this harness (~57 ms measured from a warm terminal). That is what `--count` exists to amortise,
and on a light frame it works — 3.9 ms/step at 50, 1.8 ms at 200. On a heavy frame it inverts:
300 ms/step at 50, 500 ms at 200, while the panel holds flat at 296 ms. Stepping a session does
not make it slower — the panel's first and second halves of the same run agree to within 4 ms —
so the rise is in the batch path itself and is not yet explained.

---

## 5. The Debugger view

**Changed 2026-10-01 (one control surface).** The side bar is this moment, the bottom panel is the
whole run. The Debugger view no longer draws the call stack, the paused frame's locals or the
seven control buttons: VS Code's Call Stack, Variables and debug toolbar show them over the same
debug session, and a frame clicked there scopes Variables and the Debug Console through DAP
`frameId` (5.5). The view keeps the status row, watches, breakpoints and output. The Time
Machine's `FrontierLocals` and call-stack pane are gone the same way; the Time Machine is a
`pyokka` debug session in replay (docs/PROTOCOL.md, "Replay debug session"). The `view/title`
buttons of 3.8 are gone except Debug and Debug (Recording); 5.4's `debug.selectFrame` message
stays in the protocol with no sender in the view.

### 5.1 The view

`ViewId` gains `'debug'`: `'output' | 'debugger' | 'settings' | 'diagram' | 'diff' | 'variable' |
'run-diagram' | 'http' | 'debug'`. The existing `'debugger'` is the Time Machine and is untouched,
including its `DebugStatus` and `FrontierLocals` for a `record: true` session. The two names are
confusing and stay: renaming `'debugger'` would touch every panel path for no user-visible gain.

Rail button: a `debug-alt` icon between the Time Machine's `history` and Code Story's `book`, shown
only while `debugSessionActive`. Clicking it shows the view. When the session ends the panel returns
to the view that was active when the Debugger view was first shown, `'output'` when there was none.

### 5.2 The state message

```jsonc
{ "type": "debug.session",
  "state": {
    "id": "debug-2",
    "displayName": "app.py",
    "launch": { "program": "app.py", "module": null, "args": ["--port", "8000"],
                "cwd": "project", "python": ".venv/bin/python", "record": false },
    "running": true, "paused": true, "record": false, "modified": false,
    "reason": "breakpoint",
    "reasonText": "breakpoint",
    "location": "app.py:42",
    "thread": { "name": "Thread-3", "ident": 6108209152 },
    "stack": [ { "frameId": 0, "name": "do_GET", "file": "app.py", "line": 42 },
               { "frameId": 1, "name": "handle_one_request", "file": "http/server.py", "line": 427, "library": true },
               { "frameId": 2, "name": "<module>", "file": "app.py", "line": 31 } ],
    "selectedFrame": 0,
    "locals": [ { "name": "payload", "text": "{'q': 'a'}", "valueBag": { "…": "…" } } ],
    "watches": [ { "id": "w1", "exp": "rank", "kind": "display", "text": "2" },
                 { "id": "w2", "exp": "rank == 3", "kind": "breakWhen", "breakWhen": "true" } ],
    "output": [ { "stream": "stdout", "text": "listening on 8000\nGET /health 200\n", "t": 120 } ],
    "outputOpen": null,
    "outputSeq": 34,
    "outputDropped": 0,
    "elapsed": 4200,
    "lastOutputAt": 120,
    "breakpoints": [ { "file": "app.py", "line": 42, "resolvedLine": 42 },
                     { "file": "app.py", "line": 60, "condition": "i == 3", "error": null },
                     { "function": "rrf", "file": "demo.py", "line": 41 } ],
    "exceptions": "uncaught",
    "exception": null
  } }
```

`{"type": "debug.session", "state": null}` when the last debug session ends. Every `file` is a
display path. `locals` rows are the existing value-table rows, so `webview/valueTable.ts` and
`ValueTable.tsx` render them with no change, table rendering and alias lines included. `output` is
the committed tail the host keeps (64 KB) as tagged chunks and `outputOpen` the line the program is
still writing; `t` on each is ms since the run started, and so are `elapsed` and `lastOutputAt`.
This message is the initial sync and the recovery path only — afterwards output arrives as
`debug.output.append` deltas, throttled to 100 ms (5.6).

### 5.3 The webview's messages

```ts
| { type: 'viewChanged'; view: ViewId }
| { type: 'debug.selectFrame'; index: number }
| { type: 'debug.watch.add'; exp: string; breakWhen?: 'change' | 'true' }
| { type: 'debug.watch.edit'; id: string; exp: string }
| { type: 'debug.watch.remove'; id: string }
| { type: 'debug.breakpoint.remove'; file: string; line?: number; function?: string }
| { type: 'debug.exceptions'; mode: 'off' | 'uncaught' | 'raised' }
| { type: 'debug.control'; action: 'continue' | 'pause' | 'stepOver' | 'stepInto' | 'stepOut' | 'restart' | 'stop' }
| { type: 'debug.output.resync' }
```

`debug.output.resync` is sent when an output delta does not continue where the view left off, and
the host answers with a full `debug.session` (5.6).

`debug.control` exists next to the title-bar commands so the view works when the title bar
overflows. There is no exec box in the panel: the Debug Console is where code runs, and the view's
output pane is read-only.

### 5.4 Scoping locals and eval to the selected frame

"Clicking a frame moves the editor and scopes locals and eval to it" is, on the wire, a `frameId`:

1. the webview sends `debug.selectFrame {index}`
2. the host reveals `stack[index]`'s file and line in the editor
3. the host re-reads `debugLocals({frameId: index})` and resends `debug.session` with the new
   `locals` and `selectedFrame`
4. every later `evaluate` and `exec` from the view or the console for that frame carries
   `frameId: index`

The runtime holds the pause's frame chain (2.8), so `frameId` is an index into `paused.stack` and
needs no extra handshake.

### 5.5 DAP

| request | mapping |
|---|---|
| `stackTrace` | `paused.stack`; `line` and `source` from the frame entry's own `line` / `fileId` when present, else today's `locate(frame.rid)` fallback. `frame.id` is `frameId + 1` (DAP ids are 1-based here, as today). |
| `scopes(frameId)` | one `Locals` scope per frame, its `variablesReference` bound to `{kind: 'locals', frameId}`; no longer `expensive: true` for caller frames, because `debugLocals({frameId})` answers for any frame |
| `variables` | `debugLocals({frameId})`, then the value-node walk as today |
| `evaluate` | `context: 'repl'` runs `exec` (statements allowed); `hover`, `watch` and everything else run `evaluate` (pure). Both carry the request's `frameId`. |
| `setVariable` | `exec` with `<name> = <value>` for a Locals scope, `<evaluateName> = <value>` for a nested node, then `evaluate` of the same path for the reply's `value` / `type`. Sets `modified`. |
| `setFunctionBreakpoints` | the session's `{function: name}` specs, so `--at NAME` shows in the Breakpoints view and a human can add one there |
| `exceptionInfo`, `setExceptionBreakpoints`, `completions`, `restart`, `terminate`, `disconnect` | unchanged |

`CAPABILITIES` gains `supportsSetVariable: true` and `supportsFunctionBreakpoints: true`.

### 5.6 Output while the program runs

The view is built for the moment after a pause. An agent script is almost never at one: it awaits a
model, prints a turn, awaits again, and a run of `context_personalization/run.py` takes forty-odd
seconds of which fourteen print nothing at all. In that state `stack` is `[]`, `LOCALS` is gated on
`paused`, `refreshDisplayed` returns early so every watch reads *no value at this stop*, and the one
section with anything in it is last, capped at 320 px, and never scrolled. Four of five sections are
dead for the length of the run.

**The pane follows its tail.** The `atBottom` rule the run-all list has always had
(`Entries.tsx`) — scroll to the bottom when something arrives, park when the reader scrolls up, and
offer a way back. Nothing else changes about the pane when the program is stopped.

**Sections are ordered by what is live.** Running: the activity row, then `OUTPUT` with the free
space, then watches and breakpoints. Stopped: stack, locals, watches, breakpoints, output, as
before. A watch with no value says *at the next pause* while the program runs, which is what is
actually true — the expression is fine, there has not been a stop.

**The activity row** answers what a spinner cannot: whether a program that has printed nothing for
twenty seconds is working or wedged. Elapsed, bytes printed, how long ago the last byte came, and a
trace of characters per half second over the last twenty. Every figure is measured from what the
host already has. Sampling the top frame while running would be the most useful line in it and is
deliberately not here: it would need the hook (2.3) to report a frame without stopping the program,
which is a separate question. Evaluating watches mid-run is also refused — it runs program code at
an arbitrary point, which is what run-all is for.

**`OutputLog`** (`src/session/outputBuffer.ts`) keeps the same 64 KB window as tagged chunks rather
than one string, so the pane can tell stdout from stderr — the runtime always sent `stream` and
`appendOutput` dropped it — and stamp each row with when it arrived. `DebugSession` keeps both: the
string is still what stop replies, the agent bridge and the CLI read.

**Deltas.** `state()` put all 64 KB in every push and `scheduleOutput` pushed every 100 ms, so the
cost was O(buffer) per tick with a `redact()` pass over text the view already had. `debug.output.append`
carries only what the view has not seen. `from` is the offset the chunks start at; when it is not the
offset the view holds, the view sends `debug.output.resync` and the host pushes a full
`debug.session`. The full state stays the initial sync and the recovery path, so first paint is
unchanged.

**Redaction is why the log is split into committed lines and one open line.** `redact()` matches
whole tokens and `key: value` pairs, so a secret straddling two writes is only caught if the
redactor sees both halves at once — which the old whole-buffer rescan got for free. A line is
redacted when it completes, with the end of the previous line as context (which covers
`password:\nhunter2`), and the incomplete trailing line is redacted afresh and sent *whole* every
time, never as a delta. A token stream still updates live, and no secret is ever sent one half at a
time.

`redact()` also used to backtrack quadratically in the length of what it is handed, and by more than
was first thought: measured on 3.12, 1 KB on one line cost 25 ms, 8 KB cost 1.7 s and 64 KB
extrapolated to around 100 s, against a fraction of a millisecond for the same bytes as short lines.
The shipped code ran it over the whole buffer every 100 ms, so a program printing one very long
line — which is exactly what token streaming is — could wedge the extension host.

Two separate things fixed it. The regex is now linear: the leading `[A-Za-z0-9_.-]*` of the
key-value rule could start at every offset of a run of those characters and backtrack the whole run
at each one, and a lookbehind now requires it to start where the run does, which rules out only
matches that could never have won. 64 KB on one line costs about 8 ms. Independently, the redactor
is never handed more than a kilobyte at once, with the end of each redacted slice carried into the
next as context, and the open line keeps only a short raw tail between flushes — that one still
matters, because `openLine()` runs on every flush and a line that grows a token at a time would
otherwise be re-redacted from the start each time.

**The tail is bytes, not lines.** `outputTailLines` kept the last 500 *lines*; `print(delta, end="")`
produces one line that grows without bound, so the window did nothing and the 64 KB cut landed
mid-token. Rows are built from chunks, the head cut is drawn as a marker rather than a note in the
section header, and the row the program is still writing is marked as open.

**ANSI.** Nothing in `webview/` decoded escape codes, so rich and colorama printed `ESC[2m ESC[36m`
into the pane. `webview/ansi.ts` decodes SGR to VS Code's own `terminal.ansi*` colours and swallows
the sequences it does not act on; a `\r` repaint shows the last frame, the way a terminal shows a
progress bar rather than every step of it.

---

## 6. Waves

Each wave is shippable on its own.

### Wave 1

Contract items: 1, 2.1 to 2.6, 2.8 (`frameId` on `locals` and `evaluate`), 2.9 to 2.13, 3.1 to
3.6, 3.8 (minus `pyokka.debugCurrentFileRecording` and the function-breakpoint parts), 3.9 to 3.11
(with `at` restricted to `FILE:LINE`), 4.1 to 4.3, the `noWait` half of 4.4, 4.5 to 4.8, the wave-1
half of 4.9, 5.1 to 5.5 (minus `exec` and `setVariable`).

- runtime: `config.record`, the debugger hook set, the frame-chain stack, `thread`, `frameId` on
  `locals` and `evaluate`, the module launch, no timeout, the exception rules with no recording,
  `stepCount`, `scripts/bench-debug.py`
- host: `DebugSession`, the registry, the facade, the DAP start paths, the `kind: "debug"`
  descriptor and its socket behind `pyokka.agentAccess`, the Debugger view, the status bar item,
  the URI handler, `continue`/`pause` with `noWait`
- CLI: `pyokka debug FILE|--module` with its three routes, `--at FILE:LINE`, `--no-wait`, the
  selection rule, `state --live` listing both, the refusal wording for the recording verbs
- docs for what landed: `docs/PROTOCOL.md` runtime and bridge rows, the README's "Two products"
  section and its server paragraph, the wave-1 `docs/QA.md` cases

What a user can do after wave 1 alone: press F5 on a script or a server and get a normal debugger.
It runs at full speed, stops at a breakpoint or an exception, shows the stack with real caller
lines, the locals, the watches and the output in the Debugger view, steps over, into and out,
continues, restarts and stops. No recording, no Time Machine, no re-run, no timeout. An agent can
start it cold with `pyokka debug FILE`, drive it with `continue` (`--no-wait` included), `step
--over`, `locals`, `eval`, `break FILE:LINE`, `pause`, `watch`, `restart` and `stop`, and see both
sessions in `state --live`. What is missing: writing values (`exec`, `setVariable`, the console),
`--until` / `--to` / `--count`, `--at NAME`, and recording.

### Wave 2

Contract items: 2.7, the `exec` half of 2.8, 3.7, the rest of 3.8, the `until` / `to` / `count` /
`at` half of 4.4, the wave-2 half of 4.9, 4.10, the `exec` and `setVariable` parts of 5.3 and 5.5.

- runtime: the `exec` request and both write-back branches, the `{function: NAME}` breakpoint spec
- host: `exec` through the bridge and the Debug Console, `setVariable`, function breakpoints,
  `modified` everywhere, `--until` / `--to` / `--count`, `record: true` with its overrides and
  `pyokka.debugCurrentFileRecording`, the recording path behind the facade
- CLI: `exec`, `--frame`, `--record`, `--at NAME`, the new `continue` and `step` flags,
  `break --at`
- docs: the skill, the wave-2 `docs/QA.md` cases, the rest of the README and `docs/PROTOCOL.md`

---

## 7. File ownership

Nobody writes `CHANGELOG.md` or `docs/HANDOFF-debugger.md`: the coordinator does.

### Runtime implementer

Owns `python/pyokka_runtime/**` except `python/pyokka_runtime/agent/**`, `python/tests/**` except
`python/tests/test_agent_*`, the runtime rows of `docs/PROTOCOL.md`, `scripts/bench-debug.py`.
Works in an isolated git worktree: plain `git` and heredocs are refused there, so use
`command git` and write file content through the editing tools.

**Wave 1**

| file | change |
|---|---|
| `python/pyokka_runtime/hooks_debug.py` | new: the debugger-mode hook set (2.3, 2.4) |
| `python/pyokka_runtime/dbgframes.py` | new: `frame_stack`, `frame_at`, `thread_info` |
| `python/pyokka_runtime/dbgexceptions.py` | new: `ExceptionPauseMixin` with `on_raise`, `on_uncaught`, `_pause_for_exception`, `set_exception_mode`, moved out of `debugger.py` |
| `python/pyokka_runtime/module_run.py` | new: the `runpy`-equivalent module launch |
| `python/pyokka_runtime/protocol.py` | `RunConfig.record`, `from_dict`, the HTTP-plugin skip |
| `python/pyokka_runtime/tracer.py` | wiring only: `self.record`, the `install()` hook-set branch, the `finish()` early return, `hook_error` to `runner.error`, `step_count()` |
| `python/pyokka_runtime/debugger.py` | the cells, `rearm`, `on_step(n, rid, scope, bp)`, `on_enter`, `on_leave`, `pending_sid`, `frames`, `modified`, `pause_lock`, per-thread `serving`, the `{function}` spec field on `Breakpoint`; the exception half moves out |
| `python/pyokka_runtime/errors.py` | the `record: false` branches: `seen` ring, no `records`, monitoring only when a mode is set, `report_uncaught` without coverage states |
| `python/pyokka_runtime/execute.py` | wiring only: the module-launch branch, `main_globals` |
| `python/pyokka_runtime/runner.py` | wiring only: no timeout when `config.debug`, the new capabilities |
| `python/pyokka_runtime/child.py` | nothing (the control channel already attaches the debugger) |
| `python/pyokka_runtime/control.py` | `frameId` on `evaluate` and `debug locals` (`frame_at`) |
| `python/tests/test_debug_record_off.py` | new: section 8.1 |
| `python/tests/test_debug_server.py` | new: the `http.server` fixture and the two-thread case |
| `python/tests/test_debug_module.py` | new: module launches, no timeout, the stack with caller lines |
| `python/tests/test_debug.py` | unchanged assertions; add the `thread` field where a pause is compared field by field |
| `python/tests/test_runner.py` | one change: `Client(executable=...)` so another interpreter can be driven (8.1) |
| `scripts/bench-debug.py` | new: section 8.4 |
| `docs/PROTOCOL.md` | the runtime rows: `config.record`, the event list, `debug.paused` with `record: false`, `run.module`, the timeout rule, `frameId`, the runtime notes |

**Wave 2**

| file | change |
|---|---|
| `python/pyokka_runtime/dbgexec.py` | new: `exec_in_frame` with both write-back branches and the `text` rule of 2.7 |
| `python/pyokka_runtime/control.py` | the `exec` branch and the refusals while running and after the run |
| `python/pyokka_runtime/runner.py` | wiring only: `exec` in the evaluate dispatch with the paused-only gate, `exec.result` / `exec.error` forwarding |
| `python/pyokka_runtime/debugger.py` | the `modified` flag on replies, `{function: NAME}` resolution in `file_added` |
| `python/tests/test_debug_exec.py` | new: section 8.1 |
| `python/tests/test_debug_at.py` | new: `{function}` breakpoint resolution |
| `docs/PROTOCOL.md` | the `exec` row and the `{function}` breakpoint spec |

### Host implementer

Owns `src/**`, `webview/**`, `python/pyokka_runtime/agent/**`, `python/tests/test_agent_*`,
`test/**`, the bridge rows of `docs/PROTOCOL.md`, `README.md`, `skills/**`,
`scripts/gen-manifest.py`, `docs/QA.md`.

**Wave 1**

| file | change |
|---|---|
| `src/debug/debugSession.ts` | new: the class (3.3) |
| `src/debug/debugSessionState.ts` | new: pure launch parsing, the URI codec, `stopSlice`, the descriptor shape (no descriptor picker: 4.7) |
| `src/debug/debugSessionManager.ts` | new: the registry (3.4) |
| `src/debug/debugTarget.ts` | new: the facade and `wrapDebugSession` |
| `src/debug/debugContext.ts` | new: the context-key arbiter |
| `src/debug/debugUri.ts` | new: the URI handler |
| `src/debug/dapAdapter.ts` | `resolve` routes by `record`; `startDebugSession`; `wrapSession` gains the facade members |
| `src/debug/dapTranslator.ts` | the launch attributes, real caller lines in `stackTrace`, per-frame `scopes` / `variables` |
| `src/session/debugState.ts` | `modified` on `DebugState` and the reducer, the optional `DebugFrame` fields |
| `src/session/debugController.ts` | wiring only: report its half to `debugContext` |
| `src/session/outputBuffer.ts` | new: `OUTPUT_KEPT`, `appendOutput` |
| `src/session/session.ts` | wiring only: import `appendOutput` |
| `src/agent/bridgeDebugSocket.ts` | new: the `kind: "debug"` socket, its dispatch, and the `pyokka.agentAccess` gate (4.1) |
| `src/agent/bridge.ts` | wiring only: `"kind": "run"` in the descriptor |
| `src/agent/bridgeDebug.ts` | `noWait` on `continue` and `pause`; the `launch` field on the run socket's `debug` (3.10 route (b)) |
| `src/features/debugBreakpoints.ts` | wiring only: `pushAll` also pushes the gutter to every `DebugSession` in the registry, and `onDidChangeBreakpoints` reaches both products |
| `src/runtime/runnerClient.ts` | `frameId` plumbing; the `record` capability check |
| `src/shared/protocol.ts` | `record` on `RunConfig`, `module` on the run request, `thread` / `modified` / the frame fields on `debug.paused` |
| `src/shared/webviewProtocol.ts` | `ViewId` gains `'debug'`; `DebugSessionPanel`; `debug.session`; the webview messages |
| `src/views/debuggerView.ts` | new: the view host |
| `src/views/outputPanel.ts` | wiring only: route `debug.session` and the new webview messages, `pyokka.panelView` |
| `src/views/statusText.ts` | `debuggerStatusText` |
| `src/views/debugStatusBar.ts` | new: the second item |
| `src/features/quickPicks.ts` | the debug-session entries next to the existing ones |
| `webview/components/DebuggerView.tsx` | new: the view |
| `webview/debuggerView.ts` | new: the view's pure helpers |
| `webview/components/Chrome.tsx` | the rail button |
| `webview/model.ts` | the `debug.session` state and the `'debug'` view |
| `src/extension.ts` | wiring only: the registry, the URI handler, the five commands, the status item, the api fields |
| `src/api.ts` | `debugSessions()`, `debugPanelState()`, `startDebugSession(launch)`, `handleDebugUri(uri)` for the e2e suite |
| `scripts/gen-manifest.py` | the debuggers block, the commands, the menus, the view's `when`, `activationEvents` assigned not defaulted |
| `python/pyokka_runtime/agent/debug_start.py` | new: the URI builder, the `code` lookup, the descriptor poll, the three-route order (3.10) |
| `python/pyokka_runtime/agent/render_debug.py` | new: the stop and `state` text forms without a recording |
| `python/pyokka_runtime/agent/live.py` | the debug descriptor, `kind`, the selection preference, `others`; the debug request methods |
| `python/pyokka_runtime/agent/commands.py` | `debug`'s positional and flags (a positional implies `--live`), `--no-wait`, `--frame` |
| `python/pyokka_runtime/agent/render.py` | wiring only: the dispatch entries that delegate to `render_debug` |
| `test/unit/debugSession.test.ts`, `debugLaunch.test.ts`, `debugUri.test.ts`, `stopSlice.test.ts` | new: section 8.2 |
| `test/unit/debugState.test.ts`, `dapTranslator.test.ts`, `manifest.test.ts` | extended: section 8.2 |
| `python/tests/test_agent_debug.py` | new: the selection rule and the cold start (8.2) |
| `test/e2e/debug-session.test.js`, `debug-server.test.js`, `debug-cli-cold.test.js` | new: section 8.3 |
| `test/e2e/debug-live.test.js`, `debugger.test.js`, `debug-stop.test.js`, `debug-exceptions.test.js` | updated: section 8.3 |
| `.vscode-test.mjs` | the three new specs appended to the ordered `files` list, after the existing debugger ones |
| `docs/PROTOCOL.md` | the bridge rows: the descriptors, the debug socket's requests, the stop slice, the watch stream |
| `README.md` | the "Two products" section near the top; the launch attributes; servers and reload mode (3.8); the Debugger view; `pyokka.agentAccess` for the CLI start |
| `docs/QA.md` | the wave-1 DBG cases (8.5) |

**Wave 2**

| file | change |
|---|---|
| `src/debug/debugSession.ts` | `exec`, `modified`, the `until` / `to` / `count` paths |
| `src/debug/dapTranslator.ts` | `context: "repl"` to `exec`, `setVariable`, `setFunctionBreakpoints`, the new capabilities |
| `src/agent/bridgeDebug.ts` | `until`, `to`, `count`, `at` on the shared handlers |
| `src/agent/bridgeDebugSocket.ts` | the `exec` request |
| `src/runtime/runnerClient.ts` | `exec` |
| `src/views/debuggerView.ts` | the `modified` banner |
| `src/debug/debugSessionState.ts`, `src/session/sessionManager.ts`, `src/session/session.ts` | the `record: true` overrides (`argvOverride`, `cwdOverride`, `envOverride`, the `interpreter` option) and the refusals |
| `scripts/gen-manifest.py` | `pyokka.debugCurrentFileRecording`, the recording snippet |
| `python/pyokka_runtime/agent/commands.py`, `live.py`, `debug_start.py`, `render_debug.py` | `exec`, `--frame`, `--record`, `--at NAME`, `--until`, `--to`, `--count` |
| `skills/pyokka-debug/SKILL.md` | new: the phrase table and the loop |
| `skills/pyokka-agent/SKILL.md` | two lines pointing at it |
| `test/unit/debugExec.test.ts` | new |
| `test/e2e/debug-recording.test.js` | new |
| `docs/QA.md` | the wave-2 DBG cases (8.5) |

Files over 500 lines take wiring lines only, with the logic in the new modules named above:
`src/session/session.ts` (849), `python/pyokka_runtime/runner.py` (604), `tracer.py` (602),
`execute.py` (503), `src/extension.ts` (525), `python/tests/test_agent_live.py` (824),
`src/agent/bridge.ts` (501).

---

## 8. The test plan

### 8.1 pytest, runtime implementer

The in-process `run` fixture plus `on_tracer=attach(Scripted(...))` from `test_debug.py` is the
setup for everything except the runner cases, which use the `client` fixture (parameterised over
fork and spawn).

**Wave 1, `python/tests/test_debug_record_off.py`**

| test | asserts |
|---|---|
| `test_record_off_emits_only_debug_and_output_events` | the event types of a `record: false` debug run are a subset of `{run.started, file.instrumented, output, debug.paused, debug.resumed, debug.result, run.finished}`; no `trace`, `coverage`, `log`, `locals`, `time`, `watch` appears |
| `test_record_off_emits_the_uncaught_error_with_its_traceback` | one `error` event, `handled: false`, `traceback` non-empty, `step` equal to the counter at the raise, and no caught-exception group |
| `test_record_off_prints_reach_output_not_log` | a program that prints produces `output` events whose concatenated text is the program's output, and no `log` event |
| `test_record_off_pause_carries_the_frame_chain_with_caller_lines` | `debug.paused.stack[0]` is the paused function with the paused line, `stack[-1]` is `<module>` with the **call** line, and an uninstrumented frame in between has `fileId: 0` and no `rid` |
| `test_record_off_pause_carries_the_thread` | `thread.name == "MainThread"` and `thread.ident == threading.get_ident()` of the run |
| `test_record_off_step_over_and_out_follow_the_frames` | over `CALLS` (the existing fixture source): the same `(line, reason, kind)` sequence `test_debug.py::test_step_into_over_and_out_follow_the_time_machine_moves` asserts today, proving the frame-exit rule matches the scope-chain rule |
| `test_record_off_step_over_is_exact_in_recursion` | a recursive function: Step Over at depth 3 stops at depth 3, not in the deeper call |
| `test_record_off_step_over_an_await_lands_after_it` | `asyncio.gather` of two coroutines: Step Over on the `await gather(...)` line lands on the next statement of the awaiting frame, after both coroutines ran, and the intermediate stops are not reported; then a generator the program never exhausts, where Step Over on its `yield` never fires and the run reaches the next breakpoint instead, with no pause in between (the suspension rule of 2.4) |
| `test_record_off_breakpoint_inside_a_library_module_body_never_pauses` | `libraryCode: true`, a breakpoint on a line of an imported library module's body: no pause; a breakpoint in one of its functions pauses when stepped code calls it |
| `test_record_off_benchmark_loop_event_count` | the bench program of 8.4 (1,000,003 statements) with one breakpoint that never hits emits at most 12 events in total (the file, the output, the finish), which is the machine-checkable form of "no recording" |
| `test_record_off_hook_error_becomes_a_runner_error` | a debugger monkeypatched to raise in `on_step` produces a `runner.error` and the program still finishes with exit 0 |
| `test_record_on_is_unchanged` | the same program with `record` absent produces the same events as `config={"debug": True}` does today (a golden comparison against the run-all event-type multiset) |

**Wave 1, `python/tests/test_debug_server.py`**

| test | asserts |
|---|---|
| `test_breakpoint_in_a_handler_pauses_when_a_request_arrives` | a fixture program that starts `http.server.ThreadingHTTPServer` on port 0 in a thread and prints the port; the test reads the port from the `output` events, sends a request with `urllib.request.urlopen` from a test thread, and asserts one `debug.paused` inside the handler with `reason: "breakpoint"`, the handler's locals readable, and `thread.name` not `MainThread` |
| `test_two_request_threads_queue_and_nothing_is_corrupted` | two requests in flight against the same breakpoint: exactly two `debug.paused` events, strictly ordered, with a `debug.resumed` between them, two different `thread.ident`s, and both requests answered after both resumes |
| `test_continue_does_not_wait_for_the_next_request` | `continue` at a handler pause returns and the server answers the request; a second request pauses again |
| `test_pause_while_blocked_in_accept_lands_at_the_next_statement` | `action: "pause"` while no request is in flight answers `{"ok": true, "paused": false}`, and the pause arrives only after the next request is sent |
| `test_the_server_run_is_off_the_timeout_clock` | `timeoutMs: 800`, the program idle for 2 s: no `timedOut`, the run still alive, then `stop` ends it |

**Wave 1, `python/tests/test_debug_module.py`**

| test | asserts |
|---|---|
| `test_module_launch_runs_as_main_with_argv_and_syspath` | a package under `tmp_path` with `__main__.py`; `run.module` produces `__name__ == "__main__"`, `sys.argv[0]` equal to the module's file, `sys.argv[1:]` equal to `argv`, `sys.path[0] == cwd` |
| `test_module_launch_instruments_the_module_and_honours_a_breakpoint` | a breakpoint on a line of the module pauses; `file.instrumented` reports the module's file as `fileId: 1` |
| `test_module_launch_reports_an_uncaught_exception_like_a_file_launch` | exit 1 and one `error` event with the module's file in the stack |
| `test_module_and_file_together_is_reported` | both fields produce a `runner.error` naming the conflict, and the module wins |
| `test_missing_file_content_is_read_from_disk` | a file launch without `file.content` runs what is on disk, not the buffer |

**Wave 2, `python/tests/test_debug_exec.py`**

| test | asserts |
|---|---|
| `test_exec_assigns_in_the_paused_frame_and_the_program_sees_it` | at a pause inside a function, `exec "total = 100"`, then `continue`, and the program's printed output shows 100 |
| `test_exec_at_module_level_writes_the_globals` | the same at module level, with no `ctypes` involved |
| `test_exec_reports_the_value_of_an_expression_statement` | `text == "3"` with a `valueBag`; a statement gives `text == ""` |
| `test_exec_reports_an_exception_and_stays_paused` | `1/0` answers `exception: {"type": "ZeroDivisionError", …}`, the run is still paused, and the next `continue` works |
| `test_exec_sets_modified_on_every_attempt` | `modified: true` after a failing exec, and on the next `debug.paused` and the next `locals` reply |
| `test_exec_is_refused_while_running_and_after_the_run` | `exec.error` with the two messages of 2.7 |
| `test_exec_creates_a_new_name_visible_to_evaluate_and_locals` | a name the function does not declare is readable afterwards through `evaluate` and `locals` on both interpreter branches |
| `test_exec_frame_id_targets_a_caller_frame` | `frameId: 1` writes in the caller and `frameId: 9` answers `no frame 9 in this pause` |
| `test_exec_on_the_other_interpreter_branch` | see below |

Both interpreter branches. The pytest venv is Python 3.12.9, so the 3.12
`PyFrame_LocalsToFast` branch is the one the suite exercises directly. The 3.13+ branch is
exercised by a subprocess run of the real runner under another interpreter:
`shutil.which("python3.13") or "/opt/homebrew/bin/python3.13"`, then `/opt/homebrew/bin/python3.14`,
then `sys.executable` when its version is already 3.13+. The test drives that runner over NDJSON
exactly as `test_runner.Client` does (a second `Client(executable=...)` parameter is the one change
to `test_runner.py`, which the runtime implementer owns), sets a breakpoint, execs an assignment,
continues, and reads the program's output. When no 3.13+ interpreter exists the test is
`pytest.skip`ped with the reason naming the interpreters it looked for; the branch selection itself
(`sys.version_info >= (3, 13)`) is unit-tested by monkeypatching `dbgexec._WRITE_THROUGH` so both
code paths run under 3.12, with the `ctypes` call mocked in the 3.13 direction.

**Wave 2, `python/tests/test_debug_at.py`**

| test | asserts |
|---|---|
| `test_function_breakpoint_pauses_at_every_entry` | `{"function": "bump"}` pauses at each of the four calls, with `resolvedLine` on the `def` line |
| `test_function_breakpoint_resolves_in_a_module_imported_later` | the spec is set before the import and pauses when the module loads |
| `test_function_breakpoint_reports_a_second_definition` | two files defining the name: the echo carries the `also defined in` message and the first one pauses |
| `test_function_breakpoint_matches_a_qualified_method` | `{"function": "Ranker.rank"}` resolves to the method |

### 8.2 vitest and the CLI's pytest, host implementer

| file | cases |
|---|---|
| `test/unit/debugSession.test.ts` (new) | the state machine over a fake `RunnerClient`: `starting -> running -> paused -> running -> ended`; `run.finished` disposes and emits `ended`; a restart keeps the launch, the breakpoints and the exception mode and resets `modified` and `output`; the output buffer keeps the last 64 KB and nothing else; `waitForPause` settles on a pause and on a finish; a runner that exits without `run.finished` still ends the session |
| `test/unit/debugLaunch.test.ts` (new) | `parseLaunch` defaults for every attribute; `${file}` and `${workspaceFolder}` resolution; neither `program` nor `module` is an error; `module` with `record: true` is the refusal of 3.7; `launchKey` equality and inequality across `args` and `cwd`; the entry-pause rule for a cold start |
| `test/unit/debugUri.test.ts` (new) | `debugUri(launch, at)` round-trips through `parseDebugUri`; a malformed `args` / `env` JSON is reported; `stopOnEntry=1` and its absence; an `at` of both forms |
| `test/unit/stopSlice.test.ts` (new) | the slice of 4.3 field by field from a synthetic pause: `values` empty, no `count`, no `moves`, no `coverage`, the block window and its 60-line cap, `current` on the paused line, the stack without uninstrumented frames, `output` truncation, `stale` and `staleReason` from a dirty document and from an mtime |
| `test/unit/debugState.test.ts` (extended) | `modified` through the reducer (set by `debug.paused`, reset by `run.started`); a `DebugFrame` with `frameId`/`line` and one with `scopeId`/`rid` both type-check and both survive `pausedInfo` |
| `test/unit/dapTranslator.test.ts` (extended) | `launch` with `module`, `args`, `cwd`, `env`, `python`, `record`; `stackTrace` uses the frame entry's own line when present and the `locate` fallback when not; `scopes` returns a reference per frame and `variables` asks `debugLocals({frameId})`; `evaluate` with `context: "repl"` calls `exec` and with `context: "hover"` calls `evaluate`; `setVariable` builds `name = value` and reports the new value; `setFunctionBreakpoints` maps to `{function}` specs; the two behaviours of round 2 (`setExceptionBreakpoints {filters: []}` before `configurationDone` is ignored; a `disconnect` for an older run is ignored) still hold |
| `test/unit/debugExec.test.ts` (new, wave 2) | `ExecResult` mapping: a value, no value, an exception, `modified`; the console's error text |
| `test/unit/manifest.test.ts` (extended) | `contributes.debuggers[0]` has all ten launch attributes with the types and defaults of 3.8; three `initialConfigurations`; `activationEvents` contains `onUri`; the panel view's `when` contains `pyokka.debugSessionActive`; the four new commands exist with their icons and their `navigation@2..@5` groups and a `pyokka.panelView == debug` clause; `pyokka.debugCurrentFileRecording` is in the palette with no `when`; the existing pins (the 11 `editor/title` entries, the two F5 bindings, the four panel-title debug entries) still pass unchanged |

There is no vitest suite for the descriptor selection rule: it lives in Python (4.7). Its tests,
and the cold start's, are `python/tests/test_agent_debug.py`, which the host implementer owns
(`test_agent_*`). `PYOKKA_SESSIONS_DIR` points at a `tmp_path` holding hand-written descriptors, so
no window and no socket are needed for most of them:

| test | asserts |
|---|---|
| `test_pick_session_prefers_the_debug_descriptor_for_the_debug_verbs` | two descriptors for one file, one of each kind: `continue`, `step`, `locals`, `break`, `stop`, `restart`, `exec` pick the debug one |
| `test_pick_session_prefers_the_run_descriptor_for_the_recording_verbs` | `why`, `var`, `walkthrough`, `graph`, `exceptions`, `http`, `values` pick the run one |
| `test_pick_session_falls_back_when_the_preferred_kind_is_absent` | `continue` with only a run descriptor picks it; `why` with only a debug descriptor picks it |
| `test_pick_session_descriptor_path_wins_over_the_preference` | `--session <path to the run descriptor>` with a debug verb selects exactly that socket |
| `test_pick_session_reports_two_of_the_same_kind` | two debug descriptors for one file: the "N live sessions" error listing both descriptor paths |
| `test_state_lists_both_kinds_debug_first` | the text form of 4.7 over a `state` reply carrying `others` |
| `test_debug_start_builds_the_uri` | `debug_start.build_uri(launch, at)` against the pinned encoding of 3.9, including the JSON `args` / `env` and the absent booleans |
| `test_debug_start_polls_and_connects` | `PYOKKA_CODE` set to a stub script that writes the URI it was given to a file; a thread writes a matching descriptor after 300 ms; the poll finds it and returns it, and the descriptor's `started` is at or after the request |
| `test_debug_start_ignores_a_descriptor_that_is_older_than_the_request` | a descriptor written before the request with a matching launch is not accepted |
| `test_debug_start_times_out_with_the_agent_access_hint` | `PYOKKA_CODE=/bin/true`, a 1 s timeout through the module's constant: the error names `pyokka.agentAccess` first, then the focused window |
| `test_debug_start_without_code_says_how_to_install_it` | `PYOKKA_CODE` unset and `code` absent from a stripped `PATH`: the two-line message of 3.10 |
| `test_debug_start_prefers_a_run_socket_over_the_uri` | with a run descriptor present, `build_route` returns route (b) and never calls `code` (the stub records nothing) |

### 8.3 e2e, host implementer

New specs, appended to `.vscode-test.mjs`'s ordered list after the existing debugger ones:

**`test/e2e/debug-session.test.js`** (wave 1). Fixture: `test/e2e/fixtures/debug_target.py` copied
to `_debug_session_e2e.py`, **no run-all session started**.

1. `F5 on a fresh file creates a debug session and no run-all session`: a gutter breakpoint, then
   `workbench.action.debug.start`; asserts `vscode.debug.activeDebugSession.type === 'pyokka'`, one
   entry in `api.debugSessions()`, `api.manager.get(doc) === undefined`, the pause at the
   breakpoint, `paused.thread.name === 'MainThread'`, and `paused.stack[0].line` equal to the
   breakpoint's line.
2. `the Debugger view has the frame and there is no Time Machine`: `api.debugPanelState()` has the
   stack, the locals and the output; the run-all session does not exist, so there is no `nav` and
   no timeline. `debugPanelState(): DebugSessionPanel | null` is a new getter on `src/api.ts` that
   returns the last `debug.session` state the panel pushed (the e2e suite cannot see inside the
   webview, which is why the getter exists).
3. `no timeout while paused`: `pyokka.runTimeout` set to 800 ms, paused for 2 s, then Continue:
   the run finishes normally with exit 0.
4. `an edit while paused is allowed and not applied`: `WorkspaceEdit` on the paused file, no new
   run, the pause unmoved, and the next `restart` runs the edited file.
5. `Stop ends the session and removes it from the registry`: `workbench.action.debug.stop`, then
   `api.debugSessions()` is empty and the descriptor file is gone.
6. `a module launch runs and pauses`: `vscode.debug.startDebugging` with `module` and `args`
   against a two-file package fixture.

**`test/e2e/debug-server.test.js`** (wave 1). Fixture: a new
`test/e2e/fixtures/debug_server.py` (a `ThreadingHTTPServer` on port 0 that prints its port and
has a breakpointable handler).

1. `a breakpoint in a handler pauses when a request arrives`: start the debug session, read the
   port from `api.debugPanelState().output`, `http.get` from the spec, wait for the pause, assert
   the handler's locals.
2. `continue --no-wait resumes without waiting for the next pause` (wave 1): `pyokka continue
   --live --no-wait` over the debug socket returns `resumed` at once, the pending request is
   answered, and a second request pauses again.
3. `two requests queue`: two parallel requests, two pauses in order, both answered.
4. `Stop kills the server`: the port stops accepting.

**`test/e2e/debug-cli-cold.test.js`** (wave 1). Drives the real CLI exactly as
`debug-live.test.js` does (`spawn(python, ['-m', 'pyokka_runtime', ...], {cwd: PY_DIR})`, async,
never `spawnSync`).

1. `pyokka debug FILE starts a debug session through the URI and prints the first stop` (wave 1):
   a spec cannot make VS Code open its own URI from outside, so `PYOKKA_CODE` is set to a stub
   script that writes the URI it was given to a file, and the spec polls that file and feeds the
   URI to the window through `api.handleDebugUri(uri)`, which `src/api.ts` exposes for exactly
   this. The assertion is that the CLI's own poll then finds the descriptor and prints
   `paused at …`. No run-all session exists in this case, so route (c) is the one taken.
2. `with the file open in a session, pyokka debug FILE takes the run socket and never calls code`
   (wave 1): a run-all session on the file, `PYOKKA_CODE` set to the stub; the CLI prints the first
   stop and the stub's file was never written (route (b) of 3.10).
3. `the descriptor lists kind debug and state --live prints both sessions` (wave 1): with a run-all
   session on the same file, `state --live --json` has `kind: "debug"` and one `others` entry, and
   the text form lists both with `debug` first.
4. `the recording verbs are refused with the record hint` (wave 1): `why --live` and
   `walkthrough --live` against the debug socket exit 2 with the wording of 4.2.
5. `a timeout prints the hint` (wave 1): `PYOKKA_CODE` set to `/bin/true` so no window answers; the
   CLI exits 2 within 25 s with a message whose first check is `pyokka.agentAccess`.
6. `with agentAccess off the URI is refused and nothing starts` (wave 1): the setting off, the URI
   fed through `api.handleDebugUri`; `api.debugSessions()` stays empty and no descriptor appears.
7. `--at FILE:LINE pauses there` (wave 1): the breakpoint appears in `vscode.debug.breakpoints` and
   the first stop is that line, with no entry pause.
8. `--at NAME pauses at the function's entry` (wave 2); a bare name in wave 1 exits 2 with
   `--at NAME lands in the next wave; use FILE:LINE`.
9. `--until, --to and --count` (wave 2), each one assertion.

**`test/e2e/debug-recording.test.js`** (wave 2).

1. `the recording command attaches the Time Machine`: `pyokka.debugCurrentFileRecording`, the
   pause, then `session.nav.active`, `trace.count > 0`, values as of the step, Step Back replays,
   and `why --live <step> total` answers over the bridge.
2. `record: true through a launch configuration`: the same with `startDebugging({record: true})`.
3. `module with record: true is refused with the message that names record: false`.

Existing specs, and what changes:

| spec | change |
|---|---|
| `debugger.test.js` cases 1 to 3 | unchanged. They drive `api.startDebug(session)` on a session that already exists, which is the recording path, and that path stays. |
| `debugger.test.js` case 4 (`pyokka.debugCurrentFile` on a fresh file) | asserts the new behaviour: one entry in `api.debugSessions()`, `api.manager.get(freshDoc) === undefined` (no run-all session is created), and the pause at the gutter breakpoint. Its second half (`startDebugging` with `stopOnEntry: true` on the same program) asserts that the **same** debug session restarts in place: `api.debugSessions().length === 1`, the same `id`, the same `vscode.debug.activeDebugSession.id`, and a pause with `reason: "start"` at step 0. |
| `debugger.test.js` case 5 (`workbench.action.debug.start` on a file that already has a run-all session) | asserts a `record: false` debug session pausing at the breakpoint next to the untouched run-all session: `api.debugSessions().length === 1`, `api.debug(session).active === false` on the run-all session, and its `state.runId` unchanged by the debug start. |
| `debug-stop.test.js` | cases 1 and 2 keep their assertions; `api.debug(session)` becomes `api.debugSessions()[0].debug` where they read the pause, because F5 on a file with no session now makes a debug session. Case 3 (no breakpoint, runs to the end) additionally asserts `api.debugSessions()` is empty afterwards. |
| `debug-exceptions.test.js` | the `startDebug()` helper returns the debug session instead of the run-all one; the three cases keep their assertions about `reason`, `exception.uncaught`, the lines and the stacks. |
| `debug-live.test.js` | as itemised in 4.8. |
| `features.test.js`, `bridge.test.js`, `demo.test.js`, `code-story.test.js`, `http-replay.test.js`, `execution-diagram.test.js`, `why.test.js`, `exceptions.test.js`, `values-as-of.test.js`, `walkthrough.test.js`, `uipass.test.js`, `library-cache.test.js`, `cli-live.test.js` | not touched, and must pass unchanged. |

### 8.4 `scripts/bench-debug.py`

Shape, modelled on `scripts/measure-library-run.py` (the only existing timing script) but with no
hardcoded paths: `--python PATH` (default `sys.executable`), `--repeat N` (default 3, the median
is reported), `--json`.

The program it runs, written to a temp file. `range(500_000)` makes it 1,000,003 statements (the
loop header steps once per iteration and once to end it, plus the body, plus the two module
statements), which is the program the 0.51 s and 1.14 s numbers in the brief were measured on:

```python
total = 0
for i in range(500_000):
    total += i
print(total)
```

Five rows, each measured as **wall time from before the process starts to after the run's last
event**, so interpreter start counts:

| row | how |
|---|---|
| `plain python` | `subprocess.run([python, prog])` |
| `run-all (in-process pyokka run)` | `subprocess.run([python, "-m", "pyokka_runtime", "run", prog, "--json"])`: the run-all recording with no runner and no child, for reference only |
| `run-all` | spawn `python -m pyokka_runtime serve`, `hello`, one `run` with the run-all config (`recordLocals: false`, `timeoutMs: 0`), drain to `run.finished` |
| `debugger` | the same runner, `config: {"debug": true, "record": false, "stopOnEntry": false, "timeoutMs": 0}` and **one breakpoint on a line that never executes**, so the debugger is armed for every statement. This is the honest worst case; without a breakpoint the hook is unarmed and cheaper. |
| `debugger + recording` | the same runner with `record` absent (the default) and `recordLocals: true`, `autoLog: true`, which is what the extension sends today |

The three runner-driven rows are the comparison, and **the target is the runner-driven `debugger`
row at or under the runner-driven `run-all` row**. The two other rows are reference points: the
in-process row shows the recording's own cost without the runner and the child, and `plain python`
shows the floor. A runner-driven row carries a fixed cost the in-process row does not (a spawned
child on macOS, the event pipe, the NDJSON), so the two are never compared with each other.

Each row prints the wall time in seconds to two decimals, the ratio to `plain python`, the
`stepCount` from `run.finished`, and the number of events received, so "no recording" is visible in
the numbers. The placeholders below are the layout, not measurements:

```
program: 500,000-iteration loop (1,000,003 statements)
python: /abs/.venv/bin/python (3.12.9), median of 3

row                                 wall      x plain   steps        events
plain python                        x.xx s      1.0      -            -
run-all (in-process pyokka run)     x.xx s      x.x      1000003      -
run-all                             x.xx s      x.x      1000003      9
debugger                            x.xx s      x.x      1000003      4
debugger + recording                x.xx s      x.x      1000003      9
```

The script is run before the change and after it. "Before" has four rows: `record: false` does not
exist yet, so the `debugger` row is skipped and printed as `not available before the change`. Both
tables go into `docs/HANDOFF-debugger.md`, written by the coordinator.

### 8.5 `docs/QA.md`, split per wave

The DBG cases are split so wave 1 ships with its own QA and nobody is asked to test something that
is not built yet. Wave 1 adds DBG-14 to DBG-17, wave 2 adds DBG-18 to DBG-20, and DBG-01 to DBG-13
stay as they are (they cover the recording path, which does not change).

**Wave 1**

- **DBG-14 A debug session on its own** (H2 + H3): F5 on a fresh file with a gutter breakpoint. No
  Pyokka session appears in the status bar's session list, the Debugger view shows the stack, the
  locals, the watches and the output, the Time Machine view is not attached, the status bar reads
  `Debugger: paused at …`, an edit while paused is accepted and not applied, `pyokka.runTimeout`
  does not fire, and Stop leaves nothing behind.
- **DBG-15 A server** (H2 + H3): a launch of a `ThreadingHTTPServer` or a uvicorn app without
  `--reload`, with a breakpoint in a handler. The program runs until a request arrives, pauses in
  the handler, Continue answers the request, two requests in flight pause one after the other, and
  Stop kills the server. With `--reload` the breakpoint does not hit, which is the documented case.
- **DBG-16 The CLI cold start** (H1 + H2): `pyokka.agentAccess` on, `pyokka debug FILE` from a
  terminal with the folder open. The window starts a debug session, the CLI prints the first stop,
  `state --live` lists both kinds with debug first, `continue --live --no-wait` returns at once,
  `pause --live` stops it, the recording verbs refuse with the record hint, and with the setting
  off the window shows the warning and the CLI times out naming the setting.
- **DBG-17 A module launch** (H3): a launch configuration with `module` and `args`. The program
  runs as `__main__` with its arguments, a breakpoint in the module hits, and the status bar names
  `-m app.server`.

**Wave 2**

- **DBG-18 The console writes** (H2 + H3): at a pause, the Debug Console runs `x = 3`, a call, an
  import and a statement that raises; `setVariable` in the Variables view; the stop after that
  reads "values modified from the console"; `pyokka exec --live` does the same from an agent and
  the program sees the new value after Continue.
- **DBG-19 Agent navigation** (H1): `--until`, `--to`, `--count` and `--at NAME`, each one stop,
  with the editor following.
- **DBG-20 Recording, opt-in** (H1 + H2 + H3): "Pyokka: Debug Current File (Recording)" and
  `pyokka debug FILE --record`. The Time Machine attaches at every pause with values as of the
  step, Step Back replays, the Code Story opens, `why --live` answers, and when the program exits
  it is a finished run the Time Machine owns. A `module` launch with `record: true` is refused with
  the message that names `record: false`.

The test-coverage table at the end of `docs/QA.md` gains a row per new spec file of 8.3.

---

## 9. Open questions, with a recommendation each

The recommendation is the decision, and it is what the document above specifies. The coordinator
may overturn any of them; nothing else in the design depends on more than the item itself.

1. **`record: true` is today's Session-based debug run behind a facade.**
   Alternative: `DebugSession` always, feeding a `RunState` the Time Machine can attach to.
   Recommendation: the facade, because the Time Machine, the navigator, `contextSlice`, the Code
   Story, the panel binding and the decorator are all typed on `Session` and keyed by its
   document, so the alternative is a refactor across every run-all path. **Decision: the facade
   (`DebugTarget`), with `record: false` on `DebugSession` and `record: true` on today's path.**

2. **`module` with `record: true` is refused.**
   It follows from item 1: a run-all session is keyed by a document. Alternative: synthesise a
   document for the module's file after the first import, which is a race and a lie.
   **Decision: refused, with a message that names `record: false`.**

3. **A second start on the same launch key restarts in place.**
   Alternative: start a second, parallel session. Recommendation: restart, because it is today's
   `attached` behaviour and two debuggers on one program confuse both the gutter and the CLI. A
   different `args` or `cwd` is a different key and does run in parallel.
   **Decision: restart in place; refuse only when another VS Code debug session holds it.**

4. **`debug --live` on a running, unpaused debug session is refused.**
   Alternative: restart it. Recommendation: refuse, because restarting would kill a server somebody
   is using, and the hint names both `pause --live` and `restart --live`.
   **Decision: refuse with that hint.**

5. **`record: false` turns the HTTP plugin off.**
   Alternative: keep observing so the HTTP view works. Recommendation: off, because the plugin
   keeps a row per request in memory and a server would grow without bound, and there is no HTTP
   view without a recording anyway. **Decision: off, forced in `RunConfig.from_dict`.**

6. **No timeout for any run with `config.debug: true`.**
   This changes today's behaviour for a recording debug run that is running rather than paused.
   Alternative: keep the clock while running. Recommendation: no timeout, because the brief says so
   and because a debug run that is "running" may be a server waiting for a request.
   **Decision: no timeout, guarded both in the host's request and in `Runner.handle_run`.**

7. **The panel gets a view id `'debug'` next to the existing `'debugger'` (the Time Machine).**
   The two names are confusing. Alternative: rename `'debugger'` to `'timeMachine'`.
   Recommendation: do not rename this round; it touches every panel path for no user-visible gain
   and the brief pins `'debug'`. **Decision: `'debug'`, with a comment in `webviewProtocol.ts`
   saying which is which.**

8. **`--at NAME` resolves in the runtime, as a `{function: NAME}` breakpoint spec.**
   Alternative: an AST scan on the host. Recommendation: the runtime, because a module imported
   later gets its breakpoint when it loads and the runtime already has the rid-to-name table.
   **Decision: the runtime spec, plus DAP function breakpoints so the Breakpoints view shows it.**

9. **`exec` reports a raised exception inside `exec.result`, not as `exec.error`.**
   Recommendation: inside the result, because the session stays paused and both the console and the
   CLI want "the error text, still paused" rather than a failed request. `exec.error` is only for a
   request that cannot be served. **Decision: as recommended.**

10. **Any `exec` attempt sets `modified`, success or failure.**
    Alternative: only a write sets it. Recommendation: any attempt, because the runtime cannot know
    what a statement did and a statement that raised halfway may already have written.
    **Decision: as recommended.**

11. **`pause` gains `noWait`.**
    The brief only asks for `continue --no-wait`. Recommendation: add it, because a server sitting
    in `accept()` would otherwise hang an agent for the full 600 s stop timeout, and it is one
    field. **Decision: added.**

12. **A finished debug session is disposed at once, with no grace period.**
    Alternative: keep the socket for a few seconds answering `{running: false, finished}`.
    Recommendation: dispose, because the brief says "then it is gone"; the command that was waiting
    already holds the `{finished}` reply, and a later command gets a hint that names what happened.
    **Decision: dispose at once.**

13. **The debug stop's `step` is a plain statement counter and `run.finished.stepCount` keeps it.**
    Alternative: omit `stepCount` with `record: false`. Recommendation: keep it; it means
    "statements executed", it is free, and every existing text form keeps working.
    **Decision: keep it.**

14. **`debug.paused.stack` is one field with two shapes, distinguished by optional members.**
    Alternative: a second field `frames` for the frame-chain shape. Recommendation: one field with
    optional members, because the host has one `PausedInfo` type and one DAP mapping, and the DAP
    mapping wants to prefer the real line when it is there. **Decision: one field.**

---

## 10. Things this design deliberately does not do

- No attach to a running process, no remote debugging, no named pipes for the bridge on Windows
  (the debugger itself works there through the runner's control pipe, as it does today).
- No per-thread DAP thread list: one DAP thread, named from the paused thread.
- No exec box in the panel: the Debug Console is where code runs.
- No renaming of the Time Machine's `'debugger'` view id.
- No change to `pure.py`. Hovers, displayed watches, break-when watches, `eval` and completions
  stay pure in both products.
- **No bound on the value `Registry`.** The child's `serialize.Registry` keeps every object it
  handed out a value id for, so `expand` can open it later. Every `locals` and every `evaluate` at
  every pause adds to it, and a debug session that pauses a thousand times over an hour holds a
  thousand pauses' worth of references. This is exactly what a run does today, per run, and the
  session's lifetime is now the bound instead of the run's. Known, accepted, not fixed this round:
  capping it means invalidating value ids an agent or the Variables view may still be holding, and
  that is a design of its own. The runtime implementer does not touch it.
