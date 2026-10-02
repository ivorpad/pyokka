/** Rendered panel chrome: what the rail, the Time Machine toolbar, Settings and the entries pane show per state. */
import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import type { VNode } from 'preact';
import { DebugToolbar, NoSession, Rail, railMenuItems } from '../../../webview/components/Chrome';
import { HTTP_MODE_LABEL, httpModeItems, SettingsView, timeoutLabel } from '../../../webview/components/SettingsView';
import { Entries } from '../../../webview/components/Entries';
import { Walkthrough, activeMomentIndex } from '../../../webview/components/Walkthrough';
import { Exceptions } from '../../../webview/components/Exceptions';
import { VariablePane } from '../../../webview/components/VariablePane';
import { DEFAULT_SETTINGS } from '../../../webview/model';
import { DEFAULT_PREFS } from '../../../webview/vscode';
import type { DebuggerState, ExceptionsPanel, PanelMoment, VariableView, WalkthroughPanel } from '../../../src/shared/webviewProtocol';
import type { ExceptionRow } from '../../../src/session/exceptionReportTypes';

const noop = () => undefined;
const icons = (html: string): string[] => [...html.matchAll(/codicon-([a-z-]+)/g)].map((m) => m[1]!).filter((n) => !n.startsWith('modifier'));
const tips = (html: string): string[] => [...html.matchAll(/data-tip="([^"]+)"/g)].map((m) => m[1]!);

describe('Rail', () => {
  const rail = (over: Partial<Parameters<typeof Rail>[0]> = {}) => render(<Rail view="output" debuggerActive={false} running={false} onView={noop} onCommand={noop} {...over} />);

  it('has one Settings, at the bottom above More, and no session-settings menu', () => {
    const html = rail();
    expect(icons(html)).toEqual(['play', 'output', 'history', 'book', 'symbol-variable', 'globe', 'pulse', 'settings-gear', 'ellipsis']);
    expect(tips(html)).not.toContain('Session settings');
    expect(tips(html).at(-2)).toBe('Settings');
  });
  it('names every icon in a tooltip that is not a native title', () => {
    const html = rail();
    expect(html).not.toMatch(/ title="/);
    expect(tips(html)).toEqual(['Re-execute file (F5)', 'Show Output', 'Start Time Machine on the current line', 'View Code Story', 'Variable History', 'HTTP requests', 'Profile', 'Settings', 'More']);
  });
  it('highlights the Variable History button on its own view', () => {
    expect(rail({ view: 'variable' })).toMatch(/pk-icon-btn active"[^>]*data-tip="Variable History"/);
    expect(rail()).not.toMatch(/pk-icon-btn active"[^>]*data-tip="Variable History"/);
  });
  it('carries a badge on the HTTP button while recording or replaying, and highlights it on its view', () => {
    expect(rail()).not.toContain('pk-rail-badge');
    expect(rail({ http: 'off' })).not.toContain('pk-rail-badge');
    expect(rail({ http: 'record' })).toMatch(/pk-icon-btn pk-rail-badge mode-record"[^>]*data-tip="HTTP requests · recording the next run"/);
    expect(rail({ http: 'replay' })).toMatch(/pk-icon-btn pk-rail-badge mode-replay"[^>]*data-tip="HTTP requests · replaying from the recording"/);
    expect(rail({ view: 'http' })).toMatch(/pk-icon-btn active"[^>]*data-tip="HTTP requests"/);
    expect(rail({ view: 'http', http: 'record' })).toMatch(/pk-icon-btn active pk-rail-badge mode-record"/);
  });
  it('shows a spinning run button while a run is in flight', () => {
    const html = rail({ running: true });
    expect(html).toContain('codicon-loading codicon-modifier-spin');
    expect(tips(html)[0]).toMatch(/^Running/);
  });
  it('keeps the Time Machine icon while navigating and highlights it only on its own view', () => {
    const away = rail({ debuggerActive: true, view: 'output' });
    expect(icons(away)).toContain('history');
    expect(icons(away)).not.toContain('debug-stop');
    expect(tips(away)).toContain('Show Time Machine');
    expect(away).not.toMatch(/data-tip="Show Time Machine"[^>]*class="[^"]*active/);
    const home = rail({ debuggerActive: true, view: 'debugger' });
    expect(home).toMatch(/pk-icon-btn active"[^>]*data-tip="Show Time Machine"/);
  });
  it('offers the Execution Diagram from the More menu, switching the view locally', () => {
    const views: string[] = [];
    const commands: string[] = [];
    const items = railMenuItems((v) => views.push(v), (c) => commands.push(c));
    expect(items.map((i) => i.label)).toEqual(['Show Execution Diagram', 'View Recent Files', 'Show Instrumented File', 'Edit Session Settings', 'Show Pyokka Logs']);
    items[0]!.onSelect!();
    expect(views).toEqual(['run-diagram']);
    expect(commands).toEqual([]);
  });
});

describe('DebugToolbar', () => {
  const state: DebuggerState = { active: true, autoPlaying: false, currentStep: 3, canStep: { into: true, back: true, over: true, backOver: true, out: false, backOut: false }, echoSteps: [], showCallStack: false, codePreview: true, echo: true, watches: [] };
  it('closes the Time Machine; the red Stop is on the debug toolbar', () => {
    const html = render(<DebugToolbar state={state} session={{ name: 'a.py', running: false, runMode: 'auto' }} onAction={noop} onStop={noop} />);
    expect(html).not.toContain('codicon-debug-stop');
    expect(icons(html)).toEqual(['play', 'close']);
  });
  it('shows the execution diagram button between play and close when given the handler, lit on its view', () => {
    const html = render(<DebugToolbar state={state} session={{ name: 'a.py', running: false, runMode: 'auto' }} onAction={noop} onStop={noop} onShowDiagram={noop} />);
    expect(icons(html)).toEqual(['play', 'type-hierarchy', 'close']);
    expect(tips(html)).toEqual(['Auto play', 'Show execution diagram', 'Close the Time Machine']);
    expect(html).not.toMatch(/pk-icon-btn active"[^>]*data-tip="Show execution diagram"/);
    const shown = render(<DebugToolbar state={state} session={{ name: 'a.py', running: false, runMode: 'auto' }} onAction={noop} onStop={noop} onShowDiagram={noop} diagramShown />);
    expect(shown).toMatch(/pk-icon-btn active"[^>]*data-tip="Show execution diagram"/);
  });
  it('marks a run that answered HTTP from a recording after its duration', () => {
    const replayed = render(<DebugToolbar state={state} session={{ name: 'a.py', running: false, runMode: 'auto', durationMs: 250, replayed: true }} onAction={noop} onStop={noop} />);
    expect(replayed).toContain('pk-dim"> 250ms · replayed<');
    const live = render(<DebugToolbar state={state} session={{ name: 'a.py', running: false, runMode: 'auto', durationMs: 250 }} onAction={noop} onStop={noop} />);
    expect(live).toContain('pk-dim"> 250ms<');
    expect(live).not.toContain('replayed');
  });
});

describe('SettingsView', () => {
  it('lists every session setting, the run mode, and the save / reset / recent-files buttons', () => {
    const html = render(<SettingsView settings={{ ...DEFAULT_SETTINGS, runMode: 'onSave', libraryCode: true }} onUpdate={noop} onSaveDefaults={noop} onCommand={noop} />);
    for (const label of ['Auto Log All Values', 'Value Peek', 'Show Value On Selection', 'Show Last Displayed Value Only', 'Step Into Library Code', 'Mask Secrets', 'Record Variable Changes']) expect(html).toContain(label);
    expect(html).toContain('Run On save');
    expect(tips(html)).toEqual(['Save as defaults for new files', 'Reset to defaults', 'View Recent Files']);
    expect(html).toContain('apply immediately');
    expect(html).toContain('never saved');
  });
  it('offers the run timeout as a session value with the current limit on the button', () => {
    const html = render(<SettingsView settings={{ ...DEFAULT_SETTINGS, runTimeoutMs: 120_000 }} onUpdate={noop} onSaveDefaults={noop} onCommand={noop} />);
    expect(html).toContain('Run Timeout');
    expect(html).toContain('Timeout 2 min');
    expect(html).toContain('waiting on the network included');
  });
  it('labels timeouts in seconds, minutes or as no limit', () => {
    expect([30_000, 45_500, 60_000, 90_000, 600_000, 0].map(timeoutLabel)).toEqual(['30 s', '45.5 s', '1 min', '1.5 min', '10 min', 'No limit']);
  });
  it('offers the HTTP layer as a session value with the current mode on the button', () => {
    const html = render(<SettingsView settings={DEFAULT_SETTINGS} onUpdate={noop} onSaveDefaults={noop} onCommand={noop} />);
    expect(html).toContain('pk-settings-group">HTTP<');
    expect(html).toContain('HTTP Off');
    expect(html).toContain('without touching the network');
    expect(html).toContain('Both apply to the next run');
    expect(render(<SettingsView settings={{ ...DEFAULT_SETTINGS, http: 'replay' }} onUpdate={noop} onSaveDefaults={noop} onCommand={noop} />)).toContain('HTTP Replay');
    expect(Object.values(HTTP_MODE_LABEL)).toEqual(['HTTP Off', 'HTTP Record', 'HTTP Replay']);
  });
  it('shares the HTTP dropdown items with the HTTP view: one checked, selecting names the mode', () => {
    const picked: string[] = [];
    const items = httpModeItems('record', (m) => picked.push(m));
    expect(items.map((i) => i.label)).toEqual(['HTTP Off', 'HTTP Record', 'HTTP Replay']);
    expect(items.map((i) => i.checked)).toEqual([false, true, false]);
    items[2]!.onSelect!();
    expect(picked).toEqual(['replay']);
  });
});

describe('VariablePane', () => {
  const pane = (view: VariableView | null, recordLocals = false) =>
    render(<VariablePane view={view} settings={{ ...DEFAULT_SETTINGS, recordLocals }} showFileName={false} onQuery={noop} onGoto={noop} onOpen={noop} onWhy={noop} onEnableRecordLocals={noop} onClose={noop} />);
  const history: VariableView = {
    name: 'acct',
    history: {
      name: 'acct',
      total: 3,
      truncated: false,
      recordedLocals: true,
      changes: [
        { step: 12, file: 'example.py', fileId: 1, line: 24, function: '<module>', scopeId: 0, name: 'acct', text: "Account(owner='ivor', balance=0.0)", source: 'locals', reads: [{ name: 'Account', text: "<class 'Account'>", step: 3 }] },
        { step: 15, file: 'example.py', fileId: 1, line: 26, function: '<module>', scopeId: 0, name: 'acct.deposit(amount)', text: '50.0', source: 'value', logId: 'l-9', reads: [{ name: 'amount', text: '50', step: 14 }, { name: 'acct' }] },
        { step: 40, file: 'example.py', fileId: 1, line: 33, function: '<module>', scopeId: 0, name: 'acct', source: 'assign', unchanged: false },
      ],
    },
  };
  it('prompts for a name and offers to record locals when the session does not', () => {
    const html = pane(null);
    expect(html).toContain('VARIABLE');
    expect(html).toContain('placeholder="Variable name: dt, self.balance, r.output_parsed.date"');
    expect(html).toContain('Show Variable History');
    expect(html).toContain('Record Variable Changes');
    expect(pane(null, true)).not.toContain('Record Variable Changes');
  });
  it('lists every change with its step, statement, value and what the statement read', () => {
    const html = pane(history, true);
    expect(html).toContain('pk-count">3<');
    expect(html).toMatch(/pk-variable-step">#12<.*pk-variable-name">acct<\/span> = <span class="pk-repr">.*tk-type">Account<.*tk-name">owner<.*pk-variable-fn">&lt;module><.*>24:1</);
    expect(html).toMatch(/title="Time Machine to step 12"/);
    expect(html).toMatch(/pk-variable-read"[^>]*title="History of Account"/);
    expect(html).toContain('acct.deposit(amount)');
    expect(html).toContain('assigned here (value not recorded)');
    expect(html).toMatch(/pk-variable-name">acct<\/span><span class="pk-dim"> = \?</);
  });
  it('says when it is looking a name up, when nothing was recorded, and when the host has no run', () => {
    expect(pane({ name: 'dt', history: null })).toContain('LOOKING UP dt…');
    expect(pane({ name: 'dt', history: { name: 'dt', changes: [], total: 0, truncated: false, recordedLocals: false } })).toMatch(/No recorded change of <code>dt<\/code>.*Record Variable Changes captures/);
    expect(pane({ name: 'dt', history: null, error: 'No run yet: run the file first (save, or Re-execute).' })).toMatch(/pk-notice" role="status".*No run yet/);
  });
  it('marks values a statement left unchanged', () => {
    const view: VariableView = { ...history, history: { ...history.history!, changes: [{ ...history.history!.changes[2]!, text: 'None', unchanged: true }] } };
    expect(pane(view, true)).toMatch(/None.*\(unchanged\)/);
  });
});

describe('Entries', () => {
  const entries = (emptyText?: string) =>
    render(<Entries entries={[]} allEntries={[]} hiddenLines={new Set()} filterMode={false} selection={{ ids: [], anchor: null }} prefs={DEFAULT_PREFS} onSelect={noop} onPrefs={noop} onFilter={noop} onFilterToggle={noop} onFilterMode={noop} onOpen={noop} onWhy={noop} onFocusDetails={noop} onCopy={noop} emptyText={emptyText} />);
  it('says RUNNING… while a run is in flight and NO LOGS OR ERRORS otherwise', () => {
    expect(entries('RUNNING…')).toContain('RUNNING…');
    expect(entries()).toContain('NO LOGS OR ERRORS');
  });
  it('shows a run notice above the list only when given one', () => {
    const html = render(<Entries entries={[]} allEntries={[]} hiddenLines={new Set()} filterMode={false} selection={{ ids: [], anchor: null }} prefs={DEFAULT_PREFS} onSelect={noop} onPrefs={noop} onFilter={noop} onFilterToggle={noop} onFilterMode={noop} onOpen={noop} onWhy={noop} onFocusDetails={noop} onCopy={noop} notice="Run timed out after 30 s" />);
    expect(html).toMatch(/pk-notice" role="status".*codicon-warning.*Run timed out after 30 s/);
    expect(entries()).not.toContain('pk-notice');
  });
});

describe('Walkthrough', () => {
  const moment = (over: Partial<PanelMoment>): PanelMoment => ({ id: 'm0', kind: 'call', step: 9, fileId: 1, file: 'demo.py', line: 82, function: '<module>', text: 'call to Point.__init__ from <module>', values: [], gloss: null, ...over });
  const model = (over: Partial<WalkthroughPanel> = {}): WalkthroughPanel => ({
    runId: 'r-1',
    count: 53,
    total: 3,
    shown: 3,
    truncated: false,
    narrating: false,
    canNarrate: true,
    moments: [
      moment({ id: 'm0', kind: 'start', step: 0, line: 8, text: 'module demo.py starts' }),
      moment({ id: 'm1', values: [{ role: 'in', name: 'x', text: '5' }, { role: 'in', name: 'y', text: '10' }] }),
      moment({ id: 'm2', kind: 'error', step: 52, line: 96, text: 'raised ValueError: Kaboom! uncaught' }),
    ],
    ...over,
  });
  const walk = (m: WalkthroughPanel | null, currentStep: number | null = null, open = true) => render(<Walkthrough model={m} currentStep={currentStep} open={open} onToggle={noop} onGoto={noop} onNarrate={noop} onOpen={noop} />);

  it('lists every moment with its step, sentence, values and gloss, and offers Narrate', () => {
    const html = walk(model());
    expect(html).toContain('WALKTHROUGH');
    expect(html).toMatch(/pk-count">3</);
    expect(html).toMatch(/data-step="9"[^>]*class="pk-moment kind-call"/);
    expect(html).toMatch(/pk-moment-step">#9<.*pk-moment-sentence">call to Point\.__init__ from &lt;module></);
    expect(html).toMatch(/pk-moment-role">in<\/span> <span class="pk-repr">.*?tk-name">x<.*?tk-num">5</);
    expect(html).toContain('pk-moment-sentence">raised ValueError: Kaboom! uncaught<');
    expect(html).not.toContain('pk-moment-gloss');
    const glossed = walk(model({ moments: [moment({ gloss: 'builds the first point' })] }));
    expect(glossed).toContain('pk-moment-gloss">builds the first point<');
    expect(tips(glossed)).toEqual(['Narrated (one model call per run)']);
    expect(tips(html)).toEqual(['Narrate: one model call adds a sentence per moment']);
    expect(html).toContain('codicon-sparkle');
    expect(html).not.toContain('disabled');
  });
  it('follows the Time Machine: the moment at the current step is active, earlier ones dim', () => {
    const m = model();
    expect(activeMomentIndex(m.moments, null)).toBe(-1);
    expect(activeMomentIndex(m.moments, 30)).toBe(1);
    expect(activeMomentIndex(m.moments, 52)).toBe(2);
    const html = walk(m, 30);
    expect(html).toMatch(/data-step="0"[^>]*class="pk-moment kind-start past"/);
    expect(html).toMatch(/data-step="9"[^>]*class="pk-moment kind-call active"/);
    expect(html).toMatch(/data-step="52"[^>]*class="pk-moment kind-error"/);
    expect(walk(m, null)).not.toContain(' past');
  });
  it('says NO RUN YET without a run, spins while narrating, and shows a narration error once', () => {
    expect(walk(null)).toContain('NO RUN YET');
    expect(tips(walk(null))).toEqual(['Narrate: run the file first']);
    const busy = walk(model({ narrating: true }));
    expect(busy).toContain('codicon-modifier-spin');
    expect(busy).toContain('disabled');
    expect(tips(busy)).toEqual(['Narrating… (one model call)']);
    const failed = walk(model({ narrationError: 'claude is not on the PATH' }));
    expect(failed).toMatch(/pk-notice pk-walkthrough-error" role="status".*Narration failed: claude is not on the PATH/);
    expect(tips(walk(model({ canNarrate: false })))).toEqual(['Narrate: install claude or codex, set pyokka.explain.command, or sign in to Copilot']);
  });
  it('collapses to its header and shows the cap', () => {
    const closed = walk(model(), null, false);
    expect(closed).toContain('collapsed');
    expect(closed).not.toContain('pk-moment ');
    expect(closed).toContain('codicon-chevron-right');
    const capped = walk(model({ total: 900, shown: 400, truncated: true, moments: [moment({ more: 12 })] }));
    expect(capped).toMatch(/pk-count">400 of 900</);
    expect(capped).toContain('≡ 12 more like this');
    expect(capped).toContain('… 500 more moments');
  });
});

describe('Exceptions', () => {
  const row = (over: Partial<ExceptionRow>): ExceptionRow => ({ id: 'x0', kind: 'caught', errorType: 'KeyError', message: "'b'", count: 1, step: 31, lastStep: 31, raisedAt: { file: 'main.py', line: 21, function: 'lookup', fileId: 1, rid: 12 }, handledAt: { file: 'main.py', line: 68, function: '<module>', fileId: 1, rid: 40, broad: false }, ...over });
  const uncaught = row({ id: 'x0', kind: 'uncaught', errorType: 'ZeroDivisionError', message: 'division by zero', step: 410, lastStep: 410, raisedAt: { file: 'main.py', line: 92, function: '<module>', fileId: 1, rid: 60 }, handledAt: null });
  const broad = row({ id: 'x1', count: 3, lastStep: 47, handledAt: { file: 'main.py', line: 68, function: '<module>', fileId: 1, rid: 40, broad: true } });
  const outside = row({ id: 'x2', errorType: 'AttributeError', message: 'x', count: 2, step: 300, lastStep: 301, raisedAt: { file: 'main.py', line: 88, function: '__getattr__', fileId: 1, rid: 55 }, handledAt: null });
  const model = (rows: ExceptionRow[]): ExceptionsPanel => ({ runId: 'r-1', count: 412, file: 'main.py', exitCode: 1, stale: false, staleFiles: [], total: rows.length, raises: rows.reduce((n, r) => n + r.count, 0), uncaught: rows.filter((r) => r.kind === 'uncaught').length, caught: rows.filter((r) => r.kind === 'caught').length, broad: rows.filter((r) => r.handledAt?.broad).length, rows });
  const pane = (m: ExceptionsPanel | null, open = true) => render(<Exceptions model={m} open={open} onToggle={noop} onGoto={noop} onOpen={noop} />);

  it('lists the uncaught row like an error entry and a caught row with its count, handler and the broad badge', () => {
    const html = pane(model([uncaught, broad]));
    expect(html).toContain('EXCEPTIONS');
    expect(html).toMatch(/pk-count">2</);
    expect(icons(html)).toEqual(['chevron-down', 'error', 'warning']);
    expect(html).toMatch(/data-step="410"[^>]*class="pk-moment pk-exception kind-uncaught"[^>]*title="Step 410 · main\.py:92 · click to move the Time Machine here"/);
    expect(html).toMatch(/pk-moment-step">#410<.*pk-exception-type">ZeroDivisionError<\/span>: <span class="pk-error-text pk-exception-message">division by zero</);
    expect(html).toMatch(/raised <a href="#" class="pk-exception-loc">main\.py:92<\/a> <span class="pk-exception-fn">&lt;module><\/span> · uncaught</);
    expect(html).toMatch(/data-step="31"[^>]*class="pk-moment pk-exception kind-caught broad"/);
    expect(html).toMatch(/pk-exception-type">KeyError<\/span>: <span class="pk-error-text pk-exception-message">'b'<\/span><span class="pk-exception-count">×3</);
    expect(html).toMatch(/raised <a href="#" class="pk-exception-loc">main\.py:21<\/a> <span class="pk-exception-fn">lookup<\/span> · caught <a href="#" class="pk-exception-loc">main\.py:68<\/a> <span class="pk-exception-fn">&lt;module><\/span><span class="pk-badge">broad handler</);
    expect(html).not.toContain('pk-exception-count">×1');
  });
  it('says when a caught exception was handled outside stepped code, with the pass icon for specific handlers', () => {
    const html = pane(model([outside, row({})]));
    expect(icons(html)).toEqual(['chevron-down', 'pass', 'pass']);
    expect(html).toMatch(/pk-exception-fn">__getattr__<\/span> · caught outside stepped code</);
    expect(html).not.toContain('pk-badge');
    expect(html).toMatch(/×2/);
  });
  it('shows NO RUN YET without a report and NO EXCEPTIONS for a clean run, counting rows in the header only with a report', () => {
    const none = pane(null);
    expect(none).toContain('NO RUN YET');
    expect(none).not.toContain('pk-count');
    const clean = pane(model([]));
    expect(clean).toContain('NO EXCEPTIONS');
    expect(clean).toMatch(/pk-count">0</);
    expect(clean).not.toContain('pk-exception ');
  });
  it('collapses to its header', () => {
    const closed = pane(model([uncaught, broad]), false);
    expect(closed).toContain('pk-exceptions collapsed');
    expect(closed).toMatch(/pk-count">2</);
    expect(icons(closed)).toEqual(['chevron-right']);
    expect(closed).not.toContain('pk-exception ');
    expect(closed).not.toContain('NO RUN YET');
  });
});

describe('NoSession', () => {
  it('offers Start and Debug on the current file, running the existing commands', () => {
    const html = render(<NoSession onCommand={noop} />);
    expect(html).toContain('Start on current file');
    expect(html).toContain('Debug current file');
    const ran: string[] = [];
    type Node = VNode<{ children?: Node[]; onClick?: () => void }>;
    const walk = (n: Node): void => {
      n.props.onClick?.();
      for (const c of [n.props.children ?? []].flat()) if (c && typeof c === 'object') walk(c as Node);
    };
    walk(NoSession({ onCommand: (c) => ran.push(c) }) as Node);
    expect(ran).toEqual(['pyokka.startOnCurrentFile', 'pyokka.debugCurrentFile']);
  });
});
