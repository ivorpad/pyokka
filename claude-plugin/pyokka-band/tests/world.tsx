import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { CONTEXT_64, EXCEPTIONS_CAUGHT, INVOICES_SOURCE, ORIGIN_64 } from './fixtures'

// What the band's world answers in a test: the test's hooks stand for the engine. The CLI
// answers with JSON captured from a real run of tests/programs/invoices.py (fixtures.ts);
// the files live in a map; the model replies with what the test sets.

export type World = {
  /** What `pyokka context --live --json` prints; a string: the error it fails with. */
  context: object | string
  /** What `pyokka step --live` prints; a string: the error it fails with. */
  step: object | string
  /** What `context` prints after the next `step`, when set: the stop the step reached. */
  afterStep?: object | string
  /** What `pyokka exceptions --live --json` prints; a string: the error it fails with. */
  exceptions: object | string
  /** What `pyokka suspects --live --json` prints; null: this pyokka has no `suspects`. */
  suspects: object | null
  /** What `pyokka origin --live --json STEP` prints; a string: the error it fails with. */
  origin: object | string
  /** Swallowed exceptions in a re-run of a saved file, in the order the band asks. */
  totals: number[]
  /** What `python3 FILE` prints, by whether FILE is the patched copy. */
  printed: { original: string; patched: string }
  /** The model's reply text, by model name. */
  replies: Record<string, string>
  files: Map<string, string>
  /** Every argv the band ran, in order. */
  runs: string[][]
  toasts: string[]
  /** Every prompt the band sent a model, in order. */
  prompts: string[]
}

export const PROGRAM = '/work/invoices.py'

export const newWorld = (): World => ({
  context: CONTEXT_64,
  step: {},
  exceptions: EXCEPTIONS_CAUGHT,
  suspects: null,
  origin: ORIGIN_64,
  totals: [1, 0],
  printed: {
    original: '4 invoices, revenue 209.44\naverage invoice 52.36\n',
    patched: '4 invoices, revenue 1398.79\naverage invoice 349.70\n',
  },
  replies: {},
  files: new Map([[PROGRAM, INVOICES_SOURCE]]),
  runs: [],
  toasts: [],
  prompts: [],
})

const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const done = (stdout: string, exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

/** The CLI's answer to one argv. */
const answer = (w: World, argv: readonly string[]) => {
  const verb = argv[0] === 'pyokka' ? argv[1] : argv[0]
  const isLive = argv.includes('--live')
  if (verb === 'context') return typeof w.context === 'string' ? done('', 1, w.context) : done(JSON.stringify(w.context))
  if (verb === 'step') {
    if (w.afterStep !== undefined) w.context = w.afterStep
    return typeof w.step === 'string' ? done('', 1, w.step) : done(JSON.stringify(w.step))
  }
  if (verb === 'origin') return typeof w.origin === 'string' ? done('', 2, w.origin) : done(JSON.stringify(w.origin))
  if (verb === 'suspects') {
    return w.suspects ? done(JSON.stringify(w.suspects)) : done('', 2, "pyokka: error: argument command: invalid choice: 'suspects'")
  }
  if (verb === 'exceptions' && isLive) return typeof w.exceptions === 'string' ? done(w.exceptions, 2) : done(JSON.stringify(w.exceptions))
  if (verb === 'exceptions') return done(JSON.stringify({ total: w.totals.shift() ?? 0 }))
  if (verb === 'python3') return done(argv[1]?.includes('/.pyokka/band-tmp/') ? w.printed.patched : w.printed.original)
  return done('')
}

export function engine(on: On, w: World) {
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('process.run', (_, e) => {
    w.runs.push([...e.argv])
    return answer(w, e.argv)
  })
  on('fs.read', (_, e) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: `no file ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('model.complete', (_, e) => {
    w.prompts.push(e.prompt)
    const text = w.replies[e.model]
    return text === undefined
      ? { value: { isAnswered: false, reason: 'empty-reply', usage: NO_USAGE } }
      : { value: { isAnswered: true, text, usage: NO_USAGE } }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  // Beneath the band the engine draws nothing of its own: an empty box stands for that.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  return mock.clock(on, { now: Date.UTC(2026, 9, 2, 12, 0) })
}

export const BAND = { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 120, scroll: { offset: 0, bodyRows: 30 }, view: {} }

/** The argvs of the band's `pyokka step` calls. */
export const steps = (w: World) => w.runs.filter(r => r[1] === 'step').map(r => r.slice(2).join(' '))

/** `/pk <key>` as the person types it. */
export const pk = (key: string) =>
  ({ command: 'pk', args: key, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }) as const
