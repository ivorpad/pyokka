/**
 * What VS Code's Call Stack and Variables views show while the Time Machine replays a recording:
 * the frames at a step and each frame's variables as the recording knows them. Pure, no vscode,
 * so vitest covers it (test/unit/replayFrames.test.ts); the DAP side is dapTranslator.ts.
 *
 * A frame is a scope instance of the trace (one call), so a frame's variables are the values
 * recorded inside that one call up to the step. Two sources, the same two `var` uses:
 *
 * - recorded locals (`recordLocals`): a `locals` entry at step S is the frame's state at the
 *   start of S, so an entry counts when its step is at or before the step shown;
 * - logged values whose context is a bare name (`# ?`, Auto Log, which the Time Machine turns on):
 *   an entry counts when its step is at or before the step shown, which is what the editor's
 *   inline values show at that step (valuesAsOf.ts).
 *
 * When both know a name the later step wins, and on a tie the recorded local. Nothing here assumes
 * the recording starts at the program's first statement: a recording that starts mid-program
 * simply has no values from before its first step.
 */
import type { LocalsEvent, LogEvent, ValueNode } from '../shared/protocol';
import type { TraceModel } from '../timeMachine/traceModel';

export interface ReplayVar {
  name: string;
  text: string;
  /** the logged value's tree, when the value came from a log entry that carried one */
  node?: ValueNode;
  /** the step of the entry that gave the value */
  step: number;
  source: 'locals' | 'value';
}

export interface ReplayFrame {
  /** the function's name, `<module>` for a module body */
  name: string;
  fileId: number;
  line: number;
  /** 0-based, as the trace stores it */
  col: number;
  /** the step this frame is at: the current step for the innermost frame, the call site for the others */
  step: number;
  scopeId: number;
}

/** log kinds that carry a variable's value under its name (variableHistory.ts uses the same set) */
const VALUE_KINDS: ReadonlySet<string> = new Set(['value', 'autoLog', 'autoExpand']);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type LocalsEntry = LocalsEvent['entries'][number];

/** The call stack at `step`, innermost first: the Time Machine's own (`TraceModel.callStack`). */
export function replayFrames(trace: TraceModel, step: number): ReplayFrame[] {
  return trace.callStack(step).map((f) => ({ name: f.function || '<module>', fileId: f.fileId, line: f.line, col: f.col, step: f.step, scopeId: f.scopeId }));
}

/**
 * The recording's values by scope, built once per run and asked per stop. Building walks every
 * log entry and every locals entry once; a question walks only the entries of one scope.
 */
export class ReplayIndex {
  private readonly localsByScope = new Map<number, LocalsEntry[]>();
  private readonly valuesByScope = new Map<number, LogEvent[]>();

  constructor(
    private readonly trace: TraceModel,
    locals: readonly LocalsEntry[],
    entries: Iterable<LogEvent>,
  ) {
    for (const entry of locals) push(this.localsByScope, entry.scopeId, entry);
    for (const e of entries) {
      if (!e.context || !VALUE_KINDS.has(e.kind) || !NAME.test(e.context)) continue;
      if (!trace.valid(e.step)) continue;
      push(this.valuesByScope, trace.scopeId(e.step), e);
    }
    for (const list of this.localsByScope.values()) list.sort((a, b) => a.step - b.step);
    for (const list of this.valuesByScope.values()) list.sort((a, b) => a.step - b.step || a.seq - b.seq);
  }

  /** The variables of the frame `scopeId` as of `step`, by name. */
  variables(scopeId: number, step: number): ReplayVar[] {
    const out = new Map<string, ReplayVar>();
    for (const entry of this.localsByScope.get(scopeId) ?? []) {
      if (entry.step > step) break;
      for (const ch of entry.changes) if (ch.name) out.set(ch.name, { name: ch.name, text: ch.text, step: entry.step, source: 'locals' });
    }
    for (const e of this.valuesByScope.get(scopeId) ?? []) {
      if (e.step > step) break;
      const name = e.context!;
      const known = out.get(name);
      if (known && known.step >= e.step) continue;
      const v: ReplayVar = { name, text: e.text, step: e.step, source: 'value' };
      if (e.valueBag?.data) v.node = e.valueBag.data;
      out.set(name, v);
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The variables of frame `index` (innermost 0) of the stack at `step`. */
  frameVariables(step: number, index: number): ReplayVar[] {
    const frame = replayFrames(this.trace, step)[index];
    return frame ? this.variables(frame.scopeId, frame.step) : [];
  }
}

function push<T>(map: Map<number, T[]>, key: number, value: T): void {
  let list = map.get(key);
  if (!list) map.set(key, (list = []));
  list.push(value);
}

/**
 * An expression the Watch view or a hover asks about, answered from the frame's recorded
 * variables: a name, then `.attr`, `[0]` or `['key']` steps into the logged value's tree.
 * Undefined when the recording does not hold it; nothing is evaluated.
 */
export function lookupRecorded(vars: readonly ReplayVar[], expression: string): { text: string; node?: ValueNode } | undefined {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)(.*?)\s*$/.exec(expression);
  if (!m) return undefined;
  const root = vars.find((v) => v.name === m[1]);
  if (!root) return undefined;
  const rest = m[2] ?? '';
  if (!rest) return root.node ? { text: root.text, node: root.node } : { text: root.text };
  let node = root.node;
  const step = /^(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*(-?\d+|'[^']*'|"[^"]*")\s*\])/;
  let tail = rest;
  while (tail) {
    const s = step.exec(tail);
    if (!s || !node) return undefined;
    const key = s[1] ?? s[2] ?? '';
    node = child(node, key);
    tail = tail.slice(s[0].length);
  }
  if (!node) return undefined;
  return { text: node.value ?? node.type, node };
}

function child(node: ValueNode, key: string): ValueNode | undefined {
  const props = node.props ?? [];
  const bare = /^['"].*['"]$/.test(key) ? key.slice(1, -1) : key;
  return props.find((p) => p.name === key) ?? props.find((p) => p.name === bare) ?? props.find((p) => p.name === `'${bare}'`) ?? props.find((p) => p.name === `"${bare}"`);
}
