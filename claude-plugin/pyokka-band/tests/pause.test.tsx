import { expect, test } from 'claude-code/testing'

import { CRASH_SOURCE, PAUSED_CRASH, PAUSED_OVER, PAUSED_SUBTOTAL } from './fixtures'
import { NEEDS_RECORDING } from '../hooks/parse'
import { BAND, engine, newWorld, pk, steps } from './world'

// The band at a `pyokka debug FILE` pause with nothing recorded (`recording: false`,
// docs/design/live-pause-context.md). The fixtures are what test/e2e/debug-band.test.js read
// from a real VS Code at a breakpoint in invoices.py and at crash.py's uncaught KeyError.

const BAND_TOOL = 'mcp__pyokka-band__band'
const mountBand = () => ({ plugin: 'pyokka-band', surface: 'terminal', component: 'AbovePrompt', props: BAND }) as const
const CONTEXT_OFF = '{"ok": false, "error": "context needs step or file/line while the Time Machine is not active", "hint": "send {step: N}"}'

const pausedWorld = () => {
  const w = newWorld()
  w.context = PAUSED_SUBTOTAL
  return w
}

test('a pause without a recording: place, tag, code, the frame with shapes, the stack', async ($, on) => {
  const w = pausedWorld()
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka debug invoices.py --at subtotal' })
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: 'invoices.py:34' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · subtotal' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'paused · no recording' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ #\d+\/\d+$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '▶34 ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /return sum\(item\["qty"\]/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  items  ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'list[2]  ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\[\{'qty': 2, 'sku': 'KB-01'/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '<module> › main › invoice_total › subtotal' })).toBeDefined()
  // the moves that execute, and record from here; nothing that reads history
  expect(await ui.find({ type: 'Button', text: 'record from here' })).toBeDefined()
  for (const label of ['next', 'into', 'out']) expect(await ui.find({ type: 'Button', text: label })).toBeDefined()
  for (const label of ['back', 'bugs', 'plan a fix', 'where from']) expect(await ui.find({ type: 'Button', text: label })).toBeUndefined()
  await ui.unmount()
  // `pyokka debug FILE` names the session to follow, and a pause has no run to scan for bugs
  expect(w.runs[0]).toEqual(['pyokka', 'context', '--json', '--live', '--session', 'invoices.py'])
  expect(w.runs.some(r => r[1] === 'exceptions' || r[1] === 'suspects')).toBe(false)
})

test('n, i and o step the program, and the band reads the next pause', async ($, on) => {
  const w = pausedWorld()
  w.afterStep = PAUSED_OVER
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka context --live' })
  for (const key of ['n', 'i', 'o']) await $.command.run(pk(key))
  expect(steps(w)).toEqual(['--over --json --live', '--into --json --live', '--out --json --live'])
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: /'unit_price': '1,299\.00'/ })).toBeDefined()
  await ui.unmount()
})

test('b, a step number, x, w and f say in one line that they need a recording', async ($, on) => {
  const w = pausedWorld()
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka context --live' })
  for (const key of ['b', '12', 'x', 'w', 'f']) {
    expect((await $.command.run(pk(key)))?.text).toBe(NEEDS_RECORDING)
  }
  expect(steps(w)).toEqual([])
  expect(w.runs.some(r => r[1] === 'origin')).toBe(false)
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: NEEDS_RECORDING })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'pyokka bugs ' })).toBeUndefined()
  await ui.unmount()
})

test('r records from here: the plain run stops, and a --record-from run pauses on this line', async ($, on) => {
  const w = pausedWorld()
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka context --live --session invoices.py' })
  const ui = await $.ui.mount(mountBand())
  await ui.press({ key: 'explain-r' })
  await ui.unmount()
  const stop = w.runs.findIndex(r => r[1] === 'stop')
  const debug = w.runs.findIndex(r => r[1] === 'debug')
  expect(w.runs[stop]).toEqual(['pyokka', 'stop', '--json', '--live', '--session', 'invoices.py'])
  expect(w.runs[debug]).toEqual(['pyokka', 'debug', '/work/invoices.py', '--record-from', '/work/invoices.py:34', '--no-focus'])
  expect(stop).toBeLessThan(debug)
  expect(w.toasts).toContain('Recording invoices.py from line 34: the program runs again from the top')
  expect(w.runs.some(r => r[1] === 'debug' && r.includes('--record'))).toBe(false)
})

test('a step that fails keeps the pause on screen and says why in words', async ($, on) => {
  const w = pausedWorld()
  w.step = '{"ok": false, "error": "cannot step over: the program is running", "hint": "`pause --live` stops it"}'
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka context --live' })
  await $.command.run(pk('n'))
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: 'paused · no recording' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'The step did not run: cannot step over: the program is running' })).toBeDefined()
  await ui.unmount()
})

test('a step that runs the program to its end says so, with the exit code', async ($, on) => {
  const w = pausedWorld()
  w.step = { finished: { exitCode: 0, durationMs: 12, stepCount: 80 } }
  w.afterStep = CONTEXT_OFF
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka context --live' })
  await $.command.run(pk('o'))
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: /The program finished \(exit 0\)\. Press r to record the file from the top\./ })).toBeDefined()
  await ui.unmount()
})

test('a pause that ended elsewhere: the band says the pause is over, not that the Time Machine is off', async ($, on) => {
  const w = pausedWorld()
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka context --live' })
  w.context = CONTEXT_OFF
  await $.tool.call({ tool: 'Bash', command: 'pyokka state --live' })
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: /The debug pause is over/ })).toBeDefined()
  await ui.unmount()
})

test('an uncaught exception: ⚠ with its type and message, and the prose is told', async ($, on) => {
  const w = newWorld()
  w.context = PAUSED_CRASH
  w.files.set('/work/crash.py', CRASH_SOURCE)
  w.replies.haiku = 'The function tier_of reads tiers["Ben"]. The dict tiers has no key "Ben", so the line raises KeyError.'
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka context --live --session crash.py' })
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: "uncaught KeyError: 'Ben'" })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'dict[1]  ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^The function tier_of reads/ })).toBeDefined()
  await ui.unmount()
  const prompt = w.prompts[0] ?? ''
  expect(prompt).toContain('A person pauses a running Python program in a debugger.')
  expect(prompt).toContain('Stopped at crash.py:2, in tier_of, where the line raised an exception')
  expect(prompt).toContain("Variables in the paused frame: customer (str) = 'Ben'; tiers (dict[1]) = {'Ana': 'gold'}")
  expect(prompt).toContain("nobody catches it, so it ends the program: KeyError: 'Ben'")
  expect(prompt).toContain('Simplified Technical English')
})

test('tool: show describes the pause; step, bugs, origin and fix say they need a recording', async ($, on) => {
  const w = pausedWorld()
  engine(on, w)
  const shown = JSON.stringify(await $.tool.call({ tool: BAND_TOOL, action: 'show', session: 'invoices.py' }))
  expect(shown).toContain('The band shows invoices.py:34 in subtotal, paused (breakpoint) without a recording.')
  for (const call of [{ action: 'step', step: 3 }, { action: 'bugs' }, { action: 'origin' }, { action: 'fix' }]) {
    const said = JSON.stringify(await $.tool.call({ tool: BAND_TOOL, ...call }))
    expect(said).toContain('without a recording')
    expect(said).toContain('The person can press r (or /pk r) to record from here.')
  }
  expect(steps(w)).toEqual([])
  expect(w.runs.some(r => ['origin', 'exceptions', 'suspects'].includes(r[1] ?? ''))).toBe(false)
})
