import { expect, test } from 'claude-code/testing'

import type { Fix } from '../types'
import { applyEdits, diffOf, fixPrompt, readAnswer } from '../hooks/fix'
import { narrationPrompt, STE_RULES } from '../hooks/narration'
import { toFindings, toOrigin, toSpot } from '../hooks/parse'
import type { RawFinding } from '../hooks/parse'
import { fixedText, originAnswer, planPath, planText } from '../hooks/plans'
import { CONTEXT_64, EXCEPTIONS_CAUGHT, INVOICES_SOURCE, ORIGIN_64, ORIGIN_UNKNOWN } from './fixtures'

const spot = toSpot(CONTEXT_64)!
const finding = toFindings(EXCEPTIONS_CAUGHT.rows as RawFinding[])[0]!
const EDIT = { start: 16, end: 16, replacement: `    text = raw.strip('"').replace(",", "")` }

const proposal: NonNullable<Fix> = {
  findingId: finding.id,
  status: 'ready',
  path: spot.path,
  explanation: 'parse_price keeps "1,299.00" as text. The fix removes the comma before the number check.',
  diff: diffOf(INVOICES_SOURCE, [EDIT]),
  patched: applyEdits(INVOICES_SOURCE, [EDIT]),
  original: INVOICES_SOURCE,
  verify: { before: '4 invoices, revenue 209.44', after: '4 invoices, revenue 1398.79', exceptionsBefore: 1, exceptionsAfter: 0 },
}

// What `pyokka origin` said at #64: newest first, root at #29 (parse_price returned the text).
const ORIGIN = toOrigin(ORIGIN_64, finding.id)
// `pyokka origin 64 items`: the list was filled in place, so the chain has no root.
const UNKNOWN = toOrigin(ORIGIN_UNKNOWN, finding.id)

test('a plan is written next to the program, named by file, finding and place', async () => {
  expect(planPath('/work/invoices.py', finding)).toBe('/work/.pyokka/findings/invoices-swallowed-exception-invoices-py-34.md')
})

test('a plan holds front matter, the reproduce commands, the diff and the check', async () => {
  const text = planText(finding, spot, proposal, 'open', '2026-10-02 12:00')
  expect(text).toStartWith('---\nstatus: open\nprogram: invoices.py\nfinding: swallowed exception\nwhere: invoices.py:34\nstep: 64\nrecorded: 81 steps\nupdated: 2026-10-02 12:00\n---\n')
  expect(text).toContain('pyokka step --live --to 64\npyokka why --live 64')
  expect(text).toContain(`-  16      text = raw.strip('"')\n+  16      text = raw.strip('"').replace(",", "")`)
  expect(text).toContain('- swallowed exceptions: 1 -> 0')
  expect(text).toContain('- output after: `4 invoices, revenue 1398.79`')
  expect(text).not.toContain('## Where from')
})

test('a fresh run without the finding rewrites the plan as fixed', async () => {
  const text = fixedText(planText(finding, spot, proposal, 'open', '2026-10-02 12:00'), '2026-10-02 12:30', 80)
  expect(text).toContain('status: fixed\n')
  expect(text).toContain('updated: 2026-10-02 12:30\n')
  expect(text).not.toContain('status: open')
  expect(text).toEndWith('## Fixed\n\nA run recorded at 2026-10-02 12:30 (80 steps) no longer shows this finding.\n')
})

test('with an origin chain, the plan lists it and the prompt asks for the root', async () => {
  const plan = planText(finding, spot, proposal, 'open', '2026-10-02 12:00', ORIGIN.links)
  expect(plan).toContain(`## Where from\n\nNewest first, from \`pyokka origin\`:\n\n- #64 invoices.py:34 subtotal: items[0]["unit_price"] = '1,299.00' (read)`)
  expect(plan).toContain("- #26 invoices.py:28 parse_orders: parse_price(price) = '1,299.00' (element, inferred)")
  expect(plan).toMatch(/- #29 invoices\.py:18 parse_price: return float\(text\) .* = '1,299\.00' \(return\)  root: the value goes wrong here/)
  expect(plan).not.toContain('Root: not known')
  const prompt = fixPrompt(finding, spot, INVOICES_SOURCE, ORIGIN.links)
  // the oldest step first, so the chain reads in the order the run made it
  expect(prompt.indexOf('#0 invoices.py:6')).toBeLessThan(prompt.indexOf('#29 invoices.py:18'))
  expect(prompt.indexOf('#29 invoices.py:18')).toBeLessThan(prompt.indexOf('#64 invoices.py:34'))
  expect(prompt).toContain('Fix the step marked root, not the line that raised.')
  expect(fixPrompt(finding, spot, INVOICES_SOURCE)).not.toContain('marked root')
})

test('a chain with no root says so in the plan and the prompt', async () => {
  expect(planText(finding, spot, proposal, 'open', '2026-10-02 12:00', UNKNOWN.links)).toContain('Root: not known.')
  expect(fixPrompt(finding, spot, INVOICES_SOURCE, UNKNOWN.links)).toContain('The root is not known')
})

test('the tool answer for origin lists the chain and the root, or says it is not known', async () => {
  const told = originAnswer(finding, ORIGIN)
  expect(told).toStartWith('Where the bad value of swallowed exception at #64 invoices.py:34 came from, newest step first:\n#64 ')
  expect(told).toContain('Root: #29 invoices.py:18: parse_price returned a str here; its other 5 calls returned a float')
  expect(originAnswer(finding, UNKNOWN)).toContain('Root: not known. the chain stops before a statement that made the value')
  expect(originAnswer(finding, { findingId: 'x0', step: 64, links: [], error: "invalid choice: 'origin'" }))
    .toBe("pyokka origin gave no chain: invalid choice: 'origin'")
})

test('the fix prompt numbers the file and asks for JSON edits in STE', async () => {
  const prompt = fixPrompt(finding, spot, INVOICES_SOURCE)
  expect(prompt).toContain('  34          return sum(item["qty"] * item["unit_price"] for item in items)')
  expect(prompt).toContain(STE_RULES)
  expect(prompt).toContain("Recorded values near it: items = [{'qty': 1")
})

test('the answer is read from the outermost braces, and empty edits are dropped', async () => {
  const reply = `Here: {"explanation": "x", "edits": [${JSON.stringify(EDIT)}, {"start": 0, "end": 0, "replacement": ""}]} done`
  expect(readAnswer(reply)).toEqual({ explanation: 'x', edits: [EDIT] })
})

test('edits apply from the bottom up, so earlier line numbers stay right', async () => {
  const source = 'a\nb\nc\nd'
  expect(applyEdits(source, [{ start: 1, end: 1, replacement: 'A\nA2' }, { start: 3, end: 4, replacement: 'C' }])).toBe('A\nA2\nb\nC')
})

test('the narration prompt carries the step, the stack, the code and a finding on this step', async () => {
  const prompt = narrationPrompt(spot, 'parse_price returned the text.', finding)
  expect(prompt).toContain('Step 64 of 81, invoices.py:34, in subtotal')
  expect(prompt).toContain('Call stack: <module> -> main -> invoice_total -> subtotal')
  expect(prompt).toContain('> 34          return sum(')
  expect(prompt).toContain('What you said at the previous stop: parse_price returned the text.')
  expect(prompt).toContain('A bug detector found a problem at this step (swallowed exception)')
})
