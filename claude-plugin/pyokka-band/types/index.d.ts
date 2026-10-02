export type Frame = { function: string; line: number; step: number }

export type Spot = {
  file: string
  line: number
  function: string
  step: number
  count: number
  text: string
  /** The block's lines around the current one, for the band and the narrator. */
  around: { line: number; text: string; current: boolean }[]
  values: string[]
  stack: Frame[]
  /** The file changed since this recording: what the band shows is the old run. */
  stale: boolean
  /** Full path of the file, for reading the source window. */
  path: string
  /** What each line showed so far, as the editor's inline values: hits and the latest text. */
  inline: Record<string, { hits: number; text: string }>
  /** The source around the current line, filled in from the file after the CLI answers. */
  window: { line: number; text: string; current: boolean }[]
  /**
   * A debug pause with nothing recorded (`recording: false`): `step` is the runtime's statement
   * counter, `count` is 0, and the values are the paused frame's variables.
   */
  pause?: LivePause
}

/** What a debug pause without a recording carries: why it stopped and the frame's variables. */
export type LivePause = {
  /** `breakpoint`, `step`, `exception`, `start`, `pause`, `watch` */
  reason: string
  exception?: { type: string; message: string; uncaught: boolean }
  /** The paused frame's variables, with their shape (`list[2]`, `str`). */
  variables: { name: string; shape: string; text: string }[]
}

/** What the band shows: a spot, an error line from the CLI, or nothing yet. */
export type Snapshot =
  | { kind: 'spot'; spot: Spot; at: number }
  | { kind: 'error'; message: string; at: number }
  | null

/** The narration of one step: pending while the model writes it. */
export type Prose = { step: number; text: string | null; failed?: string } | null

/** One link of `pyokka origin`'s chain: a step that carried the bad value. */
export type OriginLink = {
  step: number
  /** `invoices.py:18` */
  where: string
  function: string
  /** What carried the value at that step: `items[0]["unit_price"]`, `return …`, `price`. */
  expression: string
  /** The value's recorded text. */
  value: string
  /** How it joins the link before: read, argument, return, assigned, element, literal. */
  how: string
  /** `recorded`, or `inferred` / `text match` when picked by value, not identity. */
  certainty: string
  note?: string
  /** The link where the value took the form that failed: the one to fix. */
  root?: boolean
}

/** Where the bad value of one finding came from, newest link first. */
export type ValueOrigin = {
  findingId: string
  step: number
  links: OriginLink[]
  /** Why the root is the root, when the CLI found one. */
  rootReason?: string
  /** Why no root was found (the chain stopped before a statement that made the value). */
  rootUnknown?: string
  /** Where and why the chain ends. */
  end?: string
  /** What the CLI said when it gave no chain. */
  error?: string
} | null

/** One suspicious step, from `pyokka suspects` (or `pyokka exceptions` until it exists). */
export type Finding = {
  id: string
  kind: string
  step: number
  where: string
  reason: string
  confidence: string
  /** Where the bad value came from, newest link first, when it is known with the finding. */
  origin?: OriginLink[]
}

export type Bugs = { source: string; findings: Finding[]; error?: string; at: number } | null

export type Mode = 'explain' | 'bugs'

/** A proposed fix for one finding: what the model said, the edit, and what re-running showed. */
export type Fix = {
  findingId: string
  status: 'thinking' | 'checking' | 'ready' | 'applied' | 'failed'
  path: string
  explanation: string
  diff: { sign: '-' | '+'; line: number; text: string }[]
  patched: string
  original: string
  verify?: { before: string; after: string; exceptionsBefore: number; exceptionsAfter: number }
  /** Where the plan for this fix was written, under .pyokka/findings. */
  plan?: string
  error?: string
} | null

declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__pyokka-band__band': { action?: string; step?: number; session?: string }
  }
  interface PluginState {
    'pyokka-band': {
      snapshot: Snapshot
      isHidden: boolean
      lastPyokkaAt: number
      prose: Prose
      isNarrating: boolean
      mode: Mode
      bugs: Bugs
      bugIndex: number
      fix: Fix
      origin: ValueOrigin
      notice: string | null
    }
  }
}
