import type { Finding, Frame, LivePause, ValueOrigin, Spot } from '../types'

// The CLI's JSON, read into what the band draws. No `$` here: every function is pure.

type Place = { file?: string; line?: number; function?: string }

/**
 * `pyokka context --json`. At a debug pause with nothing recorded (`recording: false`, see
 * docs/design/live-pause-context.md) there is no `count`, `values` is empty, and `paused` and
 * `locals` carry the reason, the exception and the frame's variables.
 */
export type RawContext = {
  stale?: boolean
  step?: number
  count?: number
  recording?: boolean
  location?: Place
  stack?: { function?: string; line?: number; step?: number; elided?: number }[]
  block?: { lines?: { line?: number; text?: string; current?: boolean }[] }
  values?: { step?: number | null; line?: number; context?: string | null; text?: string }[]
  paused?: { reason?: string; exception?: { type?: string; message?: string; uncaught?: boolean } }
  locals?: { name?: string; text?: string; type?: string; length?: number }[]
}

/** The one line the band says for a key that needs a recording, at a pause without one. */
export const NEEDS_RECORDING = 'Back, step numbers, bugs, where from and fix plans need a recording. Press r to record from here.'

/** `list[2]`, `dict[1]`, `str`: the type, and the length of a container. */
export const shapeOf = (v: { type?: string; length?: number }): string =>
  v.type === undefined ? '' : v.length !== undefined && !['str', 'bytes'].includes(v.type) ? `${v.type}[${v.length}]` : v.type

const pauseOf = (raw: RawContext): LivePause => {
  const e = raw.paused?.exception
  return {
    reason: raw.paused?.reason ?? 'pause',
    exception: e?.type ? { type: e.type, message: e.message ?? '', uncaught: e.uncaught === true } : undefined,
    variables: (raw.locals ?? []).map(v => ({ name: v.name ?? '?', shape: shapeOf(v), text: v.text ?? '' })),
  }
}

/** A row of `pyokka exceptions --json` or a finding of `pyokka suspects --json`. */
export type RawFinding = {
  id?: string
  kind?: string
  type?: string
  step?: number
  file?: string
  line?: number
  reason?: string
  message?: string
  confidence?: string
  errorType?: string
  raisedAt?: Place | null
  handledAt?: (Place & { broad?: boolean }) | null
}

export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** The JSON a CLI command printed, or undefined when it failed or printed something else. */
export const jsonOf = <T>(ran: { exitCode: number; stdout: string }): T | undefined => {
  if (ran.exitCode !== 0) return undefined
  try {
    return JSON.parse(ran.stdout) as T
  } catch {
    return undefined
  }
}

/** The session descriptors a "2 live sessions" error lists. */
export const descriptorsIn = (text: string): string[] =>
  [...text.matchAll(/(\/[^\s|]+\/sessions\/[^\s|]+\.json)/g)].map(m => m[1] ?? '').filter(Boolean)

/** The first line of the CLI's error, without the hint lines under it. */
export const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''

/** The `error` of a `{ok: false, error, hint}` reply, or undefined when `text` is not one. */
const jsonError = (text: string): string | undefined => {
  try {
    const parsed = JSON.parse(text.trim()) as { ok?: boolean; error?: string }
    return parsed && parsed.ok === false && parsed.error ? parsed.error : undefined
  } catch {
    return undefined
  }
}

/**
 * Every CLI error the band shows, in words. The CLI answers `--json` errors as
 * `{ok: false, error, hint}`, alone or on one line among others; the band says the `error`
 * and, where a key helps, names it. Raw JSON never reaches the screen.
 */
export const errorMessage = (text: string, afterPause = false): string => {
  const said = jsonError(text) ??
    text.split('\n').map(line => jsonError(line)).find(error => error !== undefined) ??
    firstLine(text)
  // a CLI from before the older-extension message, talking to an older extension
  const unknown = said.match(/^unknown request ["']([^"']*)["']$/)
  if (unknown) {
    return `The VS Code extension is older than this CLI (no ${unknown[1]} request): install the vsix built from this checkout and run Developer: Reload Window.`
  }
  if (/Time Machine is not active|Time Machine inactive/i.test(said)) {
    return afterPause
      ? 'The debug pause is over: the program ran on or finished. Press r to record the file, or pause it again with pyokka debug FILE --at NAME.'
      : 'The Time Machine is off for this session. Press r to record again, or i to start at step 1.'
  }
  return said
}

/**
 * What a `pyokka step` at a pause without a recording answered, as a line for the band, or
 * undefined when it moved to another pause (the band then reads that pause).
 */
export const stepOutcome = (ran: { exitCode: number; stdout: string; stderr: string }): string | undefined => {
  if (ran.exitCode !== 0) return `The step did not run: ${errorMessage(ran.stderr || ran.stdout)}`
  const reply = jsonOf<{ finished?: { exitCode?: number | null } }>(ran)
  if (reply?.finished) {
    return `The program finished (exit ${reply.finished.exitCode ?? '?'}). Press r to record the file from the top.`
  }
  return undefined
}

const valueText = (v: { context?: string | null; text?: string }) =>
  v.context ? `${v.context} = ${v.text ?? ''}` : (v.text ?? '')

export const toSpot = (raw: RawContext): Spot | null => {
  const location = raw.location
  const step = raw.step
  if (step === undefined || !location?.file || location.line === undefined) {
    return null
  }
  const lines = raw.block?.lines ?? []
  const at = lines.findIndex(l => l.current)
  const around = lines
    .slice(Math.max(0, at - 4), at + 4)
    .map(l => ({ line: l.line ?? 0, text: l.text ?? '', current: l.current === true }))
  const stack: Frame[] = (raw.stack ?? []).map(f => ({
    function: f.function ?? (f.elided ? `…${f.elided} library` : '?'),
    line: f.line ?? 0,
    step: f.step ?? 0,
  }))
  // Values recorded up to this step. The ones of this step or line come first; a line that
  // records nothing itself (a `return` that raises) gets the latest value of each name.
  const pause = raw.recording === false ? pauseOf(raw) : undefined
  const recorded = (raw.values ?? []).filter(v => typeof v.step === 'number' && v.step <= step)
  const ofThisLine = recorded.filter(v => v.step === step || v.line === location.line)
  const latest = new Map<string, (typeof recorded)[number]>()
  for (const v of recorded) latest.set(v.context ?? `#${v.line}`, v)
  const values = pause
    ? pause.variables.map(v => `${v.name} = ${v.text}`)
    : (ofThisLine.length ? ofThisLine : [...latest.values()].reverse())
      .map(valueText)
      .filter(text => text !== '')
  const inline: Record<string, { hits: number; text: string }> = {}
  for (const v of recorded) {
    if (v.line === undefined || !v.text) continue
    const was = inline[String(v.line)]
    inline[String(v.line)] = { hits: (was?.hits ?? 0) + 1, text: valueText(v) }
  }
  return {
    stale: raw.stale === true,
    path: location.file,
    inline,
    window: [],
    file: baseName(location.file),
    line: location.line,
    function: location.function ?? '?',
    step,
    count: raw.count ?? 0,
    text: (lines[at]?.text ?? '').trim(),
    around,
    values,
    stack,
    ...(pause ? { pause } : {}),
  }
}

/** The lines of the statement that starts at `line`: it runs on while brackets stay open. */
export const statementLines = (source: string[], line: number): number[] => {
  const lines = [line]
  let depth = 0
  for (let n = line; n <= source.length; n++) {
    const text = (source[n - 1] ?? '').replace(/(['"])(?:\\.|(?!\1).)*\1/g, '').replace(/#.*$/, '')
    for (const ch of text) {
      if ('([{'.includes(ch)) depth++
      else if (')]}'.includes(ch)) depth--
    }
    if (n > line) lines.push(n)
    if (depth <= 0 || n - line > 12) break
  }
  return lines
}

/** `pyokka origin --json` (docs/design/origin.md): the chain, newest first, and its root. */
export type RawOrigin = {
  step?: number
  links?: {
    step?: number
    file?: string
    line?: number
    function?: string
    expr?: string
    how?: string
    certainty?: string
    text?: string
    note?: string
  }[]
  root?: { index?: number; step?: number; reason?: string } | null
  rootUnknown?: string
  end?: string
}

export const toOrigin = (raw: RawOrigin, findingId: string): NonNullable<ValueOrigin> => {
  const rootIndex = raw.root?.index
  return {
    findingId,
    step: raw.step ?? 0,
    links: (raw.links ?? []).map((l, i) => ({
      step: l.step ?? 0,
      where: `${baseName(l.file ?? '?')}:${l.line ?? '?'}`,
      function: l.function ?? '?',
      expression: l.expr ?? '',
      value: l.text ?? '',
      how: l.how ?? '',
      certainty: l.certainty ?? 'recorded',
      note: l.note,
      root: i === rootIndex,
    })),
    rootReason: raw.root?.reason,
    rootUnknown: raw.rootUnknown ?? (raw.root ? undefined : 'not known'),
    end: raw.end,
  }
}

export const toFindings =(rows: RawFinding[]): Finding[] =>
  rows
    .filter(r => r.step !== undefined)
    .map((r, i) => {
      // `pyokka exceptions` rows: where it was raised and where it was swallowed
      const at = r.raisedAt ?? undefined
      const caughtAt = r.handledAt ?? undefined
      const swallowed = r.kind === 'caught' && caughtAt !== undefined
      const reason = r.reason
        ?? (r.errorType
          ? `${r.errorType} (${r.message ?? ''}) raised in ${at?.function ?? '?'}` +
            (swallowed ? ` and swallowed by the except at line ${caughtAt.line}; the code after it ran as if nothing happened` : '')
          : (r.message ?? ''))
      return {
        id: r.id ?? `f${i}`,
        kind: swallowed ? 'swallowed exception' : (r.errorType ?? r.kind ?? r.type ?? 'finding'),
        step: r.step ?? 0,
        where: `${baseName(r.file ?? at?.file ?? '?')}:${r.line ?? at?.line ?? '?'}`,
        reason,
        confidence: r.confidence ?? (swallowed ? 'high' : 'medium'),
      }
    })
