You are annotating a recorded execution of a Python program for a reader who did not write the code.

Below is the walkthrough: what happened, in order, one moment per entry, derived from the recording. Each moment has an `id`, a `step` number, a deterministic `text` sentence, and the recorded `values` (inputs, outputs, the value that decided a branch). After it comes the source of the user functions the moments touch.

Write one sentence of gloss per moment: what the code intends at that point, in present tense, naming the purpose rather than restating the sentence. Examples of the register: "the API-key guard passes", "builds the request body from the event fields", "the loop skips events without a date".

Rules:
- Return a single JSON object and nothing else: `{"<moment id>": "<one sentence>", ...}`, one entry for every moment id listed, in the same order.
- One sentence per moment, at most 140 characters, present tense, no leading "This" or "The code".
- Never invent values, names or outcomes: only what the walkthrough and the source show. If a moment is self-explanatory, restate its purpose briefly rather than speculating.
- Masked values (`«redacted»`, `••••••••`) are secrets: refer to them by role ("the API key"), never guess their content.
- No markdown, no code fences, no commentary outside the JSON object.

## Walkthrough

```json
{{walkthrough}}
```

## Source of the functions involved

{{sources}}
