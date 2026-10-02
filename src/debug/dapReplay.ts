/**
 * The replay half of the DAP translator (docs/PROTOCOL.md, "Replay debug session"). A target with
 * a `replay` source is a recording the Time Machine navigates. `stepBack` and `reverseContinue`
 * move it backward; `next`, `stepIn`, `stepOut` and `continue` move it forward, and at the
 * frontier of a paused debug run they execute instead. Every Time Machine move, from the debug
 * toolbar, the panel or the agent bridge, posts one `stopped` event, and while the step shown is
 * not the live pause the stack, the variables, hovers and the Watch view answer from the
 * recording (replayFrames.ts). A `replayOnly` target is a finished run: nothing runs, and the
 * Debug Console reads recorded names.
 */
import type { PausedInfo } from '../session/debugState';
import { lookupRecorded, type ReplayFrame, type ReplayVar } from '../session/replayFrames';
import type { ValueNode } from '../shared/protocol';
import type { ReplaySource } from './debugTarget';
import type { DapCompletionItem, DapStackFrame } from './dapTypes';
import { source } from './dapShared';

/** The recorded call stack as DAP frames: ids 1.., the callers dimmed like the live stack's. */
export function replayStack(frames: readonly ReplayFrame[], pathFor: (fileId: number) => string | undefined): { stackFrames: DapStackFrame[]; totalFrames: number } {
  const stackFrames = frames.map((f, i): DapStackFrame => {
    const hint = i === 0 ? {} : { presentationHint: 'subtle' as const };
    return { id: i + 1, name: f.name, source: source(pathFor(f.fileId)), line: f.line || 1, column: f.col + 1, ...hint };
  });
  return { stackFrames, totalFrames: stackFrames.length };
}

/** A hover, a Watch row or the Debug Console at a recorded step: a recorded name and its members; nothing runs. */
export function recordedValue(vars: readonly ReplayVar[], expression: string, step: number): { text: string; node?: ValueNode } {
  const found = lookupRecorded(vars, expression);
  if (!found) throw new Error(`${expression.trim()} is not in the recording at step ${step}: a replay answers recorded names and their members`);
  return found;
}

/**
 * The page of the stack a `stackTrace` request asked for. VS Code asks for the top frame first
 * (`levels: 1`) and the rest later (`startFrame: 1`); answering every frame both times left the
 * client with one frame, or the same frames twice, and nothing below the top to focus.
 */
export function pageFrames(all: { stackFrames: DapStackFrame[]; totalFrames: number }, startFrame: unknown, levels: unknown): { stackFrames: DapStackFrame[]; totalFrames: number } {
  const start = typeof startFrame === 'number' && startFrame > 0 ? startFrame : 0;
  const count = typeof levels === 'number' && levels > 0 ? levels : all.stackFrames.length;
  return { stackFrames: all.stackFrames.slice(start, start + count), totalFrames: all.totalFrames };
}

/** Recorded names that continue the identifier before the caret; members are not offered (nothing runs to list them). */
export function recordedCompletions(vars: readonly ReplayVar[], typed: string, column: number): DapCompletionItem[] {
  if (/\.\s*\w*$/.test(typed)) return [];
  const prefix = /[A-Za-z_]\w*$/.exec(typed)?.[0] ?? '';
  return vars.filter((v) => v.name.startsWith(prefix)).map((v) => ({ label: v.name, type: 'variable', start: column - prefix.length, length: prefix.length }));
}

/**
 * Which step the debug views show and when a `stopped` is owed. Every Time Machine move schedules
 * a sync; the sync runs a macrotask later (after the response to the request that moved, once per
 * burst of moves) and posts one `stopped` when the step changed, or when a request forced it: a
 * move that hit a dead end still owes the client a stop, or its toolbar stays on "running".
 * At the live pause of a debug run the live views come back (`show.live`).
 */
export class ReplayStops {
  /** the recorded step the views show; undefined while they show the live pause, or nothing */
  shown: number | undefined;
  /** the last stop shown, `live:N` or `replay:N` */
  private last: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private force = false;

  constructor(
    private readonly state: () => { replay: ReplaySource | undefined; paused: PausedInfo | undefined },
    private readonly show: { live: (info: PausedInfo) => void; step: (step: number) => void },
  ) {}

  /** the live run paused: the views show it */
  livePaused(step: number): void {
    this.shown = undefined;
    this.last = `live:${step}`;
  }

  schedule(force = false): void {
    if (force) this.force = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.sync();
    }, 0);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private sync(): void {
    const force = this.force;
    this.force = false;
    const { replay, paused } = this.state();
    if (!replay) return;
    if (!replay.active) {
      if (this.shown === undefined) return;
      // the Time Machine closed over a live debug run: back to its pause
      this.shown = undefined;
      if (paused) this.show.live(paused);
      return;
    }
    const step = replay.step;
    if (paused && paused.step === step) {
      if (force || this.last !== `live:${step}`) this.show.live(paused);
      return;
    }
    if (!force && this.last === `replay:${step}`) return;
    this.shown = step;
    this.last = `replay:${step}`;
    this.show.step(step);
  }
}
