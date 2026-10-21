/**
 * The wire shapes of a replay (docs/PROTOCOL.md, "Replay"): what a recording run keeps of the
 * program's outside inputs, the `replay` field of a run request, and the one `replay.result`
 * event such a run answers with. A replay runs the program again in a runner of its own, checks
 * every step against the recording and copies one value whole; the host compares the values the
 * recording kept on the way (src/session/fullValue.ts).
 */
import type { RunEventBase, ValueNode } from './protocol';

/** What a recording run's program read from outside it, in order (the `inputs` event; handed back by a replay). */
export interface InputsRecord {
  /** the seed the `random` module's shared generator started from (52 bits, exact as a JS number) */
  seed: number;
  /** `[label, value]`: `time` a float, `time_ns` a decimal string, `urandom(N)` a hex string */
  reads: [label: string, value: string | number][];
  /** more reads than the runtime keeps (10,000): a replay that needs the next one goes another way */
  truncated?: boolean;
}

export interface ReplayRequest {
  /** base64 of little-endian int32 pairs (rid, depth), one per recorded step from 0 to `at.step` */
  expect: string;
  /** evaluate `expr` in the frame of step `step`, before its statement runs, and copy the value whole */
  at: { step: number; expr: string };
  /** at step `step` (at most `at.step`), the text the recorder would keep for `name`, to compare with what it kept */
  check?: { step: number; name: string };
  /** the recording run's inputs, handed back in order; absent, nothing is patched */
  inputs?: InputsRecord;
  /** a recording that began at a pause: run unrecorded until the debugger's statement count reaches this (`trace.startedAt`), record from there */
  startAt?: number;
}

export type ReplayStatus = 'reached' | 'diverged' | 'input' | 'ended' | 'error';

/** A recording run's outside inputs, once, before `run.finished` (`config.recordInputs`). */
export interface InputsEvent extends RunEventBase, InputsRecord {
  type: 'inputs';
}

/** The one answer of a replay run (`run.replay`); the program is stopped right after it. */
export interface ReplayResultEvent extends RunEventBase {
  type: 'replay.result';
  /** reached: step `at.step` with every step equal; diverged: `step` differs (or ran past the recording); input: a read the recording does not have; ended: the program finished first */
  status: ReplayStatus;
  step: number;
  /** steps compared and equal */
  matched: number;
  expected?: { rid: number; depth: number };
  actual?: { rid: number; depth: number };
  message?: string;
  /** `reached`: the whole value of `at.expr` (no registry behind it: nothing to load later) */
  value?: { data: ValueNode };
  /** `reached`: the expression's name is not defined in that frame */
  missing?: string;
  /** `reached`: the expression raised, or was refused */
  error?: string;
  /** the recorder's text for `check.name` at `check.step`; `missing` when it is not a local of that frame, `error` when its repr raised */
  check?: { step: number; text?: string; missing?: string; error?: string };
}

/** What a panel host answers beyond the common messages, announced in `init`. */
export interface PanelFeatures {
  /** `fullValue.query`: reruns for "Rerun value" (the extension; the browser page has none) */
  fullValue?: boolean;
  /** `why.followObjects`: a run that follows objects, from the Why summary's button (the extension; the browser page has none) */
  followObjects?: boolean;
}

/**
 * `checked`: the same steps, and every value the recording kept on the way came out the same;
 * `path`: the same steps, with nothing recorded on the way to compare a value with; `differs`:
 * the same steps, but a value came out different (the copy is shown, marked); `diverged`: the
 * replay took another way, so it has no value from this run; `unavailable`: this run cannot be
 * replayed (it called the network unrecorded, it began at a pause, ...); `error`: it failed.
 */
export type FullValueStatus = 'pending' | 'checked' | 'path' | 'differs' | 'diverged' | 'unavailable' | 'error';

/** "Rerun value" in the Variable and Why panes: one value copied by a replay of the run, and how far it was checked. */
export interface FullValueView {
  /** the pane's own key for the query (`change:12:orders`, `at:59:expected`) */
  key: string;
  status: FullValueStatus;
  /** the step the value was read at, before its statement ran */
  step: number;
  name: string;
  /** what was compared, or why there is no value: one or two sentences */
  summary: string;
  /** the whole value (`checked`, `path`, `differs`) */
  value?: ValueNode;
  /** the first value that came out different (`differs`) */
  difference?: { step: number; name: string; recorded: string; replay: string };
  /** steps compared and equal */
  matched?: number;
  /** how long the replay took, start to answer */
  ms?: number;
}
