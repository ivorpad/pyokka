import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Bugs, Finding, Fix, ValueOrigin, OriginLink, Snapshot, Spot } from '../types'
import { applyEdits, diffOf, fixPrompt, readAnswer } from './fix'
import { KEY_HELP, MOVES, NEEDS_HISTORY, originHere, TOOL_ACTIONS, TOOL_SPEC } from './keys'
import type { Look, ToolInput } from './keys'
import { narrationPrompt } from './narration'
import { baseName, descriptorsIn, errorMessage, jsonOf, NEEDS_RECORDING, statementLines, stepOutcome, toFindings, toOrigin, toSpot } from './parse'
import type { RawContext, RawFinding, RawOrigin } from './parse'
import { fixedText, originAnswer, planPath, planText } from './plans'
import { findingAt, FIXER, FOLLOW_MS, IDLE_MS, memory, NARRATOR, POLL_MS, PYOKKA, PYOKKA_COMMAND } from './state'
import { scratchDir, WINDOW_AFTER, WINDOW_BEFORE } from './state'
import { bugsView, errorView, explainView } from './views'

const snapshot = atom({ plugin: 'pyokka-band', key: 'snapshot' } as const, null)
const isHidden = atom({ plugin: 'pyokka-band', key: 'isHidden' } as const, false)
const lastPyokkaAt = atom({ plugin: 'pyokka-band', key: 'lastPyokkaAt' } as const, 0)
const prose = atom({ plugin: 'pyokka-band', key: 'prose' } as const, null)
const isNarrating = atom({ plugin: 'pyokka-band', key: 'isNarrating' } as const, true)
const mode = atom({ plugin: 'pyokka-band', key: 'mode' } as const, 'explain')
const bugs = atom({ plugin: 'pyokka-band', key: 'bugs' } as const, null)
const bugIndex = atom({ plugin: 'pyokka-band', key: 'bugIndex' } as const, 0)
const fix = atom({ plugin: 'pyokka-band', key: 'fix' } as const, null)
const whereFrom = atom({ plugin: 'pyokka-band', key: 'origin' } as const, null)
const notice = atom({ plugin: 'pyokka-band', key: 'notice' } as const, null)

// The band follows the Pyokka Time Machine of a VS Code session through the same
// `pyokka … --live` commands an agent runs: after every pyokka command in the transcript,
// after each of its own buttons, and every few seconds for a minute after either (so a move
// made in the editor shows up too).
//
// Every function that takes `$` lives in this file, because the validator follows `$` only
// into functions declared in the same file. What needs no `$` is in the modules beside it:
// parse (the CLI's JSON), narration and fix (prompts, edits), plans (plan text), keys (what
// each key and tool action is), views (the drawing), state (settings and memory).

// ---- the CLI bridge

async function newestDescriptor($: EngineInterface, paths: string[]): Promise<string | undefined> {
  const dir = paths[0]?.slice(0, paths[0].lastIndexOf('/'))
  if (!dir) return undefined
  const entries = await $.fs.list(dir)
  const byName = new Map(entries.map(entry => [`${dir}/${entry.name}`, entry.mtimeMs]))
  return paths.slice().sort((a, b) => (byName.get(b) ?? 0) - (byName.get(a) ?? 0))[0]
}

/**
 * Runs `pyokka <verb> --live ...` against the followed session. When the CLI says several
 * sessions are live and none is named, it follows the descriptor that changed last.
 */
async function live($: EngineInterface, args: string[]) {
  const withSession = (s?: string) => [...PYOKKA, ...args, '--live', ...(s ? ['--session', s] : [])]
  let ran = await $.process.run(withSession(memory.session), { timeoutMs: 20_000 })
  const said = `${ran.stderr}\n${ran.stdout}`
  if (ran.exitCode !== 0 && /live sessions/.test(said)) {
    memory.session = await newestDescriptor($, descriptorsIn(said))
    if (memory.session) ran = await $.process.run(withSession(memory.session), { timeoutMs: 20_000 })
  } else if (ran.exitCode !== 0 && memory.session && /no live session|not found|descriptor/i.test(said)) {
    memory.session = undefined
    ran = await $.process.run(withSession(), { timeoutMs: 20_000 })
  }
  return ran
}

async function sourceWindow($: EngineInterface, spot: Spot): Promise<Spot['window']> {
  let source = memory.sources.get(spot.path)
  if (source === undefined) {
    try {
      source = (await $.fs.read(spot.path)).split('\n')
    } catch {
      source = []
    }
    memory.sources.set(spot.path, source)
  }
  if (source.length === 0) {
    return spot.around
  }
  const current = new Set(statementLines(source, spot.line))
  const first = Math.max(1, spot.line - WINDOW_BEFORE)
  const last = Math.min(source.length, Math.max(spot.line + WINDOW_AFTER, ...current))
  const window: Spot['window'] = []
  for (let n = first; n <= last; n++) {
    window.push({ line: n, text: source[n - 1] ?? '', current: current.has(n) })
  }
  return window
}

async function stamp($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, lastPyokkaAt, () => now)
}

/**
 * Reads the session's step and draws it. The step is shown first; the bug scan and the
 * narration come after, inside a try, so a slow or failing model call never holds the band
 * on the old step.
 */
async function refresh($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  let next: Snapshot
  try {
    const ran = await live($, ['context', '--json'])
    const raw = jsonOf<RawContext>(ran)
    const parsed = raw ? toSpot(raw) : null
    const spot = parsed ? { ...parsed, window: await sourceWindow($, parsed) } : null
    next = spot
      ? { kind: 'spot', spot, at: now }
      : { kind: 'error', message: memory.pauseEnded ?? (errorMessage(ran.stderr || ran.stdout, memory.wasPaused) || 'no live session'), at: now }
  } catch (error) {
    next = { kind: 'error', message: `pyokka did not answer: ${String(error).slice(0, 80)}`, at: now }
  }
  const shown = await read($, snapshot)
  const moved = next?.kind === 'spot' && (shown?.kind !== 'spot' || shown.spot.step !== next.spot.step)
  await update($, snapshot, () => next)
  if (next?.kind !== 'spot') return
  memory.wasPaused = next.spot.pause !== undefined
  memory.pauseEnded = undefined
  if (moved) await update($, notice, () => null)
  try {
    const run = `${next.spot.path}#${next.spot.count}#${next.spot.stale ? 'stale' : 'fresh'}`
    // a pause without a recording has no run to scan
    if (!next.spot.pause && run !== memory.scannedRun) {
      memory.scannedRun = run
      await loadBugs($)
    }
    if (moved && (await read($, isNarrating))) {
      await narrate($, next.spot)
    }
  } catch (error) {
    $.ui.status(`pyokka band: ${String(error).slice(0, 60)}`)
  }
}

// ---- bugs

/** The run's suspicious steps: `pyokka suspects` when this pyokka has it, else its exceptions. */
async function scanBugs($: EngineInterface): Promise<Bugs> {
  const now = await $.clock.now()
  const suspects = jsonOf<{ findings?: RawFinding[] }>(await live($, ['suspects', '--json']))
  if (suspects) return { source: 'suspects', findings: toFindings(suspects.findings ?? []), at: now }
  const thrown = await live($, ['exceptions', '--json'])
  const doc = jsonOf<{ rows?: RawFinding[] }>(thrown)
  if (doc) return { source: 'exceptions', findings: toFindings(doc.rows ?? []), at: now }
  return { source: 'none', findings: [], error: errorMessage(thrown.stderr || thrown.stdout) || 'no answer', at: now }
}

async function loadBugs($: EngineInterface): Promise<void> {
  const next = await scanBugs($)
  await update($, bugs, () => next)
  await update($, bugIndex, () => 0)
  const shown = await read($, snapshot)
  if (shown?.kind !== 'spot' || !next) return
  if (!shown.spot.stale) {
    await settlePlans($, next.findings, shown.spot.count)
  }
  if (findingAt(next.findings, shown.spot.step) && (await read($, isNarrating))) {
    await narrate($, shown.spot)
  }
}

// ---- moving the Time Machine

/** Records the file again (a debug launch with recording, no breakpoints); the band rescans it. */
async function rerun($: EngineInterface, path: string): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf('/'))
  await $.process.run([...PYOKKA, 'debug', path, '--record', '--no-focus'], { cwd: dir, timeoutMs: 120_000 })
  memory.sources.delete(path)
  memory.scannedRun = ''
  await stamp($)
  await refresh($)
}

async function jump($: EngineInterface, step: number): Promise<void> {
  await live($, ['step', '--to', String(step)])
  await stamp($)
  await refresh($)
}

/** One move (`--over`, `--back`, `--into`, `--out`), then the band catches up. */
async function move($: EngineInterface, flag: string): Promise<void> {
  await stamp($)
  await live($, ['step', flag])
  await stamp($)
  await refresh($)
}

/**
 * One move of the program itself at a pause without a recording (`--over`, `--into`, `--out`).
 * A step that fails, or one that runs the program to its end, leaves the band on the last pause
 * or on a line that says so, never on the CLI's raw error.
 */
async function moveLive($: EngineInterface, flag: string): Promise<void> {
  await stamp($)
  const said = stepOutcome(await live($, ['step', flag, '--json']))
  await stamp($)
  if (said?.startsWith('The program finished')) {
    memory.pauseEnded = said
  } else if (said) {
    await update($, notice, () => said)
    return
  }
  await refresh($)
}

/**
 * At a pause without a recording, records the file again from this line: the plain debug run
 * stops, and a `--record-from FILE:LINE` run pauses the first time the program reaches the line,
 * as step 0 of its recording. The program runs again from the top.
 */
async function recordFromHere($: EngineInterface, spot: Spot): Promise<void> {
  const dir = spot.path.slice(0, spot.path.lastIndexOf('/'))
  $.ui.toast(`Recording ${spot.file} from line ${spot.line}: the program runs again from the top`)
  await live($, ['stop', '--json'])
  await $.process.run([...PYOKKA, 'debug', spot.path, '--record-from', `${spot.path}:${spot.line}`, '--no-focus'], { cwd: dir, timeoutMs: 120_000 })
  memory.sources.delete(spot.path)
  memory.scannedRun = ''
  await stamp($)
  await refresh($)
}

// ---- narration

async function narrate($: EngineInterface, spot: Spot): Promise<void> {
  const finding = spot.pause ? undefined : findingAt((await read($, bugs))?.findings, spot.step)
  const cacheKey = spot.pause ? `pause ${spot.path}:${spot.line} ${spot.step}` : `${spot.step}${finding ? ' finding' : ''}`
  const known = memory.narrations.get(cacheKey)
  if (known !== undefined) {
    await update($, prose, () => ({ step: spot.step, text: known }))
    return
  }
  await update($, prose, () => ({ step: spot.step, text: null }))
  const reply = await $.model.complete({ model: NARRATOR, prompt: narrationPrompt(spot, memory.previous, finding), maxTokens: 160 })
  if (reply.isAnswered) {
    const text = reply.text.trim()
    memory.narrations.set(cacheKey, text)
    memory.previous = text
    await update($, prose, () => ({ step: spot.step, text }))
  } else {
    await update($, prose, () => ({ step: spot.step, text: null, failed: reply.reason }))
  }
}

// ---- fixes and plans

async function minuteNow($: EngineInterface): Promise<string> {
  return new Date(await $.clock.now()).toISOString().slice(0, 16).replace('T', ' ')
}

/** Runs a file plainly and recorded: what it printed, and how many exceptions it raised. */
async function exceptionsIn($: EngineInterface, file: string, cwd: string, scratch: string): Promise<{ stdout: string; caught: number }> {
  const saved = `${scratch}/${baseName(file)}.json`
  const ran = await $.process.run([...PYOKKA, 'run', file, '--save', saved], { cwd, timeoutMs: 60_000 })
  const plain = await $.process.run(['python3', file], { cwd, timeoutMs: 60_000 })
  const doc = jsonOf<{ total?: number }>(await $.process.run([...PYOKKA, 'exceptions', saved, '--json'], { timeoutMs: 20_000 }))
  return { stdout: (plain.stdout || ran.stderr).trim(), caught: doc?.total ?? -1 }
}

async function writePlan($: EngineInterface, finding: Finding, spot: Spot, proposal: NonNullable<Fix>, origin?: OriginLink[]): Promise<string> {
  const path = planPath(spot.path, finding)
  await $.fs.write(path, planText(finding, spot, proposal, 'open', await minuteNow($), origin))
  memory.plans.set(path, { path, kind: finding.kind, where: finding.where, status: 'open' })
  return path
}

/** After a scan of a fresh run: a plan whose finding is gone is marked fixed. */
async function settlePlans($: EngineInterface, findings: Finding[], count: number): Promise<void> {
  for (const plan of memory.plans.values()) {
    if (plan.status !== 'open') continue
    if (findings.some(f => f.kind === plan.kind && f.where === plan.where)) continue
    const text = await $.fs.read(plan.path)
    await $.fs.write(plan.path, fixedText(text, await minuteNow($), count))
    plan.status = 'fixed'
    $.ui.toast(`${baseName(plan.path)}: fixed`)
  }
}

/**
 * Asks the model for the smallest root-cause edit, checks it on a copy in `.pyokka/band-tmp/`
 * (the program itself is left alone), and writes the plan. With an origin chain (passed in, or the finding's own) the
 * model is told which step to fix and the plan lists the chain.
 */
async function proposeFix($: EngineInterface, finding: Finding, spot: Spot, origin?: OriginLink[]): Promise<void> {
  const chain = origin ?? finding.origin
  const path = spot.path
  const base = { findingId: finding.id, path, explanation: '', diff: [], patched: '', original: '' }
  await update($, fix, () => ({ ...base, status: 'thinking' as const }))
  try {
    const original = await $.fs.read(path)
    const reply = await $.model.complete({ model: FIXER, prompt: fixPrompt(finding, spot, original, chain), maxTokens: 1200 })
    if (!reply.isAnswered) throw new Error(`no answer: ${reply.reason}`)
    const { explanation, edits } = readAnswer(reply.text)
    if (edits.length === 0) throw new Error('the model proposed no edit')
    const patched = applyEdits(original, edits)
    const proposal = { ...base, original, patched, explanation, diff: diffOf(original, edits) }
    await update($, fix, () => ({ ...proposal, status: 'checking' as const }))
    const scratch = scratchDir(path)
    const copy = `${scratch}/${baseName(path)}`
    await $.fs.write(copy, patched)
    const dir = path.slice(0, path.lastIndexOf('/'))
    const before = await exceptionsIn($, path, dir, scratch)
    const after = await exceptionsIn($, copy, dir, scratch)
    const ready = {
      ...proposal,
      status: 'ready' as const,
      verify: { before: before.stdout, after: after.stdout, exceptionsBefore: before.caught, exceptionsAfter: after.caught },
    }
    const planFile = await writePlan($, finding, spot, ready, chain)
    await update($, fix, () => ({ ...ready, plan: planFile }))
    $.ui.toast(`Fix plan written: .pyokka/findings/${baseName(planFile)}`)
  } catch (error) {
    await update($, fix, () => ({ ...base, status: 'failed' as const, error: String(error).slice(0, 200) }))
  }
}

async function applyFix($: EngineInterface): Promise<void> {
  const proposal = await read($, fix)
  if (proposal?.status !== 'ready') return
  await $.fs.write(proposal.path, proposal.patched)
  await update($, fix, () => ({ ...proposal, status: 'applied' as const }))
  $.ui.toast(`Fix written to ${baseName(proposal.path)}; recording it again`)
  await rerun($, proposal.path)
}

async function undoFix($: EngineInterface): Promise<void> {
  const proposal = await read($, fix)
  if (proposal?.status !== 'applied') return
  await $.fs.write(proposal.path, proposal.original)
  await update($, fix, () => ({ ...proposal, status: 'ready' as const }))
  $.ui.toast(`${baseName(proposal.path)} restored; recording it again`)
  await rerun($, proposal.path)
}

// ---- keys: a band button, `/pk <key>` and the `band` tool all end in `press`

async function look($: EngineInterface): Promise<Look> {
  const shown = await read($, snapshot)
  const spot = shown?.kind === 'spot' ? shown.spot : undefined
  const found = await read($, bugs)
  const list = found?.findings ?? []
  const index = await read($, bugIndex)
  return {
    mode: await read($, mode),
    spot,
    here: spot && !spot.stale && !spot.pause ? findingAt(list, spot.step) : undefined,
    found,
    index,
    picked: list[Math.min(index, Math.max(0, list.length - 1))],
    proposal: await read($, fix),
    origin: await read($, whereFrom),
    narrating: await read($, isNarrating),
    notice: await read($, notice),
  }
}

/**
 * Asks `pyokka origin` where the bad value of the finding came from, at the finding's step,
 * and holds the chain for the explain view. A CLI without `origin`, or a run with no locals,
 * gives a chain with no links and the CLI's own words.
 */
async function loadOrigin($: EngineInterface, finding: Finding): Promise<NonNullable<ValueOrigin>> {
  const ran = await live($, ['origin', '--json', String(finding.step)])
  const raw = jsonOf<RawOrigin>(ran)
  const chain: NonNullable<ValueOrigin> = raw
    ? toOrigin(raw, finding.id)
    : { findingId: finding.id, step: finding.step, links: [], error: errorMessage(ran.stderr || ran.stdout) || 'pyokka origin gave no answer' }
  await update($, whereFrom, () => chain)
  return chain
}

/**
 * Does what the key does (keys.ts lists them). Returns a line for the person when the key
 * has nothing to act on, the help when the key is unknown, and undefined when it acted.
 */
async function press($: EngineInterface, typed: string): Promise<string | undefined> {
  const key = typed === 'R' ? 'r' : typed
  const l = await look($)
  const flag = MOVES[key]
  if (l.spot?.pause && (NEEDS_HISTORY.has(key) || /^\d+$/.test(key))) {
    await update($, notice, () => NEEDS_RECORDING)
    return NEEDS_RECORDING
  }
  if (flag && l.spot?.pause) {
    await moveLive($, flag)
  } else if (key === 'r' && l.spot?.pause) {
    await recordFromHere($, l.spot)
  } else if (flag) {
    await move($, flag)
  } else if (/^\d+$/.test(key)) {
    await jump($, Number(key))
  } else if (key === 'w') {
    if (!l.here) return 'No finding on this step: /pk x lists them'
    if (originHere(l)) await update($, whereFrom, () => null)
    else await loadOrigin($, l.here)
  } else if (key === 'f') {
    if (!l.here || !l.spot) return 'No finding on this step: /pk x lists them'
    // the plan aims at the root of the chain, so the chain is read first when the band has none
    const chain = originHere(l) ?? (await loadOrigin($, l.here))
    await proposeFix($, l.here, l.spot, chain?.links.length ? chain.links : undefined)
  } else if (key === 'a') {
    await applyFix($)
  } else if (key === 'u') {
    await undoFix($)
  } else if (key === 'd') {
    await update($, fix, () => null)
  } else if (key === 'x') {
    await update($, mode, () => 'bugs')
    await loadBugs($)
  } else if (key === 'e') {
    await update($, mode, () => 'explain')
  } else if (key === 'r') {
    if (l.mode === 'bugs') {
      await loadBugs($)
    } else {
      const file = l.spot?.path ?? (jsonOf<{ file?: string }>(await live($, ['state', '--json']))?.file ?? '')
      if (!file) return 'No session to record again'
      await rerun($, file)
    }
  } else if (key === 'p') {
    await update($, isNarrating, () => !l.narrating)
    if (!l.narrating && l.spot) await narrate($, l.spot)
  } else if (key === 'g') {
    if (l.picked) await jump($, l.picked.step)
  } else if (key === 'j' || key === 'k') {
    const last = Math.max(0, (l.found?.findings.length ?? 1) - 1)
    await update($, bugIndex, () => (key === 'j' ? Math.min(last, l.index + 1) : Math.max(0, l.index - 1)))
  } else {
    return `/pk ${KEY_HELP}`
  }
  return undefined
}

/** Serves one call of the `band` tool; the text is what the model reads back. */
async function useTool($: EngineInterface, input: ToolInput): Promise<string> {
  if (input.session) memory.session = input.session
  await stamp($)
  const action = input.action ?? 'show'
  if (action === 'hide') {
    await update($, isHidden, () => true)
    return 'The band is hidden. Call action "show" to bring it back.'
  }
  await update($, isHidden, () => false)
  const before = await look($)
  if (action === 'step' && typeof input.step === 'number' && !before.spot?.pause) {
    await jump($, input.step)
  } else {
    await refresh($)
  }
  const key = TOOL_ACTIONS[action]
  const paused = (await look($)).spot
  if (paused?.pause) {
    if (action === 'step' || (key !== undefined && key !== 'e')) {
      await update($, notice, () => NEEDS_RECORDING)
      return `The session is a debug pause without a recording, so "${action}" has nothing to read. ${NEEDS_RECORDING.replace('Press r', 'The person can press r (or /pk r)')}`
    }
    if (key) await press($, key)
    return `The band shows ${paused.file}:${paused.line} in ${paused.function}, paused (${paused.pause.reason}) without a recording.` +
      (paused.pause.exception ? ` The program stopped on ${paused.pause.exception.type}: ${paused.pause.exception.message}.` : '') +
      ' /pk n, i and o step the program; /pk r records it again from this line.'
  }
  if (key === 'f') {
    if (await press($, 'f')) return 'No bug was found on the current step. Call action "bugs" to list them.'
    const plan = (await read($, fix))?.plan
    return plan ? `Fix plan written to ${plan}` : 'The fix plan could not be written; the band shows why.'
  }
  if (key === 'w') {
    const here = (await look($)).here
    if (!here) return 'No bug was found on the current step. Call action "bugs" to list them.'
    return originAnswer(here, originHere(await look($)) ?? (await loadOrigin($, here)))
  }
  if (key) await press($, key)
  const l = await look($)
  if (l.spot) {
    const count = l.found?.findings.length ?? 0
    return `The band shows ${l.spot.file}:${l.spot.line} at step ${l.spot.step} of ${l.spot.count}` +
      ` in ${l.spot.function}, ${count} bug finding(s) in this run.`
  }
  const shown = await read($, snapshot)
  return shown?.kind === 'error'
    ? `The band has no session: ${shown.message}`
    : 'The band is on; it shows the session after the next pyokka command.'
}

// ---- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.clock.every(POLL_MS, async () => {
      const since = (await $.clock.now()) - (await read($, lastPyokkaAt))
      if (since < FOLLOW_MS && !(await read($, isHidden))) {
        await refresh($)
      }
    })
    $.command.register({ name: 'pyokka-band', description: 'Show or hide the Pyokka band and refresh it' })
    $.command.register({
      name: 'pk',
      description: 'Drive the Pyokka band from the prompt: n next, b back, i into, o out, w where from, f plan a fix, a apply, u undo, x bugs, e explain, r record again, p prose',
    })
    await $.tool.register(TOOL_SPEC)
    return next(e)
  })

  on('command.run', { command: 'pyokka-band' }, async $ => {
    const hidden = await read($, isHidden)
    await update($, isHidden, () => !hidden)
    if (hidden) {
      await stamp($)
      await refresh($)
    }
    return { text: hidden ? 'Pyokka band on' : 'Pyokka band off' }
  })

  // `/pk <key>` does what the band's key does, from the prompt (the band's own keys answer
  // only while it holds the focus).
  on('command.run', { command: 'pk' }, async ($, e) => {
    const key = (e.args ?? '').trim().split(/\s+/)[0] ?? ''
    if (key === '') return { text: `/pk ${KEY_HELP}` }
    await stamp($)
    const said = await press($, key)
    return said ? { text: said } : {}
  })

  on('tool.call', { tool: 'mcp__pyokka-band__band' }, async ($, e) => {
    return { result: await useTool($, e as ToolInput) }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (PYOKKA_COMMAND.test(e.command)) {
      const named = e.command.match(/--session\s+(\S+)/)?.[1]
      // `pyokka debug FILE` names the program it starts: follow it by name, so the band reads
      // its pause rather than a session it followed before
      const started = e.command.match(/\bpyokka\s+debug\s+([^\s-]\S*\.py)\b/)?.[1]
      if (named) memory.session = named
      else if (started) memory.session = baseName(started)
      await stamp($)
      await refresh($)
    }
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, snapshot)
    if (e.props.hasSurvey || shown === null || (await read($, isHidden))) {
      return next(e)
    }
    if ((await $.clock.now()) - (await read($, lastPyokkaAt)) > IDLE_MS) {
      return next(e)
    }
    const ui = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns - 2)
    if (shown.kind === 'error') {
      return errorView(ui, width, shown.message)
    }
    const l = await look($)
    const act = (key: string) => press($, key)
    return l.mode === 'bugs' && !shown.spot.pause
      ? bugsView(ui, act, width, l, shown.spot)
      : explainView(ui, act, width, l, shown.spot, await read($, prose))
  })
}
