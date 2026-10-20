/** The bridge's `why` with `full`, and 0.7.0's `whole` (agent/bridgeWhy.ts, agent/bridgeFull.ts), with the tree and the replay faked. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Provenance } from '../../src/shared/protocol';
import type { FullValueView } from '../../src/shared/replayProtocol';
import type { FullValueQuery } from '../../src/session/fullValueReplay';
import type { Session } from '../../src/session/session';
import type { TraceModel } from '../../src/timeMachine/traceModel';

const fake = vi.hoisted(() => ({ tree: undefined as unknown, asked: [] as unknown[] }));

vi.mock('vscode', () => ({}));
vi.mock('../../src/session/variableQuery', () => ({
  sessionProvenance: vi.fn(async () => fake.tree),
  sourceLines: vi.fn(() => undefined),
}));
vi.mock('../../src/session/fullValueSession', () => ({
  sessionFullValue: vi.fn(async (_session: unknown, q: FullValueQuery): Promise<FullValueView> => {
    fake.asked.push(q);
    return {
      key: q.key,
      status: 'checked',
      step: q.step + 1,
      name: q.name,
      summary: 'The replay took the same 13 steps, and the key sk-abcdefghijklmnopqrstuvwxyz0123 came out the same.',
      value: { type: 'dict', value: "{'key': 'sk-abcdefghijklmnopqrstuvwxyz0123'}", id: 'replay 1', queryPath: ['replay'], props: [{ name: 'key', type: 'str', value: 'sk-abcdefghijklmnopqrstuvwxyz0123', id: 'replay 2', queryPath: ['replay', 'key'] }] },
      matched: 13,
      ms: 40,
    };
  }),
}));

import { bridgeWhy } from '../../src/agent/bridgeWhy';
import { bridgeWhole } from '../../src/agent/bridgeFull';

const session = { debug: { paused: undefined }, running: false, runScheduled: false } as unknown as Session;
const trace = { valid: (s: number) => s >= 0 && s < 40, count: 40 } as unknown as TraceModel;
const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz0123';

/** a why tree whose root is the change the statement at step 12 made */
function changeAt12(): Provenance {
  return { name: 'config', step: 12, depth: 5, nodes: 1, truncated: false, recordedLocals: true, root: { name: 'config', text: "{'key': 'sk-…'}", source: 'locals', step: 12, scopeId: 3, line: 27 } };
}

beforeEach(() => {
  fake.tree = changeAt12();
  fake.asked.length = 0;
});

describe('why over the bridge', () => {
  it('answers the tree alone unless the full value is asked for: a replay runs the program again', async () => {
    const out = await bridgeWhy(session, { type: 'why', step: 12, name: 'config' }, () => trace);
    expect(out['root']).toMatchObject({ name: 'config', step: 12 });
    expect(out).not.toHaveProperty('full');
    expect(fake.asked).toHaveLength(0);
  });

  it('with full: the value on the tree\'s first line, redacted like the tree', async () => {
    const out = await bridgeWhy(session, { type: 'why', step: 12, name: 'config', full: true }, () => trace);
    // the step made the value: the change is read after its statement, picked by its recorded text
    expect(fake.asked).toEqual([{ key: 'bridge', kind: 'change', step: 12, name: 'config', scopeId: 3, text: "{'key': 'sk-…'}" }]);
    const full = out['full'] as Record<string, unknown>;
    expect(full).toMatchObject({ status: 'checked', step: 13, name: 'config', matched: 13, ms: 40 });
    expect(full).not.toHaveProperty('key');
    expect(JSON.stringify(full)).not.toContain(SECRET);
  });

  it('with full at a step after the value was made: the value when the step ran', async () => {
    fake.tree = { ...changeAt12(), step: 20, root: { ...changeAt12().root, step: 12 } };
    await bridgeWhy(session, { type: 'why', step: 20, name: 'config', full: true }, () => trace);
    expect(fake.asked).toEqual([{ key: 'bridge', kind: 'at', step: 20, name: 'config' }]);
  });

  it('full needs the name the tree explains, and a step in the run', async () => {
    await expect(bridgeWhy(session, { type: 'why', step: 12, full: true }, () => trace)).rejects.toThrow('full needs a name');
    await expect(bridgeWhy(session, { type: 'why', step: 99, name: 'config', full: true }, () => trace)).rejects.toThrow('step 99 is out of range');
    expect(fake.asked).toHaveLength(0);
  });
});

describe('whole, the 0.7.0 request', () => {
  it('still answers, with the value when the step began, as it did', async () => {
    const out = await bridgeWhole(session, { type: 'whole', step: 12, name: 'config' });
    expect(fake.asked).toEqual([{ key: 'bridge', kind: 'at', step: 12, name: 'config' }]);
    expect(out).toMatchObject({ status: 'checked', name: 'config' });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('a request without step and name points at why with full', async () => {
    await expect(bridgeWhole(session, { type: 'whole', step: 12 })).rejects.toThrow('whole needs step and name');
  });
});
