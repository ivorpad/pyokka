/** The page's fakes for the unit tests: a code pane and a bridge link that record what they are handed, and one recorded run. */
import { PageHost, type CodeDecorations, type CodeView, type Link } from '../../web/pageHost';
import { packSteps } from '../../src/timeMachine/traceModel';
import type { BridgeFile, BridgeToPage, PageToBridge, RequestBody } from '../../web/bridgeProtocol';
import type { HostToWebview } from '../../src/shared/webviewProtocol';
import type { RunEvent, RunnerMessage } from '../../src/shared/protocol';

export const SOURCE = ['def add(a, b):', '    s = a + b', '    return s', '', 'x = add(1, 2)', 'print(x)'].join('\n');
export const MAIN: BridgeFile = { path: '/w/demo.py', displayName: 'demo.py', language: 'python', content: SOURCE };

export class FakeCode implements CodeView {
  shown: string | undefined;
  last: CodeDecorations | undefined;
  narration: { text: string; line: number } | null = null;
  revealed: number[] = [];
  cursor: number | undefined;
  files = new Map<string, BridgeFile>();
  showFile(file: BridgeFile): void {
    this.shown = file.path;
    this.files.set(file.path, file);
  }
  setMain(file: BridgeFile): void {
    this.showFile(file);
  }
  shownPath(): string | undefined {
    return this.shown;
  }
  render(d: CodeDecorations): void {
    this.last = d;
  }
  reveal(line: number): void {
    this.revealed.push(line);
  }
  setNarration(n: { text: string; line: number } | null): void {
    this.narration = n;
  }
  cursorLine(): number | undefined {
    return this.cursor;
  }
  expression: string | undefined;
  expressionAtCursor(): string | undefined {
    return this.expression;
  }
}

export class FakeLink implements Link {
  sent: PageToBridge[] = [];
  replies: RunnerMessage[] = [];
  send(msg: PageToBridge): void {
    this.sent.push(msg);
  }
  requests: RequestBody[] = [];
  debugRequests: RequestBody[] = [];
  request(body: RequestBody): Promise<RunnerMessage> {
    this.requests.push(body);
    return Promise.resolve(this.replies.shift() ?? { type: 'error', id: 0, message: 'none' });
  }
  debugRequest(body: RequestBody): Promise<RunnerMessage> {
    this.debugRequests.push(body);
    return Promise.resolve(this.replies.shift() ?? { type: 'error', id: 0, message: 'none' });
  }
}

export function b64(steps: Int32Array): string {
  return Buffer.from(steps.buffer).toString('base64');
}

/** A run of SOURCE: module (rids 0..), add's def header, its body, the print. */
export function runEvents(runId: string): RunEvent[] {
  // local ranges: 0 whole file, 1 def, 2 `s = a + b`, 3 `return s`, 4 `x = add(1, 2)`, 5 `print(x)`
  const ranges: [number, number, number, number][] = [[1, 0, 6, 8], [1, 0, 3, 12], [2, 4, 2, 13], [3, 4, 3, 12], [5, 0, 5, 13], [6, 0, 6, 8]];
  const steps = packSteps([[1, 0, 0], [4, 0, 0], [1, 1, 1, 4], [2, 1, 1], [3, 1, 1], [5, 0, 0]]);
  let seq = 0;
  const base = { runId };
  return [
    { ...base, seq: ++seq, type: 'run.started', pid: 1 },
    { ...base, seq: ++seq, type: 'file.instrumented', fileId: 1, path: MAIN.path, rangeBase: 0, ranges, statements: [1, 2, 3, 4, 5], functions: [{ rid: 1, name: 'add', bodyRange: [2, 4, 3, 12] }], magic: [] },
    { ...base, seq: ++seq, type: 'log', logId: 'l1', kind: 'log', fileId: 1, rid: 5, hit: 1, step: 5, text: '3', runtimeKey: 'k5' },
    { ...base, seq: ++seq, type: 'coverage', fileId: 1, states: [1, 1, 1, 1, 1, 1], hits: [1, 1, 1, 1, 1, 1] },
    { ...base, seq: ++seq, type: 'locals', entries: [{ step: 2, scopeId: 1, changes: [{ name: 'a', text: '1' }, { name: 'b', text: '2' }] }, { step: 4, scopeId: 1, changes: [{ name: 's', text: '3' }] }] },
    { ...base, seq: ++seq, type: 'trace', steps: b64(steps), scopes: [{ scopeId: 0, rid: 0, name: '<module>', parent: -1, depth: 0, first: 0, last: 5 }, { scopeId: 1, rid: 1, name: 'add', parent: 0, depth: 1, first: 2, last: 4, returned: '3' }], truncated: false },
    { ...base, seq: ++seq, type: 'run.finished', exitCode: 0, durationMs: 5, timedOut: false, stopped: false, stepCount: 6, logCount: 1 },
  ];
}

export function setup() {
  const code = new FakeCode();
  const link = new FakeLink();
  const panel: HostToWebview[] = [];
  const host = new PageHost(link, code, (m) => panel.push(m));
  const feed = (m: BridgeToPage) => host.onBridge(m);
  feed({ type: 'hello', file: MAIN, runtime: { command: 'fake', ready: null }, watch: true, canNarrate: false });
  host.onPanel({ type: 'ready' });
  feed({ type: 'run.begin', runId: 'w-1', content: SOURCE, reason: 'start' });
  for (const ev of runEvents('w-1')) feed({ type: 'event', event: ev });
  return { code, link, panel, host, feed };
}
