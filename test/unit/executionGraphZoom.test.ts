/**
 * The host side of the Execution Diagram's semantic zoom over the statement-node fixture run
 * (`fixtures/graph-run.json`, the program under `fixtures/graph/`): the hits of a statement, a loop
 * header and a function (`executionGraphHits.ts`), and the phases the real source gives
 * (`executionGraphPhases.ts`). The run loader is the one of executionGraphStatements.test.ts.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileTable } from '../../src/session/fileTable';
import { TraceModel } from '../../src/timeMachine/traceModel';
import { decodeSteps, type ErrorEvent, type FileInstrumentedEvent, type LocalsEvent, type LogEvent, type TraceEvent } from '../../src/shared/protocol';
import type { WalkthroughInputs } from '../../src/session/walkthrough';
import { buildExecutionGraph, type CallNode, type DecisionNode, type StatementNode } from '../../src/session/executionGraph';
import { HITS_MAX, nodeHits, type HitsTrace } from '../../src/session/executionGraphHits';
import { buildPhases } from '../../src/session/executionGraphPhases';

const FIXTURES = path.join(__dirname, 'fixtures');
const FIXTURE_ROOT = '/fixture';
const GRAPH_RUN = path.join(FIXTURES, 'graph-run.json');
const GRAPH_PROGRAM = path.join(FIXTURES, 'graph');

interface SavedRun {
  meta: { file: string; workspaceRoot: string; durationMs: number; exitCode: number };
  events: ({ type: string } & Record<string, unknown>)[];
}

function loadInputs(): WalkthroughInputs {
  const doc = JSON.parse(fs.readFileSync(GRAPH_RUN, 'utf8')) as SavedRun;
  const files = new FileTable();
  const entries: LogEvent[] = [];
  const locals: LocalsEvent['entries'] = [];
  const errors: ErrorEvent[] = [];
  let traceEv: TraceEvent | undefined;
  for (const ev of doc.events) {
    if (ev.type === 'file.instrumented') files.add(ev as unknown as FileInstrumentedEvent);
    else if (ev.type === 'log') entries.push(ev as unknown as LogEvent);
    else if (ev.type === 'locals') locals.push(...(ev as unknown as LocalsEvent).entries);
    else if (ev.type === 'error') errors.push(ev as unknown as ErrorEvent);
    else if (ev.type === 'trace' && !ev['partial']) traceEv = ev as unknown as TraceEvent;
  }
  const trace = new TraceModel(decodeSteps(traceEv!.steps), traceEv!.scopes, !!traceEv!.truncated, (rid) => {
    const l = files.locate(rid);
    return l ? { fileId: l.fileId, range: l.range } : undefined;
  });
  const readSource = (fileId: number): string[] | undefined => {
    const p = files.get(fileId)?.path;
    if (!p || !p.startsWith(FIXTURE_ROOT + '/')) return undefined;
    try {
      return fs.readFileSync(path.join(GRAPH_PROGRAM, p.slice(FIXTURE_ROOT.length + 1)), 'utf8').split('\n');
    } catch {
      return undefined;
    }
  };
  return { trace, files, entries, locals, errors, mainFile: doc.meta.file, workspaceRoot: doc.meta.workspaceRoot, readSource, finished: { exitCode: doc.meta.exitCode, durationMs: doc.meta.durationMs } };
}

const inputs = loadInputs();
const graph = buildExecutionGraph(inputs);
const fn = (label: string): CallNode => {
  const n = graph.nodes.find((n): n is CallNode => n.kind !== 'decision' && n.kind !== 'statement' && n.label === label);
  if (!n) throw new Error(`no node ${label}`);
  return n;
};
const statement = (prefix: string): StatementNode => {
  const n = graph.nodes.find((n): n is StatementNode => n.kind === 'statement' && n.label.startsWith(prefix));
  if (!n) throw new Error(`no statement ${prefix}`);
  return n;
};
const decision = (label: string): DecisionNode => {
  const n = graph.nodes.find((n): n is DecisionNode => n.kind === 'decision' && n.label === label);
  if (!n) throw new Error(`no decision ${label}`);
  return n;
};
const lineOf = (step: number): number | undefined => inputs.trace.location(step)?.range[0];

describe('nodeHits over the fixture run', () => {
  it('lists every step a statement ran at, in order, with the value logged there', () => {
    const inc = statement('count += 1');
    const h = nodeHits(graph, inputs.trace, inc.id, (step) => `v${step}`);
    expect(h).toBeDefined();
    expect(h!.total).toBe(inc.hits);
    expect(h!.steps).toHaveLength(2);
    expect(h!.steps[0]).toBe(inc.firstStep);
    expect(h!.steps[1]).toBeGreaterThan(h!.steps[0]!);
    expect(h!.steps.every((s) => lineOf(s) === inc.line)).toBe(true);
    expect(h!.values).toEqual(h!.steps.map((s) => `v${s}`));
    expect(nodeHits(graph, inputs.trace, inc.id)!.values).toEqual([null, null]);
  });
  it('counts a loop header once per step on its line: the iterations and the entry', () => {
    const loop = decision('for person in event.participants');
    const h = nodeHits(graph, inputs.trace, loop.id)!;
    expect(h.total).toBe(loop.hits + 1);
    expect(h.steps.every((s) => lineOf(s) === loop.line)).toBe(true);
    expect(h.steps[0]).toBe(loop.firstStep);
  });
  it('lists the entries of a function from the trace scopes, nothing for a module', () => {
    const shout = fn('shout');
    const h = nodeHits(graph, inputs.trace, shout.id)!;
    expect(h.total).toBe(shout.calls);
    expect(h.steps).toEqual(shout.spans.map(([entry]) => entry));
    expect(h.values).toEqual(h.steps.map(() => null));
    expect(nodeHits(graph, inputs.trace, fn('<module>').id)).toBeUndefined();
    expect(nodeHits(graph, inputs.trace, 'nope')).toBeUndefined();
  });
  it('caps the list at HITS_MAX and keeps the total', () => {
    const inc = statement('count += 1');
    const hot: HitsTrace = { count: HITS_MAX + 100, location: () => ({ fileId: inc.fileId, range: [inc.line, 0, inc.line, 0] }), scopes: [] };
    const h = nodeHits(graph, hot, inc.id, (s) => (s % 2 ? 'odd' : undefined))!;
    expect(h.total).toBe(HITS_MAX + 100);
    expect(h.steps).toHaveLength(HITS_MAX);
    expect(h.values).toHaveLength(HITS_MAX);
    expect(h.values[1]).toBe('odd');
    expect(h.values[0]).toBeNull();
  });
});

describe('buildPhases over the fixture program', () => {
  const phases = buildPhases(graph, inputs.readSource);
  it('gives a scope one phase when no blank or comment line separates its statements', () => {
    const module = fn('<module>');
    const mine = phases.filter((p) => p.parent === module.id);
    expect(mine).toHaveLength(1);
    const members = graph.nodes.filter((n) => (n.kind === 'statement' || n.kind === 'decision') && n.parent === module.id);
    expect(mine[0]!.members).toHaveLength(members.length);
    expect(mine[0]!.members).toEqual([...members].sort((a, b) => a.firstStep - b.firstStep).map((n) => n.id));
    expect(mine[0]!.label).toBe('text, event, count, …');
    expect(mine[0]!.comment).toBe(false);
    expect(mine[0]!.line).toBe(statement('text = ').line);
  });
  it('phases every function that has statement nodes and labels them by what they assign', () => {
    const parse = phases.filter((p) => p.parent === fn('parse_event').id);
    expect(parse).toHaveLength(1);
    expect(parse[0]!.label).toBe('name, date, people, …');
    const shout = phases.filter((p) => p.parent === fn('shout').id);
    expect(shout).toHaveLength(1);
    expect(shout[0]!.members[0]).toBe(decision('if not word').id);
    expect(phases.every((p) => graph.nodes.some((n) => n.id === p.parent))).toBe(true);
  });
});
