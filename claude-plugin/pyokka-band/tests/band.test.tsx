import { expect, test } from 'claude-code/testing'

import { CONTEXT_29, CONTEXT_STALE, SUSPECTS } from './fixtures'
import { BAND, engine, newWorld, pk, steps } from './world'

// The band as drawn, from the CLI's real answers. The plugin's state is seeded by driving its
// hooks: a pyokka command in Bash makes it ask the CLI and draw.

const mountBand = (surface: 'terminal' | 'desktop' = 'terminal') =>
  ({ plugin: 'pyokka-band', surface, component: 'AbovePrompt', props: BAND }) as const

test('explain view: place, progress, code, values, stack and the finding on this step', async ($, on) => {
  const w = newWorld()
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka step --live --to 64' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(mountBand(surface))
    expect(await ui.find({ type: 'Text', text: 'invoices.py:34' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' · subtotal' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' #64/81' })).toBeDefined()
    // the source window is read from the file: the current line, with `▶`
    expect(await ui.find({ type: 'Text', text: '▶34 ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /return sum\(item\["qty"\]/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /items = \[\{'qty': 1, 'sku': 'MON-27'/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '<module> › main › invoice_total › subtotal' })).toBeDefined()
    // the finding: counted in the header, marked in the gutter, spelled out under the code
    expect(await ui.find({ type: 'Text', text: '  ⚠ 1' })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: '●' })).toHaveLength(1)
    expect(await ui.find({ type: 'Text', text: /^swallowed exception: TypeError/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'plan a fix' })).toBeDefined()
    await ui.unmount()
  }
})

test('explain view: findings later in the run are ahead, earlier ones reached', async ($, on) => {
  const w = newWorld()
  w.context = CONTEXT_29
  w.suspects = SUSPECTS
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka step --live --to 29' })
  const ui = await $.ui.mount(mountBand())
  // the dead store at step 6 is behind this step, the swallowed TypeError at step 64 ahead
  expect(await ui.find({ type: 'Text', text: '  ⚠ 1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  ○ 1 ahead' })).toBeDefined()
  // line 22 (the dead store) is in the window; line 34 is not
  expect(await ui.findAll({ type: 'Text', text: '●' })).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /^(swallowed exception|caught-exception|dead-store): / })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: 'plan a fix' })).toBeUndefined()
  await ui.unmount()
})

test('a stale recording: a notice, record again, and no findings', async ($, on) => {
  const w = newWorld()
  w.context = CONTEXT_STALE
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka context --live' })
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: /^◌ The file changed since this recording/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⚠/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^(swallowed exception|caught-exception|dead-store): / })).toBeUndefined()
  expect(await ui.findAll({ type: 'Text', text: '●' })).toHaveLength(0)
  await ui.press({ key: 'stale-r' })
  expect(w.runs).toContainEqual(['pyokka', 'debug', '/work/stale/invoices.py', '--record', '--no-focus'])
  await ui.unmount()
})

test('bugs view: the list from suspects, the picked finding, j/k and go to step', async ($, on) => {
  const w = newWorld()
  w.suspects = SUSPECTS
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka step --live --to 64' })
  await $.command.run(pk('x'))
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: 'pyokka bugs ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2 suspicious steps · from suspects' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'caught-exception  invoices.py:34  #64' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'dead-store  invoices.py:22  #6' })).toBeDefined()
  await ui.press({ key: 'bugs-j' })
  expect(await ui.find({ type: 'Text', text: /^header = 'customer,tier/ })).toBeDefined()
  await ui.press({ key: 'bugs-g' })
  expect(steps(w)).toContain('--to 6 --live')
  await ui.press({ key: 'bugs-e' })
  expect(await ui.find({ type: 'Text', text: 'pyokka bugs ' })).toBeUndefined()
  await ui.unmount()
})

test('without suspects the band falls back to exceptions', async ($, on) => {
  const w = newWorld()
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka step --live --to 64' })
  await $.command.run(pk('x'))
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: '1 suspicious step · from exceptions' })).toBeDefined()
  await ui.unmount()
})

test('the CLI saying no session is one dim line', async ($, on) => {
  const w = newWorld()
  w.context = 'no live session\nhint: open VS Code with pyokka.agentAccess on'
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka state --live' })
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: 'pyokka  no live session' })).toBeDefined()
  await ui.unmount()
})

test('the band stays out of the way during a survey, and after 10 idle minutes', async ($, on) => {
  const w = newWorld()
  const clock = engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka step --live --to 64' })
  const survey = await $.ui.mount({ ...mountBand(), props: { ...BAND, hasSurvey: true } })
  expect(await survey.find({ type: 'Text', text: /invoices\.py/ })).toBeUndefined()
  await survey.unmount()
  await clock.advance(11 * 60_000)
  const idle = await $.ui.mount(mountBand())
  expect(await idle.find({ type: 'Text', text: /invoices\.py/ })).toBeUndefined()
  await idle.unmount()
})

test('a Bash command that is not pyokka leaves the band alone', async ($, on) => {
  const w = newWorld()
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'ls pyokka-notes' })
  expect(w.runs).toEqual([])
  await $.tool.call({ tool: 'Bash', command: 'pyokka step --live --to 64 --session invoices.py' })
  expect(w.runs[0]).toEqual(['pyokka', 'context', '--json', '--live', '--session', 'invoices.py'])
})
