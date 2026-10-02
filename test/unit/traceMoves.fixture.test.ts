/**
 * Shared fixture for the Time Machine moves: the TypeScript model is the reference, the Python
 * port (`pyokka_runtime/trace.py`) is checked against `fixtures/trace-moves.json`.
 * Regenerate with PYOKKA_WRITE_FIXTURES=1 after changing the model.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TraceModel, packSteps } from '../../src/timeMachine/traceModel';
import type { TraceScope } from '../../src/shared/protocol';

const FIXTURE = path.join(__dirname, 'fixtures', 'trace-moves.json');
const resolve = (rid: number) => ({ fileId: 1, range: [rid, 0, rid, 10] as [number, number, number, number] });
const scope = (scopeId: number, name: string, parent: number, depth: number, first: number, last: number, rid = 0): TraceScope => ({ scopeId, rid, name, parent, depth, first, last });

const cases: Record<string, { steps: [number, number, number, number?][]; scopes: TraceScope[]; startLines: number[] }> = {
  nested: { steps: [[5, 0, 0], [2, 1, 1, 4], [4, 2, 2, 4], [6, 0, 0]], scopes: [scope(0, '<module>', -1, 0, 0, 3), scope(1, 'f', 0, 1, 1, 1, 1), scope(2, 'g', 1, 2, 2, 2, 3)], startLines: [1, 2, 4, 5, 6, 9] },
  recursion: { steps: [[4, 0, 0], [2, 1, 1, 4], [3, 1, 1], [2, 2, 2, 4], [3, 2, 2], [2, 3, 3, 4], [5, 0, 0]], scopes: [scope(0, '<module>', -1, 0, 0, 6), scope(1, 'fact', 0, 1, 1, 2, 1), scope(2, 'fact', 1, 2, 3, 4, 1), scope(3, 'fact', 2, 3, 5, 5, 1)], startLines: [2, 3, 4, 5, 7] },
  loop: { steps: [[1, 0, 0], [2, 0, 0, 1], [2, 0, 0, 1], [2, 0, 0, 1], [3, 0, 0]], scopes: [scope(0, '<module>', -1, 0, 0, 4)], startLines: [1, 2, 3, 4] },
  // `h = (f(), g())`: two sibling calls at the same depth with no module step between them
  siblings: { steps: [[5, 0, 0], [1, 1, 1, 4], [2, 1, 1], [3, 2, 1, 4], [4, 2, 1], [6, 0, 0]], scopes: [scope(0, '<module>', -1, 0, 0, 5), scope(1, 'f', 0, 1, 1, 2, 1), scope(2, 'g', 0, 1, 3, 4, 3)], startLines: [2, 4, 5, 6] },
  // main awaits turn(1) directly, then gathers turn(2) and turn(3): tasks resumed by the event loop
  // have the module as parent (see the docs in traceModel.test.ts), their steps interleave
  gather: {
    steps: [[11, 0, 0], [7, 1, 1, 4], [8, 1, 1], [4, 2, 2, 4], [5, 2, 2], [1, 3, 3, 4], [2, 3, 3], [3, 3, 3], [6, 2, 2], [9, 1, 1], [4, 4, 1, 4], [5, 4, 1], [1, 5, 2, 4], [2, 5, 2], [4, 6, 1, 4], [5, 6, 1], [1, 7, 2, 4], [2, 7, 2], [3, 5, 2], [6, 4, 1], [3, 7, 2], [6, 6, 1], [10, 1, 1]],
    scopes: [scope(0, '<module>', -1, 0, 0, 0), scope(1, 'main', 0, 1, 1, 22, 7), scope(2, 'turn', 1, 2, 3, 8, 4), scope(3, 'fetch', 2, 3, 5, 7, 1), scope(4, 'turn', 0, 1, 10, 19, 4), scope(5, 'fetch', 4, 2, 12, 18, 1), scope(6, 'turn', 0, 1, 14, 21, 4), scope(7, 'fetch', 6, 2, 16, 20, 1)],
    startLines: [2, 5, 9, 10, 11],
  },
  empty: { steps: [], scopes: [], startLines: [1] },
};

function build() {
  const out: Record<string, unknown> = {};
  for (const [name, c] of Object.entries(cases)) {
    const model = new TraceModel(packSteps(c.steps), c.scopes, false, resolve);
    const quads = Array.from(model.steps);
    const moves = [];
    for (let i = 0; i < model.count; i++) {
      moves.push({ step: i, into: model.stepInto(i), back: model.stepBackInto(i), over: model.stepOver(i), backOver: model.stepBackOver(i), out: model.stepOut(i), backOut: model.stepBackOut(i), canStep: model.canStep(i), echo: model.echoSteps(i), stack: model.callStack(i).map((f) => ({ step: f.step, scopeId: f.scopeId })) });
    }
    out[name] = { quads, scopes: c.scopes, count: model.count, moves, startStep: c.startLines.map((line) => ({ fileId: 1, line, step: model.startStep(1, line) })) };
  }
  return out;
}

describe('trace moves fixture', () => {
  it('matches fixtures/trace-moves.json (the Python port is tested against the same file)', () => {
    const built = build();
    if (process.env.PYOKKA_WRITE_FIXTURES) fs.writeFileSync(FIXTURE, JSON.stringify(built, null, 1) + '\n');
    const stored = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    expect(built).toEqual(stored);
  });
});
