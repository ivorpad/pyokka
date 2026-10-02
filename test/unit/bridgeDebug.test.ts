import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { BridgeDebug, applyWatchRequest, breakpointReply, displayFile, displayWatchItems, entryPause, exceptionMode, localsReply, nextWatchId, nodeText, outputTail, parseBreakItems, pausedReply, resolveFile, type PathContext } from '../../src/agent/bridgeDebug';
import type { PausedInfo } from '../../src/session/debugState';

// the module imports vscode for the gutter; the shaping under test never touches it
vi.mock('vscode', () => ({}));

const root = path.resolve('/ws');
const ctx: PathContext = {
  workspaceRoot: root,
  filePath: path.join(root, 'agent.py'),
  displayName: 'agent.py',
  runFiles: () => [
    { fileId: 1, path: path.join(root, 'agent.py') },
    { fileId: 2, path: path.join(root, 'lib', 'rank.py') },
  ],
};
const none = (): boolean => false;

describe('displayFile', () => {
  it('prints workspace files relative and others absolute', () => {
    expect(displayFile(ctx, path.join(root, 'lib', 'rank.py'))).toBe(path.join('lib', 'rank.py'));
    expect(displayFile(ctx, '/elsewhere/x.py')).toBe('/elsewhere/x.py');
    expect(displayFile({ ...ctx, workspaceRoot: '' }, path.join(root, 'agent.py'))).toBe(path.join(root, 'agent.py'));
  });
});

describe('resolveFile', () => {
  it('takes the display name, an absolute path, a relative path that exists, or the basename of a run file', () => {
    expect(resolveFile(ctx, undefined, none)).toBe(ctx.filePath);
    expect(resolveFile(ctx, 'agent.py', none)).toBe(ctx.filePath);
    expect(resolveFile(ctx, '/abs/other.py', none)).toBe('/abs/other.py');
    expect(resolveFile(ctx, 'lib/rank.py', none)).toBe(path.join(root, 'lib', 'rank.py'));
    expect(resolveFile(ctx, 'rank.py', none)).toBe(path.join(root, 'lib', 'rank.py'));
    // a file that is not in the run yet resolves against the workspace (a breakpoint before an import)
    expect(resolveFile(ctx, 'helper.py', none)).toBe(path.join(root, 'helper.py'));
    expect(resolveFile(ctx, 'new.py', (p) => p === path.join(root, 'new.py'))).toBe(path.join(root, 'new.py'));
  });
});

describe('parseBreakItems and breakpointReply', () => {
  it('drops entries without a line, keeps conditions, and annotates from the echo by path, line and condition', () => {
    const items = parseBreakItems(ctx, [{ file: 'rank.py', line: 12, condition: ' n > 3 ' }, { file: 'agent.py' }, { path: '/abs/x.py', line: '7' }, 'junk'], none);
    expect(items).toEqual([
      { path: path.join(root, 'lib', 'rank.py'), line: 12, condition: 'n > 3' },
      { path: '/abs/x.py', line: 7 },
    ]);
    const reply = breakpointReply(ctx, items, [{ path: path.join(root, 'lib', 'rank.py'), line: 12, condition: 'n > 3', rid: 88, fileId: 2, resolvedLine: 12 }, { path: '/abs/x.py', line: 7, error: 'SyntaxError: x' }]);
    expect(reply).toEqual([
      { file: path.join('lib', 'rank.py'), line: 12, condition: 'n > 3', rid: 88, fileId: 2, resolvedLine: 12 },
      { file: '/abs/x.py', line: 7, error: 'SyntaxError: x' },
    ]);
    expect(breakpointReply(ctx, items, undefined)[0]).toEqual({ file: path.join('lib', 'rank.py'), line: 12, condition: 'n > 3' });
  });
});

describe('pausedReply', () => {
  it('adds the absolute file of the frontier and prints the breakpoint file relative', () => {
    const info: PausedInfo = {
      step: 412,
      rid: 88,
      fileId: 2,
      line: 12,
      scopeId: 7,
      depth: 1,
      reason: 'breakpoint',
      breakpoint: { path: path.join(root, 'lib', 'rank.py'), line: 12, condition: 'n > 3', rid: 88, fileId: 2, resolvedLine: 12 },
      stack: [{ scopeId: 7, name: 'build', rid: 80, depth: 1 }],
    };
    const out = pausedReply(ctx, info);
    expect(out['file']).toBe(path.join(root, 'lib', 'rank.py'));
    expect(out['breakpoint']).toEqual({ ...info.breakpoint, file: path.join('lib', 'rank.py') });
    expect(out['stack']).toEqual(info.stack);
    const watch = pausedReply(ctx, { ...info, fileId: 9, reason: 'watch', watch: { id: 'w1', exp: 'x is None', text: 'True' } });
    expect(watch['file']).toBe(ctx.filePath);
    expect(watch['watch']).toEqual({ id: 'w1', exp: 'x is None', text: 'True' });
    const raised = pausedReply(ctx, { ...info, reason: 'exception', exception: { type: 'ValueError', message: 'bad token sk-abcdefghijklmnopqrstuvwxyz', uncaught: true } });
    expect(raised['exception']).toEqual({ type: 'ValueError', message: 'bad token «redacted»', uncaught: true });
  });
});

describe('exceptionMode', () => {
  it('takes only the three modes from a request', () => {
    expect(exceptionMode('raised')).toBe('raised');
    expect(exceptionMode('uncaught')).toBe('uncaught');
    expect(exceptionMode('off')).toBe('off');
    expect(exceptionMode(undefined)).toBeUndefined();
    expect(exceptionMode('all')).toBeUndefined();
  });
});

describe('watches', () => {
  it('assigns w1, w2, ... to break-when items and applies set, add and remove; items without breakWhen are displayed watches', () => {
    expect(nextWatchId([])).toBe('w1');
    expect(nextWatchId([{ id: 'w3', exp: 'a', breakWhen: 'change' }, { id: 'mine', exp: 'b', breakWhen: 'true' }])).toBe('w4');
    const req = { add: [{ exp: 'total' }, { exp: 'x is None', breakWhen: 'true' }, { exp: '   ' }, { exp: 'n', breakWhen: 'change' }] };
    const added = applyWatchRequest([], req);
    expect(added).toEqual([
      { id: 'w1', exp: 'x is None', breakWhen: 'true' },
      { id: 'w2', exp: 'n', breakWhen: 'change' },
    ]);
    expect(displayWatchItems(req.add)).toEqual(['total']);
    expect(displayWatchItems(undefined)).toEqual([]);
    expect(applyWatchRequest(added, { remove: ['w1'] })).toEqual([{ id: 'w2', exp: 'n', breakWhen: 'change' }]);
    expect(applyWatchRequest(added, { set: [{ id: 'k', exp: 'n', breakWhen: 'change' }] })).toEqual([{ id: 'k', exp: 'n', breakWhen: 'change' }]);
    expect(applyWatchRequest(added, { list: true })).toEqual(added);
  });
  it('prints a value node as its value, else its type', () => {
    expect(nodeText({ type: 'number', value: '3' })).toBe('3');
    expect(nodeText({ type: 'dict' })).toBe('dict');
    expect(nodeText(undefined)).toBeUndefined();
  });
});

describe('entryPause', () => {
  const agent = path.join(root, 'agent.py');
  const rank = path.join(root, 'lib', 'rank.py');
  const files = [agent, rank];

  it('pauses at the first statement only when asked or when no breakpoint of the run can hit', () => {
    expect(entryPause({}, [], files)).toBe(true);
    expect(entryPause({ stopOnEntry: true }, [{ path: agent, line: 12 }], files)).toBe(true);
    expect(entryPause({}, [{ path: agent, line: 12 }], files)).toBe(false);
    expect(entryPause({}, [{ path: rank, line: 3, condition: 'n > 3' }], files)).toBe(false);
    // a breakpoint in a file the run never touches would never hit: the run must still stop somewhere
    expect(entryPause({}, [{ path: path.join(root, 'other.py'), line: 4 }], files)).toBe(true);
    expect(entryPause({}, [{ path: agent, line: 12 }], [])).toBe(true);
    // only a real boolean counts: "true" from a request field does not
    expect(entryPause({ stopOnEntry: 'true' }, [{ path: agent, line: 12 }], files)).toBe(false);
    expect(entryPause({ stopOnEntry: false }, [], files)).toBe(true);
  });
});

describe('outputTail', () => {
  it('keeps the tail, says when it cut, and redacts what it keeps', () => {
    expect(outputTail('')).toEqual({ text: '', truncated: false });
    expect(outputTail('start\nend\n')).toEqual({ text: 'start\nend\n', truncated: false });
    expect(outputTail('abcdef', 4)).toEqual({ text: 'cdef', truncated: true });
    expect(outputTail('abcd', 4)).toEqual({ text: 'abcd', truncated: false });
    expect(outputTail('key: sk-abcdefghijklmnopqrstuvwxyz\n').text).toBe('key: «redacted»\n');
  });
});

describe('localsReply', () => {
  it('keeps the value bag only when asked', () => {
    const bag = { data: { type: 'number', value: '1', id: 'd:1 1', queryPath: [] as string[] }, runtimeKey: 'd:1' };
    const vars = [{ name: 'i', text: '1', valueBag: bag as never }];
    expect(localsReply(vars, false)).toEqual([{ name: 'i', text: '1', type: 'number' }]);
    expect(localsReply(vars, true)[0]).toHaveProperty('valueBag');
  });

  it('gives the shape from the value node, and none for a masked value', () => {
    const node = (data: Record<string, unknown>) => ({ data: { id: 'x', queryPath: [] as string[], ...data }, runtimeKey: 'd:1' }) as never;
    const vars = [
      { name: 'items', text: "[{'sku': 'KB-01'}, {'sku': 'MS-07'}]", valueBag: node({ type: 'list', length: 2 }) },
      { name: 'api_key', text: '«secret»', valueBag: node({ type: 'str', length: 40, secret: true }) },
      { name: 'old', text: '3' },
    ];
    expect(localsReply(vars, false)).toEqual([
      { name: 'items', text: "[{'sku': 'KB-01'}, {'sku': 'MS-07'}]", type: 'list', length: 2 },
      { name: 'api_key', text: '«secret»' },
      { name: 'old', text: '3' },
    ]);
  });
});

describe('BridgeDebug.pauseContext: the run socket answers a plain debug pause of its file', () => {
  const stopReply = { step: 58, recording: false, location: { file: '/ws/invoices.py', line: 34, function: 'subtotal' }, locals: [{ name: 'items', text: '[]', type: 'list', length: 0 }] };
  const make = (opts: { navActive?: boolean; paused?: boolean; debugActive?: boolean; debugSession?: boolean }) => {
    const served: { type: string; req: unknown }[] = [];
    const session = {
      nav: { active: !!opts.navActive },
      debug: { active: !!opts.debugActive, paused: opts.paused ? ({ step: 3 } as unknown) : undefined },
    };
    const bridge = new BridgeDebug({} as never, {
      debugSessionFor: () => (opts.debugSession ? { serve: async (type: string, req: unknown) => (served.push({ type, req }), stopReply) } : undefined),
    } as never);
    return { bridge, session: session as never, served };
  };

  it('serves `context` from the record: false debug session when the run session has no step', async () => {
    const { bridge, session, served } = make({ debugSession: true });
    await expect(bridge.pauseContext(session, { type: 'context', scope: true })).resolves.toEqual(stopReply);
    expect(served).toEqual([{ type: 'context', req: { type: 'context', scope: true } }]);
  });

  it('keeps the old error when no debug session is paused on the file', async () => {
    const { bridge, session } = make({});
    await expect(bridge.pauseContext(session, {})).rejects.toThrow('context needs step or file/line while the Time Machine is not active');
  });

  it('leaves a session with its own Time Machine, pause or recording debug run to the recorded path', async () => {
    for (const own of [{ navActive: true }, { paused: true }, { debugActive: true }]) {
      const { bridge, session, served } = make({ debugSession: true, ...own });
      await expect(bridge.pauseContext(session, {})).rejects.toThrow('Time Machine is not active');
      expect(served).toEqual([]);
    }
  });
});
