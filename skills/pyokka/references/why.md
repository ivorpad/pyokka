# Reading a `why` answer

`pyokka why RUN STEP NAME` (or `--live`) prints the tree, one sentence of conclusion, then a
summary of one to four lines. Read the summary first. It names the cause when the recording saw
one, and it names the next command when the recording could not see it. Every value and step in
it comes from the tree, and a sentence that does not match the tree is not printed.

## The summary's first word

**`answer:`** The recording saw the line that changed the value through another name. Quote it
with its step, and give that step as the cause:

```text
answer: bo['lines'][0], the same object as line, was changed at #23 promo.py:4 in bulk_bonus: line["qty"] += 1.
  It is an input of order, which is {'customer': 'bo', 'lines': [{'price': 1.0, 'qty': 2, 'sku'… at #34 billing.py:5.
  They share it since #17 catalog.py:5.
  order at #34 billing.py:5 is the bo passed at #33 main.py:12.
```

The indented lines say which value it feeds, since when the two names hold the same object, and
which argument each parameter on the way came from.

**`signpost:`** A plain value (a number, a string, a list, a dict) is different at two steps, and
no recorded statement between them gives it the new value. The cause is a change in place that a
default recording does not see. Run the `next:` line, then ask `why` again at the same step:

```text
signpost: bo['lines'][0]['qty'] was 1 at #15 main.py:9, and charge received 2 as order['lines'][0]['qty'] at #34 billing.py:5.
  This recording has no change of bo between #15 main.py:9 and the call at #33 main.py:12.
  This recording sees new values given to names, not changes inside an object. Record again following objects to see the line that changed it.
  next: record again following objects (--follow-objects)
```

Record again with `pyokka run FILE --follow-objects --save RUN`, or `pyokka debug FILE --record
--follow-objects --at NAME` live. Step numbers stay the same only when the program takes the
same path, so find the step again with `var RUN NAME`.

**`summary:`** The recording could not see far enough. Each line names one limit. Do what the
line asks:

| the line says | run |
|---|---|
| `shows nothing inside it` (an object such as `<Cart object at 0x…>`) | record again with `--follow-objects` |
| `This run recorded no locals` | record again without `--no-locals` |
| `stopped keeping changes at its limit` | record less: `run --only GLOB` or `--exclude GLOB`, or `debug FILE --record-from NAME` to start at the function in question |
| `The value is cut` | `why --live STEP NAME --rerun` ([debug.md](debug.md), "At a pause") |
| `The chain goes on past what is shown` | `why RUN STEP NAME` on the deepest node's name and step, or `--depth N` |
| `made before the recording started, at #0` | the stop's `locals:` at the pause where the recording began |

**No summary line.** Nothing in the chain changed through another name or differs from what a
call received. The tree's first line and the statement under it are the answer.

## `passed X at #N` on a parameter

A parameter's line ends with the argument the call site passed for it:

```text
order = {'customer': 'bo', …}   #34 billing.py:5 charge   def charge(self, order):   passed bo at #33 main.py:12 main
  ← bo = {'customer': 'bo', …}   #23 promo.py:4 bulk_bonus   line["qty"] += 1
```

The line under it explains `bo` in the caller, so the tree goes on across the call. It works
for methods (the receiver is `self`), keywords, `*args` and `**kwargs`, `super().__init__`,
inherited `__init__`, `__new__`, property getters, functions kept in a variable, and two calls of
one function in one statement.

A parameter without `passed` has no argument the source can name: a callback (`sorted(rows,
key=f)`, `map(f, xs)`), a decorator's wrapper, a dunder that Python calls itself (`__eq__`,
`__getitem__`), a default value, or a call in a loop, a comprehension or `and`/`or` that calls
the same function more than once. For these, `pyokka step RUN STEP --back-out` lands on the
call, and `origin RUN STEP EXPR` follows one value across the call.

## At a pause

A recording made at a pause (`debug --record`, `--record-from`, `record --live`) can miss the
value that the statement just before the pause made, until the run goes on. This was seen once
and is not yet reproduced. When `why --live` at the pause shows `= ?` or an older value for a
name the stop's `locals:` shows, give the value from `locals:` and say which source it came from.

## JSON

`why --json` adds `summary: {state, headline, details, action?, limits?}` to the tree: `state` is
`answer`, `signpost` or `fallback`; `headline` and each of `details` are lists of pieces (`{t}`
text, `{name}`, `{value, of?, at?, path?}`, `{step, file, line, function}`, `{code}`);
`limits` are `noLocals`, `cap`, `opaque`, `cut`, `chainCut` and `beforeRecording`; `action` is
`followObjects`. A parameter node has `argument: {text, step, file, line, function, statement}`.
The tree has `followObjects: true` when the recording followed objects.
