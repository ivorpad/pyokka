/**
 * Running code at a pause, and the three ways an agent asks for more than one move
 * (docs/design/debugger-product.md, 2.7, 4.4). Pure and vscode-free, so vitest covers it
 * (test/unit/debugExec.test.ts); the logic lives here because debugSession.ts and the two bridge
 * sockets take wiring lines only.
 *
 * `exec` runs a statement in the paused frame. Any attempt sets `modified`, successful or not: the
 * runtime cannot know what a statement did, and one that raised halfway may already have written.
 * A raised exception comes back inside the result, because the session stays paused and both the
 * Debug Console and the CLI want "the error text, still paused" rather than a failed request.
 *
 * `until`, `to` and `count` are built from the moves the session already has: a one-shot break-when
 * watch, the transient run-to-line breakpoint, and N steps in a row.
 */
import type { ValueBag } from '../shared/protocol';
import type { BreakWatchSpec, DebugReason, PausedInfo, StepKind } from '../session/debugState';

export interface ExecResult {
  /** the last expression statement's value, or '' for a block that ends in a statement */
  text: string;
  modified: boolean;
  valueBag?: ValueBag;
  /** the statement raised; the session is still paused */
  exception?: { type: string; message: string; traceback?: string };
}

/** The runner's `executed` reply as an `ExecResult`; a reply from an older runtime is a plain value. */
export function execResult(reply: { text?: unknown; modified?: unknown; valueBag?: ValueBag; exception?: { type?: unknown; message?: unknown; traceback?: unknown } }): ExecResult {
  const out: ExecResult = { text: typeof reply.text === 'string' ? reply.text : '', modified: reply.modified !== false };
  if (reply.valueBag) out.valueBag = reply.valueBag;
  const e = reply.exception;
  if (e && typeof e === 'object') {
    out.exception = { type: String(e.type ?? 'Exception'), message: String(e.message ?? '') };
    if (typeof e.traceback === 'string' && e.traceback) out.exception.traceback = e.traceback;
  }
  return out;
}

/** `{text, modified, valueBag?, exception?}` as the bridge sends it; `redact` is the socket's. */
export function execReply(r: ExecResult, redact: (text: string) => string = (t) => t): Record<string, unknown> {
  const out: Record<string, unknown> = { text: redact(r.text), modified: r.modified };
  if (r.valueBag) out.valueBag = r.valueBag;
  if (r.exception) {
    const e: Record<string, unknown> = { type: r.exception.type, message: redact(r.exception.message) };
    if (r.exception.traceback) e.traceback = redact(r.exception.traceback);
    out.exception = e;
  }
  return out;
}

/**
 * What the Debug Console prints for an `exec`. A statement that raised reads like Python's own
 * error line, so the console shows `ZeroDivisionError: division by zero` and not a DAP failure:
 * the request succeeded, the statement did not.
 */
export function consoleText(r: ExecResult): string {
  if (r.exception) return `${r.exception.type}: ${r.exception.message}`;
  return r.text;
}

/** `setVariable`: the statement that writes the value, from a name or a nested node's path. */
export function assignment(target: string, value: string): string {
  return `${target} = ${value}`;
}

/* ---------- 4.4 until, to and count ---------- */

/** The one-shot watch `continue --until EXPR` installs; `w<digits>` ids cannot clash with it. */
export const UNTIL_WATCH_ID = 'until';

export const STEP_COUNT_MAX = 1_000;

/** `count` as the wire accepts it: an integer clamped to 1..1000; anything else is one step. */
export function clampCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(STEP_COUNT_MAX, Math.trunc(n)));
}

/**
 * What the driver needs from a paused session. Both products supply it: a `DebugSession` and a
 * recording run-all `Session` behind the facade. `stop` runs an action and waits for the stop it
 * leads to, which is the socket's own waiter.
 */
export interface StopRunner {
  /** the break-when watches the runtime holds right now */
  watches: () => readonly BreakWatchSpec[];
  /** replace them */
  setWatches: (specs: BreakWatchSpec[]) => Promise<void>;
  resume: () => Promise<void>;
  step: (kind: StepKind) => Promise<void>;
  /** the transient run-to-line breakpoint, then resume */
  runTo: (file: string, line: number) => Promise<void>;
  /** run `action` and wait for the next pause, or 'finished' when the program ended instead */
  stop: (action: () => Promise<void>) => Promise<PausedInfo | 'finished'>;
}

/**
 * `continue --until EXPR`: a break-when watch that lives for one resume. It is installed before the
 * resume and removed after the stop, and also when the run ends instead of stopping, which is why
 * the removal is in a `finally`.
 */
export async function continueUntil(r: StopRunner, exp: string): Promise<PausedInfo | 'finished'> {
  const kept = r.watches().filter((w) => w.id !== UNTIL_WATCH_ID);
  await r.setWatches([...kept, { id: UNTIL_WATCH_ID, exp, breakWhen: 'true' }]);
  try {
    return await r.stop(() => r.resume());
  } finally {
    await r.setWatches([...kept]).catch(() => undefined);
  }
}

/** `continue --to FILE:LINE`: the run-to-line breakpoint the pause already has, for one resume. */
export function continueTo(r: StopRunner, file: string, line: number): Promise<PausedInfo | 'finished'> {
  return r.stop(() => r.runTo(file, line));
}

export interface StepCountResult {
  /** the last stop, or 'finished' when the program ended mid-count */
  result: PausedInfo | 'finished';
  /** stops made before the program ended; only with 'finished' */
  stepped?: number;
  /** something else stopped the program on the way, and that stop wins */
  stoppedEarly?: { after: number; reason: DebugReason };
}

/**
 * `step --count N`: N stops in a row, the last one is the reply. Two early exits: a stop that is
 * not this step's (a breakpoint, a watch, an exception, a pause request) wins and is reported with
 * `stoppedEarly`, and a program that ended mid-count is reported with `stepped`.
 */
export async function stepCount(r: StopRunner, kind: StepKind, count: number): Promise<StepCountResult> {
  const n = clampCount(count);
  let last: PausedInfo | 'finished' = 'finished';
  for (let i = 0; i < n; i++) {
    last = await r.stop(() => r.step(kind));
    if (last === 'finished') return { result: last, stepped: i };
    if (last.reason !== 'step' && i + 1 < n) return { result: last, stoppedEarly: { after: i + 1, reason: last.reason } };
  }
  return { result: last };
}

/** `{stoppedEarly}` / `{stepped}` as the reply carries them; empty for a plain run of N steps. */
export function stepCountExtras(r: StepCountResult): Record<string, unknown> {
  if (r.stoppedEarly) return { stoppedEarly: { after: r.stoppedEarly.after, reason: r.stoppedEarly.reason } };
  if (r.stepped !== undefined) return { stepped: r.stepped };
  return {};
}
