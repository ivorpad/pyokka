/**
 * The provenance builder (docs/PROTOCOL.md, "Provenance") over a hand-built trace, then over the
 * shared fixture run `fixtures/provenance-run.json` with the cases `fixtures/provenance.json`
 * (both written by python/tests/test_provenance.py): every case must produce exactly the tree the
 * Python builder wrote. Regenerate them from the Python side with PYOKKA_WRITE_FIXTURES=1.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TraceModel, packSteps } from '../../src/timeMachine/traceModel';
import { FileTable } from '../../src/session/fileTable';
import { decodeSteps, type ErrorEvent, type FileInstrumentedEvent, type LocalsEvent, type LogEvent, type ProvenanceNode, type Range4, type StatementBinding, type TraceEvent, type TraceScope } from '../../src/shared/protocol';
import { indexBindings } from '../../src/session/variableHistory';
import { calleeOf, provenance, stepOfEntry, type ProvenanceInputs } from '../../src/session/provenance';
import { provenanceConclusion, renderProvenance } from '../../src/shared/provenanceText';

const FILE = '/w/main.py';
const scope = (scopeId: number, name: string, parent: number, depth: number, first: number, last: number, rid = 0): TraceScope => ({ scopeId, rid, name, parent, depth, first, last });
const log = (rid: number, step: number, text: string, context: string, kind: LogEvent['kind'] = 'autoLog'): LogEvent => ({ type: 'log', runId: 'r', seq: 0, logId: `l-${rid}-${step}`, kind, fileId: 1, rid, hit: 1, step, context, text, runtimeKey: `k${rid}` });
const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

/**
 * rid == source line; one file (id 1, /w/main.py), a call whose body was stepped, a class whose
 * `__init__` was stepped, builtin calls nobody stepped, a value log on the call line:
 *  1  total = 0
 *  2  for i in range(2):
 *  3      total += i
 *  4  def double(x):
 *  5      y = x * 2
 *  6      return y
 *  7  class Box:
 *  8      def __init__(self, v):
 *  9          self.v = v
 * 10  n = double(total)  # ?
 * 11  box = Box(n)
 * 12  size = len(str(n)) + box.v
 * Steps: 0 (line 1), 1 (loop start), 2 (iteration 1), 3 (line 3), 4 (iteration 2), 5 (line 3), 6 (line 10, the call
 * site), 7-9 (double: the def header, lines 5 and 6), 10 (line 11), 11-12 (__init__: the header, line 9), 13 (line 12).
 * `def` and `class` statements at module level are not steps. Locals are observed at the start of a step, a
 * parameter at the step after the header; the `# ?` on line 10 is stamped with the step the callee returned on.
 */
const SOURCE = ['total = 0', 'for i in range(2):', '    total += i', 'def double(x):', '    y = x * 2', '    return y', 'class Box:', '    def __init__(self, v):', '        self.v = v', 'n = double(total)  # ?', 'box = Box(n)', 'size = len(str(n)) + box.v'];
const BINDINGS: StatementBinding[] = [
  { line: 1, col: 0, assigns: ['total'], reads: [] },
  { line: 2, col: 0, assigns: ['i'], reads: [], loop: 3, calls: ['range(2)'] },
  { line: 3, col: 4, assigns: ['total'], reads: ['total', 'i'] },
  { line: 4, col: 0, assigns: ['x'], reads: [] },
  { line: 5, col: 4, assigns: ['y'], reads: ['x'] },
  { line: 6, col: 4, assigns: [], reads: ['y'] },
  { line: 8, col: 4, assigns: ['self', 'v'], reads: [] },
  { line: 9, col: 8, assigns: ['self.v'], reads: ['self', 'v'] },
  { line: 10, col: 0, assigns: ['n'], reads: ['double', 'total'], calls: ['double(total)'] },
  { line: 11, col: 0, assigns: ['box'], reads: ['Box', 'n'], calls: ['Box(n)'] },
  { line: 12, col: 0, assigns: ['size'], reads: ['n', 'box'], calls: ['len(str(n))', 'str(n)'] },
];

function program(bindings: StatementBinding[] = BINDINGS): ProvenanceInputs & { locals: LocalsEvent['entries'] } {
  const files = new FileTable();
  const ranges: Range4[] = [[1, 0, 12, 26], [1, 0, 1, 9], [2, 0, 2, 18], [3, 4, 3, 14], [4, 0, 4, 14], [5, 4, 5, 13], [6, 4, 6, 12], [7, 0, 7, 10], [8, 4, 8, 26], [9, 8, 9, 18], [10, 0, 10, 17], [11, 0, 11, 12], [12, 0, 12, 26]];
  const file = files.add({ fileId: 1, path: FILE, rangeBase: 0, ranges, statements: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], functions: [{ rid: 4, name: 'double', bodyRange: [4, 0, 6, 12] }, { rid: 8, name: '__init__', bodyRange: [8, 4, 9, 18] }], magic: [] });
  const steps = packSteps([[1, 0, 0], [2, 0, 0], [2, 0, 0], [3, 0, 0], [2, 0, 0], [3, 0, 0], [10, 0, 0], [4, 1, 1], [5, 1, 1], [6, 1, 1], [11, 0, 0], [8, 2, 1], [9, 2, 1], [12, 0, 0]]);
  const trace = new TraceModel(steps, [scope(0, '<module>', -1, 0, 0, 13), scope(1, 'double', 0, 1, 7, 9, 4), scope(2, '__init__', 0, 1, 11, 12, 8)], false, (rid) => {
    const l = files.locate(rid);
    return l ? { fileId: l.fileId, range: l.range } : undefined;
  });
  const locals: LocalsEvent['entries'] = [
    { step: 1, scopeId: 0, changes: [{ name: 'total', text: '0' }] },
    { step: 2, scopeId: 0, changes: [{ name: 'i', text: '0' }] },
    { step: 4, scopeId: 0, changes: [{ name: 'i', text: '1' }] },
    { step: 6, scopeId: 0, changes: [{ name: 'total', text: '1' }] },
    { step: 8, scopeId: 1, changes: [{ name: 'x', text: '1' }] },
    { step: 9, scopeId: 1, changes: [{ name: 'y', text: '2' }] },
    { step: 10, scopeId: 0, changes: [{ name: 'n', text: '2' }] },
    { step: 12, scopeId: 2, changes: [{ name: 'self', text: '<Box>' }, { name: 'v', text: '2' }] },
    { step: 13, scopeId: 0, changes: [{ name: 'box', text: '<Box>' }] },
  ];
  const entries = [log(3, 5, '1', 'total'), log(10, 9, '2', 'n', 'value')];
  const entriesByRid = new Map<number, LogEvent[]>();
  for (const e of entries) entriesByRid.set(e.rid, [...(entriesByRid.get(e.rid) ?? []), e]);
  return { trace, files, entries, locals, errors: [], mainFile: FILE, workspaceRoot: '/w', readSource: (fileId) => (fileId === 1 ? SOURCE : undefined), entriesByRid, bindings: new Map([[1, indexBindings(file, bindings)]]), mainFileId: 1 };
}

/* the nodes of the program's tree, named by their step */
const at = (step: number, line: number, fn = '<module>', scopeId = 0): Record<string, unknown> => ({ step, file: FILE, fileId: 1, line, function: fn, scopeId });
const leaf = (name: string): Record<string, unknown> => ({ name });
const T0 = { name: 'total', text: '0', source: 'locals', ...at(0, 1), statement: 'total = 0', reads: [], calls: [], opaque: [] };
const I4 = { name: 'i', text: '1', source: 'locals', ...at(4, 2), statement: 'for i in range(2):', reads: [], calls: [], opaque: ['range(2)'] };
// a locals node names the entry its statement logged for the name: `total += i` logged at its own step, `n = double(total)  # ?` at the callee's last step
const T5 = { name: 'total', text: '1', source: 'locals', logId: 'l-3-5', ...at(5, 3), statement: 'total += i', reads: [T0, I4], calls: [], opaque: [] };
const DOUBLE = { name: 'double', scopeId: 1, entryStep: 7, returnStep: 9, file: FILE, fileId: 1, line: 4, inputs: [{ name: 'x', text: '1' }], result: '2' };
const N6 = { name: 'n', text: '2', source: 'locals', logId: 'l-10-9', ...at(6, 10), statement: 'n = double(total)  # ?', reads: [leaf('double'), T5], calls: [DOUBLE], opaque: [] };
const INIT = { name: '__init__', scopeId: 2, entryStep: 11, returnStep: 12, file: FILE, fileId: 1, line: 8, inputs: [{ name: 'v', text: '2' }] };
const B10 = { name: 'box', text: '<Box>', source: 'locals', ...at(10, 11), statement: 'box = Box(n)', reads: [leaf('Box'), N6], calls: [INIT], opaque: [] };
const SIZE = { name: 'size', source: 'assign', ...at(13, 12), statement: 'size = len(str(n)) + box.v', reads: [N6, B10], calls: [], opaque: ['len(str(n))', 'str(n)'] };

describe('provenance', () => {
  it('explains an assignment: its reads resolved and expanded, the stepped call with its inputs and result, the builtin calls as opaque leaves', () => {
    const p = provenance(program(), { step: 13, name: 'size' });
    expect(json(p)).toEqual({ name: 'size', step: 13, depth: 5, nodes: 13, truncated: false, recordedLocals: true, root: SIZE, conclusion: '' });
  });

  it('roots on the change var lists at the step, with the entry the statement logged (at the callee\'s last step for a call line)', () => {
    const p = provenance(program(), { step: 6, name: 'n' });
    expect(json(p)).toEqual({ name: 'n', step: 6, depth: 5, nodes: 5, truncated: false, recordedLocals: true, root: N6, conclusion: 'n is 2 at #6 (main.py:10). double(total) returned 2.' });
    const merged = provenance(program(), { step: 5, name: 'total' });
    expect(merged.root).toMatchObject({ name: 'total', text: '1', source: 'locals', logId: 'l-3-5', step: 5 });
    // the entry stamped at step 9 is line 10's (`n`); a node inside double gets no logId from it
    expect(provenance(program(), { step: 9, name: 'y' }).root).toMatchObject({ name: 'y', text: '2', source: 'locals', step: 8 });
    expect(provenance(program(), { step: 9, name: 'y' }).root.logId).toBeUndefined();
  });

  it('roots on the value the name had when the step ran when the statement did not change it', () => {
    const p = provenance(program(), { step: 6, name: 'total' });
    expect(json(p.root)).toEqual(T5);
    expect(p.nodes).toBe(3);
  });

  it('answers a leaf for a name nothing recorded and for a step outside the trace', () => {
    expect(json(provenance(program(), { step: 6, name: 'nothing' }))).toEqual({ name: 'nothing', step: 6, depth: 5, nodes: 1, truncated: false, recordedLocals: true, root: { name: 'nothing' }, conclusion: '' });
    expect(provenance(program(), { step: 99, name: 'total' }).root).toEqual({ name: 'total' });
  });

  it('explains the statement itself for an empty name', () => {
    const p = provenance(program(), { step: 13, name: '' });
    expect(p.name).toBe('');
    expect(json(p.root)).toEqual({ ...SIZE, name: '', source: undefined });
    expect(provenance(program(), { step: 13 }).root.name).toBe('');
  });

  it('prefers the exact name among the rows at the step, else the first', () => {
    const inputs = program();
    const bv = { ...log(12, 13, '2', 'box.v', 'value'), logId: 'l-bv' };
    const b = { ...log(12, 13, '<Box>', 'box', 'value'), logId: 'l-b' };
    inputs.entriesByRid = new Map([...inputs.entriesByRid, [12, [bv, b]]]);
    expect(provenance(inputs, { step: 13, name: 'box.v' }).root).toMatchObject({ name: 'box.v', text: '2', source: 'value', logId: 'l-bv', step: 13 });
    expect(provenance(inputs, { step: 13, name: 'box' }).root).toMatchObject({ name: 'box', text: '<Box>', logId: 'l-b', step: 13 });
    inputs.entriesByRid = new Map([...inputs.entriesByRid, [12, [bv]]]);
    expect(provenance(inputs, { step: 13, name: 'box' }).root).toMatchObject({ name: 'box.v', logId: 'l-bv' });
  });

  it('falls back to the first segment of a dotted name nothing recorded, and says so by the name', () => {
    const p = provenance(program(), { step: 13, name: 'box.v' });
    expect(json(p.root)).toEqual(B10);
    const attr = provenance(program(), { step: 12, name: 'self.v' });
    const header = { source: 'locals', ...at(11, 8, '__init__', 2), statement: 'def __init__(self, v):', reads: [], calls: [], opaque: [] };
    expect(json(attr.root)).toEqual({ name: 'self.v', source: 'assign', ...at(12, 9, '__init__', 2), statement: 'self.v = v', reads: [{ name: 'self', text: '<Box>', ...header }, { name: 'v', text: '2', ...header }], calls: [], opaque: [] });
  });

  it('stops at a read whose value the statement itself made (a loop variable)', () => {
    // `for i in range(2)` reading its own target, as `for node in node.children` does
    const bindings = BINDINGS.map((b) => (b.line === 2 ? { ...b, reads: ['i'] } : b));
    const p = provenance(program(bindings), { step: 4, name: 'i' });
    expect(json(p.root)).toEqual({ ...I4, reads: [{ name: 'i', text: '1', source: 'locals', ...at(4, 2), statement: 'for i in range(2):' }] });
    expect(p.nodes).toBe(2);
  });

  it('cuts at the last level and clamps the depth', () => {
    const p = provenance(program(), { step: 13, name: 'size', depth: 1 });
    const cut = (n: Record<string, unknown>): Record<string, unknown> => {
      const { reads: _r, calls: _c, opaque: _o, ...rest } = n;
      return { ...rest, cut: true };
    };
    expect(json(p)).toEqual({ name: 'size', step: 13, depth: 1, nodes: 3, truncated: false, recordedLocals: true, root: { ...SIZE, reads: [cut(N6), cut(B10)] }, conclusion: '' });
    expect(provenance(program(), { step: 13, name: 'size', depth: 0 }).depth).toBe(1);
    expect(provenance(program(), { step: 13, name: 'size', depth: 99 }).depth).toBe(8);
    expect(provenance(program(), { step: 13, name: 'size', depth: 2 }).nodes).toBe(7);
  });

  it('cuts the nodes whose reads would pass the budget and says so', () => {
    const four = provenance(program(), { step: 13, name: 'size', nodes: 4 });
    expect([four.nodes, four.truncated, four.root.reads!.map((r) => r.cut)]).toEqual([3, true, [true, true]]);
    const five = provenance(program(), { step: 13, name: 'size', nodes: 5 });
    expect([five.nodes, five.truncated]).toEqual([5, true]);
    expect(five.root.reads![0]!.reads!.map((r) => [r.name, r.cut])).toEqual([['double', undefined], ['total', true]]);
    expect(five.root.reads![1]!.cut).toBe(true);
    expect(provenance(program(), { step: 13, name: 'size', nodes: 60 }).truncated).toBe(false);
  });

  it('works from logged values alone when the run recorded no locals', () => {
    const inputs = program();
    inputs.locals = [];
    const p = provenance(inputs, { step: 6, name: 'n' });
    expect(p.recordedLocals).toBe(false);
    expect(json(p.root)).toEqual({
      name: 'n',
      source: 'assign',
      logId: 'l-10-9',
      ...at(6, 10),
      statement: 'n = double(total)  # ?',
      reads: [leaf('double'), { name: 'total', text: '1', source: 'value', logId: 'l-3-5', ...at(5, 3), statement: 'total += i', reads: [leaf('total'), leaf('i')], calls: [], opaque: [] }],
      calls: [{ ...DOUBLE, inputs: [] }],
      opaque: [],
    });
  });

  it('renders the text form', () => {
    expect(renderProvenance(provenance(program(), { step: 6, name: 'n', depth: 1 }))).toBe(['why n at #6', 'n = 2   #6 /w/main.py:10 <module>   n = double(total)  # ?', '  ← double = ?', '  ← total = 1   #5 /w/main.py:3 <module>   total += i  …', '  ↳ double #7–#9 /w/main.py:4   in x = 1   out 2', 'n is 2 at #6 (main.py:10). double(total) returned 2.'].join('\n'));
    expect(renderProvenance(provenance(program(), { step: 3, name: 'total', depth: 1 }), (id) => `f${id}`)).toBe(['why total at #3', 'total = 0  (unchanged)   #3 f1:3 <module>   total += i', '  ← total = 0   #0 f1:1 <module>   total = 0  …', '  ← i = 0   #2 f1:2 <module>   for i in range(2):  …', 'total is 0 at #3 (main.py:3). It reads total = 0, i = 0.'].join('\n'));
    const inputs = program();
    inputs.locals = [];
    const lines = renderProvenance(provenance(inputs, { step: 13, name: 'size', nodes: 3 })).split('\n');
    expect(lines[1]).toBe('size  assigned here (value not recorded)   #13 /w/main.py:12 <module>   size = len(str(n)) + box.v');
    expect(lines.slice(2)).toEqual(['  ← n = ?', '  ← box = ?', '  · len(str(n))   not stepped', '  · str(n)   not stepped']);
    const cut = renderProvenance(provenance(program(), { step: 13, name: '', nodes: 4 })).split('\n');
    expect(cut[0]).toBe('why #13');
    expect(cut[cut.length - 1]).toBe("… more inputs than 60 nodes show; ask why for a node's name at its step");
  });

  it('names the callee of a call text', () => {
    expect(['helper.describe(total, os.sep)', 'Account("guest", 5)', 'sum(a.balance for a in xs)', 'acct.deposit(amount)', 'f (x)', '(lambda: 1)()'].map(calleeOf)).toEqual(['describe', 'Account', 'sum', 'deposit', 'f', '']);
  });

  it('finds the statement of an entry stamped inside a callee', () => {
    const { trace } = program();
    expect(stepOfEntry(trace, { step: 9, rid: 10 })).toBe(6); // the `# ?` of line 10, stamped at double's last step
    expect(stepOfEntry(trace, { step: 5, rid: 3 })).toBe(5); // logged at its own step
    expect(stepOfEntry(trace, { step: 13, rid: 0 })).toBe(13); // a live entry (no step has the module range)
    expect(stepOfEntry(trace, { step: 99, rid: 12 })).toBe(13); // a stamp past the trace
  });
});

/* ---------- the shared fixture: the Python builder's answers over one recorded program ---------- */

const FIXTURES = path.join(__dirname, 'fixtures');
const PROGRAM = path.join(FIXTURES, 'provenance');
const RUN_JSON = path.join(FIXTURES, 'provenance-run.json');
const CASES_JSON = path.join(FIXTURES, 'provenance.json');
const FIXTURE_ROOT = '/fixture';

interface SavedRun {
  meta: { file: string; workspaceRoot: string; durationMs: number; exitCode: number };
  events: ({ type: string } & Record<string, unknown>)[];
}
interface Cases {
  bindings: Record<string, StatementBinding[]>;
  cases: { file: string; line: number; occurrence: number; name: string; depth?: number | null; step: number; result: unknown }[];
}

const HAVE_FIXTURE = fs.existsSync(RUN_JSON) && fs.existsSync(CASES_JSON);

function loadFixture(): { inputs: ProvenanceInputs; cases: Cases['cases'] } {
  const doc = JSON.parse(fs.readFileSync(RUN_JSON, 'utf8')) as SavedRun;
  const spec = JSON.parse(fs.readFileSync(CASES_JSON, 'utf8')) as Cases;
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
      return fs.readFileSync(path.join(PROGRAM, p.slice(FIXTURE_ROOT.length + 1)), 'utf8').split('\n');
    } catch {
      return undefined;
    }
  };
  const entriesByRid = new Map<number, LogEvent[]>();
  for (const e of entries) entriesByRid.set(e.rid, [...(entriesByRid.get(e.rid) ?? []), e]);
  const bindings = new Map<number, ReadonlyMap<number, StatementBinding>>();
  for (const f of files.all()) {
    const list = spec.bindings[path.basename(f.path)];
    if (list) bindings.set(f.fileId, indexBindings(f, list));
  }
  const inputs: ProvenanceInputs = { trace, files, entries, locals, errors, mainFile: doc.meta.file, workspaceRoot: doc.meta.workspaceRoot, readSource, entriesByRid, bindings, mainFileId: files.byPath(doc.meta.file)?.fileId };
  return { inputs, cases: spec.cases };
}

describe('provenanceConclusion', () => {
  const root = (over: Record<string, unknown>) => ({ root: { name: 'label', text: "'total/35.0'", step: 24, file: '/w/main.py', line: 29, statement: 'label = helper.describe(total, os.sep)', reads: [], calls: [], opaque: [], ...over } as ProvenanceNode });
  const read = (name: string, text: string, step: number, line = 12): ProvenanceNode => ({ name, text, step, file: '/w/main.py', line });
  it('states the value, then one cause per rule, in the Python twin\'s words', () => {
    expect(provenanceConclusion(root({ name: 'preferred', statement: 'preferred = label if flag else None', reads: [read('label', "'total/35.0'", 20), read('flag', 'True', 23)] }))).toBe("preferred is 'total/35.0' at #24 (main.py:29). The if arm ran: flag is True.");
    expect(provenanceConclusion(root({ name: 'preferred', text: 'None', statement: 'preferred = label if flag else None', reads: [read('flag', 'False', 23)] }))).toBe('preferred is None at #24 (main.py:29). The else arm ran: flag is False.');
    expect(provenanceConclusion(root({ name: 'absent', text: 'None', statement: 'absent = label if count > 50 else None', reads: [read('count', '10', 22), read('label', "'x'", 21)] }))).toBe('absent is None at #24 (main.py:29). The else arm ran: count > 50 was false, since count is 10.');
    const calls = [{ name: 'describe', scopeId: 5, entryStep: 25, returnStep: 27, file: '/w/helper.py', fileId: 2, line: 1, result: "'total/35.0'", inputs: [{ name: 'value', text: '35.0' }, { name: 'sep', text: "''" }] }];
    expect(provenanceConclusion(root({ calls }))).toBe("label is 'total/35.0' at #24 (main.py:29). helper.describe(total, os.sep) returned 'total/35.0' with sep = ''.");
    expect(provenanceConclusion(root({ name: 'copy_of_label', statement: 'copy_of_label = label', reads: [read('label', "'total/35.0'", 20, 12)] }))).toBe("copy_of_label is 'total/35.0' at #24 (main.py:29). It copies label, which has been 'total/35.0' since #20 (main.py:12).");
    expect(provenanceConclusion(root({ name: 'missing', text: 'None', statement: 'missing = settings.get("colour")', reads: [read('settings', "{'theme': 'dark', 'size': 3}", 20)] }))).toBe('missing is None at #24 (main.py:29). settings.get("colour") is None: the key is not in settings (2 keys).');
    expect(provenanceConclusion(root({ name: 'missing', text: 'None', statement: 'missing = table[key]', reads: [read('table', "{'a': 1, …}", 20), read('key', "'z'", 19)] }))).toBe('missing is None at #24 (main.py:29). table[key] is None: the key is not in table.');
    expect(provenanceConclusion(root({ name: 'total', text: '35.0', statement: 'total = sum(a.balance for a in xs) + b + c + d', reads: [read('xs', '[1, 2]', 20), read('b', '1', 19), read('c', '2', 18), read('d', '3', 17)] }))).toBe('total is 35.0 at #24 (main.py:29). It reads xs = [1, 2], b = 1, c = 2.');
    expect(provenanceConclusion(root({ name: 'base', text: '3', statement: 'base = 3' }))).toBe('base is 3 at #24 (main.py:29).');
    expect(provenanceConclusion(root({ text: "'" + 'x'.repeat(80) + "'", statement: 'label = build()' }))).toBe("label is '" + 'x'.repeat(58) + '… at #24 (main.py:29).');
  });
  it('says nothing without a recorded value', () => {
    expect(provenanceConclusion({ root: { name: 'size', step: 13, statement: 'size = len(n)', reads: [{ name: 'n', text: '2', step: 6 }] } })).toBe('');
    expect(provenanceConclusion({ root: { name: 'nothing' } })).toBe('');
    expect(provenanceConclusion({ root: { name: '', text: '1', step: 3, statement: 'x = 1' } })).toBe('');
  });
});

describe.skipIf(!HAVE_FIXTURE)('provenance fixture', () => {
  const fixture = HAVE_FIXTURE ? loadFixture() : undefined;
  const cases = fixture?.cases ?? [];
  it('has cases', () => {
    expect(cases.length).toBeGreaterThan(0);
  });
  it.each(cases.map((c) => [`${c.file}:${c.line} (${c.occurrence}) ${JSON.stringify(c.name)} at #${c.step}${c.depth ? ` depth ${c.depth}` : ''}`, c] as const))('answers %s like the Python builder', (_label, c) => {
    const got = provenance(fixture!.inputs, { step: c.step, name: c.name, depth: c.depth ?? undefined });
    expect(json(got)).toEqual(c.result);
  });
});
