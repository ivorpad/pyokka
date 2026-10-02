# The code-history page

How the `show` mode delivers an explanation: numbered source on the left, chronological
checkpoints on the right, dim context, green lines that ran, amber current line and values.

What makes it worth more than a prose report is a property, not a look: **every value on it was
generated from the run, and every checkpoint carries the command that prints those values
again.** `pyokka history` builds the data; you write the prose. Keep it that way. A page whose
numbers were typed is exactly the thing this exists to prevent, and it fails silently, which is
worse.

## Build one

```sh
# 1. the data
pyokka history run.json --at 3 --at demo.py:82 --var contribution --why 124 fused_ranking \
  --out history.json

# 2. the prose, keyed by the checkpoint ids the command printed
cat > prose.json <<'EOF'
{
  "title": "Why C wins",
  "eyebrow": "CODE HISTORY",
  "heading": "C is the only document both retrievers ranked, and that is the whole result",
  "subtitle": "demo.py, reciprocal rank fusion over two rankings",
  "summary": "Every score is a sum of 1/(60+rank). C appears in both lists, so it sums twice.",
  "historyLabel": "4 RECORDED STEPS",
  "scope": "One saved run of demo.py. No network, no arguments.",
  "footer": "Regenerate with the same command and re-apply this file.",
  "steps": {
    "step-3": { "title": "The two rankings", "text": "...", "note": "...", "evidence": ["notes/rankings.txt"] },
    "why-124-fused_ranking": { "title": "Where the order comes from" }
  }
}
EOF

# 3. merge and render
pyokka history run.json --at 3 --at demo.py:82 --var contribution --why 124 fused_ranking \
  --out history.json --prose prose.json
node <skill>/scripts/render-code-history.cjs history.json history.html
```

Write the data and the page to a scratch directory outside the user's repository and the skill,
and keep a real case's data where nothing commits it.

## Choosing checkpoints

Lead with the finding or the open question in `heading`. Then the smallest sequence that
explains the behaviour: the input or producer, the transformation or decision that matters, the
consumer or output, and any later validation you captured. Let the explanation set the number
of checkpoints, and show the source each one needs.

| selector | gives you |
|---|---|
| `--at STEP` | one checkpoint at that step |
| `--at FILE:LINE` | one at the first step on that line |
| `--var NAME` | one per recorded change, in step order, each with what the statement read |
| `--why STEP NAME` | one whose chain is the provenance tree as an indented list |
| `--live --pause` | one from the debug session's current pause, read without moving it |

They appear in the order you write them. `--var` on a name that changes fifty times is fifty
cards: use `--limit`, and the header will say what was left out.

A program passes one pause at a time, so a page that follows a live program through two of them
is built twice: run the verb at each pause with `--append` and the same `--out`, and the second
run adds its checkpoint with a fresh id. `--append` is the way to join pauses, because then no
value on the page was typed. With more than one session open, give every one of those runs
the same `--session NAME` the debug commands used. Render as soon as the last checkpoint is
written. A run that stops with only `history.json` on disk has no page to show.

Update the same page as an investigation grows rather than making another. Keep distinct runs
distinct: the header's `run.json` hash is what tells two pages apart.

## The four evidence kinds

`kind` is one of these and the renderer refuses anything else. They are four different claims:

| kind | the claim | what it may carry |
|---|---|---|
| `recorded step` | the program executed this statement; the recording holds its values | everything |
| `live pause` | the program is stopped here now, the frame is live | `values` from the frame, `output`, `reason`; **no chain**, because a `record: false` session recorded nothing behind the pause |
| `static source` | nobody ran this; the explanation needs the source | **no values** |
| `gloss` | a sentence a model wrote, from `narrate` | not an observation |

Rules that keep a page honest, beyond the kinds:

- Repeated inspections at one pause are one pause: one checkpoint.
- A value is shown as of a step. A later value is a later checkpoint, not a correction.
- A branch that went both ways says so. `history` writes `took False x2, True x1` rather than
  reporting whichever pass came last.
- Preserve the difference between a missing key, `None`, an empty collection and a truncated
  value. The recording already does; keep the prose as exact.
- Put what you observed in `text` and what it establishes in `note`, and say in `note` when
  something is an inference. A demonstrated omission is not a reason for it.
- If a boundary was not observed, mark the gap and leave it a gap.
- When you used `exec --live`, the page must say so. The card's tag carries it automatically;
  repeat it in `summary`, because a finding from a modified frame is worth less.

## The data contract

Top level. Prose fields are empty until you fill them; the rest is generated.

| field | who | content |
|---|---|---|
| `lang`, `labels` | generated | page language (`en`, `es`; another language gets English); `labels` overrides any word the page draws |
| `title`, `eyebrow`, `heading`, `subtitle`, `summary` | **prose** | tab title, small label, the finding, the subject, the conclusion |
| `historyLabel`, `scope`, `footer` | **prose** | evidence coverage, its limits, completion or handoff status |
| `reportHref`, `reportLabel` | prose | optional link, both or neither |
| `meta` | generated | run identity (below) |
| `files` | generated | `{"path": ["line 1", ...]}`, index 0 is line 1, `""` where no checkpoint asked |
| `steps` | generated | the checkpoints, in the order the selectors were written |

`meta`: `mode` (`saved run` or `live session`), `run`, `file`, `sourceSha256`, `runSha256`,
`python`, `runtimeVersion`, `exitCode`, `stepCount`, `recordedAt`, `paused`, and `truncated`,
a list of what a `--limit` cut. The header draws each as a chip and shows `truncated` in amber.

A checkpoint:

| field | who | content |
|---|---|---|
| `id` | generated | stable across regenerations; what `--prose` keys on |
| `kind`, `tag` | generated | the evidence kind; the label on the card (`tag` is editable prose) |
| `step` | generated | the step number, or `null` for a live pause or static source |
| `title`, `text`, `note` | **prose** | the observation, what it establishes, the limits |
| `file`, `start`, `end`, `focus`, `bright` | generated | a key of `files`, the panel's range, the selected line, the lines that ran |
| `values` | generated | one `name = value` per line |
| `reads` | generated | what the statement read, for a `--var` checkpoint |
| `stack` | generated | the call stack at that step |
| `call` | generated | `{name, in: [...], out}` when the step is a call site |
| `hits`, `arm` | generated | how often the line ran; the arm a branch took |
| `reason` | generated | why a live session is paused (`breakpoint`, `watch total: 3`, `uncaught ValueError: too big`) |
| `output` | generated | what the program printed so far, at a live pause |
| `chain` | generated | the `why` tree, flat: `{depth, via, name, text, statement, location, step}`, `via` one of `root`, `reads`, `calls` |
| `exception`, `http`, `gloss` | generated | when the step raised, made a request, or was narrated |
| `modified` | generated | the frame was written to with `exec` |
| `verify` | generated | the `pyokka` command that reproduces these values |
| `evidence` | prose | a list of links relative to the HTML, or `http(s)` URLs; `--prose` takes it as a JSON list |

Everything is plain text. Handlebars escapes the page fields and the renderer's `json` helper
escapes the embedded JSON. Data fields hold plain text.

## Render and check

```sh
node <skill>/scripts/render-code-history.cjs history.json history.html [--theme NAME]
```

It writes one standalone file: no CDN, no network, no browser-side Handlebars. It validates
first and names the checkpoint in every refusal, so `Checkpoint 3 (why-22-answer): invalid
source range or focus` tells you which card to fix.

The Python is coloured by Shiki here, while the file is being written, and the page carries the
tokens as data. That is why it still opens with nothing to fetch. `--theme` takes any Shiki
theme; the default is `github-dark-dimmed`, whose background is the panel colour the
design already uses. The renderer drops a file's colours rather than shift them when the token
rows and the source disagree, because colours off by a line describe a different statement.

Handlebars and Shiki ship with the skill in `scripts/render-deps.cjs` (Shiki cut down to Python
and the default theme), so rendering needs no `npm install`, no network and nothing in the
user's project. Another `--theme` needs a full Shiki: it is looked for in the working directory,
the skill's directory and `~/.cache/pyokka/render`, and without one the page is monochrome with
a line on stderr saying why. Install it in that cache, which keeps the user's project untouched:
`npm install --prefix ~/.cache/pyokka/render shiki`. `--handlebars-module /absolute/path` uses
another Handlebars instead of the bundled one. `node scripts/build-render-deps.mjs` in the
Pyokka checkout rebuilds the bundle after either package is upgraded.

Check the page before you hand it over. Headless Chrome, and the virtual time budget matters
because without it the shot is blank:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --hide-scrollbars --window-size=1400,900 --virtual-time-budget=3000 \
  --screenshot=page.png "file://$PWD/history.html"
```

Then give the user the path with a short conclusion in the chat: the finding, what remains
uncertain, and for a paused handoff the file, line, frame and the next manual action. A
rendering that failed is a blocker to name, not a page to claim exists.

## Keep the visual

The template is the approved design. Change the data, not the page: the dark slate panels, the
two-panel proportions, the monospace source with line numbers, dim context, green markers, amber
values and selected line, the chronological cards, the counter, slider, previous and next
buttons, arrow keys, and the stacked layout under 850px. Syntax colours are the theme's and mean
nothing on their own: what carries evidence is the green gutter marker, the dimming of context,
and the amber outline on the selected line, so keep those three louder than the colouring. Ligatures are off on purpose, so a
`--json` in a verify line reads as two hyphens and can be copied. Deliver the page; a diagram, a
table or a prose report is for when the user asks for one.
