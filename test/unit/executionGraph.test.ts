/**
 * The host's execution graph over the shared fixture run (`fixtures/walkthrough-run.json`): the
 * expectations of docs/PROTOCOL.md, and byte equality with the graphs the Python builder wrote to
 * `fixtures/execution-graph.json` (python/tests/test_graph.py, PYOKKA_WRITE_FIXTURES=1). The
 * statement-node fixture program has its own file, executionGraphStatements.test.ts.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileTable } from '../../src/session/fileTable';
import { TraceModel } from '../../src/timeMachine/traceModel';
import { decodeSteps, type ErrorEvent, type FileInstrumentedEvent, type LocalsEvent, type LogEvent, type TraceEvent } from '../../src/shared/protocol';
import type { WalkthroughInputs } from '../../src/session/walkthrough';
import { buildExecutionGraph, graphStack, renderGraphLines, type CallEdge, type CallNode, type DecisionNode, type ExecutionGraph, type ExecutionGraphOptions, type StatementNode } from '../../src/session/executionGraph';

const FIXTURES = path.join(__dirname, 'fixtures');
const FIXTURE_ROOT = '/fixture';
const WALKTHROUGH_RUN = path.join(FIXTURES, 'walkthrough-run.json');
const WALKTHROUGH_PROGRAM = path.join(FIXTURES, 'walkthrough');
const GRAPH_FIXTURE = path.join(FIXTURES, 'execution-graph.json');

interface SavedRun {
  meta: { file: string; workspaceRoot: string; durationMs: number; exitCode: number };
  events: ({ type: string } & Record<string, unknown>)[];
}

/** A saved run as the builder's inputs; `/fixture/…` paths read their source under `program`. */
function loadInputs(runFile: string, program: string): WalkthroughInputs {
  const doc = JSON.parse(fs.readFileSync(runFile, 'utf8')) as SavedRun;
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
      return fs.readFileSync(path.join(program, p.slice(FIXTURE_ROOT.length + 1)), 'utf8').split('\n');
    } catch {
      return undefined;
    }
  };
  return { trace, files, entries, locals, errors, mainFile: doc.meta.file, workspaceRoot: doc.meta.workspaceRoot, readSource, finished: { exitCode: doc.meta.exitCode, durationMs: doc.meta.durationMs } };
}

function build(opts: ExecutionGraphOptions = {}): ExecutionGraph {
  return buildExecutionGraph(loadInputs(WALKTHROUGH_RUN, WALKTHROUGH_PROGRAM), opts);
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

describe('execution graph on the walkthrough fixture', () => {
  const g = build();

  it('has the module, function and package nodes in firstStep order', () => {
    expect(calls(g).map((n) => [n.label, n.kind, n.calls])).toEqual([
      ['<module>', 'module', 1],
      ['helper.py', 'module', 1],
      ['double', 'function', 3],
      ['Counter.__init__', 'function', 1],
      ['Counter.bump', 'function', 1],
      ['libq', 'package', 1],
      ['<lambda>', 'function', 1],
      ['greet', 'function', 1],
      ['fail', 'function', 2],
    ]);
    expect(g.nodes.map((n) => n.id)).toEqual(g.nodes.map((_, i) => `n${i}`));
    expect(g.count).toBe(64);
    expect(g.capped).toBe(false);
    expect(g.truncated).toBe(false);
  });

  it('describes the main module, the imported module and the package', () => {
    const main = node(g, '<module>');
    expect(main).toMatchObject({ id: 'n0', file: '/fixture/main.py', line: 1, fileId: 1, function: '<module>', firstStep: 0, spans: [[0, 63]], rows: [] });
    expect(node(g, 'helper.py')).toMatchObject({ file: '/fixture/helper.py', line: 1, fileId: 2, function: '<module>', firstStep: 2, spans: [[3, 3]] });
    const libq = node(g, 'libq');
    expect(libq).toMatchObject({ package: 'libq', firstStep: 41, spans: [[42, 49]], nested: 2 });
    expect(libq.file).toBeUndefined();
    expect(libq.fileId).toBeUndefined();
    expect(Object.keys(libq)).toEqual(['id', 'kind', 'label', 'package', 'calls', 'firstStep', 'spans', 'rows', 'nested']);
    expect(Object.keys(main)).toEqual(['id', 'kind', 'label', 'file', 'line', 'fileId', 'function', 'calls', 'firstStep', 'spans', 'rows']);
  });

  it('gives every function its spans and the first call rows', () => {
    const double = node(g, 'double');
    expect(double).toMatchObject({ file: '/fixture/helper.py', line: 1, fileId: 2, function: 'double', firstStep: 8, spans: [[9, 11], [14, 16], [19, 21]] });
    expect(double.rows).toEqual([
      { kind: 'in', name: 'x', text: '0', step: 9 },
      { kind: 'out', name: 'return', text: '0', step: 11 },
    ]);
    const fail = node(g, 'fail');
    expect(fail).toMatchObject({ firstStep: 55, spans: [[56, 58], [61, 63]] });
    // the error moments sit on the `raise` statement; the function's own row says how its first call left
    expect(fail.rows).toEqual([
      { kind: 'in', name: 'n', text: '6', step: 56 },
      { kind: 'raised', name: 'ValueError', text: 'too small: 6', step: 58 },
    ]);
    expect(statement(g, 'raise ValueError(')).toMatchObject({ parent: fail.id, hits: 2, rows: [{ kind: 'raised', name: 'ValueError', text: 'too small: 6', step: 58 }] });
    expect(node(g, '<lambda>')).toMatchObject({ file: '/fixture/main.py', line: 44, firstStep: 48, spans: [[48, 48]], rows: [] });
    expect(node(g, 'greet').rows).toEqual([
      { kind: 'in', name: 'name', text: "'bob'", step: 51 },
      { kind: 'out', name: 'return', text: "'hello bob'", step: 53 },
    ]);
  });

  it('hangs the decisions under their function with taken, hits and notRun', () => {
    const main = node(g, '<module>').id;
    const fail = node(g, 'fail').id;
    expect(decisions(g).map((d) => [d.label, d.parent, d.taken, d.hits, d.notRun])).toEqual([
      ['for i in range(3)', main, undefined, 3, []],
      ['for j in []', main, undefined, 0, []],
      ['while k < 2', main, undefined, 2, []],
      ['if total > 100 and k > 0', main, 'False', 1, [32]],
      ['elif total > 5', main, 'True', 1, [36]],
      ['match total', main, 'case _', 1, [39]],
      ['if n > 100', fail, 'False', 2, [8]],
    ]);
    const d = decision(g, 'if n > 100');
    expect(d).toMatchObject({ file: '/fixture/helper.py', line: 7, fileId: 2, text: 'if n > 100 took False', firstStep: 57, rows: [] });
    expect(Object.keys(d)).toEqual(['id', 'kind', 'parent', 'label', 'file', 'line', 'fileId', 'text', 'taken', 'firstStep', 'hits', 'notRun', 'rows']);
    expect(Object.keys(decision(g, 'for j in []'))).not.toContain('taken');
  });

  it('hangs the statements under their scope, compound headers and imports left out', () => {
    const main = node(g, '<module>').id;
    expect(statements(g).filter((s) => s.parent === main).map((s) => [s.label, s.hits])).toEqual([
      ["sys.path.insert(0, os.path.join(os.path.dirname(os.path.abs…", 1],
      ['total = 0', 1],
      ['total += helper.double(i)', 3],
      ['k = 0', 1],
      ['k += 1', 2],
      ['mid = True', 1],
      ['z = 1', 1],
      ['c = Counter(10)', 1],
      ['c.bump(5)', 1],
      ['seen = libq.run(lambda n: n * 2)', 1],
      ['print(greet("bob"), total)', 1],
      ['helper.fail(total)', 1],
      ['handled = True', 1],
      ['result = helper.fail(total)', 1],
    ]);
    expect(statements(g).map((s) => s.parent === main || s.parent)).not.toContain(node(g, 'libq').id);
    expect(statements(g).filter((s) => s.parent === node(g, 'double').id).map((s) => [s.label, s.targets, s.reads, s.hits])).toEqual([
      ['y = x * 2', ['y'], ['x'], 3],
      ['return y', [], ['y'], 3],
    ]);
    // the multi-line `if (total > 100\n and k > 0):` header is a decision, never a statement
    expect(statements(g).some((s) => s.line === 30 && s.fileId === 1)).toBe(false);
    expect(statement(g, 'total += helper.double(i)')).toMatchObject({ targets: ['total'], reads: ['total', 'helper', 'i'], firstStep: 8, rows: [{ kind: 'out', name: 'total', text: '0', step: 11 }] });
    expect(statement(g, 'print(greet(')).toMatchObject({ reads: ['print', 'greet', 'total'], rows: [{ kind: 'print', name: 'stdout', text: 'hello bob 6', step: 53 }] });
  });

  it('draws the call, tool and data edges', () => {
    expect(edgeList(g)).toEqual([
      '<module> → helper.py call ×1',
      'total += helper.double(i) → double call ×3',
      'total = 0 ⇢ total += helper.double(i) total',
      'for i in range(3) ⇢ total += helper.double(i) i',
      'double ⇢ y = x * 2 x',
      'y = x * 2 ⇢ return y y',
      'double ⇢ double x',
      'k = 0 ⇢ while k < 2 k',
      'k = 0 ⇢ k += 1 k',
      'total += helper.double(i) ⇢ if total > 100 and k > 0 total',
      'k += 1 ⇢ if total > 100 and k > 0 k',
      'total += helper.double(i) ⇢ elif total > 5 total',
      'total += helper.double(i) ⇢ match total total',
      'c = Counter(10) → Counter.__init__ call ×1',
      'Counter.__init__ ⇢ self.value = start start',
      'c.bump(5) → Counter.bump call ×1',
      'c = Counter(10) ⇢ c.bump(5) c',
      'Counter.bump ⇢ self.value += by by',
      'seen = libq.run(lambda n: n * 2) → libq call ×1',
      'libq → <lambda> tool ×1',
      'print(greet("bob"), total) → greet call ×1',
      'total += helper.double(i) ⇢ print(greet("bob"), total) total',
      'greet ⇢ msg = "hello " + name name',
      'msg = "hello " + name ⇢ return msg msg',
      'helper.fail(total) → fail call ×1',
      'total += helper.double(i) ⇢ helper.fail(total) total',
      'fail ⇢ if n > 100 n',
      'fail ⇢ raise ValueError("too small: %d" % n) n',
      'result = helper.fail(total) → fail call ×1',
      'total += helper.double(i) ⇢ result = helper.fail(total) total',
    ]);
    const toDouble = g.edges.find((e) => e.kind === 'call' && labelOf(g, e.to) === 'double') as CallEdge;
    expect(toDouble).toMatchObject({ from: statement(g, 'total += ').id, count: 3, firstStep: 8, steps: [8, 13, 18], momentIds: ['m5', 'm7', 'm9'] });
    expect(Object.keys(toDouble)).toEqual(['id', 'from', 'to', 'kind', 'count', 'firstStep', 'steps', 'momentIds']);
    // fail(n=6) takes the running total, not anything double returned (0, 2, 4)
    expect(g.edges.some((e) => e.kind === 'data' && labelOf(g, e.from) === 'double' && labelOf(g, e.to) === 'fail')).toBe(false);
    const data = g.edges.find((e) => e.kind === 'data' && e.label === 'x' && labelOf(g, e.from) === 'double')!;
    expect(Object.keys(data)).toEqual(['id', 'from', 'to', 'kind', 'label', 'firstStep']);
    expect(g.edges.map((e) => e.id)).toEqual(g.edges.map((_, i) => `e${i}`));
  });

  it('maps every moment with a node and every trace scope', () => {
    const byId = new Map(g.moments.map((m) => [m.id, m]));
    expect(byId.get('m0')).toEqual({ id: 'm0', kind: 'start', step: 0, nodeId: 'n0' });
    expect(byId.get('m5')).toEqual({ id: 'm5', kind: 'call', step: 8, nodeId: node(g, 'double').id, edgeId: 'e1' });
    expect(byId.get('m28')).toMatchObject({ kind: 'tool', nodeId: node(g, '<lambda>').id, edgeId: g.edges.find((e) => e.kind === 'tool')!.id });
    expect(byId.get('m34')).toEqual({ id: 'm34', kind: 'decision', step: 57, nodeId: decision(g, 'if n > 100').id });
    expect(byId.get('m35')).toEqual({ id: 'm35', kind: 'error', step: 58, nodeId: statement(g, 'raise ValueError(').id });
    expect(byId.get('m22')).toMatchObject({ kind: 'value', nodeId: statement(g, 'self.value = start').id });
    expect(byId.get('m32')).toMatchObject({ kind: 'print', nodeId: statement(g, 'print(greet(').id });
    expect(byId.get('m6')).toMatchObject({ kind: 'value', nodeId: statement(g, 'total += helper.double(i)').id });
    expect(byId.get('m40')).toMatchObject({ kind: 'end', nodeId: 'n0' });
    expect(g.moments.length).toBe(41);
    const id = (label: string): string => node(g, label).id;
    expect(g.scopes).toEqual({ '0': 'n0', '1': id('helper.py'), '2': id('double'), '3': id('double'), '4': id('double'), '5': id('Counter.__init__'), '6': id('Counter.bump'), '7': id('libq'), '8': id('libq'), '9': id('<lambda>'), '10': id('greet'), '11': id('fail'), '12': id('fail') });
  });

  it('caps the function nodes to the most called, earliest first', () => {
    const c = build({ cap: 6 });
    expect(c.capped).toBe(true);
    expect(calls(c).map((n) => [n.label, n.calls])).toEqual([
      ['<module>', 1],
      ['helper.py', 1],
      ['double', 3],
      ['Counter.__init__', 1],
      ['3 more functions', 3],
      ['libq', 1],
      ['fail', 2],
    ]);
    const more = node(c, '3 more functions');
    expect(more).toEqual({ id: more.id, kind: 'package', label: '3 more functions', file: '/fixture/main.py', fileId: 1, calls: 3, firstStep: 37, spans: [], rows: [], more: 3 });
    // the dropped functions take their statements, and every edge touching them, along
    expect(edgeList(c)).toEqual([
      '<module> → helper.py call ×1',
      'total += helper.double(i) → double call ×3',
      'total = 0 ⇢ total += helper.double(i) total',
      'for i in range(3) ⇢ total += helper.double(i) i',
      'double ⇢ y = x * 2 x',
      'y = x * 2 ⇢ return y y',
      'double ⇢ double x',
      'k = 0 ⇢ while k < 2 k',
      'k = 0 ⇢ k += 1 k',
      'total += helper.double(i) ⇢ if total > 100 and k > 0 total',
      'k += 1 ⇢ if total > 100 and k > 0 k',
      'total += helper.double(i) ⇢ elif total > 5 total',
      'total += helper.double(i) ⇢ match total total',
      'c = Counter(10) → Counter.__init__ call ×1',
      'Counter.__init__ ⇢ self.value = start start',
      'c = Counter(10) ⇢ c.bump(5) c',
      'seen = libq.run(lambda n: n * 2) → libq call ×1',
      'total += helper.double(i) ⇢ print(greet("bob"), total) total',
      'helper.fail(total) → fail call ×1',
      'total += helper.double(i) ⇢ helper.fail(total) total',
      'fail ⇢ if n > 100 n',
      'fail ⇢ raise ValueError("too small: %d" % n) n',
      'result = helper.fail(total) → fail call ×1',
      'total += helper.double(i) ⇢ result = helper.fail(total) total',
    ]);
    expect(statements(c).some((s) => ['self.value += by', 'return self.value', 'msg = "hello " + name', 'return msg'].includes(s.label))).toBe(false);
    expect(statements(c).every((s) => c.nodes.some((n) => n.id === s.parent))).toBe(true);
    expect(c.moments.some((m) => m.id === 'm24' || m.id === 'm25' || m.id === 'm28' || m.id === 'm30' || m.id === 'm31')).toBe(false);
    expect(c.scopes['6']).toBe(more.id);
    expect(c.scopes['9']).toBe(more.id);
    expect(c.scopes['10']).toBe(more.id);
    expect(decisions(c).length).toBe(7);
    expect(edgeList(build({ cap: 6, statements: false }))).toEqual(['<module> → helper.py call ×1', '<module> → double call ×3', 'double ⇢ double x', '<module> → Counter.__init__ call ×1', '<module> → libq call ×1', '<module> → fail call ×2']);
  });

  it('unrolls the library with all, and with expand', () => {
    for (const opts of [{ all: true }, { expand: ['libq'] }]) {
      const a = build(opts);
      expect(calls(a).map((n) => n.label)).toEqual(['<module>', 'helper.py', 'double', 'Counter.__init__', 'Counter.bump', 'run', 'helper', '<lambda>', 'greet', 'fail']);
      expect(node(a, 'run')).toMatchObject({ kind: 'function', package: 'libq', fileId: 3, function: 'run', calls: 1 });
      expect(node(a, 'run').nested).toBeUndefined();
      // library scopes never get statements: the calls inside libq leave from the function nodes
      expect(edgeList(a)).toContain('run → helper call ×1');
      expect(edgeList(a)).toContain('run → <lambda> tool ×1');
      expect(edgeList(a)).toContain('seen = libq.run(lambda n: n * 2) → run call ×1');
      expect(statements(a).some((s) => s.parent === node(a, 'run').id || s.parent === node(a, 'helper').id)).toBe(false);
      expect(a.scopes['8']).toBe(node(a, 'helper').id);
      expect(calls(a).some((n) => n.kind === 'package')).toBe(false);
    }
  });

  it('keeps expanding one package from folding another', () => {
    const e = build({ expand: ['other'] });
    expect(node(e, 'libq').kind).toBe('package');
    expect(edgeList(e)).not.toContain('libq → libq call ×1');
    expect(node(e, 'libq').calls).toBe(1);
  });

  it('applies the scope window', () => {
    const s = build({ scope: 'fail' });
    expect(calls(s).map((n) => n.label)).toEqual(['<module>', 'fail']);
    expect(decisions(s).map((d) => d.label)).toEqual(['if n > 100']);
    // only the steps inside the window make statements: the call sites in the module are outside it
    expect(statements(s).map((st) => [st.label, st.parent, st.hits])).toEqual([['raise ValueError("too small: %d" % n)', 'n1', 2]]);
    expect(edgeList(s)).toEqual(['<module> → fail call ×2', 'fail ⇢ if n > 100 n', 'fail ⇢ raise ValueError("too small: %d" % n) n']);
    expect(s.scopes).toEqual({ '0': 'n0', '11': 'n1', '12': 'n1' });
    expect(s.moments.map((m) => m.id)).toEqual(['m33', 'm34', 'm35', 'm37', 'm38', 'm39', 'm40']);
    expect(s.moments.find((m) => m.id === 'm35')!.nodeId).toBe('n3');
    expect(s.count).toBe(64);
  });

  it('leaves the statements out with statements: false', () => {
    const f = build({ statements: false });
    expect(statements(f)).toEqual([]);
    expect(f.nodes.length).toBe(16);
    expect(edgeList(f)).toEqual(['<module> → helper.py call ×1', '<module> → double call ×3', 'double ⇢ double x', '<module> → Counter.__init__ call ×1', '<module> → Counter.bump call ×1', '<module> → libq call ×1', 'libq → <lambda> tool ×1', '<module> → greet call ×1', '<module> → fail call ×2']);
    expect(node(f, 'fail').rows).toEqual([
      { kind: 'in', name: 'n', text: '6', step: 56 },
      { kind: 'raised', name: 'ValueError', text: 'too small: 6', step: 58 },
    ]);
    expect(f.moments.find((m) => m.id === 'm35')!.nodeId).toBe(node(f, 'fail').id);
    expect(f.moments.find((m) => m.id === 'm22')!.nodeId).toBe(node(f, 'Counter.__init__').id);
  });

  it('renders the text form', () => {
    const lines = renderGraphLines(g, { workspaceRoot: '/fixture' });
    expect(lines[0]).toBe('38 nodes, 30 edges over 64 steps');
    expect(lines[1]).toBe('n0 <module> main.py:1  ×1');
    expect(lines[2]!.startsWith('   n1 sys.path.insert(0, os.path.join(')).toBe(true);
    expect(lines).toContain('n5 double helper.py:1  ×3  in x = 0 · out 0');
    expect(lines).toContain('n32 fail helper.py:6  ×2  in n = 6 · raised ValueError: too small: 6');
    expect(lines).toContain('n28 greet main.py:7  ×1  in name = \'bob\' · out \'hello bob\'');
    expect(lines).toContain('n25 libq  ×1  2 nested  in cb = <function <lambda> at 0x0> · out 8');
    expect(lines).toContain('   n13 if total > 100 and k > 0 took False  ×1  not run: 32');
    // statements and decisions interleave under their parent in firstStep order
    const total = lines.indexOf('   n3 total = 0  ×1  out total = 0');
    expect(total).toBeGreaterThan(1);
    expect(lines[total + 1]).toBe('   n4 for i in range(3) ran 3 times  ×3');
    expect(lines[total + 2]).toBe('   n6 total += helper.double(i)  ×3  out total = 0');
    expect(lines).toContain('   n29 print(greet("bob"), total)  ×1  print stdout = hello bob 6');
    expect(lines.indexOf('   n34 if n > 100 took False  ×2  not run: 8')).toBe(lines.indexOf('n32 fail helper.py:6  ×2  in n = 6 · raised ValueError: too small: 6') + 1);
    expect(lines.indexOf('   n35 raise ValueError("too small: %d" % n)  ×2  raised ValueError: too small: 6')).toBe(lines.indexOf('n32 fail helper.py:6  ×2  in n = 6 · raised ValueError: too small: 6') + 2);
    expect(lines.indexOf('n5 double helper.py:1  ×3  in x = 0 · out 0')).toBeGreaterThan(lines.indexOf('   n37 result = helper.fail(total)  ×1'));
    expect(lines).toContain('n6 → n5  ×3  #8');
    expect(lines).toContain('n25 → n27  tool ×1  #48');
    expect(lines).not.toContain('n5 ⇢ n32  n');
    expect(lines).toContain('n3 ⇢ n6  total');
    expect(lines.every((l) => l.length <= 100)).toBe(true);
    expect(renderGraphLines(g, { limit: 30 }).every((l) => l.length <= 30)).toBe(true);
  });

  it('maps a call stack through the scopes, the running statement first', () => {
    const inputs = loadInputs(WALKTHROUGH_RUN, WALKTHROUGH_PROGRAM);
    const frames = inputs.trace.callStack(48);
    expect(frames.map((f) => f.scopeId)).toEqual([9, 7, 0]);
    // every frame's running statement precedes its scope: the lambda body sits on the `seen = …` line, the outer frames are call sites
    expect(graphStack(g, frames)).toEqual([statement(g, 'seen = ').id, node(g, '<lambda>').id, node(g, 'libq').id, 'n0']);
    expect(graphStack(g, inputs.trace.callStack(45))).toEqual([node(g, 'libq').id, statement(g, 'seen = ').id, 'n0']);
    expect(graphStack(g, [{ scopeId: 99 }, { scopeId: 0 }, { scopeId: 0 }])).toEqual(['n0']);
    expect(graphStack(g, [])).toEqual([]);
    // `current` puts the statement node at that line ahead of the scope nodes; a line without one changes nothing
    expect(graphStack(g, inputs.trace.callStack(26), { fileId: 1, line: 29 })).toEqual([statement(g, 'k += 1').id, 'n0']);
    expect(graphStack(g, inputs.trace.callStack(10), { fileId: 2, line: 2 })).toEqual([statement(g, 'y = x * 2').id, node(g, 'double').id, statement(g, 'total += helper.double(i)').id, 'n0']);
    // inside the lambda the current line is still `seen = libq.run(lambda …)`: that statement leads
    expect(graphStack(g, frames, { fileId: 1, line: 44 })).toEqual([statement(g, 'seen = ').id, node(g, '<lambda>').id, node(g, 'libq').id, 'n0']);
    expect(graphStack(g, inputs.trace.callStack(6), { fileId: 1, line: 23 })).toEqual(['n0']);
  });
});

describe('execution graph fixtures', () => {
  const same = (name: string, expected: unknown, actual: ExecutionGraph): void => {
    expect(expected, name).toBeDefined();
    expect(JSON.parse(JSON.stringify(actual)), name).toEqual(expected);
    expect(JSON.stringify(JSON.parse(JSON.stringify(actual))), `${name}: field order`).toBe(JSON.stringify(expected));
  };

  it('equals the graphs the Python builder wrote for the walkthrough run', () => {
    expect(fs.existsSync(GRAPH_FIXTURE), `${GRAPH_FIXTURE} is missing: run python/tests/test_graph.py with PYOKKA_WRITE_FIXTURES=1`).toBe(true);
    const expected = JSON.parse(fs.readFileSync(GRAPH_FIXTURE, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(expected).sort()).toEqual(['all', 'cap', 'default', 'scope']);
    const cases: Record<string, ExecutionGraphOptions> = { default: {}, all: { all: true }, scope: { scope: 'fail' }, cap: { cap: 6 } };
    for (const [name, opts] of Object.entries(cases)) same(name, expected[name], build(opts));
  });
});
