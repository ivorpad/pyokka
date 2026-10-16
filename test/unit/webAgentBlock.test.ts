import { describe, expect, it } from 'vitest';
import { runAgentCommand } from '../../web/agent';
import type { RunEvent } from '../../src/shared/protocol';
import { MAIN, SOURCE, runEvents, setup } from './webPageFakes';

/**
 * An agent stepping through the page used to get one line of code back from a recording move and
 * none from a live pause, so it read the file again before it could explain the stop. Each reply now
 * carries the enclosing function, as the CLI's stops print it.
 */

type Block = { function: string; file: string; lines: { line: number; text: string; current?: boolean }[] };
const shape = (b: Block | undefined) => b?.lines.map((l) => [l.line, l.text, !!l.current]);
const tick = () => new Promise((r) => setTimeout(r, 0));

const LIB = '/w/lib.py';
const LIB_SOURCE = ['def scale(n):', '    doubled = n * 2', '    return doubled'].join('\n');

/** The main file as the runtime reports it: a function's span starts at its `def` line. */
function mainInstrumented(runId: string): RunEvent {
  return { ...(runEvents(runId)[1] as Extract<RunEvent, { type: 'file.instrumented' }>), functions: [{ rid: 1, name: 'add', bodyRange: [1, 0, 3, 12] }] };
}

describe('the code an agent reply carries', () => {
  it('a recording move returns the enclosing function with the landing line marked', async () => {
    const { host, link } = setup();
    const moved = (await runAgentCommand(host, link, { action: 'goto', step: 3 })) as { block?: Block };
    expect(moved.block).toMatchObject({ function: 'add', file: MAIN.path });
    expect(shape(moved.block)).toEqual([
      [1, 'def add(a, b):', false],
      [2, '    s = a + b', true],
      [3, '    return s', false],
    ]);
    const stepped = (await runAgentCommand(host, link, { action: 'step', kind: 'over' })) as { state: { block?: Block } };
    expect(stepped.state.block?.lines.find((l) => l.current)?.line).toBe(3);
  });

  it('state carries the block while the Time Machine is on, and none while it is off', async () => {
    const { host, link } = setup();
    expect(await runAgentCommand(host, link, { action: 'state' })).not.toHaveProperty('block');
    host.start({ step: 3 });
    expect(await runAgentCommand(host, link, { action: 'state' })).toHaveProperty('block.function', 'add');
  });

  it('a live pause returns the paused function with the paused line marked', async () => {
    const { host, link, feed } = setup();
    host.debug.setBreakpoint(MAIN.path, 2);
    host.debug.start();
    feed({ type: 'debug.begin', runId: 'd-1', content: SOURCE });
    feed({ type: 'debug.event', event: mainInstrumented('d-1') });
    link.replies.push({ type: 'debug.result', id: 1, locals: [{ name: 'a', text: '1' }, { name: 'b', text: '2' }] });
    feed({ type: 'debug.event', event: { runId: 'd-1', seq: 3, type: 'debug.paused', step: 3, rid: 2, fileId: 1, line: 2, scopeId: 1, depth: 1, reason: 'breakpoint', breakpoint: { path: MAIN.path, line: 2 }, stack: [{ frameId: 0, name: 'add', fileId: 1, line: 2 }, { frameId: 1, name: '<module>', fileId: 1, line: 5 }] } });
    for (let i = 0; i < 5; i++) await tick();
    const reply = (await runAgentCommand(host, link, { action: 'debug', op: 'state' })) as { location: string; locals: unknown[]; block?: Block };
    expect(reply).toMatchObject({ location: 'demo.py:2', locals: [{ name: 'a', text: '1' }, { name: 'b', text: '2' }] });
    expect(reply.block).toMatchObject({ function: 'add', file: MAIN.path });
    expect(shape(reply.block)).toEqual([
      [1, 'def add(a, b):', false],
      [2, '    s = a + b', true],
      [3, '    return s', false],
    ]);
  });

  it('a pause in another file reads that file from the bridge before it answers', async () => {
    const { host, link, feed } = setup();
    host.debug.setBreakpoint(LIB, 2);
    host.debug.start();
    feed({ type: 'debug.begin', runId: 'd-1', content: SOURCE });
    feed({ type: 'debug.event', event: mainInstrumented('d-1') });
    feed({ type: 'debug.event', event: { runId: 'd-1', seq: 3, type: 'file.instrumented', fileId: 2, path: LIB, rangeBase: 10, ranges: [[1, 0, 3, 18], [1, 0, 3, 18], [2, 4, 2, 19], [3, 4, 3, 18]], statements: [1, 2, 3], functions: [{ rid: 11, name: 'scale', bodyRange: [1, 0, 3, 18] }], magic: [] } });
    link.replies.push({ type: 'debug.result', id: 1, locals: [{ name: 'n', text: '4' }] });
    feed({ type: 'debug.event', event: { runId: 'd-1', seq: 4, type: 'debug.paused', step: 7, rid: 12, fileId: 2, line: 2, scopeId: 2, depth: 2, reason: 'breakpoint', breakpoint: { path: LIB, line: 2 }, stack: [{ frameId: 0, name: 'scale', fileId: 2, line: 2 }, { frameId: 1, name: '<module>', fileId: 1, line: 5 }] } });
    for (let i = 0; i < 5; i++) await tick();
    const answer = runAgentCommand(host, link, { action: 'debug', op: 'state' }) as Promise<{ block?: Block }>;
    const asked = () => link.sent.some((m) => m.type === 'file.read' && m.path === LIB);
    for (let i = 0; i < 100 && !asked(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(asked()).toBe(true);
    feed({ type: 'file', file: { path: LIB, displayName: 'lib.py', language: 'python', content: LIB_SOURCE } });
    const reply = await answer;
    expect(reply.block).toMatchObject({ function: 'scale', file: LIB });
    expect(shape(reply.block)).toEqual([
      [1, 'def scale(n):', false],
      [2, '    doubled = n * 2', true],
      [3, '    return doubled', false],
    ]);
  });
});
