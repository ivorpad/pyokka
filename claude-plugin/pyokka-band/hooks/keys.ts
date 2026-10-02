import type { Bugs, Finding, Fix, Mode, ValueOrigin, Spot } from '../types'

// The band's keys and the model's tool actions, as data. A band button, `/pk <key>` and the
// `band` tool all end in `press` (register.tsx), which does what a key does.
//
// A new key is one entry in BUTTONS (when the band draws it), one in KEY_HELP and one case
// in `press`; a new tool action that is a key is one entry in TOOL_ACTIONS.

/** What the band shows now, read once per press or draw. */
export type Look = {
  mode: Mode
  spot?: Spot
  /** The finding on the current step of a fresh recording. */
  here?: Finding
  found: Bugs
  index: number
  /** The finding the bugs view points at. */
  picked?: Finding
  proposal: Fix
  /** The `pyokka origin` chain the band holds, for whichever finding asked last. */
  origin: ValueOrigin
  narrating: boolean
  /** One line the band shows until the next stop: what a key could not do here. */
  notice: string | null
}

/** The band follows a debug pause with nothing recorded: the keys that need history say so. */
export const isPause = (l: Look) => l.spot?.pause !== undefined

/** Keys that read the recording: at a pause without one they answer NEEDS_RECORDING (parse.ts). */
export const NEEDS_HISTORY = new Set(['b', 'w', 'f', 'x', 'g', 'j', 'k'])

/** Where a button sits: the explain view's bar, the bugs view's, the fix box, the stale notice. */
export type Bar = 'explain' | 'bugs' | 'fix' | 'stale'

export type ButtonSpec = {
  key: string
  bar: Bar
  label: string | ((l: Look) => string)
  shows?: (l: Look) => boolean
  primary?: boolean
  dim?: boolean
}

/** The proposal the band shows: the one for the finding on this step. */
export const fixHere = (l: Look): Fix => (l.here && l.proposal?.findingId === l.here.id ? l.proposal : null)

/** The chain the band shows: the one for the finding on this step. */
export const originHere = (l: Look): ValueOrigin => (l.here && l.origin?.findingId === l.here.id ? l.origin : null)

// In the order each bar draws them.
export const BUTTONS: ButtonSpec[] = [
  { bar: 'stale', key: 'r', label: 'record again', primary: true },
  { bar: 'fix', key: 'a', label: 'apply now', shows: l => fixHere(l)?.status === 'ready' },
  { bar: 'fix', key: 'u', label: 'undo', shows: l => fixHere(l)?.status === 'applied' },
  { bar: 'fix', key: 'f', label: 'try again', dim: true, shows: l => ['ready', 'failed'].includes(fixHere(l)?.status ?? '') },
  { bar: 'fix', key: 'd', label: 'dismiss', dim: true },
  { bar: 'explain', key: 'w', label: l => (originHere(l) ? 'hide where from' : 'where from'), shows: l => l.here !== undefined },
  { bar: 'explain', key: 'f', label: 'plan a fix', primary: true, shows: l => l.here !== undefined && fixHere(l) === null },
  { bar: 'explain', key: 'r', label: 'record from here', primary: true, shows: isPause },
  { bar: 'explain', key: 'x', label: 'bugs', dim: true, shows: l => !isPause(l) },
  { bar: 'explain', key: 'b', label: 'back', dim: true, shows: l => !isPause(l) },
  { bar: 'explain', key: 'n', label: 'next' },
  { bar: 'explain', key: 'i', label: 'into' },
  { bar: 'explain', key: 'o', label: 'out' },
  { bar: 'explain', key: 'p', label: l => (l.narrating ? 'prose' : 'prose off'), dim: true },
  { bar: 'bugs', key: 'e', label: 'explain', dim: true },
  { bar: 'bugs', key: 'k', label: 'prev', dim: true },
  { bar: 'bugs', key: 'j', label: 'next' },
  { bar: 'bugs', key: 'g', label: 'go to step' },
  { bar: 'bugs', key: 'r', label: 'rescan', dim: true },
]

export const KEY_HELP = [
  'n next', 'b back', 'i into', 'o out', '123 go to step',
  'w where from', 'f plan a fix', 'a apply', 'u undo', 'd dismiss',
  'x bugs', 'j/k next/prev bug', 'g go to bug', 'e explain',
  'r record again (rescan in the bugs view; record from here at a pause without a recording)', 'p prose',
].join(' · ')

/** The keys that move the Time Machine, as `pyokka step` flags. */
export const MOVES: Record<string, string> = { n: '--over', b: '--back', i: '--into', o: '--out' }

/** Tool actions that are a key press; `show`, `hide` and `step` are served in `useTool`. */
export const TOOL_ACTIONS: Record<string, string> = { explain: 'e', bugs: 'x', origin: 'w', fix: 'f' }

export type ToolInput = { action?: string; step?: number; session?: string }

export const TOOL_SPEC = {
  name: 'band',
  description: [
    'Shows or hides the Pyokka band above the person\'s prompt and sets what it shows.',
    'The band follows the Pyokka Time Machine of a VS Code session: the code around the current step, the recorded values, the call stack, a short explanation, and bugs found in the run.',
    'Call action "show" when you start to step through a run with the person, "hide" when the work moves to something else (planning, editing other code).',
    '"explain" and "bugs" pick the view; "step" moves the Time Machine to `step`; "origin" shows and returns where the bad value of the bug on the current step came from (`pyokka origin`), newest step first, with the root to fix; "fix" writes a fix plan for that bug, aimed at the root, to .pyokka/findings and leaves the source file as it is.',
    'Applying the fix is the person\'s choice: point them to `/pk a` (apply) and `/pk u` (undo).',
    'At a `pyokka debug` pause without a recording the band shows the paused frame: "show" and "explain" work, "step", "bugs", "origin" and "fix" answer that they need a recording.',
    'Pass `session` (a file name such as "invoices.py") when several VS Code sessions are live.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['show', 'hide', 'step', ...Object.keys(TOOL_ACTIONS)] },
      step: { type: 'number', description: 'for action "step": the step to move to' },
      session: { type: 'string', description: 'the session to follow, by file name or descriptor path' },
    },
    required: ['action'],
  },
}
