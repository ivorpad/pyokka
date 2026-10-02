/** The Details pane's why tree: the document built from a provenance tree, and the Why buttons on entry and Variable pane rows. */
import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import type { Provenance } from '../../../src/shared/protocol';
import { provenanceLines } from '../../../src/shared/provenanceText';
import type { PanelEntry, VariableView } from '../../../src/shared/webviewProtocol';
import { Entries } from '../../../webview/components/Entries';
import { VariablePane } from '../../../webview/components/VariablePane';
import { DEFAULT_SETTINGS } from '../../../webview/model';
import { DEFAULT_PREFS } from '../../../webview/vscode';
import { buildWhyDocument, whyName } from '../../../webview/why';

const noop = () => undefined;

// a root with two reads (a leaf and an expanded one with a cut read and an opaque call), one stepped call
const tree: Provenance = {
  name: 'label',
  step: 24,
  depth: 5,
  nodes: 4,
  truncated: true,
  recordedLocals: true,
  root: {
    name: 'label',
    text: "'total/35.0'",
    source: 'locals',
    step: 24,
    file: 'main.py',
    fileId: 1,
    line: 29,
    function: '<module>',
    scopeId: 0,
    statement: 'label = helper.describe(total, os.sep)',
    reads: [
      { name: 'helper' },
      {
        name: 'total',
        text: '35.0',
        source: 'locals',
        step: 23,
        file: 'main.py',
        fileId: 1,
        line: 28,
        function: '<module>',
        scopeId: 0,
        statement: 'total = sum(a.balance for a in [acct, Account("guest", 5)])',
        reads: [{ name: 'acct', text: "Account(owner='ivor', balance=30.0)", source: 'value', step: 22, file: 'main.py', fileId: 1, line: 20, function: '<module>', scopeId: 0, cut: true }],
        opaque: ['sum(a.balance for a in [acct, Account("guest", 5)])'],
      },
    ],
    calls: [{ name: 'describe', scopeId: 5, entryStep: 25, returnStep: 27, file: 'helper.py', fileId: 2, line: 1, inputs: [{ name: 'value', text: '35.0' }, { name: 'sep', text: "'/'" }], result: "'total/35.0'" }],
  },
};

describe('buildWhyDocument', () => {
  const doc = buildWhyDocument({ step: 24, name: 'label', tree });
  const text = doc.text.split('\n');

  it('is the text form line for line, with the step and the location of every node and call line', () => {
    expect(text).toEqual(provenanceLines(tree).map((l) => l.text));
    expect(doc.lines.map((l) => l.kind)).toEqual(['title', 'node', 'node', 'node', 'node', 'opaque', 'call', 'note']);
    expect(doc.lines.map((l) => l.step)).toEqual([undefined, 24, undefined, 23, 22, undefined, 25, undefined]);
    expect(doc.lines[1]?.link).toEqual({ fileId: 1, line: 29, col: 0 });
    expect(doc.lines[2]?.link).toBeUndefined();
    expect(doc.lines[6]?.link).toEqual({ fileId: 2, line: 1, col: 0 });
  });
  it('marks the step and location of a line as its link, not the value or the statement', () => {
    const span = (i: number): string => {
      const [start, end] = doc.lines[i]?.linkSpan ?? [0, 0];
      return text[i]?.slice(start, end) ?? '';
    };
    expect(span(1)).toBe('#24 main.py:29 <module>');
    expect(span(3)).toBe('#23 main.py:28 <module>');
    // the cut node has no statement: the link stops before the ellipsis
    expect(span(4)).toBe('#22 main.py:20 <module>');
    expect(span(6)).toBe('#25–#27 helper.py:1');
    expect(doc.lines[2]?.linkSpan).toBeUndefined();
  });
  it('ends with the conclusion as its own line kind when the tree has one', () => {
    const withConclusion = buildWhyDocument({ step: 24, name: 'label', tree: { ...tree, conclusion: "label is 'total/35.0' at #24 (main.py:29). helper.describe(total, os.sep) returned 'total/35.0'." } });
    expect(withConclusion.lines.map((l) => l.kind).slice(-2)).toEqual(['note', 'conclusion']);
    expect(withConclusion.text.split('\n').pop()).toBe("label is 'total/35.0' at #24 (main.py:29). helper.describe(total, os.sep) returned 'total/35.0'.");
    expect(withConclusion.lines[withConclusion.lines.length - 1]?.link).toBeUndefined();
  });
  it('says it is looking the value up until the host answers, and shows the host error instead of a tree', () => {
    expect(buildWhyDocument({ step: 21, name: 'total', tree: null })).toEqual({ text: 'LOOKING UP…', lines: [{ kind: 'wait' }] });
    const error = 'No run yet: run the file first (save, or Re-execute).';
    expect(buildWhyDocument({ step: 21, name: '', tree: null, error })).toEqual({ text: error, lines: [{ kind: 'error' }] });
  });
});

describe('whyName', () => {
  it('asks about the entry context when it is a name or attribute path, else about the statement', () => {
    expect(whyName({ context: 'total' })).toBe('total');
    expect(whyName({ context: 'self.balance' })).toBe('self.balance');
    expect(whyName({ context: 'acct.deposit(amount)' })).toBe('');
    expect(whyName({ context: 'a + b' })).toBe('');
    expect(whyName({})).toBe('');
  });
});

describe('Why buttons', () => {
  const entry = (over: Partial<PanelEntry>): PanelEntry => ({ logId: 'l1', kind: 'value', fileId: 1, file: 'main.py', line: 29, col: 1, rid: 1, hit: 1, step: 24, context: 'label', text: "'total/35.0'", runtimeKey: 'k', ...over });
  const entriesHtml = (entries: PanelEntry[], prefs = DEFAULT_PREFS) =>
    render(<Entries entries={entries} allEntries={entries} hiddenLines={new Set()} filterMode={false} selection={{ ids: [], anchor: null }} prefs={prefs} onSelect={noop} onPrefs={noop} onFilter={noop} onFilterToggle={noop} onFilterMode={noop} onOpen={noop} onWhy={noop} onFocusDetails={noop} onCopy={noop} />);

  it('puts one on every entry row, error rows included, after the source link', () => {
    const html = entriesHtml([entry({}), entry({ logId: 'e1', kind: 'error', isError: true, text: 'boom', context: undefined })]);
    expect(html.match(/data-tip="Why this value"/g)?.length).toBe(2);
    expect(html).toMatch(/pk-srclink.*?pk-icon-btn pk-why"[^>]*data-tip="Why this value"[^>]*><i class="codicon codicon-question"/);
  });
  it('shows auto-expanded values with the variable icon', () => {
    expect(entriesHtml([entry({ kind: 'autoExpand' })], { ...DEFAULT_PREFS, showKindIcon: true })).toContain('codicon-symbol-variable');
  });
  it('puts one on every Variable pane row, named after the row step', () => {
    const view: VariableView = {
      name: 'acct',
      history: {
        name: 'acct',
        total: 2,
        truncated: false,
        recordedLocals: true,
        changes: [
          { step: 12, file: 'example.py', fileId: 1, line: 24, function: '<module>', scopeId: 0, name: 'acct', text: "Account(owner='ivor', balance=0.0)", source: 'locals' },
          { step: 40, file: 'example.py', fileId: 1, line: 33, function: '<module>', scopeId: 0, name: 'acct', source: 'assign' },
        ],
      },
    };
    const html = render(<VariablePane view={view} settings={{ ...DEFAULT_SETTINGS, recordLocals: true }} showFileName={false} onQuery={noop} onGoto={noop} onOpen={noop} onWhy={noop} onEnableRecordLocals={noop} onClose={noop} />);
    expect(html).toContain('data-tip="Why this value at #12"');
    expect(html).toContain('data-tip="Why this value at #40"');
    expect(html).toMatch(/pk-variable-row.*?data-tip="Why this value at #12"[^>]*><i class="codicon codicon-question"/);
  });
});
