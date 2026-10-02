/**
 * The host's execution graph over the statement-node fixture program (`fixtures/graph/main.py`,
 * run into `fixtures/graph-run.json` by python/tests/test_graph.py): the statement nodes, their
 * targets and reads, the call edges from statements, the data edges between them, and byte
 * equality with `fixtures/execution-graph-statements.json` (PYOKKA_WRITE_FIXTURES=1). The run
 * loader is the one of executionGraph.test.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileTable } from '../../src/session/fileTable';
import { TraceModel } from '../../src/timeMachine/traceModel';
import { decodeSteps, type ErrorEvent, type FileInstrumentedEvent, type LocalsEvent, type LogEvent, type TraceEvent } from '../../src/shared/protocol';
import type { WalkthroughInputs } from '../../src/session/walkthrough';
import { buildExecutionGraph, graphStack, renderGraphLines, type CallEdge, type CallNode, type DecisionNode, type ExecutionGraph, type ExecutionGraphOptions, type StatementNode } from '../../src/session/executionGraph';

const FIXTURES = path.join(__dirname, 'fixtures');
const FIXTURE_ROOT = '/fixture';
const GRAPH_RUN = path.join(FIXTURES, 'graph-run.json');
const GRAPH_PROGRAM = path.join(FIXTURES, 'graph');
const STATEMENTS_FIXTURE = path.join(FIXTURES, 'execution-graph-statements.json');
const MISSING = 'is missing: run python/tests/test_graph.py with PYOKKA_WRITE_FIXTURES=1';

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

function build(opts: ExecutionGraphOptions = {}): ExecutionGraph {
  return buildExecutionGraph(loadInputs(), opts);
}

const calls = (g: ExecutionGraph): CallNode[] => g.nodes.filter((n): n is CallNode => n.kind !== 'decision' && n.kind !== 'statement');
const decisions = (g: ExecutionGraph): DecisionNode[] => g.nodes.filter((n): n is DecisionNode => n.kind === 'decision');
const statements = (g: ExecutionGraph): StatementNode[] => g.nodes.filter((n): n is StatementNode => n.kind === 'statement');
const node = (g: ExecutionGraph, label: string): CallNode => {
  const n = calls(g).find((n) => n.label === label);
  if (!n) throw new Error(`no node ${label}`);
  return n;
};
const decision = (g: ExecutionGraph, label: string): DecisionNode => {
  const n = decisions(g).find((n) => n.label === label);
  if (!n) throw new Error(`no decision ${label}`);
  return n;
};
/** The statement whose label starts with `prefix` (labels are cut at 60 chars). */
const statement = (g: ExecutionGraph, prefix: string): StatementNode => {
  const n = statements(g).find((n) => n.label.startsWith(prefix));
  if (!n) throw new Error(`no statement ${prefix}`);
  return n;
};
const labelOf = (g: ExecutionGraph, id: string): string => g.nodes.find((n) => n.id === id)!.label;
const edgeList = (g: ExecutionGraph): string[] => g.edges.map((e) => (e.kind === 'data' ? `${labelOf(g, e.from)} ⇢ ${labelOf(g, e.to)} ${e.label}` : `${labelOf(g, e.from)} → ${labelOf(g, e.to)} ${e.kind} ×${e.count}`));

describe('execution graph on the statement fixture program', () => {
  let g: ExecutionGraph;
  beforeAll(() => {
    expect(fs.existsSync(GRAPH_RUN), `${GRAPH_RUN} ${MISSING}`).toBe(true);
    g = build();
  });
  const main = (): string => node(g, '<module>').id;

  it('draws the script as a pipeline of statements under the module and the functions', () => {
    expect(g.nodes.map((n) => [n.id, n.kind, n.label])).toEqual([
      ['n0', 'module', '<module>'],
      ['n1', 'statement', 'text = "fair|Sep 16|alice,bob"'],
      ['n2', 'function', 'parse_event'],
      ['n3', 'statement', 'event = parse_event(text, year=2026)'],
      ['n4', 'statement', 'name, date, people = text.split("|")'],
      ['n5', 'statement', 'participants = people.split(",")'],
      ['n6', 'function', 'Event.__init__'],
      ['n7', 'statement', 'event = Event( name=name, date=f"{date} {year}", participan…'],
      ['n8', 'statement', 'self.name = name'],
      ['n9', 'statement', 'self.date = date'],
      ['n10', 'statement', 'self.participants = participants'],
      ['n11', 'statement', 'return event'],
      ['n12', 'statement', 'count = 0'],
      ['n13', 'decision', 'for person in event.participants'],
      ['n14', 'statement', 'count += 1'],
      ['n15', 'statement', 'print(f"Participant: {person}")'],
      ['n16', 'function', 'shout'],
      ['n17', 'statement', 'label = shout(event.name)'],
      ['n18', 'decision', 'if not word'],
      ['n19', 'statement', 'return word.upper()'],
      ['n20', 'decision', 'if count > 1'],
      ['n21', 'statement', 'summary = f"{label} with {count} people on {event.date}"'],
      ['n22', 'statement', 'print(summary)'],
      ['n23', 'statement', 'shout("")'],
      ['n24', 'statement', 'raise ValueError("empty")'],
      ['n25', 'statement', 'handled = True'],
    ]);
    expect(calls(g).map((n) => [n.label, n.calls])).toEqual([['<module>', 1], ['parse_event', 1], ['Event.__init__', 1], ['shout', 2]]);
    expect(g.count).toBe(33);
    expect(g.capped).toBe(false);
    expect(g.truncated).toBe(false);
  });

  it('gives every statement its parent, targets, reads and hits', () => {
    const parse = node(g, 'parse_event').id;
    const init = node(g, 'Event.__init__').id;
    const shout = node(g, 'shout').id;
    expect(statements(g).map((s) => [s.label.slice(0, 14), s.parent, s.targets, s.reads, s.hits])).toEqual([
      ['text = "fair|S', main(), ['text'], [], 1],
      ['event = parse_', main(), ['event'], ['parse_event', 'text'], 1],
      ['name, date, pe', parse, ['name', 'date', 'people'], ['text'], 1],
      ['participants =', parse, ['participants'], ['people'], 1],
      ['event = Event(', parse, ['event'], ['Event', 'name', 'date', 'year', 'participants'], 1],
      ['self.name = na', init, [], ['self', 'name'], 1],
      ['self.date = da', init, [], ['self', 'date'], 1],
      ['self.participa', init, [], ['self', 'participants'], 1],
      ['return event', parse, [], ['event'], 1],
      ['count = 0', main(), ['count'], [], 1],
      ['count += 1', main(), ['count'], ['count'], 2],
      ['print(f"Partic', main(), [], ['print', 'person'], 2],
      ['label = shout(', main(), ['label'], ['shout', 'event'], 1],
      ['return word.up', shout, [], ['word'], 1],
      ['summary = f"{l', main(), ['summary'], ['label', 'count', 'event'], 1],
      ['print(summary)', main(), [], ['print', 'summary'], 1],
      ['shout("")', main(), [], ['shout'], 1],
      ['raise ValueErr', shout, [], ['ValueError'], 1],
      ['handled = True', main(), ['handled'], [], 1],
    ]);
    const call = statement(g, 'event = Event(');
    expect(call).toMatchObject({ file: '/fixture/main.py', line: 22, fileId: 1, text: 'event = Event( name=name, date=f"{date} {year}", participants=participants, )', firstStep: 6, rows: [{ kind: 'out', name: 'event', text: '<__main__.Event object at 0x0>', step: 10 }] });
    expect(Object.keys(call)).toEqual(['id', 'kind', 'parent', 'label', 'file', 'line', 'fileId', 'text', 'targets', 'reads', 'firstStep', 'hits', 'rows']);
    // never nodes: the import, the docstring, `try:` / `except ValueError:`, and the else arm that never ran
    expect(statements(g).some((s) => [8, 19, 46, 48, 50].includes(s.line))).toBe(false);
    expect(statements(g).some((s) => s.label.startsWith('import') || s.label.startsWith('"""') || s.label === 'summary = label')).toBe(false);
  });

  it('puts the logged value, the print and the handled raise on their statements', () => {
    expect(statement(g, 'text = ').rows).toEqual([{ kind: 'out', name: 'text', text: "'fair|Sep 16|alice,bob'", step: 1 }]);
    expect(statement(g, 'count = 0').rows).toEqual([{ kind: 'out', name: 'count', text: '0', step: 12 }]);
    expect(statement(g, 'count += 1').rows).toEqual([{ kind: 'out', name: 'count', text: '1', step: 15 }]);
    expect(statement(g, 'print(f"Partic').rows).toEqual([{ kind: 'print', name: 'stdout', text: 'Participant: alice', step: 16 }]);
    expect(statement(g, 'print(summary)').rows).toEqual([{ kind: 'print', name: 'stdout', text: 'FAIR with 2 people on Sep 16 2026', step: 26 }]);
    expect(statement(g, 'summary = ').rows).toEqual([{ kind: 'out', name: 'summary', text: "'FAIR with 2 people on Sep 16 2026'", step: 25 }]);
    expect(statement(g, 'raise ValueError(').rows).toEqual([{ kind: 'raised', name: 'ValueError', text: 'empty', step: 31 }]);
    expect(node(g, 'shout').rows).toEqual([
      { kind: 'in', name: 'word', text: "'fair'", step: 21 },
      { kind: 'out', name: 'return', text: "'FAIR'", step: 23 },
    ]);
    expect(decisions(g).map((d) => [d.label, d.parent, d.taken, d.hits, d.notRun])).toEqual([
      ['for person in event.participants', main(), undefined, 2, []],
      ['if not word', node(g, 'shout').id, 'False', 2, []],
      ['if count > 1', main(), 'True', 1, [46]],
    ]);
  });

  it('draws the call edges from the statements and the data edges between them', () => {
    const l = (prefix: string): string => statement(g, prefix).label;
    expect(edgeList(g)).toEqual([
      `${l('event = parse_')} → parse_event call ×1`,
      `${l('text = ')} ⇢ ${l('event = parse_')} text`,
      `parse_event ⇢ ${l('name, date')} text`,
      `${l('name, date')} ⇢ ${l('participants =')} people`,
      `${l('event = Event(')} → Event.__init__ call ×1`,
      `parse_event ⇢ ${l('event = Event(')} year`,
      `${l('name, date')} ⇢ ${l('event = Event(')} date`,
      `${l('name, date')} ⇢ ${l('event = Event(')} name`,
      `${l('participants =')} ⇢ ${l('event = Event(')} participants`,
      `Event.__init__ ⇢ ${l('self.name')} name`,
      `Event.__init__ ⇢ ${l('self.date')} date`,
      `Event.__init__ ⇢ ${l('self.participants')} participants`,
      `${l('event = Event(')} ⇢ ${l('return event')} event`,
      `${l('event = parse_')} ⇢ for person in event.participants event`,
      `${l('count = 0')} ⇢ ${l('count += 1')} count`,
      `for person in event.participants ⇢ ${l('print(f"Partic')} person`,
      `${l('label = ')} → shout call ×1`,
      `${l('event = parse_')} ⇢ ${l('label = ')} event`,
      // the call-value rule: `self.name = 'fair'` logged in Event.__init__ matches shout's `word = 'fair'` by text
      'Event.__init__ ⇢ shout word',
      'shout ⇢ if not word word',
      `shout ⇢ ${l('return word.up')} word`,
      `${l('count += 1')} ⇢ if count > 1 count`,
      `${l('event = parse_')} ⇢ ${l('summary = ')} event`,
      `${l('count += 1')} ⇢ ${l('summary = ')} count`,
      `${l('label = ')} ⇢ ${l('summary = ')} label`,
      `${l('summary = ')} ⇢ ${l('print(summary)')} summary`,
      `${l('shout("")')} → shout call ×1`,
    ]);
    const toShout = g.edges.filter((e) => e.kind === 'call' && labelOf(g, e.to) === 'shout') as CallEdge[];
    expect(toShout.map((e) => [labelOf(g, e.from), e.count, e.steps, e.momentIds])).toEqual([
      ['label = shout(event.name)', 1, [20], ['m17']],
      ['shout("")', 1, [28], ['m23']],
    ]);
    expect(g.edges.map((e) => e.id)).toEqual(g.edges.map((_, i) => `e${i}`));
  });

  it('maps the value, print and error moments to their statements', () => {
    const byId = new Map(g.moments.map((m) => [m.id, m]));
    expect(byId.get('m11')).toEqual({ id: 'm11', kind: 'value', step: 12, nodeId: statement(g, 'count = 0').id });
    expect(byId.get('m14')).toEqual({ id: 'm14', kind: 'print', step: 16, nodeId: statement(g, 'print(f"Partic').id });
    expect(byId.get('m22')).toEqual({ id: 'm22', kind: 'print', step: 26, nodeId: statement(g, 'print(summary)').id });
    expect(byId.get('m25')).toEqual({ id: 'm25', kind: 'error', step: 31, nodeId: statement(g, 'raise ValueError(').id });
    expect(byId.get('m2')).toEqual({ id: 'm2', kind: 'call', step: 2, nodeId: node(g, 'parse_event').id, edgeId: 'e0' });
    expect(byId.get('m12')).toEqual({ id: 'm12', kind: 'decision', step: 13, nodeId: decision(g, 'for person in event.participants').id });
    expect(g.moments.length).toBe(28);
    expect(g.scopes).toEqual({ '0': 'n0', '1': 'n2', '2': 'n6', '3': 'n16', '4': 'n16' });
  });

  it('renders statements interleaved with the decisions, print rows as print stdout', () => {
    const lines = renderGraphLines(g, { workspaceRoot: '/fixture' });
    expect(lines[0]).toBe('26 nodes, 27 edges over 33 steps');
    expect(lines[1]).toBe('n0 <module> main.py:1  ×1');
    expect(lines[2]).toBe("   n1 text = \"fair|Sep 16|alice,bob\"  ×1  out text = 'fair|Sep 16|alice,bob'");
    const count = lines.indexOf('   n12 count = 0  ×1  out count = 0');
    expect(lines[count + 1]).toBe('   n13 for person in event.participants ran 2 times  ×2');
    expect(lines[count + 2]).toBe('   n14 count += 1  ×2  out count = 1');
    expect(lines[count + 3]).toBe('   n15 print(f"Participant: {person}")  ×2  print stdout = Participant: alice');
    expect(lines).toContain('   n24 raise ValueError("empty")  ×1  raised ValueError: empty');
    expect(lines).toContain("n16 shout main.py:30  ×2  in word = 'fair' · out 'FAIR'");
    expect(lines).toContain('n3 → n2  ×1  #2');
    expect(lines).toContain('n1 ⇢ n3  text');
    expect(lines.every((l) => l.length <= 100)).toBe(true);
  });

  it('puts the running statement first in the stack', () => {
    const inputs = loadInputs();
    expect(graphStack(g, inputs.trace.callStack(15), { fileId: 1, line: 40 })).toEqual([statement(g, 'count += 1').id, 'n0']);
    expect(graphStack(g, inputs.trace.callStack(31), { fileId: 1, line: 32 })).toEqual([statement(g, 'raise ValueError(').id, node(g, 'shout').id, statement(g, 'shout("")').id, 'n0']);
    expect(graphStack(g, inputs.trace.callStack(13), { fileId: 1, line: 39 })).toEqual(['n0']);
  });

  it('is the function-level graph with statements: false', () => {
    const f = build({ statements: false });
    expect(f.nodes.map((n) => n.label)).toEqual(['<module>', 'parse_event', 'Event.__init__', 'for person in event.participants', 'shout', 'if not word', 'if count > 1']);
    expect(edgeList(f)).toEqual(['<module> → parse_event call ×1', 'parse_event → Event.__init__ call ×1', '<module> → shout call ×2', 'Event.__init__ ⇢ shout word']);
    expect(node(f, 'shout').rows).toEqual([
      { kind: 'in', name: 'word', text: "'fair'", step: 21 },
      { kind: 'out', name: 'return', text: "'FAIR'", step: 23 },
      { kind: 'raised', name: 'ValueError', text: 'empty', step: 31 },
    ]);
    expect(f.moments.find((m) => m.id === 'm25')!.nodeId).toBe(node(f, 'shout').id);
    expect(f.moments.find((m) => m.id === 'm11')!.nodeId).toBe('n0');
    expect(f.truncated).toBe(false);
  });
});

describe('execution graph statements fixture', () => {
  it('equals the graphs the Python builder wrote for the statement fixture program', () => {
    expect(fs.existsSync(STATEMENTS_FIXTURE), `${STATEMENTS_FIXTURE} ${MISSING}`).toBe(true);
    expect(fs.existsSync(GRAPH_RUN), `${GRAPH_RUN} ${MISSING}`).toBe(true);
    const expected = JSON.parse(fs.readFileSync(STATEMENTS_FIXTURE, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(expected).sort()).toEqual(['default', 'functions']);
    for (const [name, opts] of [['default', {}], ['functions', { statements: false }]] as [string, ExecutionGraphOptions][]) {
      expect(expected[name], name).toBeDefined();
      const actual = JSON.parse(JSON.stringify(build(opts))) as unknown;
      expect(actual, name).toEqual(expected[name]);
      expect(JSON.stringify(actual), `${name}: field order`).toBe(JSON.stringify(expected[name]));
    }
  });
});
