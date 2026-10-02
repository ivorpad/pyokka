/**
 * Preview harness for the Debugger view (docs/design/debugger-product.md, 5.1). It renders
 * `DebugSessionView` into `#root` with one of three fixture states, so the view can be judged as
 * pixels in a headless browser instead of as markup in a test. Never bundled into the extension:
 * `scripts/preview-debugger-view.mjs` builds it into a scratch directory, and `test/**` is in
 * `.vscodeignore`.
 *
 *   node scripts/preview-debugger-view.mjs     # build, write the pages, screenshot each state
 *
 * The state is the page's `?state=` (`paused`, `running`, `exception`).
 */
import { render } from 'preact';
import { DebugSessionView } from '../../webview/components/DebuggerView';
import type { DebugSessionPanel } from '../../src/shared/webviewProtocol';
import type { ValueBag, ValueNode } from '../../src/shared/protocol';

const noop = (): void => undefined;

function node(type: string, value: string | undefined, props?: { name: string; n: ValueNode }[], extra: Partial<ValueNode> = {}): ValueNode {
  const out: ValueNode = { type: type as ValueNode['type'], id: `${type}-${value ?? 'x'}`, queryPath: [], ...extra };
  if (value !== undefined) out.value = value;
  if (props) {
    out.props = props.map((p) => ({ ...p.n, name: p.name, expressionPath: p.name }));
    out.length = props.length;
  }
  return out;
}

function bag(data: ValueNode): ValueBag {
  return { data, runtimeKey: data.id };
}

/** The `request` local of the live session: a pydantic model with an expandable bag. */
const REQUEST = bag(
  node('RankRequest', undefined, [
    { name: 'rankings', n: node('list', undefined, [{ name: '0', n: node('list', '[3, 1, 2]') }, { name: '1', n: node('list', '[1, 3]') }]) },
    { name: 'k', n: node('number', '60') },
    { name: 'weights', n: node('None', 'None') },
  ]),
);

/** (a) paused at the breakpoint, exactly the session of the screenshot: `-m api.main`. */
export const PAUSED: DebugSessionPanel = {
  id: 'debug-1',
  displayName: '-m api.main',
  launch: { program: null, module: 'api.main', args: [], cwd: '.', python: '.venv/bin/python', record: false },
  launchTitle: '/path/to/project/.venv/bin/python -m api.main  ·  cwd /path/to/project',
  running: true,
  paused: true,
  record: false,
  modified: false,
  reason: 'breakpoint',
  reasonText: 'breakpoint',
  location: 'api/main.py:52',
  thread: { name: 'AnyIO worker thread', ident: 6108209152 },
  stack: [
    { frameId: 0, name: 'rank', file: 'api/main.py', line: 52 },
    { frameId: 1, name: 'run', file: 'anyio/_backends/_asyncio.py', line: 1100, library: true },
    { frameId: 2, name: '_bootstrap_inner', file: 'threading.py', line: 1082, library: true },
    { frameId: 3, name: '_bootstrap', file: 'threading.py', line: 1044, library: true },
  ],
  selectedFrame: 0,
  locals: [{ name: 'request', text: 'RankRequest(rankings=[[3, 1, 2], [1, 3]], k=60, weights=None)', valueBag: REQUEST }],
  watches: [{ id: 'w1', exp: 'len(request.rankings)', kind: 'breakWhen', breakWhen: 'true' }],
  output: [],
  outputOpen: null,
  outputSeq: 0,
  outputDropped: 0,
  elapsed: 0,
  lastOutputAt: null,
  breakpoints: [
    { file: 'api/main.py', line: 52, resolvedLine: 52, rid: 118 },
    { file: 'demo.py', line: 40 },
    { file: 'demo.py', line: 73 },
    { file: 'demo.py', line: 124 },
    { file: 'demo.py', line: 175 },
  ],
  files: ['api/main.py'],
  exceptions: 'uncaught',
  exception: null,
};

/** (b) running, with output arriving. */
export const RUNNING: DebugSessionPanel = {
  ...PAUSED,
  paused: false,
  // no pause, so no thread being served: the host only sends one while it is paused
  thread: undefined,
  reasonText: 'running',
  location: '',
  stack: [],
  locals: [],
  watches: [{ id: 'w1', exp: 'len(request.rankings)', kind: 'breakWhen', breakWhen: 'true' }],
  // uvicorn logs to stderr, which the pane now shows as its own stream; the gap and the open line
  // are what a server actually looks like between requests
  output: [
    { stream: 'stderr' as const, text: 'INFO:     Started server process [48213]\nINFO:     Waiting for application startup.\nINFO:     Application startup complete.\nINFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)\n', t: 240 },
    { stream: 'stderr' as const, text: 'INFO:     127.0.0.1:53114 - "POST /rank HTTP/1.1" 200 OK\n', t: 9_800 },
    { stream: 'stdout' as const, text: '\x1b[32mrank ok\x1b[0m k=60 weights=None\nscores: 3 documents\n  doc-a  0.0312\n  doc-b  0.0164\n  doc-c  0.0161\n', t: 9_820 },
    { stream: 'stderr' as const, text: 'INFO:     127.0.0.1:53118 - "POST /rank HTTP/1.1" 200 OK\n', t: 21_400 },
  ],
  outputOpen: { stream: 'stdout' as const, text: 'ranking 12 documents', t: 21_460 },
  outputSeq: 320,
  outputDropped: 0,
  elapsed: 28_900,
  lastOutputAt: 21_460,
};

/** (c) paused on an uncaught exception, after a console write. */
export const EXCEPTION: DebugSessionPanel = {
  ...PAUSED,
  modified: true,
  reason: 'exception',
  reasonText: 'uncaught ValueError: k must be positive',
  location: 'api/rrf.py:18',
  thread: { name: 'MainThread', ident: 1 },
  stack: [
    { frameId: 0, name: 'rrf', file: 'api/rrf.py', line: 18 },
    { frameId: 1, name: 'rank', file: 'api/main.py', line: 52 },
  ],
  locals: [
    { name: 'k', text: '0', valueBag: bag(node('number', '0')) },
    { name: 'rankings', text: '[[3, 1, 2], [1, 3]]', valueBag: bag(node('list', undefined, [{ name: '0', n: node('list', '[3, 1, 2]') }, { name: '1', n: node('list', '[1, 3]') }])) },
  ],
  watches: [
    { id: 'w1', exp: 'k', kind: 'display', text: '0' },
    { id: 'w2', exp: 'k > 0', kind: 'breakWhen', breakWhen: 'true' },
  ],
  output: [{ stream: 'stderr' as const, text: 'INFO:     127.0.0.1:53120 - "POST /rank HTTP/1.1" 500 Internal Server Error\n', t: 30_100 }],
  outputOpen: null,
  outputSeq: 76,
  outputDropped: 0,
  elapsed: 30_400,
  lastOutputAt: 30_100,
  exception: { type: 'ValueError', message: 'k must be positive', uncaught: true },
};

export const STATES: Record<string, DebugSessionPanel> = { paused: PAUSED, running: RUNNING, exception: EXCEPTION };

const query = new URLSearchParams(location.search);
const which = query.get('state') ?? 'paused';
const root = document.getElementById('root');
if (root) {
  render(
    <DebugSessionView state={STATES[which] ?? PAUSED} onOpen={noop} onWatchAdd={noop} onWatchRemove={noop} onBreakpointRemove={noop} onExceptions={noop} />,
    root,
  );
  // `?add=1` opens the watch add row, which is internal state: the page clicks the header's `+`
  if (query.get('add') === '1') {
    setTimeout(() => (document.querySelector('button[aria-label="Add a watch expression"]') as HTMLButtonElement | null)?.click(), 0);
  }
}
