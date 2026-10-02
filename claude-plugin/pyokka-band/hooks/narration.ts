import type { Finding, Spot } from '../types'

// One or two sentences per step from a small model, written from the code window, the
// recorded values, the stack and the previous stop's sentences.

// The house style of every sentence the band shows: the core writing rules of ASD-STE100
// (Simplified Technical English), without its dictionary.
export const STE_RULES = [
  'Write in Simplified Technical English (ASD-STE100):',
  '- Each sentence has at most 20 words and one idea. Write 2 or 3 sentences.',
  '- Use the active voice. Name who does the action: the function, the line, the loop.',
  '- Use the simple present for what the code does, and the simple past for what this run did.',
  '- Use common words, and use the same word for the same thing every time. Do not use synonyms.',
  '- Use the names from the code exactly as they are written.',
  '- Repeat the noun instead of "it" or "this" when the reference is not clear.',
  '- Use "a" and "the" before nouns.',
  '- Do not use -ing words, except in names from the code.',
  '- Do not use phrasal verbs (use "make", "find", "stop", not "come up with", "figure out", "end up").',
  '- Give values as digits, exactly as recorded.',
  '- Do not use filler words: no "basically", "essentially", "simply", "ensures", "it matters because".',
].join('\n')

export const narrationPrompt = (spot: Spot, before: string, finding?: Finding): string =>
  spot.pause ? pausePrompt(spot, before) : [
    'A person steps through a recorded Python run. Explain the current line:',
    'what the line does with the values below, and what the line gives to the next part of the program.',
    'Use only the values shown. If no values are shown, tell what the line does. No preamble, no markdown.',
    STE_RULES,
    '',
    `Step ${spot.step} of ${spot.count}, ${spot.file}:${spot.line}, in ${spot.function}`,
    `Call stack: ${spot.stack.slice().reverse().map(f => f.function).join(' -> ')}`,
    'Code (> is the current line):',
    ...spot.around.map(l => `${l.current ? '>' : ' '} ${l.line}  ${l.text}`),
    spot.values.length ? `Recorded values: ${spot.values.slice(0, 4).join('; ')}` : 'Recorded values: none at this step',
    before ? `What you said at the previous stop: ${before}` : '',
    finding ? `A bug detector found a problem at this step (${finding.kind}): ${finding.reason}. Tell what goes wrong here, and what the program does wrong after it.` : '',
  ].join('\n')

/** The prompt at a debug pause with nothing recorded: the frame's variables, no history. */
export const pausePrompt = (spot: Spot, before: string): string => {
  const pause = spot.pause
  const thrown = pause?.exception
  return [
    'A person pauses a running Python program in a debugger. Explain the current line:',
    'what the line does with the variables below, and what the line gives to the next part of the program.',
    'Use only the values shown. The debugger recorded nothing before this pause, so tell only what the frame holds now. No preamble, no markdown.',
    STE_RULES,
    '',
    thrown
      ? `Stopped at ${spot.file}:${spot.line}, in ${spot.function}, where the line raised an exception`
      : `Paused (${pause?.reason ?? 'pause'}) at ${spot.file}:${spot.line}, in ${spot.function}, before the line runs`,
    `Call stack: ${spot.stack.slice().reverse().map(f => f.function).join(' -> ')}`,
    'Code (> is the current line):',
    ...spot.around.map(l => `${l.current ? '>' : ' '} ${l.line}  ${l.text}`),
    pause?.variables.length
      ? `Variables in the paused frame: ${pause.variables.slice(0, 6).map(v => `${v.name} (${v.shape}) = ${v.text}`).join('; ')}`
      : 'Variables in the paused frame: none',
    before ? `What you said at the previous stop: ${before}` : '',
    thrown ? `The exception: ${thrown.uncaught ? 'nobody catches it, so it ends the program' : 'raised here'}: ${thrown.type}: ${thrown.message}. Tell what goes wrong here.` : '',
  ].join('\n')
}
