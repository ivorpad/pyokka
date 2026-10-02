import type { Finding, Fix, ValueOrigin, OriginLink, Spot } from '../types'
import { baseName } from './parse'

// Fix plans: each proposed fix is written to .pyokka/findings/<file>-<finding>.md next to the
// program, a local file for the person, who applies it (`/pk a`). A later run without the
// finding marks it fixed.

export const planPath = (programPath: string, finding: Finding) => {
  const dir = programPath.slice(0, programPath.lastIndexOf('/'))
  const name = baseName(programPath).replace(/\.py$/, '')
  return `${dir}/.pyokka/findings/${name}-${finding.kind.replace(/[^a-z0-9]+/gi, '-')}-${finding.where.replace(/[^a-z0-9]+/gi, '-')}.md`
}

/** How a link joins the one before, and how sure the recording is: `argument`, `element, inferred`. */
export const linkHow = (l: OriginLink) => (l.certainty === 'recorded' ? l.how : `${l.how}, ${l.certainty}`)

/** One line per link, in the order given, for a plan, a prompt or the tool's answer. */
export const originLines = (origin: OriginLink[]): string[] =>
  origin.map(l => `#${l.step} ${l.where} ${l.function}: ${l.expression} = ${l.value} (${linkHow(l)})${l.root ? '  root: the value goes wrong here' : ''}`)

/** What the `band` tool's `origin` action tells the model. */
export const originAnswer = (finding: Finding, origin: NonNullable<ValueOrigin>): string => {
  if (origin.error) return `pyokka origin gave no chain: ${origin.error}`
  const root = origin.links.find(l => l.root)
  return [
    `Where the bad value of ${finding.kind} at #${finding.step} ${finding.where} came from, newest step first:`,
    ...originLines(origin.links),
    root ? `Root: #${root.step} ${root.where}: ${origin.rootReason ?? ''}` : `Root: not known. ${origin.rootUnknown ?? ''}`,
    'Links marked inferred or text match were picked by value; check one with `pyokka step --live --to N --into` before a fix rests on it.',
    'The band shows the chain; each step is a button that moves the Time Machine there.',
  ].join('\n')
}

export const planText = (
  finding: Finding,
  spot: Spot,
  proposal: NonNullable<Fix>,
  status: string,
  updatedAt: string,
  origin: OriginLink[] | undefined = finding.origin,
): string => {
  const v = proposal.verify
  const diff = proposal.diff.map(d => `${d.sign} ${String(d.line).padStart(3)}  ${d.text}`).join('\n')
  return [
    '---',
    `status: ${status}`,
    `program: ${baseName(spot.path)}`,
    `finding: ${finding.kind}`,
    `where: ${finding.where}`,
    `step: ${finding.step}`,
    `recorded: ${spot.count} steps`,
    `updated: ${updatedAt}`,
    '---',
    '',
    `# ${finding.kind} at ${finding.where}`,
    '',
    finding.reason,
    '',
    '## Reproduce',
    '',
    '```sh',
    `pyokka step --live --to ${finding.step}`,
    `pyokka why --live ${finding.step}`,
    '```',
    '',
    spot.values.length ? `Recorded values at that step: ${spot.values.slice(0, 6).map(x => `\`${x}\``).join(', ')}` : '',
    ...(origin?.length
      ? ['', '## Where from', '', 'Newest first, from `pyokka origin`:', '', ...originLines(origin).map(l => `- ${l}`),
        ...(origin.some(l => l.root) ? [] : ['', 'Root: not known. The chain stops before a statement that made the value.'])]
      : []),
    '',
    '## Cause and fix',
    '',
    proposal.explanation,
    '',
    '```diff',
    diff,
    '```',
    '',
    '## Checked by re-running a patched copy',
    '',
    v ? `- swallowed exceptions: ${v.exceptionsBefore} -> ${v.exceptionsAfter}` : '- not checked',
    v ? `- output before: \`${v.before.replace(/\n/g, ' / ')}\`` : '',
    v ? `- output after: \`${v.after.replace(/\n/g, ' / ')}\`` : '',
    '',
    'The check compares behaviour only; whether the new output is the right one is for the reader or a test to say.',
    '',
  ].join('\n')
}

/** The text of a plan once a fresh run no longer shows its finding. */
export const fixedText = (text: string, now: string, count: number): string =>
  text.replace(/^status: open$/m, 'status: fixed').replace(/^updated: .*$/m, `updated: ${now}`) +
  `\n## Fixed\n\nA run recorded at ${now} (${count} steps) no longer shows this finding.\n`
