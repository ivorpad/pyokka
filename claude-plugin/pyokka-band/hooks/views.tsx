import type { Elements, RenderInput } from 'claude-code'

import type { OriginLink, Prose, Spot } from '../types'
import { BUTTONS, fixHere, originHere } from './keys'
import { linkHow } from './plans'
import type { Bar, Look } from './keys'
import { baseName } from './parse'

// The band's drawing: one function per view. Each gets the surface's elements, the band's
// width, what `look` read, and `act`, which does what a key does (`press` in register.tsx).

type Band = RenderInput<'AbovePrompt'>
export type Ui = Elements[Band['surface']]
export type Act = (key: string) => unknown

const cut = (text: string, room: number) => (text.length > room ? `${text.slice(0, room - 1)}…` : text)

const BAR = 14

/** The buttons of one bar, as BUTTONS lists them; each press goes through `press`. */
function buttons(ui: Ui, act: Act, l: Look, bar: Bar) {
  const { Button } = ui
  return BUTTONS.filter(b => b.bar === bar && (b.shows?.(l) ?? true)).map(b => (
    <Button
      key={`${bar}-${b.key}`}
      label={typeof b.label === 'string' ? b.label : b.label(l)}
      hotkey={b.key}
      plain
      variant={b.primary ? 'primary' : undefined}
      dimColor={b.dim}
      onPress={() => act(b.key)}
    />
  ))
}

export function errorView(ui: Ui, width: number, message: string) {
  const { Box, Text } = ui
  return (
    <Box>
      <Text dimColor>{cut(`pyokka  ${message}`, width)}</Text>
    </Box>
  )
}

export function bugsView(ui: Ui, act: Act, width: number, l: Look, spot: Spot) {
  const { Box, Text } = ui
  const found = l.found
  const list = found?.findings ?? []
  const tone = (c: string) => (c === 'high' ? 'red' : c === 'medium' ? 'yellow' : 'gray')
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
      <Box justifyContent="space-between">
        <Box>
          <Text color="red" bold>pyokka bugs </Text>
          <Text dimColor>{found === null ? 'scanning…' : `${list.length} suspicious step${list.length === 1 ? '' : 's'} · from ${found.source}`}</Text>
        </Box>
        <Text dimColor>{`${spot.file} · #${spot.step}/${spot.count}`}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {found?.error ? <Text dimColor>{cut(found.error, width - 4)}</Text> : null}
        {found !== null && list.length === 0 && !found.error ? <Text dimColor>Nothing suspicious found in this run.</Text> : null}
        {list.slice(0, 6).map((f, i) => (
          <Box key={`f${f.id}`}>
            <Text color={i === l.index ? 'cyan' : undefined}>{i === l.index ? '▶ ' : '  '}</Text>
            <Text color={tone(f.confidence)}>{'● '}</Text>
            <Text bold={i === l.index}>{cut(`${f.kind}  ${f.where}  #${f.step}`, 48)}</Text>
            <Text dimColor>{cut(`  ${f.reason}`, Math.max(10, width - 58))}</Text>
          </Box>
        ))}
        {list.length > 6 ? <Text dimColor>{`  … ${list.length - 6} more`}</Text> : null}
      </Box>
      {l.picked ? (
        <Box marginTop={1}>
          <Text color="red">{'▌ '}</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="wrap">{l.picked.reason || l.picked.kind}</Text>
          </Box>
        </Box>
      ) : null}
      <Box justifyContent="flex-end" marginTop={1} columnGap={2}>
        {buttons(ui, act, l, 'bugs')}
      </Box>
    </Box>
  )
}

function fixBox(ui: Ui, act: Act, l: Look, inner: number) {
  const { Box, Text } = ui
  const proposed = fixHere(l)
  if (!proposed) return null
  const title =
    proposed.status === 'thinking' ? 'fix: asking the model…'
    : proposed.status === 'checking' ? 'fix: re-running the original and the patched copy…'
    : proposed.status === 'failed' ? `fix failed: ${proposed.error ?? ''}`
    : proposed.status === 'applied' ? `fix applied to ${baseName(proposed.path)}`
    : 'fix plan'
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={proposed.status === 'applied' ? 'green' : 'yellow'} paddingX={1}>
      <Text bold color={proposed.status === 'failed' ? 'red' : 'yellow'}>{title}</Text>
      {proposed.explanation ? <Text wrap="wrap">{proposed.explanation}</Text> : null}
      {proposed.plan ? <Text color="cyan">{cut(`plan: .pyokka/findings/${baseName(proposed.plan)}`, inner - 4)}</Text> : null}
      {proposed.diff.map((d, i) => (
        <Text key={`d${i}`} color={d.sign === '-' ? 'red' : 'green'}>{cut(`${d.sign} ${String(d.line).padStart(3)}  ${d.text}`, inner - 4)}</Text>
      ))}
      {proposed.verify ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{`exceptions swallowed: ${proposed.verify.exceptionsBefore} → ${proposed.verify.exceptionsAfter}`}</Text>
          <Text dimColor>{cut(`before: ${proposed.verify.before.replace(/\n/g, ' · ')}`, inner - 4)}</Text>
          <Text color={proposed.verify.exceptionsAfter === 0 ? 'green' : 'yellow'}>{cut(`after:  ${proposed.verify.after.replace(/\n/g, ' · ')}`, inner - 4)}</Text>
        </Box>
      ) : null}
      <Box columnGap={2} marginTop={1}>
        {buttons(ui, act, l, 'fix')}
      </Box>
    </Box>
  )
}

/** One link as a line: the place and the root mark stay whole, the expression is cut to fit. */
const linkLabel = (x: OriginLink, room: number) => {
  const head = `${x.root ? '▶' : ' '} #${x.step} ${x.where} ${x.function}  `
  const tail = `  (${linkHow(x)})${x.root ? '  ◀ root' : ''}`
  return `${head}${cut(`${x.expression} = ${x.value}`, Math.max(12, room - head.length - tail.length))}${tail}`
}

/**
 * Where the finding's bad value came from (`pyokka origin`): newest step first, the root marked
 * `▶`, links picked by value (inferred, text match) dimmed. Each link moves the Time Machine there.
 */
function originBox(ui: Ui, act: Act, l: Look, inner: number) {
  const { Box, Button, Text } = ui
  const chain = originHere(l)
  if (!chain) return null
  const root = chain.links.find(x => x.root)
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text dimColor>{chain.error ? cut(`where from: ${chain.error}`, inner - 2) : 'where from, newest first:'}</Text>
      {chain.links.map((x, i) => (
        <Button
          key={`origin-${i}`}
          label={linkLabel(x, inner - 4)}
          plain
          dimColor={x.certainty !== 'recorded'}
          variant={x.root ? 'primary' : undefined}
          onPress={() => act(String(x.step))}
        />
      ))}
      {chain.error ? null : root ? (
        <Text color="yellow" wrap="wrap">{`root: #${root.step} ${root.where} ${root.function}: ${chain.rootReason ?? ''}`}</Text>
      ) : (
        <Text color="yellow" wrap="wrap">{`root: not known. ${chain.end ?? chain.rootUnknown ?? ''}`}</Text>
      )}
    </Box>
  )
}

/** At a pause without a recording: the exception the program stopped on, and the frame's variables. */
function pauseBox(ui: Ui, spot: Spot, inner: number) {
  const { Box, Text } = ui
  const pause = spot.pause
  if (!pause) return null
  const thrown = pause.exception
  const named = Math.min(16, Math.max(0, ...pause.variables.map(v => v.name.length)))
  const shaped = Math.min(12, Math.max(0, ...pause.variables.map(v => v.shape.length)))
  return (
    <Box flexDirection="column" marginTop={1}>
      {thrown ? (
        <Box>
          <Text color="red" bold>{'⚠ '}</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text color="red" wrap="wrap">{`${thrown.uncaught ? 'uncaught ' : ''}${thrown.type}: ${thrown.message}`}</Text>
          </Box>
        </Box>
      ) : null}
      {pause.variables.length === 0 ? <Text dimColor>no variables in this frame</Text> : null}
      {pause.variables.slice(0, 6).map(v => (
        <Box key={`v-${v.name}`}>
          <Text>{`  ${v.name.padEnd(named)}  `}</Text>
          <Text color="cyan">{`${v.shape.padEnd(shaped)}  `}</Text>
          <Text color="gray">{cut(v.text, Math.max(10, inner - named - shaped - 6))}</Text>
        </Box>
      ))}
      {pause.variables.length > 6 ? <Text dimColor>{`  … ${pause.variables.length - 6} more`}</Text> : null}
    </Box>
  )
}

export function explainView(ui: Ui, act: Act, width: number, l: Look, spot: Spot, said: Prose) {
  const { Box, Text } = ui
  // findings belong to a recording; a pause without one has none
  const findings = spot.pause ? [] : (l.found?.findings ?? [])
  const here = l.here
  // a finding belongs to the time it happened: reached (at or before this step) or ahead
  const inFile = findings.filter(f => f.where.startsWith(`${spot.file}:`))
  const reachedLines = new Set(inFile.filter(f => f.step <= spot.step).map(f => f.where.slice(spot.file.length + 1)))
  const aheadLines = new Set(inFile.filter(f => f.step > spot.step).map(f => f.where.slice(spot.file.length + 1)))
  const reached = findings.filter(f => f.step <= spot.step).length
  const ahead = findings.length - reached
  const inner = width - 4
  const stack = spot.stack.slice().reverse().map(f => f.function).join(' › ')
  const story =
    !l.narrating || said === null || said.step !== spot.step
      ? null
      : said.text ?? (said.failed ? `no narration: ${said.failed}` : null)
  const writing = l.narrating && said !== null && said.step === spot.step && said.text === null && !said.failed
  const filled = spot.count > 0 ? Math.round((spot.step / spot.count) * BAR) : 0
  const shownLines = spot.window.length ? spot.window : spot.around
  const gutter = String(Math.max(...shownLines.map(x => x.line), 0)).length
  const indent = Math.min(...shownLines.filter(x => x.text.trim()).map(x => x.text.length - x.text.trimStart().length), 99)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Box>
          <Text color="cyan" bold>pyokka </Text>
          <Text bold>{cut(`${spot.file}:${spot.line}`, 40)}</Text>
          <Text dimColor>{` · ${cut(spot.function, 30)}`}</Text>
          {reached && !spot.stale ? <Text color="red" bold>{`  ⚠ ${reached}`}</Text> : null}
          {ahead && !spot.stale ? <Text dimColor>{`  ○ ${ahead} ahead`}</Text> : null}
        </Box>
        {spot.pause ? (
          <Text color="yellow">paused · no recording</Text>
        ) : (
          <Box>
            <Text color="cyan">{'━'.repeat(filled)}</Text>
            <Text dimColor>{'─'.repeat(BAR - filled)}</Text>
            <Text dimColor>{` #${spot.step}/${spot.count}`}</Text>
          </Box>
        )}
      </Box>
      {spot.stale ? (
        <Box marginTop={1} columnGap={2}>
          <Text color="yellow">{'◌ The file changed since this recording: values and findings are from the old run.'}</Text>
          {buttons(ui, act, l, 'stale')}
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {shownLines.map(x => {
          const code = x.text.slice(indent)
          const seen = spot.inline[String(x.line)]
          const tail = seen ? `  ${seen.hits > 1 ? `×${seen.hits} ` : ''}${seen.text}` : ''
          const room = inner - gutter - 3
          const shownCode = cut(code, room)
          const mark = spot.stale ? ' ' : reachedLines.has(String(x.line)) ? '●' : aheadLines.has(String(x.line)) ? '○' : ' '
          return (
            <Box key={`l${x.line}`}>
              <Text color={mark === '●' ? 'red' : undefined} dimColor={mark === '○'}>{mark}</Text>
              <Text color={x.current ? 'yellow' : undefined} dimColor={!x.current}>
                {`${x.line === spot.line ? '▶' : x.current ? '│' : ' '}${String(x.line).padStart(gutter)} `}
              </Text>
              <Text color={x.current ? 'yellow' : undefined} bold={x.line === spot.line}>
                {shownCode}
              </Text>
              {tail && shownCode.length < room - 4 ? <Text color="gray" italic>{cut(tail, room - shownCode.length)}</Text> : null}
            </Box>
          )
        })}
      </Box>
      {here ? (
        <Box marginTop={1}>
          <Text color="red" bold>{'⚠ '}</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text color="red" wrap="wrap">{`${here.kind}: ${here.reason}`}</Text>
          </Box>
        </Box>
      ) : null}
      {pauseBox(ui, spot, inner)}
      {l.notice ? <Text color="yellow" wrap="wrap">{l.notice}</Text> : null}
      {originBox(ui, act, l, inner)}
      {fixBox(ui, act, l, inner)}
      {story || writing ? (
        <Box marginTop={1}>
          <Text color="cyan">{'▌ '}</Text>
          <Box flexGrow={1} flexShrink={1}>
            {writing ? <Text dimColor italic>writing…</Text> : <Text wrap="wrap">{story}</Text>}
          </Box>
        </Box>
      ) : null}
      <Box justifyContent="space-between" marginTop={1}>
        <Text dimColor wrap="truncate">{cut(stack, Math.max(10, inner - 46))}</Text>
        <Box key="moves" columnGap={2}>
          {buttons(ui, act, l, 'explain')}
        </Box>
      </Box>
    </Box>
  )
}
