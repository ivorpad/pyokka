import { expect, test } from 'claude-code/testing'

import { errorMessage, shapeOf, statementLines, stepOutcome, toFindings, toOrigin, toSpot } from '../hooks/parse'
import type { RawFinding } from '../hooks/parse'
import {
  CONTEXT_29,
  CONTEXT_64,
  CONTEXT_STALE,
  EXCEPTIONS_CAUGHT,
  EXCEPTIONS_UNCAUGHT,
  INVOICES_SOURCE,
  ORIGIN_64,
  ORIGIN_UNKNOWN,
  PAUSED_CRASH,
  PAUSED_SUBTOTAL,
  SUSPECTS,
} from './fixtures'

// Each shape the band reads, as the CLI printed it for tests/programs/invoices.py.

test('context: the failing step of subtotal becomes a spot with the stack and its values', async () => {
  const spot = toSpot(CONTEXT_64)
  expect(spot).toMatchObject({ file: 'invoices.py', path: '/work/invoices.py', line: 34, step: 64, count: 81, function: 'subtotal', stale: false })
  expect(spot?.text).toBe('return sum(item["qty"] * item["unit_price"] for item in items)')
  expect(spot?.stack.map(f => f.function)).toEqual(['subtotal', 'invoice_total', 'main', '<module>'])
  // line 34 records nothing itself (it raises): the latest value in the block stands in
  expect(spot?.values).toEqual([
    "items = [{'qty': 1, 'sku': 'MON-27', 'unit_price': '1,299.00'}, {'qty': 3, 'sku': 'CBL-02', 'unit_price': 7.5}]",
  ])
  expect(spot?.inline['33']?.hits).toBe(1)
})

test('context: values of the current line come first, and each line keeps its latest value', async () => {
  const spot = toSpot(CONTEXT_29)
  expect(spot).toMatchObject({ line: 18, step: 29, function: 'parse_price' })
  expect(spot?.values).toEqual(["text = '1,299.00'"])
  expect(spot?.inline['16']).toEqual({ hits: 1, text: `raw = '"1,299.00"'` })
  expect(spot?.around.find(l => l.current)?.line).toBe(18)
})

test('context: a recording older than the file is stale', async () => {
  expect(toSpot(CONTEXT_STALE)?.stale).toBe(true)
  expect(toSpot(CONTEXT_64)?.stale).toBe(false)
})

test('context: a reply with no location is no spot', async () => {
  expect(toSpot({ step: 3 })).toBe(null)
})

test('exceptions: a caught TypeError is a swallowed exception at the line that raised', async () => {
  const [found] = toFindings(EXCEPTIONS_CAUGHT.rows as RawFinding[])
  expect(found).toMatchObject({ id: 'x0', kind: 'swallowed exception', step: 64, where: 'invoices.py:34', confidence: 'high' })
  expect(found?.reason).toMatch(/^TypeError \(unsupported operand type\(s\) for \+: 'int' and 'str'\) raised in subtotal and swallowed by the except at line 35/)
})

test('exceptions: an uncaught KeyError keeps its type as the kind', async () => {
  const [found] = toFindings(EXCEPTIONS_UNCAUGHT.rows as RawFinding[])
  expect(found).toMatchObject({ kind: 'KeyError', step: 6, where: 'crash.py:2', confidence: 'medium' })
  expect(found?.reason).toBe("KeyError ('Ben') raised in tier_of")
})

test('suspects: each finding keeps its kind, place, reason and confidence', async () => {
  const found = toFindings(SUSPECTS.findings as RawFinding[])
  expect(found.map(f => [f.id, f.kind, f.where, f.step, f.confidence])).toEqual([
    ['f1', 'caught-exception', 'invoices.py:34', 64, 'medium'],
    ['f2', 'dead-store', 'invoices.py:22', 6, 'low'],
  ])
  expect(found[1]?.reason).toMatch(/^header = 'customer,tier,sku,qty,unit_price'/)
})

test('origin: the chain at #64 runs newest first, with the root at parse_price #29', async () => {
  const chain = toOrigin(ORIGIN_64, 'x0')
  expect(chain.links.map(l => l.step)).toEqual([64, 61, 52, 26, 29, 28, 26, 24, 23, 6, 4, 0])
  expect(chain.links.filter(l => l.root).map(l => [l.step, l.where, l.function, l.how])).toEqual([[29, 'invoices.py:18', 'parse_price', 'return']])
  expect(chain.links[3]).toMatchObject({ how: 'element', certainty: 'inferred', expression: 'parse_price(price)', value: "'1,299.00'" })
  expect(chain.links[11]).toMatchObject({ where: 'invoices.py:6', how: 'literal', certainty: 'text match' })
  expect(chain.rootReason).toBe('parse_price returned a str here; its other 5 calls returned a float')
  expect(chain.rootUnknown).toBeUndefined()
})

test('origin: a list filled in place has no root, and says why', async () => {
  const chain = toOrigin(ORIGIN_UNKNOWN, 'x0')
  expect(chain.links.map(l => l.step)).toEqual([64, 61, 52])
  expect(chain.links.some(l => l.root)).toBe(false)
  expect(chain.rootUnknown).toBe('the chain stops before a statement that made the value, so its root is not known')
  expect(chain.end).toMatch(/^no statement before #52 put this value under key 'items'/)
})

test('a statement runs on while its brackets stay open', async () => {
  const source = INVOICES_SOURCE.split('\n')
  expect(statementLines(source, 34)).toEqual([34])
  expect(statementLines(['x = f(', '    1,', ')', 'y = 2'], 1)).toEqual([1, 2, 3])
  // brackets inside strings and comments do not count
  expect(statementLines(['s = "("  # (', 'y = 2'], 1)).toEqual([1])
})

test('a JSON error with the Time Machine off reads as words with the keys that help', () => {
  const said = errorMessage(
    '{"ok": false, "error": "context needs step or file/line while the Time Machine is not active", "hint": "send {step: N}"}',
  )
  expect(said).toBe('The Time Machine is off for this session. Press r to record again, or i to start at step 1.')
  expect(errorMessage('{"ok": false, "error": "no such step"}')).toBe('no such step')
  expect(errorMessage('Error: 2 live sessions; say which\n--session NAME')).toBe('Error: 2 live sessions; say which')
})

test('context at a pause without a recording: the frame\'s variables with their shape, no count, no inline values', async () => {
  const spot = toSpot(PAUSED_SUBTOTAL)
  expect(spot).toMatchObject({ file: 'invoices.py', line: 34, function: 'subtotal', count: 0, stale: false })
  expect(spot?.stack.map(f => f.function)).toEqual(['subtotal', 'invoice_total', 'main', '<module>'])
  expect(spot?.pause?.reason).toBe('breakpoint')
  expect(spot?.pause?.exception).toBeUndefined()
  expect(spot?.pause?.variables.map(v => [v.name, v.shape])).toEqual([['items', 'list[2]']])
  expect(spot?.values[0]).toStartWith("items = [{'qty': 2, 'sku': 'KB-01'")
  expect(spot?.inline).toEqual({})
  // a recorded context has no pause
  expect(toSpot(CONTEXT_64)?.pause).toBeUndefined()
})

test('context at an uncaught exception without a recording: the exception from the pause', async () => {
  const spot = toSpot(PAUSED_CRASH)
  expect(spot?.pause?.exception).toEqual({ type: 'KeyError', message: "'Ben'", uncaught: true })
  expect(spot?.pause?.variables).toEqual([
    { name: 'customer', shape: 'str', text: "'Ben'" },
    { name: 'tiers', shape: 'dict[1]', text: "{'Ana': 'gold'}" },
  ])
})

test('shapes and step outcomes at a pause', async () => {
  expect(shapeOf({ type: 'tuple', length: 3 })).toBe('tuple[3]')
  expect(shapeOf({ type: 'bytes', length: 3 })).toBe('bytes')
  expect(shapeOf({ type: 'int' })).toBe('int')
  expect(shapeOf({})).toBe('')
  expect(stepOutcome({ exitCode: 0, stdout: '{"step": 64}', stderr: '' })).toBeUndefined()
  expect(stepOutcome({ exitCode: 0, stdout: '{"finished": {"exitCode": 1}}', stderr: '' })).toBe('The program finished (exit 1). Press r to record the file from the top.')
  expect(stepOutcome({ exitCode: 2, stdout: '', stderr: '{"ok": false, "error": "session stopped"}' })).toBe('The step did not run: session stopped')
})

test('errorMessage: a JSON error alone or among other lines, and an older extension', async () => {
  expect(errorMessage('{"ok": false, "error": "session stopped", "hint": "h"}')).toBe('session stopped')
  expect(errorMessage('note: something first\n{"ok": false, "error": "session stopped"}\n')).toBe('session stopped')
  expect(errorMessage('error: no live session\nopen the file')).toBe('error: no live session')
  expect(errorMessage('{"ok": false, "error": "unknown request \\"origin\\"", "hint": "type is one of state"}')).toBe(
    'The VS Code extension is older than this CLI (no origin request): install the vsix built from this checkout and run Developer: Reload Window.',
  )
})
