/**
 * The names scanner behind the execution graph's statement nodes (`src/session/names.ts`): the
 * targets and reads of a statement's source, string literals and comments handled as the
 * contract's scanner says. `python/pyokka_runtime/agent/names.py` follows the same steps.
 */
import { describe, expect, it } from 'vitest';
import { namesOf, stripCode, stripComments } from '../../src/session/names';

const names = (...lines: string[]): { targets: string[]; reads: string[] } => namesOf(lines);

describe('namesOf', () => {
  it('reads a plain assignment and drops the target from the reads', () => {
    expect(names('event = parse_event(text, year=2026)')).toEqual({ targets: ['event'], reads: ['parse_event', 'text'] });
    expect(names('count = 0')).toEqual({ targets: ['count'], reads: [] });
    expect(names('handled = True')).toEqual({ targets: ['handled'], reads: [] });
  });

  it('blanks string literals, with or without a prefix', () => {
    expect(names('text = "fair|Sep 16|alice,bob"')).toEqual({ targets: ['text'], reads: [] });
    expect(names('p = rf"{base}\\n"')).toEqual({ targets: ['p'], reads: ['base'] });
    // a backslash skips the next character in every literal, raw ones included: `\{` opens no expression
    expect(names('p = rf"C:\\{base}"')).toEqual({ targets: ['p'], reads: [] });
    expect(names("q = b'no names here'")).toEqual({ targets: ['q'], reads: [] });
    expect(names("u = U'\\'still one literal\\' x'")).toEqual({ targets: ['u'], reads: [] });
  });

  it('carries a triple-quoted literal across lines', () => {
    expect(names('doc = """first line', 'second # not a comment', 'third""" + tail')).toEqual({ targets: ['doc'], reads: ['tail'] });
    expect(names("s = '''a", "b''' + c")).toEqual({ targets: ['s'], reads: ['c'] });
  });

  it('keeps the expression parts of an f-string, nested braces and {{ handled', () => {
    expect(names('summary = f"{label} with {count} people on {event.date}"')).toEqual({ targets: ['summary'], reads: ['label', 'count', 'event'] });
    expect(names('print(f"Participant: {person}")')).toEqual({ targets: [], reads: ['print', 'person'] });
    // the format suffix is appended with the expression, so its `f` counts as a read (the contract accepts that)
    expect(names('s = f"{{literal}} {value:{width}.{prec}f} {d[key]}"')).toEqual({ targets: ['s'], reads: ['value', 'width', 'prec', 'f', 'd', 'key'] });
    expect(names('t = f"{a}{b}"')).toEqual({ targets: ['t'], reads: ['a', 'b'] });
  });

  it('ends the line at a # outside a literal only', () => {
    expect(names('x = y  # reads z')).toEqual({ targets: ['x'], reads: ['y'] });
    expect(names('x = "#" + y')).toEqual({ targets: ['x'], reads: ['y'] });
    expect(stripComments(['x = "#" + y  # z', 'w = 1 # 2'])).toEqual(['x = "#" + y  ', 'w = 1 ']);
    expect(stripCode(['text = "fair"  # the fields', ' + more'])).toBe('text = "fair"    + more');
  });

  it('drops keyword-argument names inside brackets but not a depth-0 assignment', () => {
    expect(names('event = Event(', '    name=name,', '    date=f"{date} {year}",', '    participants=participants,', ')')).toEqual({ targets: ['event'], reads: ['Event', 'name', 'date', 'year', 'participants'] });
    expect(names('f(a=b, c=[d, e=f])')).toEqual({ targets: [], reads: ['f', 'b', 'd', 'f'].filter((n, i, all) => all.indexOf(n) === i) });
  });

  it('does not take ==, <=, !=, >= or := for an assignment', () => {
    expect(names('a == b')).toEqual({ targets: [], reads: ['a', 'b'] });
    expect(names('check(a <= b, c != d, e >= f)')).toEqual({ targets: [], reads: ['check', 'a', 'b', 'c', 'd', 'e', 'f'] });
    expect(names('if (n := len(items)) > 3: pass')).toEqual({ targets: [], reads: ['n', 'len', 'items'] });
    expect(names('a = b == c')).toEqual({ targets: ['a'], reads: ['b', 'c'] });
  });

  it('keeps the target of an augmented assignment among the reads', () => {
    expect(names('count += 1')).toEqual({ targets: ['count'], reads: ['count'] });
    expect(names('total //= step ** 2')).toEqual({ targets: ['total'], reads: ['total', 'step'] });
    expect(names('m @= other')).toEqual({ targets: ['m'], reads: ['m', 'other'] });
  });

  it('takes tuple and annotated targets', () => {
    expect(names('name, date, people = text.split("|")')).toEqual({ targets: ['name', 'date', 'people'], reads: ['text'] });
    expect(names('total: float = start')).toEqual({ targets: ['total'], reads: ['float', 'start'] });
    expect(names('a = b = 1')).toEqual({ targets: ['a'], reads: ['b'] });
  });

  it('assigns no name through an attribute, subscript or starred target and reads the base', () => {
    expect(names('self.name = name')).toEqual({ targets: [], reads: ['self', 'name'] });
    expect(names('d[k] = v')).toEqual({ targets: [], reads: ['d', 'k', 'v'] });
    expect(names('first, *rest = items')).toEqual({ targets: [], reads: ['first', 'rest', 'items'] });
    expect(names('(a) = b')).toEqual({ targets: [], reads: ['a', 'b'] });
  });

  it('skips attribute names and keywords', () => {
    expect(names('label = shout(event.name)')).toEqual({ targets: ['label'], reads: ['shout', 'event'] });
    expect(names('return word.upper() if word is not None else None')).toEqual({ targets: [], reads: ['word'] });
    expect(names('raise ValueError("empty") from None')).toEqual({ targets: [], reads: ['ValueError'] });
    expect(names('x = lambda n: n * 2')).toEqual({ targets: ['x'], reads: ['n'] });
  });
});
