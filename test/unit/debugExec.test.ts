import { describe, expect, it } from 'vitest';
import { UNTIL_WATCH_ID, assignment, clampCount, consoleText, continueTo, continueUntil, execReply, execResult, stepCount, stepCountExtras, type StopRunner } from '../../src/debug/debugExec';
import type { BreakWatchSpec, DebugReason, PausedInfo } from '../../src/session/debugState';
import type { ValueBag, ValueNode } from '../../src/shared/protocol';

function bag(value: string): ValueBag {
  const data: ValueNode = { type: 'number', id: `n:${value}`, queryPath: [], value };
  return { data, runtimeKey: `x:${value}` };
}

function pause(reason: DebugReason, step: number): PausedInfo {
  return { step, rid: 1, fileId: 1, line: 10, scopeId: 0, depth: 0, reason, stack: [] };
}

/** A recorded runner: what was asked, in order, and the stops it hands back. */
function runner(stops: (PausedInfo | 'finished')[]): StopRunner & { calls: string[]; held: BreakWatchSpec[] } {
  const calls: string[] = [];
  let held: BreakWatchSpec[] = [{ id: 'w1', exp: 'total', breakWhen: 'change' }];
  const queue = [...stops];
  const r: StopRunner & { calls: string[]; held: BreakWatchSpec[] } = {
    calls,
    get held() {
      return held;
    },
    watches: () => held,
    setWatches: async (specs) => {
      held = specs.map((w) => ({ ...w }));
      calls.push(`watches ${specs.map((w) => w.id).join(',') || '(none)'}`);
    },
    resume: async () => void calls.push('resume'),
    step: async (kind) => void calls.push(`step ${kind}`),
    runTo: async (file, line) => void calls.push(`runTo ${file}:${line}`),
    stop: async (action) => {
      await action();
      return queue.shift() ?? 'finished';
    },
  };
  return r;
}

describe('exec results', () => {
  it('maps a value, a statement, an exception and modified out of the runner reply', () => {
    expect(execResult({ text: '3', modified: true, valueBag: bag('3') })).toEqual({ text: '3', modified: true, valueBag: bag('3') });
    expect(execResult({ text: '', modified: true })).toEqual({ text: '', modified: true });
    // any attempt sets modified: a statement that raised halfway may already have written
    expect(execResult({ text: '', modified: true, exception: { type: 'KeyError', message: "'b'", traceback: 'Traceback…' } })).toEqual({
      text: '',
      modified: true,
      exception: { type: 'KeyError', message: "'b'", traceback: 'Traceback…' },
    });
    // a reply that says nothing about modified is still a write attempt
    expect(execResult({ text: '' }).modified).toBe(true);
    expect(execResult({ text: '', modified: false }).modified).toBe(false);
  });

  it('builds the bridge reply and redacts the text and the exception', () => {
    const r = execResult({ text: "'sk-secret'", modified: true, valueBag: bag('3'), exception: { type: 'ValueError', message: 'sk-secret', traceback: 'at sk-secret' } });
    expect(execReply(r, (t) => t.replace(/sk-secret/g, '***'))).toEqual({
      text: "'***'",
      modified: true,
      valueBag: bag('3'),
      exception: { type: 'ValueError', message: '***', traceback: 'at ***' },
    });
    expect(execReply({ text: '', modified: true })).toEqual({ text: '', modified: true });
  });

  it('prints an error like Python does and a value as its repr', () => {
    expect(consoleText({ text: '', modified: true, exception: { type: 'ZeroDivisionError', message: 'division by zero' } })).toBe('ZeroDivisionError: division by zero');
    expect(consoleText({ text: "'last'", modified: true })).toBe("'last'");
    expect(consoleText({ text: '', modified: true })).toBe('');
  });

  it('writes a variable as a statement, from a name or a nested path', () => {
    expect(assignment('rank', '3')).toBe('rank = 3');
    expect(assignment("payload['q']", "'b'")).toBe("payload['q'] = 'b'");
  });
});

describe('continue --until', () => {
  it('installs a one-shot watch next to the session, resumes, and removes it after the stop', async () => {
    const r = runner([pause('watch', 1408)]);
    const result = await continueUntil(r, 'rank == 3');
    expect(result).toEqual(pause('watch', 1408));
    expect(r.calls).toEqual(['watches w1,until', 'resume', 'watches w1']);
    expect(r.held).toEqual([{ id: 'w1', exp: 'total', breakWhen: 'change' }]);
  });

  it('removes the watch when the run ends instead of stopping', async () => {
    const r = runner(['finished']);
    expect(await continueUntil(r, 'rank == 3')).toBe('finished');
    expect(r.calls.at(-1)).toBe('watches w1');
    expect(r.held.some((w) => w.id === UNTIL_WATCH_ID)).toBe(false);
  });

  it('replaces an `until` watch a previous call left behind', async () => {
    const r = runner([pause('watch', 1), pause('watch', 2)]);
    await continueUntil(r, 'a');
    await continueUntil(r, 'b');
    expect(r.held.filter((w) => w.id === UNTIL_WATCH_ID)).toHaveLength(0);
  });
});

describe('continue --to', () => {
  it('goes through the transient run-to-line breakpoint', async () => {
    const r = runner([pause('breakpoint', 1500)]);
    expect(await continueTo(r, '/w/app.py', 82)).toEqual(pause('breakpoint', 1500));
    expect(r.calls).toEqual(['runTo /w/app.py:82']);
  });
});

describe('step --count', () => {
  it('takes N steps and answers the last stop', async () => {
    const r = runner([pause('step', 1), pause('step', 2), pause('step', 3)]);
    const out = await stepCount(r, 'over', 3);
    expect(out.result).toEqual(pause('step', 3));
    expect(stepCountExtras(out)).toEqual({});
    expect(r.calls).toEqual(['step over', 'step over', 'step over']);
  });

  it('gives way to a stop that is not the step and says after how many', async () => {
    const r = runner([pause('step', 1), pause('breakpoint', 2), pause('step', 3)]);
    const out = await stepCount(r, 'over', 3);
    expect(out.result).toEqual(pause('breakpoint', 2));
    expect(stepCountExtras(out)).toEqual({ stoppedEarly: { after: 2, reason: 'breakpoint' } });
    // the third step is never asked for
    expect(r.calls).toEqual(['step over', 'step over']);
  });

  it('reports how many steps were made when the program ends mid-count', async () => {
    const r = runner([pause('step', 1), pause('step', 2), 'finished']);
    const out = await stepCount(r, 'over', 5);
    expect(out.result).toBe('finished');
    expect(stepCountExtras(out)).toEqual({ stepped: 2 });
  });

  it('does not report an early stop when the last step is the one that landed elsewhere', async () => {
    const r = runner([pause('step', 1), pause('breakpoint', 2)]);
    const out = await stepCount(r, 'over', 2);
    expect(out.result).toEqual(pause('breakpoint', 2));
    expect(stepCountExtras(out)).toEqual({});
  });

  it('clamps the count to 1..1000', () => {
    expect(clampCount(3)).toBe(3);
    expect(clampCount(0)).toBe(1);
    expect(clampCount(-7)).toBe(1);
    expect(clampCount(5000)).toBe(1000);
    expect(clampCount('4')).toBe(4);
    expect(clampCount(2.7)).toBe(2);
    expect(clampCount('nonsense')).toBe(1);
    expect(clampCount(undefined)).toBe(1);
  });
});
