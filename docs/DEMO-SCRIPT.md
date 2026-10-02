# Demo script: recording Pyokka, features first, then an agent driving it

Written 2026-09-16 for a self-recorded video. Project on screen: `examples/rrf`
(demo.py is the RRF program, 188 lines; `api/` is its FastAPI service).
VS Code on the left, a terminal with Claude Code on the right.

## Setup (once)

1. Skills the agent needs, linked into the work profile (`cc` uses `~/.claude-work`):
   `skills/pyokka` is symlinked as `~/.claude-work/skills/pyokka`; the demo uses `/pyokka explain` and `/pyokka show`.
2. VS Code: open the example folder and `demo.py`, press `Cmd+K Q`. The workspace settings
   already have `pyokka.agentAccess: true` and `pyokka.http: replay`. Check from any terminal:
   `pyokka state --live` must print `demo.py: 243 steps, live in VS Code`.
3. Terminal, in the example folder: `IS_DEMO=1 cc --model opus`. `IS_DEMO` is Claude Code's demo
   mode: it hides the organization name and email from `/status`, the "Message from <org>" line,
   Anthropic-only tips and announcements, and skips the startup offers. It keeps the logo header,
   so when the prompt box appears press **Ctrl+L**. The logo header and the Warp plugin's SessionStart line are static output;
   Claude Code never redraws them, so the pane shows only the prompt box.
   To keep the Warp line from printing at all, flip `warp@claude-code-warp` to `false` in
   `~/.claude/profiles/cc.json` (that is the profile `cc` passes with `--settings`).
   To hide your status line for the take, rename `statusLine` in
   `~/.claude-work/settings.json` and restore it afterwards.
4. Screen Studio: Cmd+Opt+3 records the display, Cmd+Opt+Enter stops, Cmd+Opt+Backspace
   restarts a take. Projects land in `~/Downloads`. Keep the editor at normal zoom; the auto
   zoom does the magnification.
5. Never open `.env` on camera. Replay mode never sends the key, and masking hides it in the
   panel, but the file itself is plain text.

## Part A: the playground, you at the keyboard

One take, about two minutes.

1. `example.py`, `Cmd+K Q`. The file was written for this: `sys.executable  # ?`,
   `acct  # ?+` (the object, expanded), `total = ...  # ?.` (the timing). Values and the green
   coverage squares appear on save.
2. Change `50` in the deposit loop to `500`, save, watch every value move.
3. `demo.py`. Cursor on line 73 (`contribution = reciprocal_rank(rank, k)`), `Shift+F5`.
   `F10` four times: the values on lines 73 to 82 change per iteration, `scores` grows.
   `Ctrl+F10` three times: backwards. `Shift+F5` stops.
4. Panel, palette commands in this order: `Pyokka: View Code Story`,
   `Pyokka: Show Execution Diagram`, `Pyokka: Show Variable History` (type `scores`),
   `Pyokka: Narrate Walkthrough` (the gloss comes from `claude -p`, 20 to 40 s).
5. Exceptions: open `examples/demo.py` in the same
   window, `Cmd+K Q`. The last line raises on purpose: red square, pink stack path, the
   message beside the line, the EXCEPTIONS section in the panel.

## Part B: the agent, prompts to paste

Send prompt 0 first. Every other prompt is one scene; the follow-ups are separate messages.
The editor moving on its own is the shot, so the prompts say so.

### 0. Style, once per session

```
For this session: answer in at most eight lines, no headers. Every time you refer to a line of code, move my editor there first. Name the pyokka command you ran, in one line, before the finding. demo.py is open in Pyokka and has run; use the live session, never re-run the file.
```

### 1. Map the run without touching the editor

```
Without moving my editor: what does demo.py do, in order, and where are the five moments worth stopping at? Give me step numbers.
```

What happens: `pyokka state --live`, `walkthrough --live`, `graph --live`; a short list with
`#steps`.

### 2. Explain rrf live, the editor follows

```
Explain how rrf works in demo.py, live: put my editor on the line you are talking about, one stop per message, and wait for me to say next.
```

Follow-ups, one per message:

```
next
```

```
step into reciprocal_rank
```

```
back one step
```

```
what did scores look like right here?
```

What happens: `step --live --to N`, `--into`, `--back`, `context --live`; the Time Machine
moves and the inline values change with every message.

### 3. Provenance

```
Why did C end up first in fused_ranking? Trace the value back through the recording and put my editor on the statement that decided it.
```

What happens: `why --live <step> fused_ranking`, five levels back, ending on the two
contributions C collected (rank 2 in BM25, rank 1 in Vector).

### 4. Variable history and per-hit values

```
Show me every value scores took during the run and which statement changed it each time.
```

```
How many times did line 73 run, and what was contribution on each hit?
```

What happens: `var --live scores`, `values --live --line demo.py:73`.

### 5. The debugger, driven from the terminal

Stop the Time Machine first (`Shift+F5`) so the gutter is clean.

```
Start the debugger on demo.py with a breakpoint at rrf. When it pauses, show me the stack and the locals, then step over three times and tell me what changed.
```

```
Set k to 10 in this frame, continue to demo.py:130, and show me fused_ranking.
```

```
Add a breakpoint on demo.py:73 that only fires when rank == 3, continue, and show me the locals.
```

```
Stop debugging.
```

What happens: `pyokka debug demo.py --at rrf`, `locals --live`, `step --live --over --count 3`,
`exec --live 'k = 10'`, `continue --live --to demo.py:130`, `eval --live fused_ranking`,
`break --live demo.py:73 --when 'rank == 3'`, `stop --live`. VS Code shows the pause, the
gutter breakpoints and "(values modified from the console)" after the write.

### 6. A server under the debugger

```
Debug the FastAPI service in api/: start it with the debugger stopped on entry, break at the first statement of the /rank handler, let it run, then POST a rank request with curl and show me where it paused and the request's locals.
```

```
Step into rrf, show me scores building up, then continue and show me the response payload.
```

```
Request GET /documents/zzz, make the debugger pause on the raised HTTPException, and show me where Starlette catches it.
```

```
Stop the server.
```

What happens: `pyokka debug --module api.main --cwd . --stop-on-entry`,
`break --live api/main.py:52`, `continue --live --no-wait`, the curl from the module
docstring, a pause on a worker thread, `break --live --on-exception raised`. The recipe is
in the docstring of `api/main.py`, so the agent finds the details itself.

### 7. HTTP replay

Open `agent.py` and press `Cmd+K Q` first. HTTP mode is Replay in this workspace, so the LLM
call is answered from `.pyokka/replay/` and nothing goes on the wire.

```
agent.py just ran in Pyokka. Show me the HTTP requests it made, where each answer came from, and what the response body said. Then put my editor on the statement that made the call.
```

What happens: `http --live`, one row with method, status and "replayed"; the editor lands on
`client.responses.parse(...)`.

### 8. Exceptions report

With the extension's `examples/demo.py` open and run (Part A, step 5):

```
This file raised at the end. Use the exceptions report on the live session: what raised, where, and did anything catch it?
```

### 9. The artifact: a code-history page

```
Record a run of demo.py to run.json and build the code-history page: checkpoints at the first contribution, at the sorted fused ranking, and the provenance of fused_ranking after the sort. One sentence of prose per checkpoint, render it to HTML and open it in the browser.
```

What happens: `pyokka run demo.py --save run.json`, `pyokka history run.json --at ... --why ...
--out history.json`, a prose JSON, `render-code-history.cjs`, `open history.html`. Every value
on the page carries the command that reproduces it.

### 10. Async, optional

Open `async_demo.py`, `Cmd+K Q`.

```
Show me how the two gathered tasks interleave: walk the run and put my editor on each await as the tasks swap.
```

## Cleanup after recording

- `git status` in the example folder: `run.json`, `history.json`, `history.html` are new files.
- Stop any debug session: `pyokka stop --live`.
- Restore `~/.claude/profiles/cc.json` and `statusLine` if you changed them.
