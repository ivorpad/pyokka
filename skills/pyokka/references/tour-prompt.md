# Write a guided tour of one recorded Python run

Below this prompt comes TOUR.JSON, which a recorder produced from one run of a Python program.
Every value in it was read from the recording. Your job is to pick the stops that tell the story
of the run and write short prose for them. A checker compares your prose with the recording
and rejects any claim that the recording does not hold.

Your reader is a developer who has not seen this program. After the tour they should be able to
say what the run did, in what order, and which values made the result what it is. They read in
short bursts. Put the point first, keep sentences short, and use plain words.

## What TOUR.JSON holds

- `run`: the script, its step count, exit code, and how many HTTP requests and model calls it made.
- `goal`: what the run produced (by default its last output line). The tour explains this.
- `chapters`: consecutive step ranges in run order, each with an `id` (`c1`, `c2`, ...), the
  function that opens it (`title`), its `steps` as `[first, last]`, and `http` and `llm` counts.
- `candidates`: places in the run worth a stop. Each one has an `id`, the `step` it ran at, its
  `chapter`, `file`, `line`, `function`, the `statement`, the `signals` that proposed it (with a
  `reason`), and `values`: what the program held there. Each value has an `id` (`<stop id>.v1`,
  ...), a `role`, a `name`, its full `length`, and `text`. A long text is cut at 300 characters
  here, and the recording keeps it whole. A long value can also carry `evidence`, which holds
  sentences of the full text with `from` and `to` character offsets into it. `sameAs` means the
  value equals an earlier value, which has that id. `like` with `from`, `to` and `text` shows
  only the part that differs from the previous value of the same name.

## What to write

1. Pick stops.
   - If TOUR.JSON has fewer than 60 candidates, pick 6 to 10 stops in all.
   - Otherwise pick 3 to 6 stops in every chapter.
   Cover the input, each decision or external call that shaped the result, the evidence the
   result rests on, and the result itself. Prefer a stop where a value changes shape or arrives
   from outside (a model reply, a tool result, a file) over one that passes a value along. List
   the picks in `pick` in run order (ascending `step`).
2. Write `intro`, at most 3 sentences. Say what the program does in this run and the idea that
   makes it work, as the run shows it.
3. For each chapter that holds a pick, write a `title` of 2 to 5 words that names the phase in
   plain English. Add a `text` of 1 or 2 sentences that says what this part of the run does and
   why the run needs it.
4. For each pick, write a `title` (under 10 words) and a `text` of 1 to 3 sentences. Open with
   the "so what", which is why this moment matters for the result. Then say what the values show.
5. To quote a long value, quote it by range: `"quote": {"field": "<value id>", "from": <int>,
   "to": <int>}`, with offsets into that value's full text. Take the offsets from an `evidence`
   window, or from inside the visible `text`. The checker cuts the quoted slice from the recording
   and shows it under your text. Describe the slice in your own words and let the quote carry
   the exact characters. Keep a quote under about 300 characters.
6. Copy every number exactly as it appears in that stop's values, its statement or its quote:
   the same digits, with no rounding, no converted units, and no totals you computed. Thousands
   separators are fine (`23,567` matches `23567`). If a number you want to mention is not in
   that stop's values, describe it in words instead ("the second page", "fewer tokens").
   - A chapter's `text` may use numbers from the stops you picked in that chapter, its step
     range, and its `http` and `llm` counts.
   - The `intro` may use numbers from any pick, plus the run's step count and request counts.
   - Refer to stops by what happens at them. Write step numbers and ids only in `pick`,
     `stops` and `quote`.
7. Put function, variable and tool names in `code` backticks, spelled the way TOUR.JSON spells
   them. Put text you copy out of a value in 'single quotes', exactly as it appears in that
   stop's values.

## Output

Reply with one JSON object and nothing else. Leave out Markdown fences and comments.

```
{
  "intro": "...",
  "chapters": {"c2": {"title": "...", "text": "..."}},
  "pick": ["s12-3fa9c1", "s40-77b0de"],
  "stops": {
    "s12-3fa9c1": {"title": "...", "text": "..."},
    "s40-77b0de": {"title": "...", "text": "...", "quote": {"field": "s40-77b0de.v2", "from": 706, "to": 770}}
  }
}
```

`pick` lists the chosen candidate ids in run order. `stops` has one entry for each picked id and
no others. `quote` is optional. `chapters` uses the chapter ids from TOUR.JSON.

## Retry

When the checker rejects a reply, the next message repeats TOUR.JSON and adds YOUR PREVIOUS
REPLY and the checker's list of problems, one per line. Each problem names the stop or chapter
and the field (`s12-3fa9c1.text`, `c2.title`, `intro`). Reply with the whole corrected JSON
object. Fix each listed problem by rewording or by dropping the claim, and keep every other
part of the reply as it was.

TOUR.JSON:
