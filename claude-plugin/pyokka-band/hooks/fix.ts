import type { Finding, Fix, OriginLink, Spot } from '../types'
import { STE_RULES } from './narration'
import { originLines } from './plans'

// Fixing a finding: the prompt for the model, and the edits it answers with. Asking, checking
// the edit on a copy and writing it to the person's file happen in register.tsx.

export type Edit = { start: number; end: number; replacement: string }

const numbered = (source: string) => source.split('\n').map((t, i) => `${String(i + 1).padStart(4)}  ${t}`).join('\n')

export const fixPrompt = (finding: Finding, spot: Spot, source: string, origin: OriginLink[] | undefined = finding.origin): string =>
  [
    'A Python program ran to the end without an error, but a recording of the run shows a bug.',
    `Finding (${finding.kind}) at step ${finding.step}, ${finding.where}: ${finding.reason}`,
    spot.values.length ? `Recorded values near it: ${spot.values.slice(0, 6).join('; ')}` : '',
    ...(origin?.length
      ? ['The bad value came to the failing statement through these steps, the oldest first:', ...originLines(origin.slice().reverse()),
        origin.some(l => l.root)
          ? 'Fix the step marked root, not the line that raised. Links marked inferred or text match were picked by value; check them against the code.'
          : 'The root is not known: the chain stops before a statement that made the value. Find where the oldest step got it.']
      : []),
    'Fix the root cause with the smallest edit: make the data correct where it goes wrong.',
    'Keep the program\'s behaviour for valid input. Do not widen or hide the exception handling.',
    'Write the explanation with these rules:',
    STE_RULES,
    'Answer with JSON only, no markdown: {"explanation": "2 or 3 sentences: the cause, and what the fix changes",',
    '"edits": [{"start": first line number to replace, "end": last line number to replace, "replacement": "the new lines, newline separated, with the original indentation"}]}',
    '',
    'The file, with line numbers:',
    numbered(source),
  ].filter(Boolean).join('\n')

export const applyEdits = (source: string, edits: Edit[]): string => {
  const lines = source.split('\n')
  for (const edit of edits.slice().sort((a, b) => b.start - a.start)) {
    lines.splice(edit.start - 1, edit.end - edit.start + 1, ...edit.replacement.split('\n'))
  }
  return lines.join('\n')
}

export const diffOf = (source: string, edits: Edit[]): NonNullable<Fix>['diff'] => {
  const lines = source.split('\n')
  const out: NonNullable<Fix>['diff'] = []
  for (const edit of edits.slice().sort((a, b) => a.start - b.start)) {
    for (let n = edit.start; n <= edit.end; n++) out.push({ sign: '-', line: n, text: lines[n - 1] ?? '' })
    edit.replacement.split('\n').forEach((text, i) => out.push({ sign: '+', line: edit.start + i, text }))
  }
  return out
}

/** The model's answer: the explanation and the edits inside the reply's outermost braces. */
export const readAnswer = (reply: string): { explanation: string; edits: Edit[] } => {
  const json = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)
  const answer = JSON.parse(json) as { explanation?: string; edits?: Edit[] }
  const edits = (answer.edits ?? []).filter(e => e.start >= 1 && e.end >= e.start)
  return { explanation: answer.explanation ?? '', edits }
}
