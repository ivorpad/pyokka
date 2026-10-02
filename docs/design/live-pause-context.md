# The band at a debug pause without a recording

2026-10-02. With `pyokka debug FILE --at NAME` (no `--record`) paused, the Claude Code band showed
"The Time Machine is off" because `pyokka context --live` failed. This note records what the bridge
knows at such a pause, the change that lets `context` answer there, and what the band does with it.

## What the bridge had

A plain `pyokka debug` starts a `record: false` debug session (`src/debug/debugSession.ts`) with its
own socket, `kind: "debug"` (`src/agent/bridgeDebugSocket.ts`). At a pause it holds:

- `debug.paused` (`PausedInfo`): `step` (the runtime's statement counter, not a navigable index),
  `fileId`, `line`, `reason` (`breakpoint`, `step`, `exception`, `start`, `pause`, `watch`), the
  frame chain in `stack` with each frame's real line, `thread`, and `exception: {type, message,
  uncaught}` when it stopped on one.
- The variables of any frame of the pause, through the runtime's `locals` action
  (`debugger.py`): `{name, text, valueBag}`, the value bag carrying the value node's `type` and
  `length`.
- The source of the file, read from the open document or disk, and the output so far.

The debug socket already answered `context` at a pause with a stop slice (`stopReply` in
`bridgeDebugReply.ts`): `step`, `location`, `stack`, `block.lines` with `current`, empty `values`,
`paused`, `locals`, `output`, no `count` and no `moves`.

## Why the band still failed

Measured in a scratch VS Code (e2e `test/e2e/debug-band.test.js`, first run before the change):
with a run-all session open on the same file, `context --live --session <run descriptor>` answered
`context needs step or file/line while the Time Machine is not active`. The band reaches the run
socket whenever it follows a descriptor path (it picks the newest descriptor when the CLI says
several sessions are live, and it keeps a `--session` an earlier command named). `step --live
--over` on the same run socket already worked: `BridgeDebug.executes` sends the moves that execute
to the debug session of the file (`debugSessionFor`). `context` had no such route.

The CLI's text renderer needed nothing: `render_context` picks the pause format by shape (`block`
without `count`).

## The change

Three additive pieces, the recorded path untouched:

1. **The run socket's `context` serves the file's plain pause** when it has no step of its own:
   no `step` asked, no Time Machine, no pause of its own (`BridgeDebug.pauseContext`). The answer is
   the debug socket's own stop reply. Otherwise the old error stands.
2. **`recording: false` on that stop reply.** The same field a `recordFrom` run's pause carries
   before its recording starts, so one test tells a reader that nothing behind the pause was kept.
3. **`type` and `length` on each `locals` row**, from the value node the runtime already sends.
   A masked value keeps only its name and masked text.

`step` stays in the reply. It is the statement counter, which other readers use (`history --live
--pause` cards, the text renderer), and the band uses it only to tell one pause from the next.
`count`, `moves` and recorded `values` stay absent.

Reply at a breakpoint on `invoices.py:34` (abridged from the `PAUSED_SUBTOTAL` fixture):

```jsonc
{ "step": 58, "recording": false, "stale": false,
  "location": { "file": "/work/invoices.py", "line": 34, "function": "subtotal" },
  "stack": [ { "function": "subtotal", "line": 34, "frameId": 0 }, { "function": "invoice_total", "line": 42 },
             { "function": "main", "line": 47 }, { "function": "<module>", "line": 53 } ],
  "block": { "lines": [ { "line": 34, "text": "        return sum(...)", "current": true } ] },
  "values": [],
  "paused": { "reason": "breakpoint", "line": 34 },
  "locals": [ { "name": "items", "text": "[{'qty': 2, ...}, ...]", "type": "list", "length": 2 } ] }
```

## The band

`toSpot` reads `recording: false` into `spot.pause`: the reason, the exception, and the variables
with a shape (`list[2]`, `dict[1]`, `str`). The explain view then draws:

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ pyokka invoices.py:34 · subtotal                       paused · no recording │
│                                                                              │
│   32 def subtotal(items):                                                    │
│   33     try:                                                                │
│ ▶34         return sum(item["qty"] * item["unit_price"] for item in items)   │
│   35     except (KeyError, TypeError):                                       │
│                                                                              │
│   items  list[2]  [{'qty': 2, 'sku': 'KB-01', 'unit_price': 49.9}, …         │
│                                                                              │
│ ▌ The function subtotal adds qty times unit_price for each item in items.    │
│                                                                              │
│ <module> › main › invoice_total › subtotal   record from here  next into out │
╰──────────────────────────────────────────────────────────────────────────────╯
```

At an uncaught exception a red `⚠ uncaught KeyError: 'Ben'` line sits above the variables, and the
narrator is told about it.

Keys:

| key | at a pause without a recording |
|---|---|
| `n` `i` `o` | `pyokka step --live --over/--into/--out --json`: the program runs to its next stop and the band reads it. A failed step keeps the pause on screen with one line saying why; a step that ends the program says so with the exit code. |
| `b`, a step number, `x`, `w`, `f`, `g`, `j`, `k` | one line: "Back, step numbers, bugs, where from and fix plans need a recording. Press r to record from here." Nothing runs. |
| `r` (`/pk R` too) | record from here: `pyokka stop --live`, then `pyokka debug FILE --record-from FILE:LINE --no-focus`. |
| `e` `p` | as always |

Band hotkeys take one lowercase letter, so "record from here" is `r` in this view, where "record
again from the top" has nothing to add: the plain run already shows the top.

`record --live` cannot start a recording at a `record: false` pause: the debug socket refuses it,
because a `record: false` session has no run-all session to hold a trace. `--record-from FILE:LINE`
is the nearest thing. It runs the program again from the top and pauses the first time it reaches
the line, which is the same pause only when that line runs once before the one shown. The band's
toast says the program runs again.

The bug scan does not run at such a pause (there is no run to scan), findings of an earlier
recording are not shown against it, and the tool answers `step`, `bugs`, `origin` and `fix` with
the same one line. `pyokka debug FILE` in Bash makes the band follow `FILE` by name, so it reads
the new pause rather than a session it followed before.

## Checks

- vitest: `BridgeDebug.pauseContext` (served, refused, and left alone when the run session has its
  own step), `localsReply` shapes.
- e2e `test/e2e/debug-band.test.js`: both sockets answer the pause with `recording: false`, `step
  --over` through the run socket moves the program, `stop` then `debug --record-from FILE:LINE`
  pauses there as step 0, and crash.py's uncaught `KeyError` carries its type and message. With
  `PYOKKA_BAND_CAPTURE` set it writes the replies that `scripts/band-fixtures.py --live` turns into
  the `PAUSED_*` fixtures.
- Band: `tests/pause.test.tsx` and three cases in `tests/parse.test.ts`.
