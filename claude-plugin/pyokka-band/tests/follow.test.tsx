import { expect, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'

import { BAND, engine, newWorld } from './world'
import type { World } from './world'

// Which live session the band reads: the one this Claude Code session's agent started or named
// last, held in the session's state, and never one picked among several.

const BAND_TOOL = 'mcp__pyokka-band__band'
const DESCRIPTOR = '/h/.pyokka/sessions/41-2.json'
const mountBand = () => ({ plugin: 'pyokka-band', surface: 'terminal', component: 'AbovePrompt', props: BAND }) as const
/** The `--session` of each `context` the band ran, in order; undefined for none. */
const contexts = (w: World) => w.runs.filter(r => r[1] === 'context').map(r => (r.includes('--session') ? r[r.indexOf('--session') + 1] : undefined))
/** A second plugin that says what the band holds: any plugin reads any value, its owner alone writes it. */
const PEEK = {
  name: 'peek',
  register: on => {
    on('session.start', async ($, e, next) => {
      $.command.register({ name: 'peek', description: 'what the band follows' })
      return next(e)
    })
    on('command.run', { command: 'peek' }, async $ => ({ text: JSON.stringify((await $.state.get({ plugin: 'pyokka-band', key: 'followed' })).value ?? null) }))
  },
} satisfies Plugin
const held = async ($: Engine) =>
  JSON.parse((await $.command.run({ command: 'peek', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }))?.text ?? 'null')
const gone = (session: string) => JSON.stringify({ ok: false, error: `no live session for ${session}`, hint: 'live sessions: run invoices.py (pid 4, invoices.py) /h/.pyokka/sessions/4-1.json' })

test('a plain debug start: the band reads the exact session the CLI printed', { plugins: [PEEK] }, async ($, on) => {
  const w = newWorld()
  w.bash = `paused at invoices.py:34 (breakpoint) in subtotal\nsession: pass --session invoices.py to the commands that follow (exactly this one: --session ${DESCRIPTOR})\n`
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka debug invoices.py --at subtotal' })
  expect(contexts(w)).toEqual([DESCRIPTOR])
  // the session's own state, which the host keeps per session and through a reload
  expect(await held($)).toEqual([DESCRIPTOR, '/work/invoices.py'])
})

test('a start with --json: the descriptor of its session object', async ($, on) => {
  const w = newWorld()
  w.bash = JSON.stringify({ kind: 'debug', paused: { line: 34 }, session: { name: 'invoices.py', descriptor: DESCRIPTOR } }, null, 2)
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka debug invoices.py --at subtotal --json' })
  expect(contexts(w)).toEqual([DESCRIPTOR])
})

test('a recorded start prints only the name: the band reads the file by its full path', async ($, on) => {
  const w = newWorld()
  w.cwd = '/work/app'
  w.bash = 'paused at invoices.py:1 (entry)\nsession: pass --session invoices.py to the commands that follow\n'
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka debug ./../invoices.py --record --no-focus 2>&1 | tail -20' })
  expect(contexts(w)).toEqual(['/work/invoices.py'])
})

test('a module start has no file: the band reads the name the CLI printed', async ($, on) => {
  const w = newWorld()
  w.bash = "paused at app/server.py:12 (breakpoint) in handle\nsession: pass --session '-m app.server' to the commands that follow\n"
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka debug -m app.server --at handle' })
  expect(contexts(w)).toEqual(['-m app.server'])
})

test('later commands: the --session they name, quoted or with =, and one that names none keeps it', async ($, on) => {
  const w = newWorld()
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: "pyokka continue --live --session '-m pytest'" })
  await $.tool.call({ tool: 'Bash', command: 'pyokka state --live --session=invoices.py' })
  await $.tool.call({ tool: 'Bash', command: 'pyokka step --over --live' })
  expect(contexts(w)).toEqual(['-m pytest', 'invoices.py', 'invoices.py'])
})

test('the band tool sets the session too', async ($, on) => {
  const w = newWorld()
  engine(on, w)
  await $.tool.call({ tool: BAND_TOOL, action: 'show', session: 'report.py' })
  expect(contexts(w)).toEqual(['report.py'])
})

test('several live sessions and none named: the band says so and reads no other', async ($, on) => {
  const w = newWorld()
  w.context = JSON.stringify({
    ok: false,
    error: '2 live sessions; say which',
    hint: '--session NAME with one of: run invoices.py (pid 4, invoices.py) /h/.pyokka/sessions/4-1.json; run report.py (pid 9, report.py) /h/.pyokka/sessions/9-1.json',
  })
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka state --live' })
  // `state` asked which run a command without --session reaches, and the CLI said several
  expect(w.runs.filter(r => r[1] === 'state')).toHaveLength(1)
  expect(contexts(w)).toEqual([])
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: 'pyokka  2 live sessions; say which' })).toBeDefined()
  await ui.unmount()
})

test('nothing named, and the one live run is another directory\'s: the band names it and reads nothing', async ($, on) => {
  const w = newWorld()
  w.workspace = '/other/abl3/langchain'
  w.stateFile = '/other/abl3/langchain/_policy.py'
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka state --live' })
  expect(contexts(w)).toEqual([])
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: /^pyokka {2}no live session here: _policy\.py is live in another directory/ })).toBeDefined()
  await ui.unmount()
  // the agent reads the whole line, with the session that follows it
  const said = JSON.stringify(await $.tool.call({ tool: BAND_TOOL, action: 'show' }))
  expect(said).toContain('--session /other/abl3/langchain/_policy.py follows it')
  expect(contexts(w)).toEqual([])
})

test('nothing named: a run of this workspace, or of a program under this directory, is read unnamed', async ($, on) => {
  const w = newWorld()
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka state --live' })
  w.workspace = ''
  await $.tool.call({ tool: 'Bash', command: 'pyokka state --live' })
  expect(contexts(w)).toEqual([undefined, undefined])
})

test('a name two sessions match: the band says so and keeps the name', { plugins: [PEEK] }, async ($, on) => {
  const w = newWorld()
  w.context = JSON.stringify({ ok: false, error: '2 live sessions match invoices.py', hint: 'pick one by descriptor: --session /h/.pyokka/sessions/4-1.json | /h/.pyokka/sessions/9-1.json' })
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka step --live --to 64 --session invoices.py' })
  expect(contexts(w)).toEqual(['invoices.py'])
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: 'pyokka  2 live sessions match invoices.py' })).toBeDefined()
  await ui.unmount()
  expect(await held($)).toEqual(['invoices.py'])
})

test('the plain run ended: the band reads the file it started, and never asks for the old session again', async ($, on) => {
  const w = newWorld()
  w.bash = `session: pass --session invoices.py to the commands that follow (exactly this one: --session ${DESCRIPTOR})\n`
  w.contextBySession = { [DESCRIPTOR]: gone(DESCRIPTOR) }
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka debug invoices.py --at subtotal' })
  expect(contexts(w)).toEqual([DESCRIPTOR, '/work/invoices.py'])
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: 'invoices.py:34' })).toBeDefined()
  await ui.unmount()
  w.bash = ''
  await $.tool.call({ tool: 'Bash', command: 'pyokka context --live' })
  expect(contexts(w)).toEqual([DESCRIPTOR, '/work/invoices.py', '/work/invoices.py'])
})

test('everything it followed is gone: the band says so and keeps the file, reading no other run', { plugins: [PEEK] }, async ($, on) => {
  const w = newWorld()
  w.bash = `session: pass --session invoices.py to the commands that follow (exactly this one: --session ${DESCRIPTOR})\n`
  w.contextBySession = { [DESCRIPTOR]: gone(DESCRIPTOR), '/work/invoices.py': gone('/work/invoices.py') }
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'pyokka debug invoices.py --at subtotal' })
  expect(contexts(w)).toEqual([DESCRIPTOR, '/work/invoices.py'])
  const ui = await $.ui.mount(mountBand())
  expect(await ui.find({ type: 'Text', text: 'pyokka  no live session for /work/invoices.py' })).toBeDefined()
  await ui.unmount()
  expect(await held($)).toEqual(['/work/invoices.py'])
})
