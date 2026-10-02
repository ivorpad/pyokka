import { expect, test } from 'claude-code/testing'

import { CONTEXT_29, CONTEXT_64, INVOICES_SOURCE, ORIGIN_UNKNOWN } from './fixtures'
import { TOOL_SPEC } from '../hooks/keys'
import { BAND, engine, newWorld, pk, PROGRAM, steps } from './world'

// `/pk <key>`, the band's buttons and the model's `band` tool all end in the same `press`.

const BAND_TOOL = 'mcp__pyokka-band__band'
const mountBand = () => ({ plugin: 'pyokka-band', surface: 'terminal', component: 'AbovePrompt', props: BAND }) as const
const PLAN = '/work/.pyokka/findings/invoices-swallowed-exception-invoices-py-34.md'
// What the fixer model answered for this finding (checked by hand: the right fix).
const FIX_REPLY = JSON.stringify({
  explanation: 'The function parse_price keeps "1,299.00" as text. The fix removes the comma before the number check.',
  edits: [{ start: 16, end: 16, replacement: `    text = raw.strip('"').replace(",", "")` }],
})

test('/pk moves the Time Machine: n b i o and a step number', async ($, on) => {
  const w = newWorld()
  engine(on, w)
  for (const key of ['n', 'b', 'i', 'o', '29']) await $.command.run(pk(key))
  expect(steps(w)).toEqual(['--over --live', '--back --live', '--into --live', '--out --live', '--to 29 --live'])
})

test('/pk with no key or an unknown one answers with the keys', async ($, on) => {
  engine(on, newWorld())
  expect((await $.command.run(pk('')))?.text).toStartWith('/pk n next · b back')
  expect((await $.command.run(pk('zz')))?.text).toContain('f plan a fix')
})

test('/pk f on a step with no finding says where the findings are', async ($, on) => {
  const w = newWorld()
  w.context = CONTEXT_29
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka step --live --to 29' })
  expect((await $.command.run(pk('f')))?.text).toBe('No finding on this step: /pk x lists them')
})

test('the band buttons press the same keys', async ($, on) => {
  const w = newWorld()
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka step --live --to 64' })
  const ui = await $.ui.mount(mountBand())
  await ui.press({ key: 'explain-n' })
  await ui.press({ key: 'explain-b' })
  expect(steps(w)).toEqual(['--over --live', '--back --live'])
  await ui.unmount()
})

test('narration: the small model explains each new step, and p turns it off', async ($, on) => {
  const w = newWorld()
  w.replies.haiku = 'The function subtotal adds qty times unit_price for each item. The sum fails on the text 1,299.00.'
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka step --live --to 64' })
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: /^The function subtotal adds qty/ })).toBeDefined()
  await $.command.run(pk('p'))
  expect(await ui.find({ type: 'Text', text: /^The function subtotal adds qty/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: 'prose off' })).toBeDefined()
  await ui.unmount()
})

test('tool: show reports the step, hide hides the band, session is passed on', async ($, on) => {
  const w = newWorld()
  engine(on, w)
  const shown = await $.tool.call({ tool: BAND_TOOL, action: 'show', session: 'invoices.py' })
  expect(JSON.stringify(shown)).toContain('The band shows invoices.py:34 at step 64 of 81 in subtotal, 1 bug finding(s) in this run.')
  expect(w.runs[0]).toEqual(['pyokka', 'context', '--json', '--live', '--session', 'invoices.py'])
  const hidden = await $.tool.call({ tool: BAND_TOOL, action: 'hide' })
  expect(JSON.stringify(hidden)).toContain('The band is hidden.')
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: /invoices\.py/ })).toBeUndefined()
  await ui.unmount()
})

test('tool: step moves the Time Machine, bugs opens the bugs view', async ($, on) => {
  const w = newWorld()
  engine(on, w)
  await $.tool.call({ tool: BAND_TOOL, action: 'step', step: 63 })
  expect(steps(w)).toEqual(['--to 63 --live'])
  await $.tool.call({ tool: BAND_TOOL, action: 'bugs' })
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: 'pyokka bugs ' })).toBeDefined()
  await ui.unmount()
})

test('w: where from, under the finding: newest first, the root marked, inferred links dim', async ($, on) => {
  const w = newWorld()
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka step --live --to 64 --session invoices.py' })
  await $.command.run(pk('w'))
  expect(w.runs).toContainEqual(['pyokka', 'origin', '--json', '64', '--live', '--session', 'invoices.py'])
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: 'where from, newest first:' })).toBeDefined()
  const links = await ui.findAll({ type: 'Button', text: /^[▶ ] #\d+ / })
  expect(links.map(b => b.text.match(/#(\d+)/)?.[1])).toEqual(['64', '61', '52', '26', '29', '28', '26', '24', '23', '6', '4', '0'])
  expect(links[0]?.text).toStartWith(`  #64 invoices.py:34 subtotal  items[0]["unit_price"] = '1,299.00'  (read)`)
  expect(links[4]?.text).toMatch(/^▶ #29 invoices\.py:18 parse_price  return float\(text\) .*…  \(return\)  ◀ root$/)
  expect(links[4]?.props.variant).toBe('primary')
  expect(links[3]?.props.dimColor).toBe(true) // element, inferred
  expect(links[1]?.props.dimColor).toBe(false) // argument, recorded
  expect(await ui.find({ type: 'Text', text: 'root: #29 invoices.py:18 parse_price: parse_price returned a str here; its other 5 calls returned a float' })).toBeDefined()
  // a link moves the Time Machine to its step
  await ui.press({ key: 'origin-4' })
  expect(steps(w)).toContain('--to 29 --live --session invoices.py')
  await ui.unmount()
})

test('w again hides the chain; the button says which', async ($, on) => {
  const w = newWorld()
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka step --live --to 64' })
  const ui = await $.ui.mount(mountBand())
  await ui.press({ key: 'explain-w' })
  expect(await ui.find({ type: 'Button', text: 'hide where from' })).toBeDefined()
  await ui.press({ key: 'explain-w' })
  expect(await ui.find({ type: 'Text', text: 'where from, newest first:' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: 'where from' })).toBeDefined()
  await ui.unmount()
})

test('w: a chain with no root says root: not known, and why', async ($, on) => {
  const w = newWorld()
  w.origin = ORIGIN_UNKNOWN
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka step --live --to 64' })
  await $.command.run(pk('w'))
  const ui = await $.ui.mount(mountBand())
  expect(await ui.findAll({ type: 'Button', text: /^[▶ ] #\d+ / })).toHaveLength(3)
  expect(await ui.find({ type: 'Button', text: /◀ root/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^root: not known\. no statement before #52/ })).toBeDefined()
  await ui.unmount()
})

test('w: a pyokka without origin says so in the band', async ($, on) => {
  const w = newWorld()
  w.origin = "pyokka: error: argument command: invalid choice: 'origin'"
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka step --live --to 64' })
  await $.command.run(pk('w'))
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: "where from: pyokka: error: argument command: invalid choice: 'origin'" })).toBeDefined()
  await ui.unmount()
})

test('w on a step with no finding says where the findings are', async ($, on) => {
  const w = newWorld()
  w.context = CONTEXT_29
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka step --live --to 29' })
  expect((await $.command.run(pk('w')))?.text).toBe('No finding on this step: /pk x lists them')
})

test('tool: origin returns the chain and the root to the model, and the band shows it', async ($, on) => {
  const w = newWorld()
  engine(on, w)
  const said = JSON.stringify(await $.tool.call({ tool: BAND_TOOL, action: 'origin' }))
  expect(said).toContain('newest step first')
  expect(said).toContain('Root: #29 invoices.py:18: parse_price returned a str here')
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Button', text: /◀ root/ })).toBeDefined()
  await ui.unmount()
})

test('tool: the agent can plan a fix but not apply one; applying stays /pk a', async () => {
  expect(TOOL_SPEC.inputSchema.properties.action.enum).toEqual(['show', 'hide', 'step', 'explain', 'bugs', 'origin', 'fix'])
  expect(TOOL_SPEC.description).toContain('`/pk a`')
})

test('tool: fix with no finding on the step says how to list them', async ($, on) => {
  const w = newWorld()
  w.context = CONTEXT_29
  engine(on, w)
  const said = await $.tool.call({ tool: BAND_TOOL, action: 'fix' })
  expect(JSON.stringify(said)).toContain('No bug was found on the current step.')
})

test('fix: plan, check on a copy, apply, the fresh run marks the plan fixed, undo', async ($, on) => {
  const w = newWorld()
  w.replies.sonnet = FIX_REPLY
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka step --live --to 64' })
  const said = await $.tool.call({ tool: BAND_TOOL, action: 'fix' })
  expect(JSON.stringify(said)).toContain(`Fix plan written to ${PLAN}`)

  // the patched copy ran from .pyokka/band-tmp next to the program, which stayed as it was
  expect(w.runs).toContainEqual(['python3', '/work/.pyokka/band-tmp/invoices.py'])
  expect(w.files.get('/work/.pyokka/band-tmp/invoices.py')).toContain(`text = raw.strip('"').replace(",", "")`)
  expect(w.files.get(PROGRAM)).toBe(INVOICES_SOURCE)
  const plan = w.files.get(PLAN) ?? ''
  expect(plan).toStartWith('---\nstatus: open\n')
  expect(plan).toContain('- swallowed exceptions: 1 -> 0')
  // the band asked `pyokka origin` first, and the fixer and the plan got the chain
  const fixerPrompt = w.prompts.find(p => p.startsWith('A Python program ran')) ?? ''
  expect(fixerPrompt).toContain('Fix the step marked root, not the line that raised.')
  expect(fixerPrompt).toContain('#29 invoices.py:18 parse_price: return float(text)')
  expect(plan).toContain('## Where from')
  expect(plan).toContain('- output after: `4 invoices, revenue 1398.79 / average invoice 349.70`')
  expect(w.toasts).toContain('Fix plan written: .pyokka/findings/invoices-swallowed-exception-invoices-py-34.md')

  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: 'fix plan' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\+  16      text = raw\.strip/ })).toBeDefined()

  // the recording of the patched file: 80 steps and no exceptions (`pyokka run` on it says so)
  w.context = { ...CONTEXT_64, count: 80 }
  w.exceptions = { rows: [] }
  await ui.press({ key: 'fix-a' })
  expect(w.files.get(PROGRAM)).toContain(`text = raw.strip('"').replace(",", "")`)
  expect(w.runs).toContainEqual(['pyokka', 'debug', PROGRAM, '--record', '--no-focus'])
  const fixed = w.files.get(PLAN) ?? ''
  expect(fixed).toContain('status: fixed\n')
  expect(fixed).toContain('(80 steps) no longer shows this finding.')
  expect(w.toasts).toContain('invoices-swallowed-exception-invoices-py-34.md: fixed')

  await $.command.run(pk('u'))
  expect(w.files.get(PROGRAM)).toBe(INVOICES_SOURCE)
  await ui.unmount()
})

test('fix: a model with no answer leaves a failed box with try again', async ($, on) => {
  const w = newWorld()
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka step --live --to 64' })
  await $.command.run(pk('f'))
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: 'fix failed: Error: no answer: empty-reply' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'try again' })).toBeDefined()
  expect(w.files.has(PLAN)).toBe(false)
  await ui.unmount()
})

// What an extension older than the CLI answers to a request it does not serve, as `--json` prints it.
const OLD_EXTENSION = '{"ok": false, "error": "unknown request \\"recording\\"", "hint": "type is one of state, step, context"}'

test('errors read as words everywhere: the origin chain and the bug scan never show raw JSON', async ($, on) => {
  const w = newWorld()
  w.origin = OLD_EXTENSION
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka step --live --to 64' })
  await $.command.run(pk('w'))
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: /^where from: The VS Code extension is older than this CLI \(no recording request\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\{"ok"/ })).toBeUndefined()
  // the bug scan, asked again by x, fails the same way
  w.exceptions = OLD_EXTENSION
  await ui.press({ key: 'explain-x' })
  expect(await ui.find({ type: 'Text', text: /^The VS Code extension is older than this CLI \(no recording request\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\{"ok"/ })).toBeUndefined()
  await ui.unmount()
})
