import type { Finding } from '../types'

// The band's settings, and what one load of the plugin remembers outside its atoms (the atoms
// are in register.tsx, where the validator can read every update of them).

/** The CLI that reads a program. */
export const PYOKKA = ['pyokka']
/** How the program runs without the Time Machine, for a fix check. */
export const plainRun = (path: string) => ['python3', path]
export const POLL_MS = 3000
export const FOLLOW_MS = 60_000
// With no pyokka command, band press or band tool call for this long, the band steps aside.
export const IDLE_MS = 10 * 60_000
export const PYOKKA_COMMAND = /(^|[\s;&|/])(pyokka|pk)(\s|$)/
export const NARRATOR = 'haiku'
export const FIXER = 'sonnet'
/**
 * Where a fix is checked: `.pyokka/band-tmp/` next to the program, beside the plans in
 * `.pyokka/findings/`. The host has no temp-directory call, and `/tmp` is not on every OS.
 */
export const scratchDir = (programPath: string) => `${programPath.slice(0, programPath.lastIndexOf('/'))}/.pyokka/band-tmp`
export const WINDOW_BEFORE = 3
export const WINDOW_AFTER = 6

/** A fix plan written this load: its path, and how to know its finding in a later run. */
export type PlanRecord = { path: string; kind: string; where: string; status: string }

// One load's memory, outside the atoms because no view draws it. A reload of this code empties
// it, so what the band follows is an atom (`followed` in register.tsx).
export const memory = {
  /** Narrations written this load, by step (and whether a finding was on it), or by pause. */
  narrations: new Map<string, string>(),
  /** The last thing shown was a debug pause without a recording. */
  wasPaused: false,
  /** How that pause ended, when a step of the band's ran the program to its end. */
  pauseEnded: undefined as string | undefined,
  /** The last narration shown: the narrator reads it so stops read as one story. */
  previous: '',
  /** The run the last bug scan covered (file, step count, stale), so each run is scanned once. */
  scannedRun: '',
  /** Source files by path, read once per load. */
  sources: new Map<string, string[]>(),
  plans: new Map<string, PlanRecord>(),
}

export const findingAt = (findings: Finding[] | undefined, step: number): Finding | undefined =>
  findings?.find(f => f.step === step)
