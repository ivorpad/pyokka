# Code Story: the Quokka contract

What Quokka's Code Story Viewer does, observed on 2026-09-14 in Cursor
(wallabyjs.quokka-vscode, current build) on a 26-line probe, cross-checked with
Quokka's 2019 Code Story frames and a 2026-08 screenshot (both kept locally, not in
the repository).
Pyokka's story document follows these rules 1:1 where Python has the same notion;
the deliberate gaps are listed at the end. Rules are numbered so tests can cite them.

Terms: a *step* is one trace step (statement range, scope). A *block* is a run of
steps listed together. *Bright* means rendered with normal token colours, *dim*
means the same tokens at 0.45 opacity.

## The document

- **D1** One read-only document per session, opened beside the editor. Tab title
  "Pyokka Code Story", language `pyokka-story`, scheme `pyokka-code-timeline`.
- **D2** Opening the story starts the Time Machine when it is not on. The story
  exists only while the Time Machine is on: stopping the Time Machine (or the
  session) closes the story editor. There is no "stopped" text state.
- **D3** Row 1 of the document is empty. Then the blocks. Between two blocks there
  is exactly one row holding `…` at the code column (line-number gutter blank),
  and nothing else: no blank rows, no `…` before the first block, no `…` after the
  last block, no header text, no code lens row.
- **D4** Each listed source line is rendered as `<number right-aligned to the width
  of the file's line count>  <source line>`. Blank source lines are listed with the
  number and nothing after it.
- **D5** The story content never changes while stepping. Only highlight, scroll,
  cursor and the current-step value change.
- **D6** No fences. The grammar tokenises every row as Python, except a row that is
  only whitespace + `…`, which is a fold marker (comment scope, dim).

## Blocks

- **B1** A block is a run of consecutive steps in one scope (the existing
  `storyBlocks` rule): it ends when the scope changes (a call splices the callee's
  block in under the call line, the caller resumes in a new block) or when a step
  revisits a line already listed in the block (a loop header stepping again starts
  the next turn's block). Steps in another file are swallowed as today.
- **B2** Lines inside a block are listed in source order once each.

## Lines of a block

- **L1** Executed lines = the first line of every step's range in the block. The
  continuation lines of a multi-line statement are listed (they are inside the
  window) but rendered dim.
- **L2** Window = executed lines ± 2 source lines, clamped to the block's scope
  span. For a function scope the span is the whole function (the `def` line
  through the last line of its body) extended upward over the comment lines and
  decorators directly above the `def`. For the module scope the span is the file.
- **L3** Edge blanks are dropped: blank lines at the top or bottom of the window
  are removed (repeat until the edge line is non-blank). Blank lines between two
  listed lines stay.
- **L4** A run of more than 4 consecutive non-executed lines inside the window is
  replaced by one `…` row (the existing `GAP_FILL` rule; Quokka shows no evidence
  either way, keep it). A run of at most 4 stays, dim.
- **L5** There is no header rule: a function's `def` line and comments are listed
  only when they fall inside the window (a first pass through a short function
  shows them; a later loop turn deep in the body does not).
- **L6** Brightness is per executed range: on an executed line, the columns of the
  step's range (from its start column to its end column, or to the end of the line
  when the range continues on later lines) are bright; the rest of that line is
  dim. Context lines are entirely dim. (Quokka lights `r.length < n` only on a
  `while` header; Pyokka's header range starts at the keyword, so the whole header
  is bright: the closest Python has.)

## Values

- **V1** The story shows the values of the current Time Machine step only: the
  entries (log / error kinds) whose step is the current step, rendered after the
  end of the current step's story line in the current block, with the same inline
  decoration kinds and text as the editor (`×N` hit prefix, time formatting,
  120-character cut, full text on hover). Nothing on any other line or block.
- **V2** An unhandled error raised at the current step is shown the same way.
- **V1 in Pyokka** is behind `pyokka.story.values`: `step` is Quokka's rule above; the default
  `all` paints every block's values during that block's steps (the user's call on 2026-09-14,
  after using both: a loop's turns each carrying their own values is what the story is for),
  and `asOf` hides what the run has not reached yet.
- **V3** Hovering a name on a story line shows the value the editor's Value Peek
  would show for that name at that line's step (the story maps the row to
  `{fileId, line, step}` and delegates). Skip if Value Peek cannot be given a step.

## Time Machine sync

- **T1** The current step is boxed on its executed range in the story (the same
  decoration as the editor's current-step range, not a whole-line background),
  in the block that contains the current step. Cleared when there is no step.
- **T2** On every navigation the story scrolls so the boxed line is visible
  (centre if outside the viewport) and the story's cursor moves to that row, at the
  range's start column.
- **T3** Placing the cursor on a story line does not move the Time Machine.
  Selecting text on a single story line (existing behaviour) moves the Time Machine
  to that line's first step in that block and adds a Show Value marker on the
  source; this is Pyokka's, Quokka's selection behaviour was not observed.
- **T4** The Time Machine keys work while the story is focused (existing
  keybinding `when` clauses). The Time Machine toolbar lives in the Pyokka panel
  header as in the editor; the editor-title contributions that Quokka's manifest
  declares for `quokka-code-timeline` are mirrored for `pyokka-code-timeline`.
- **T5** Go to Definition on a story code line opens the source at that line
  (existing; unverified against Quokka).

## Not ported (Python has no equivalent, or Pyokka-only on purpose)

- Quokka paints a function's closing `}` and the file's end-of-program line bright
  on the pass that leaves them. Python has neither.
- Quokka's walkthrough prefix does not exist; Pyokka keeps
  `pyokka.story.walkthrough` (default off) as its own addition.
- The `pyokka story` CLI listing stays narrower (executed lines + header, for an
  agent's context window); only the editor document follows this contract. Its
  `--limit` flag must work.

## Evidence

Probe transcription (Quokka, 2026-09-14; B = bright, d = dim):

```
                            (empty row 1)
   15  }                    d
   16
   17  const items = [7, 42];   B
   18
   19  for (const it of items) {   `items` B, rest d
   20    const out = twice(it);   B
   21    console.log(out);        d
   22  }                          d
…
   11  function twice(x) {   d
   12    const a = pad(x, 3); B
   13    const b = pad(x, 4); d
   14    return a + b;        d
…
    1  // story probe        d
    2  function pad(s, n) {  d
    3    let r = String(s);  B
    4
    5    while (r.length < n) {   `r.length < n` B
    6      r = '0' + r;      B
    7    }                   d
    8    return r;           d
…
    3 d · 4 · 5 cond B · 6 B · 7 d · 8 d          (turn 2)
…
    3 d · 4 · 5 cond B · 6 d · 7 d · 8 B · 9 B    (exit)
…   (and so on; the last block: 19 d · 20 d · 21 B · 22 d · 23 · 24 B · 25 · 26 B · 27)
```

Steps observed: `17:1, 19:18, 20:3, 12:3, 3:3, 5:10, 6:5, 5:10, 6:5, 5:10, 8:3, 13:3, …`.
Value seen: `'0070007'` after `console.log(out);` on line 21 of the first-iteration
block while the Time Machine stood at 21:3; no value anywhere else. Stop closed the
story. Clicking story lines did not move the Time Machine.
