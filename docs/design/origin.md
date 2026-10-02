# `pyokka origin`: where a bad value was made

Asked for on 2026-10-02 (`handoffs/2026-10-02-pyokka-band.md`, "Where from"). `why` explains one
statement and stops at a function's parameter. `origin` follows one value back across calls and
containers to the statement that gave it its failing form, and says how sure each step of that
walk is.

Code: `python/pyokka_runtime/agent/origin/` (walk, containers, pick, root, need, text) and
`agent/reprs.py`. Tests: `python/tests/test_origin.py` over `python/tests/fixtures/origin/`.

## Ablation: what a `--record-locals` recording holds

Measured on invoices.py (`python/tests/fixtures/origin/invoices.py`, the stray `b` on line 34 removed), 81 steps, caught
`TypeError` at #64.

| fact | where | footing |
|---|---|---|
| each step's statement, scope, depth | `trace.steps` | exact |
| each call: scope, parent, first and last step, `returned` text | `trace.scopes` | exact |
| the call site of a scope | the parent's last step before the scope's first (`MomentBuilder.call_site`) | exact for a call written in the statement; a callback's parent can be too shallow |
| a local's value after each statement that changed it | `locals` entries, as `repr` text | text only, cut to a length budget and at a nesting depth (`[{...}, {...}]`) |
| which statement changed it | `History.attribute` (the scope's previous step, when its AST binds the name) | exact for a binding; a change in place (`d[k] = v`, `xs.append(v)`) is seen only when the container's length changes |
| what a statement reads, assigns and calls | `bindings.py`, from the AST | exact, static |
| the exception: type, message, raising step, handler | `error` events | exact |

What it does not hold:

- **Object identity.** A value is text. Two objects with the same text cannot be told apart, and
  an element of a container cannot be tied to the local it was before it went in.
- **Which arm of `a if c else b` ran.** The instrumenter counts the arms (`_pk_c(6)`, `_pk_c(7)`)
  as coverage, not per step.
- **Comprehension variables.** `order` in `{n: f(order) for n, order in orders.items()}` has no
  step of its own, so no locals entry.
- **Element-level detail of deep or long containers.** `orders` at #51 reads
  `{'Ana': {'items': [{...}, {...}], ...` and is cut after a few keys.

## Each link kind, tried on invoices.py #64

| link | how it is found | result on #64 | footing |
|---|---|---|---|
| parameter to argument | scope's call site, the `Call` in its AST whose callee is the scope's name, the parameter bound by keyword or position (`self` to the receiver) | `items` to `order["items"]` at #61, `order` to `order` at #52 | **recorded** |
| name to its statement | `History.value_at`, then the statement's AST | `text` to #28, `price` to #24, `rows` to #6 | **recorded** |
| call result to `return` | the scope entered at that site with that name, its last step, the `Return` node | `parse_price(price)` to #29 | **recorded**; several same-name calls at one site are told apart by returned text (**inferred**) |
| loop variable to iterable | the `For` node at the producing step | `row` to `rows` at #23 | **recorded** |
| element of a container | when the container is followed with a path (`order["items"][0]["unit_price"]`) and its producer is an argument, a return or a plain assignment, the path rides along. Where that stops (here: `order` is a comprehension variable at #52) every statement before it that inserts into a container (`{"k": v}`, `x["k"] = v`, `append`, `setdefault`) is checked for the same key and a value whose recorded text equals the carried text | #26 `"unit_price": parse_price(price)`, whose call returned `'1,299.00'` | **inferred**: key and text, not identity |
| a branch of `a if c else b` | the arm whose recorded value equals the carried text | `text` arm at #29 | **inferred** |
| a value computed by code with no steps (`raw.strip('"')`) | its only recorded input; with several, the one whose text contains the carried string | `raw` at #28, `row` at #24, `csv_text` at #6 | **inferred** (one input), **text match** (several) |
| the line of a multi-line literal | the line holding a string the chain carried | `ORDERS_CSV` line 6 | **text match** |
| a container filled in place | not possible: `xs.append(v)` is not a binding, and the container's text at its creation (`[]`) never equals its text later | `origin 64 items` stops at #52 | none; the command says `root: not known` |

The chain on #64 matches the target in the handoff: #64, #61, #52, #26, #29 (root), #28, #26,
#24, #23, #6, #4, #0 at invoices.py:6.

## The root

The root is the first link, walking forward in time, from which the value has the form that
failed. Two rules, in order:

1. **Sibling runs.** Among the links that carry the failing value unchanged, the earliest one whose
   statement produced a value that fits on its other runs: the same function's other `returned`
   texts for a `return` link, the same statement's other recorded values for an `assigned` or
   `argument` link. `parse_price` returned `float` five times and `str` once, so #29 is the root,
   not #28 (`text` is a `str` on every run). The reason names the count.
2. **Otherwise the earliest maker.** The earliest link that already carries the failing value and
   made it (`assigned`, `return`, `element`, `literal`). A chain that stops at an argument or a
   read has no maker: `root` is `null` and `rootUnknown` says why.

"Fits" comes from the error: a number for `int + str`, the type named in `can only concatenate`,
anything but `None` for an `AttributeError` or a `TypeError` on `NoneType`, a dict with the key
for a `KeyError`, a sequence longer than the index for an `IndexError`. With `EXPR` and no error,
rule 1 asks for a different type on the other runs.

## Which value an error is about

Read from the failing statement's AST and the values recorded at its step, a comprehension's
variable fanned out over its iterable's elements:

- `TypeError` with two types: the access chain whose value has the odd type (the non-number
  beside a number; the second type otherwise), the longest chain first. `item["unit_price"]`
  over `items` gives `items[0]["unit_price"]`.
- `KeyError`: the subscript whose key equals the message's key, on a dict without it.
- `AttributeError`: the base of the attribute named in the message, when it has the named type.
- `IndexError`: the subscript with an integer key past the end of its sequence.
- Otherwise, and at a step with no exception, the statement's reads are listed and `EXPR` picks.

## Not done

- **`suspects` findings** as a starting point: that branch (`worktree-bugs`, 994f73a) is not merged.
- **Attribute paths into objects** (`self.cart.items[0]`): an object's repr does not show its
  fields, so the walk follows the base name and drops the path.
- **Done since, in the band** (`claude-plugin/pyokka-band`): `w`, `/pk w` and the tool action
  `origin` call `origin --live --json STEP` on a finding's step and draw the chain; `proposeFix`
  gets the chain and aims at `links[root.index]`.

## Recorder changes that would make inferred links exact

None of these are needed for the command to be honest; each turns an `inferred` link into a
`recorded` one.

- **Object ids with locals.** `tracer._record_locals` already computes `(id(value), len(value))`
  as its change marker. Writing the id into the entry would tie a local to the same object
  elsewhere while both live (ids are reused after collection). It does not reach an element inside
  a container unless the serializer also writes element ids, which costs per element.
- **The arm of a conditional expression per step.** The arms are instrumented already; recording
  which one ran at the step would make the branch link exact.
- **Changes in place per statement.** The work item in `docs/HANDOFF.md` ("Make a container's
  re-bind visible") would let a container filled by `append` be traced to its statements.
