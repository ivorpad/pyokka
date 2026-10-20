import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BridgeServer, LOG_PATH, languageFor, parseCtl, pickConfig, pickWatches, runConfig, runtimeCommand, sameOrigin, splitCommand } from '../../web/server';
import { ServerViews } from '../../web/serverViews';
import { applyEvent, emptyRun } from '../../web/runState';
import { packSteps } from '../../src/timeMachine/traceModel';
import type { RunEvent } from '../../src/shared/protocol';
import { decodeFrames, encodeFrame } from '../../web/ws';
import type { BridgeToPage } from '../../web/bridgeProtocol';
import * as pathShim from '../../web/pathShim';
import { runtimeLabelText } from '../../web/pageHost';
import { staleBuild } from '../../web/pageBuild';

const fake = path.join(__dirname, 'fixtures', 'fakeRunner.cjs');

describe('web bridge helpers', () => {
  it('splits a runtime command line, keeping quoted parts whole', () => {
    expect(splitCommand('"/a b/python3" -m pyokka_runtime serve')).toEqual(['/a b/python3', '-m', 'pyokka_runtime', 'serve']);
    expect(splitCommand("uv run 'x y.py'")).toEqual(['uv', 'run', 'x y.py']);
  });

  it('runs the Python runtime from dist/python, and any other command as given', () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'pkw-'));
    fs.mkdirSync(path.join(dist, 'python', 'pyokka_runtime'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'python', 'pyokka_runtime', '__main__.py'), '');
    const py = runtimeCommand({ runtime: 'python', python: 'python3.12', distDir: dist, file: '/w/a.py' });
    expect(py).toEqual({ command: 'python3.12', args: ['-m', 'pyokka_runtime', 'serve'], cwd: path.join(dist, 'python'), env: { PYTHONPATH: path.join(dist, 'python') } });
    const other = runtimeCommand({ runtime: 'uv run python -m pyokka_runtime serve', python: 'python3', distDir: dist, file: '/w/a.py' });
    expect(other).toEqual({ command: 'uv', args: ['run', 'python', '-m', 'pyokka_runtime', 'serve'], cwd: '/w', env: {} });
  });

  it('labels the runtime with its Python version', () => {
    expect(runtimeLabelText(null)).toBe('starting…');
    expect(runtimeLabelText({ pythonVersion: '3.13.1 (main)', capabilities: [] })).toBe('Python 3.13.1');
  });

  it('names the Monaco language from the extension', () => {
    expect(languageFor('/a/b.py')).toBe('python');
    expect(languageFor('/a/b.mjs')).toBe('javascript');
    expect(languageFor('/a/b.tsx')).toBe('typescript');
    expect(languageFor('/a/b.rb')).toBe('plaintext');
  });

  it('accepts only its own Host and Origin', () => {
    expect(sameOrigin({ host: '127.0.0.1:4777' }, 4777)).toBe(true);
    expect(sameOrigin({ host: 'localhost:4777', origin: 'http://127.0.0.1:4777' }, 4777)).toBe(true);
    expect(sameOrigin({ host: '127.0.0.1:4777', origin: 'https://evil.example' }, 4777)).toBe(false);
    expect(sameOrigin({ host: 'evil.example:4777' }, 4777)).toBe(false); // DNS rebinding
    expect(sameOrigin({ host: '127.0.0.1:4777', origin: 'http://127.0.0.1:9999' }, 4777)).toBe(false);
    expect(sameOrigin({ host: '127.0.0.1:4777', origin: 'null' }, 4777)).toBe(false);
  });

  it('keeps only the run settings a page may change', () => {
    expect(pickConfig({ autoLog: true, timeoutMs: -1, http: 'nope' as never, maskSecrets: false, ...({ plugins: ['x'] } as object) })).toEqual({ autoLog: true, maskSecrets: false });
    const c = runConfig({ maskSecrets: false, timeoutMs: 0 });
    expect(c.recordLocals).toBe(true);
    expect(c.secrets).toEqual({ mask: false, names: [] });
    expect(c.timeoutMs).toBe(0);
  });

  it('parses ctl commands', () => {
    expect(parseCtl(['goto', '12', '--say', 'here'])).toEqual({ action: 'goto', step: 12, say: 'here' });
    expect(parseCtl(['step', 'backOver'])).toEqual({ action: 'step', kind: 'backOver' });
    expect(parseCtl(['say', 'two', 'words', '--line', '4'])).toEqual({ action: 'say', text: 'two words', line: 4 });
    expect(parseCtl(['eval', 'len(xs)'])).toEqual({ action: 'eval', expression: 'len(xs)' });
    expect(() => parseCtl(['goto', 'x'])).toThrow(/whole number/);
    expect(() => parseCtl(['step', 'sideways'])).toThrow(/unknown step kind/);
    expect(() => parseCtl(['dance'])).toThrow(/unknown command/);
    expect(parseCtl(['var', 'total'])).toEqual({ action: 'var', name: 'total' });
    expect(parseCtl(['why', 'total', '--step', '7'])).toEqual({ action: 'why', name: 'total', step: 7 });
    expect(parseCtl(['watch', 'a', '+', 'b'])).toEqual({ action: 'watch', exp: 'a + b' });
    expect(parseCtl(['watch', 'a', '--remove'])).toEqual({ action: 'watch', exp: 'a', remove: true });
    expect(parseCtl(['scratchpad', 'say', 'reads', 'the', 'cart', '--line', '3'])).toEqual({ action: 'scratchpad', op: 'say', line: 3, text: 'reads the cart' });
    expect(parseCtl(['scratchpad', 'say'])).toEqual({ action: 'scratchpad', op: 'say', text: '' });
    expect(parseCtl(['break', '12', 'off'])).toEqual({ action: 'breakpoint', line: 12, on: false });
    expect(parseCtl(['break', '12', '--if', 'i > 2'])).toEqual({ action: 'breakpoint', line: 12, condition: 'i > 2' });
    expect(parseCtl(['debug', 'step', 'into', '--say', 'in we go'])).toEqual({ action: 'debug', op: 'step', kind: 'into', say: 'in we go' });
    expect(parseCtl(['debug', 'step'])).toEqual({ action: 'debug', op: 'step', kind: 'over' });
    expect(parseCtl(['debug', 'start'])).toEqual({ action: 'debug', op: 'start' });
    expect(() => parseCtl(['debug', 'fly'])).toThrow(/unknown debug op/);
    expect(parseCtl(['story'])).toEqual({ action: 'story' });
    expect(parseCtl(['profile'])).toEqual({ action: 'profile' });
  });

  it('keeps only well-formed watch requests from a page', () => {
    expect(pickWatches([{ id: 'w1', exp: 'x', range: [1, 2, 3, 4] }, { id: 2, exp: 'y' }, null, 'z'])).toEqual([{ id: 'w1', exp: 'x' }]);
    expect(pickWatches('nope')).toEqual([]);
  });

  it('round-trips WebSocket frames, masked and of every length class', () => {
    for (const size of [0, 5, 125, 126, 70_000]) {
      const payload = Buffer.alloc(size, 'a');
      const { frames, rest } = decodeFrames(encodeFrame(0x1, payload));
      expect(rest.length).toBe(0);
      expect(frames[0]!.payload.equals(payload)).toBe(true);
    }
    // a masked client frame split across two chunks
    const mask = Buffer.from([1, 2, 3, 4]);
    const text = Buffer.from('hello');
    const masked = Buffer.from(text.map((b, i) => b ^ mask[i & 3]!));
    const frame = Buffer.concat([Buffer.from([0x81, 0x80 | text.length]), mask, masked]);
    expect(decodeFrames(frame.subarray(0, 4)).frames).toEqual([]);
    expect(decodeFrames(frame).frames[0]!.payload.toString()).toBe('hello');
  });

  it('shims the node:path calls the walkthrough builders make', () => {
    expect(pathShim.resolve('/a/b', '../c', './d')).toBe('/a/c/d');
    expect(pathShim.basename('/a/b/__init__.py')).toBe('__init__.py');
    expect(pathShim.dirname('/a/b/c.py')).toBe('/a/b');
    expect(pathShim.dirname('/c.py')).toBe('/');
  });
});

/** A finished one-statement run of `x = 1` in /w/main.py, folded as the bridge folds it. */
function finishedRun() {
  const run = emptyRun('w-1', 'x = 1\n');
  const events: RunEvent[] = [
    { runId: 'w-1', seq: 1, type: 'file.instrumented', fileId: 1, path: '/w/main.py', rangeBase: 0, ranges: [[1, 0, 1, 5], [1, 0, 1, 5]], statements: [1], functions: [], magic: [] },
    { runId: 'w-1', seq: 2, type: 'trace', steps: Buffer.from(packSteps([[1, 0, 0]]).buffer).toString('base64'), scopes: [{ scopeId: 0, rid: 0, name: '<module>', parent: -1, depth: 0, first: 0, last: 0 }], truncated: false },
    { runId: 'w-1', seq: 3, type: 'locals', entries: [{ step: 0, scopeId: 0, changes: [{ name: 'x', text: '1' }] }] },
    { runId: 'w-1', seq: 4, type: 'run.finished', exitCode: 0, durationMs: 1, timedOut: false, stopped: false, stepCount: 1, logCount: 0 },
  ] as RunEvent[];
  for (const ev of events) expect(applyEvent(run, ev)).toBe(true);
  return run;
}

describe('ServerViews', () => {
  it('narrates the walkthrough with one model call and answers the glosses', async () => {
    const run = finishedRun();
    const sent: unknown[] = [];
    let prompt = '';
    const views = new ServerViews({ distDir: path.join(__dirname, '..', '..', 'dist'), python: 'python3', ask: async (p) => ((prompt = p), JSON.stringify({ m0: 'the module starts' })) }, () => ({ run, mainPath: '/w/main.py' }), (m) => sent.push(m));
    expect(views.canNarrate()).toBe(true);
    await views.narrate();
    expect(prompt.length).toBeGreaterThan(0);
    expect(sent).toEqual([{ type: 'narration', narration: { runId: 'w-1', narrating: true } }, { type: 'narration', narration: { runId: 'w-1', narrating: false, glosses: { m0: 'the module starts' } } }]);
    expect(views.replay('w-1')).toEqual([sent[1]]);
    views.reset();
    expect(views.replay('w-1')).toEqual([]);
  });

  it('runs the tour command over the run saved as a run.json', async () => {
    const run = finishedRun();
    const sent: { type: string; tour?: { status: string; doc?: unknown; error?: string } }[] = [];
    let saved: { meta: { file: string }; events: { type: string }[] } | undefined;
    const tourCli = async (_o: unknown, argv: string[]) => {
      saved = JSON.parse(fs.readFileSync(argv[1]!, 'utf8'));
      return { tour: 1, run: { file: '/w/main.py', steps: 1, exitCode: 0, durationMs: 1, http: 0, llm: 0 }, goal: { kind: 'end', step: 0, text: '' }, small: true, budget: { tokens: 0, estimate: 0, found: 0, kept: 0, dropped: 0 }, chapters: [], candidates: [] };
    };
    const views = new ServerViews({ distDir: '/nowhere', python: 'python3', tourCli: tourCli as never }, () => ({ run, mainPath: '/w/main.py' }), (m) => sent.push(m as never));
    await views.computeTour();
    expect(saved?.meta.file).toBe('/w/main.py');
    expect(saved?.events.map((e) => e.type)).toEqual(['file.instrumented', 'locals', 'trace', 'run.finished']);
    expect(sent.map((m) => m.tour?.status)).toEqual(['computing', 'ready']);
    views.dispose();
  });
});

describe('BridgeServer', () => {
  let server: BridgeServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function start(runtime = fake): Promise<{ url: string; port: number; file: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkw-'));
    const file = path.join(dir, 'scratch.py');
    fs.writeFileSync(file, 'print("ok")\n');
    server = new BridgeServer({ file, port: 0, host: '127.0.0.1', runtime: `"${process.execPath}" "${runtime}"`, python: 'python3', watch: false, open: false, distDir: dir, stateDir: dir });
    await server.start();
    const port = Number(new URL(server.url).port);
    return { url: server.url, port, file };
  }

  function connect(port: number): Promise<{ ws: WebSocket; messages: BridgeToPage[]; next: (pred: (m: BridgeToPage) => boolean) => Promise<BridgeToPage> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const messages: BridgeToPage[] = [];
      const waiters: [(m: BridgeToPage) => boolean, (m: BridgeToPage) => void][] = [];
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data)) as BridgeToPage;
        messages.push(m);
        for (const w of [...waiters]) if (w[0](m)) {
          waiters.splice(waiters.indexOf(w), 1);
          w[1](m);
        }
      };
      const next = (pred: (m: BridgeToPage) => boolean) =>
        new Promise<BridgeToPage>((res) => {
          const hit = messages.find(pred);
          if (hit) res(hit);
          else waiters.push([pred, res]);
        });
      ws.onopen = () => resolve({ ws, messages, next });
      ws.onerror = () => reject(new Error('websocket failed'));
    });
  }

  it('echoes a requested run token without carrying it into later runs or replay', async () => {
    const { port } = await start();
    const page = await connect(port);
    await page.next((m) => m.type === 'event' && m.event.type === 'run.finished');
    page.ws.send(JSON.stringify({ type: 'run', requestId: 'page-request-1', content: 'print("requested")\n' }));
    const begin = await page.next((m) => m.type === 'run.begin' && m.runId === 'w-2');
    expect(begin).toMatchObject({ requestId: 'page-request-1', runId: 'w-2', reason: 'page' });
    await page.next((m) => m.type === 'event' && m.event.runId === 'w-2' && m.event.type === 'run.finished');

    const late = await connect(port);
    expect(await late.next((m) => m.type === 'run.begin')).not.toHaveProperty('requestId');
    page.ws.send(JSON.stringify({ type: 'config', patch: { autoLog: false } }));
    expect(await page.next((m) => m.type === 'run.begin' && m.runId === 'w-3')).not.toHaveProperty('requestId');
    await page.next((m) => m.type === 'event' && m.event.runId === 'w-3' && m.event.type === 'run.finished');
    await server!.run('disk');
    expect(await page.next((m) => m.type === 'run.begin' && m.runId === 'w-4')).not.toHaveProperty('requestId');
    await page.next((m) => m.type === 'event' && m.event.runId === 'w-4' && m.event.type === 'run.finished');
    page.ws.send(JSON.stringify({ type: 'run' }));
    expect(await page.next((m) => m.type === 'run.begin' && m.runId === 'w-5')).not.toHaveProperty('requestId');
    page.ws.close();
    late.ws.close();
  });

  it('identifies a refused launch by request token while retaining legacy runner errors', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkw-refuse-'));
    const runtime = path.join(dir, 'refuse.cjs');
    // Keep the real runner transport; this runtime refuses each run at its acknowledgment.
    fs.writeFileSync(runtime, `const readline = require('node:readline');
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.type === 'hello') send({ type: 'ready', id: m.id, capabilities: [] });
  else if (m.type === 'run') send({ type: 'error', id: m.id, message: 'launch refused' });
  else if (m.type === 'shutdown') process.exit(0);
  else send({ type: 'ok', id: m.id });
});`);
    const { port } = await start(runtime);
    const page = await connect(port);
    await page.next((m) => m.type === 'runner.error');
    page.ws.send(JSON.stringify({ type: 'run', requestId: 'failed-request' }));
    await page.next((m) => m.type === 'run.begin' && m.runId === 'w-2');
    // A round-trip request also ensures the launch failure messages reached the page.
    page.ws.send(JSON.stringify({ type: 'request', id: 17, body: { type: 'expand', runId: 'w-2', valueId: 'v1', queryPath: [] } }));
    await page.next((m) => m.type === 'reply' && m.id === 17);
    expect(page.messages).toContainEqual({ type: 'run.error', requestId: 'failed-request', runId: 'w-2', message: 'launch refused' });
    expect(page.messages.filter((m) => m.type === 'runner.error')).toHaveLength(2);
    expect(page.messages.filter((m) => m.type === 'run.error')).toHaveLength(1);
    page.ws.close();
  });

  it('identifies a requested launch held back by the live debugger without beginning it', async () => {
    const { port } = await start();
    const page = await connect(port);
    await page.next((m) => m.type === 'event' && m.event.type === 'run.finished');
    page.ws.send(JSON.stringify({ type: 'debug.start', breakpoints: [], exceptions: 'uncaught' }));
    await page.next((m) => m.type === 'debug.event' && m.event.type === 'debug.paused');
    await server!.run('settings', undefined, 'held-request');
    expect(await page.next((m) => m.type === 'run.error')).toEqual({ type: 'run.error', requestId: 'held-request', message: expect.stringMatching(/live debug run is active/) });
    expect(page.messages.filter((m) => m.type === 'run.begin')).toHaveLength(1);
    page.ws.close();
  });

  it('relays a run of any runtime to the page, replies to requests, and refuses other origins', async () => {
    const { port, file } = await start();
    const page = await connect(port);
    const hello = await page.next((m) => m.type === 'hello');
    expect(hello).toMatchObject({ type: 'hello', file: { path: file, language: 'python', content: 'print("ok")\n' } });
    const log = await page.next((m) => m.type === 'event' && m.event.type === 'log');
    expect(log).toMatchObject({ event: { text: 'ok', runId: 'w-1' } });
    await page.next((m) => m.type === 'event' && m.event.type === 'run.finished');

    // a host request is relayed with the page's own id; an error reply comes back as data
    page.ws.send(JSON.stringify({ type: 'request', id: 7, body: { type: 'expand', runId: 'w-1', valueId: 'v1', queryPath: [] } }));
    const reply = await page.next((m) => m.type === 'reply' && m.id === 7);
    expect(reply).toMatchObject({ reply: { type: 'error', message: 'no such value' } });

    // a page that connects late gets the run so far
    const late = await connect(port);
    await late.next((m) => m.type === 'event' && m.event.type === 'run.finished');
    expect(late.messages.map((m) => m.type).slice(0, 2)).toEqual(['hello', 'run.begin']);

    // an edit from the page runs the buffer, unsaved
    page.ws.send(JSON.stringify({ type: 'run', content: 'print("edited")\n' }));
    const begin = await page.next((m) => m.type === 'run.begin' && m.runId === 'w-2');
    expect(begin).toMatchObject({ content: 'print("edited")\n', reason: 'page' });
    expect(fs.readFileSync(file, 'utf8')).toBe('print("ok")\n');

    // a page cannot read a file the run did not instrument
    page.ws.send(JSON.stringify({ type: 'file.read', path: '/etc/passwd' }));

    // another site's page is refused the socket and the API
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    const post = await fetch(`http://127.0.0.1:${port}/api/command`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"action":"run"}' });
    expect(post.status).toBe(415);
    expect(page.messages.some((m) => m.type === 'file' && m.file.path === '/etc/passwd')).toBe(false);
    page.ws.close();
    late.ws.close();
  });

  it('runs the live debugger on a runtime of its own and keeps the watches for later runs', async () => {
    const { port } = await start();
    const page = await connect(port);
    await page.next((m) => m.type === 'event' && m.event.type === 'run.finished');
    page.ws.send(JSON.stringify({ type: 'debug.start', breakpoints: [{ path: '/x.py', line: 2 }], exceptions: 'uncaught' }));
    const begin = (await page.next((m) => m.type === 'debug.begin')) as Extract<BridgeToPage, { type: 'debug.begin' }>;
    await page.next((m) => m.type === 'debug.event' && m.event.type === 'debug.paused');
    page.ws.send(JSON.stringify({ type: 'debug.request', id: 7, body: { type: 'debug', runId: begin.runId, action: 'continue' } }));
    const reply = (await page.next((m) => m.type === 'reply' && m.id === 7)) as Extract<BridgeToPage, { type: 'reply' }>;
    expect(reply.reply.type).toBe('debug.result');
    await page.next((m) => m.type === 'debug.end');
    // a run with watches answers them, and the next run (a save, a settings change) keeps them
    page.ws.send(JSON.stringify({ type: 'run', watch: [{ id: 'w1', exp: 'x' }], traceContext: { step: 3, prefetch: 10 } }));
    const w = (await page.next((m) => m.type === 'event' && m.event.type === 'watch')) as Extract<BridgeToPage, { type: 'event' }>;
    expect(w.event).toMatchObject({ watchId: 'w1', step: 3 });
    page.ws.close();
  });

  it('hands an agent command to the open page and returns its answer', async () => {
    const { port } = await start();
    const none = await fetch(`http://127.0.0.1:${port}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'goto', step: 3 }) });
    expect(none.status).toBe(409);
    expect(((await none.json()) as { error: string }).error).toMatch(/no page is open/);

    const page = await connect(port);
    page.ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as BridgeToPage;
      if (m.type === 'agent') page.ws.send(JSON.stringify({ type: 'agent.result', id: m.id, result: { did: m.command } }));
    };
    const res = await fetch(`http://127.0.0.1:${port}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'goto', step: 3 }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { did: { action: 'goto', step: 3 } } });
    page.ws.close();
  });

  it('refuses control with two pages open, a second pending command, and a page that disconnects', async () => {
    const { port } = await start();
    const one = await connect(port);
    const two = await connect(port);
    const state = await fetch(`http://127.0.0.1:${port}/api/state`);
    expect(state.status).toBe(409);
    expect(await state.json()).toMatchObject({ pages: 2, state: null, error: expect.stringContaining('2 pages are open') });
    expect([...one.messages, ...two.messages].some((m) => m.type === 'agent')).toBe(false);
    const closed = new Promise<void>((resolve) => two.ws.addEventListener('close', () => resolve()));
    two.ws.close();
    await closed;
    await new Promise((r) => setTimeout(r, 50));
    const pending = server!.agent({ action: 'debug', op: 'step' });
    await one.next((m) => m.type === 'agent');
    expect(await server!.agent({ action: 'clear' })).toMatchObject({ error: expect.stringContaining('pending') });
    one.ws.close();
    expect(await pending).toMatchObject({ error: expect.stringContaining('disconnected') });
    const none = await fetch(`http://127.0.0.1:${port}/api/state`);
    expect(none.status).toBe(409);
    expect(await none.json()).toMatchObject({ state: null, error: expect.stringContaining('no page is open') });
    const bad = await fetch(`http://127.0.0.1:${port}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1]' });
    expect(bad.status).toBe(400);
  });

  it('refreshes the source but starts no second run while the live debugger is paused, and runs saves again after it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkw-'));
    const file = path.join(dir, 'app.py');
    fs.writeFileSync(file, 'print("one")\n');
    server = new BridgeServer({ file, port: 0, host: '127.0.0.1', runtime: `"${process.execPath}" "${fake}"`, python: 'python3', watch: true, open: false, distDir: dir, stateDir: dir });
    await server.start();
    const page = await connect(Number(new URL(server.url).port));
    await page.next((m) => m.type === 'event' && m.event.type === 'run.finished');
    page.ws.send(JSON.stringify({ type: 'debug.start', breakpoints: [], exceptions: 'uncaught' }));
    await page.next((m) => m.type === 'debug.event' && m.event.type === 'debug.paused');
    fs.writeFileSync(file, 'print("two")\n');
    await page.next((m) => m.type === 'file' && m.file.content === 'print("two")\n');
    page.ws.send(JSON.stringify({ type: 'config', patch: { autoLog: false } }));
    // messages are handled in order: the answer to `recent` comes after the settings change was
    page.ws.send(JSON.stringify({ type: 'recent' }));
    await page.next((m) => m.type === 'recent');
    await new Promise((r) => setTimeout(r, 300));
    expect(page.messages.filter((m) => m.type === 'run.begin').map((m) => (m as { runId: string }).runId)).toEqual(['w-1']);
    page.ws.send(JSON.stringify({ type: 'debug.stop' }));
    await page.next((m) => m.type === 'debug.end');
    fs.writeFileSync(file, 'print("three")\n');
    expect(await page.next((m) => m.type === 'run.begin' && m.runId !== 'w-1')).toMatchObject({ reason: 'disk', content: 'print("three")\n' });
    page.ws.close();
  });

  it('re-sends an imported file the run instrumented on a write and on an atomic rename, without running it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkw-'));
    const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'pkw-lib-'));
    const file = path.join(dir, 'app.py');
    const helper = path.join(lib, 'helper.py');
    fs.writeFileSync(file, 'import helper\n');
    fs.writeFileSync(helper, 'X = 1\n');
    process.env['FAKE_IMPORT'] = helper;
    try {
      server = new BridgeServer({ file, port: 0, host: '127.0.0.1', runtime: `"${process.execPath}" "${fake}"`, python: 'python3', watch: true, open: false, distDir: dir, stateDir: dir });
      await server.start();
      const page = await connect(Number(new URL(server.url).port));
      await page.next((m) => m.type === 'event' && m.event.type === 'run.finished');
      fs.writeFileSync(helper, 'X = 2\n');
      await page.next((m) => m.type === 'file' && m.file.path === helper && m.file.content === 'X = 2\n');
      fs.writeFileSync(helper + '.tmp', 'X = 3\n');
      fs.renameSync(helper + '.tmp', helper);
      await page.next((m) => m.type === 'file' && m.file.path === helper && m.file.content === 'X = 3\n');
      expect(page.messages.filter((m) => m.type === 'run.begin')).toHaveLength(1);
      page.ws.close();
    } finally {
      delete process.env['FAKE_IMPORT'];
    }
  });

  it('sends the main file\'s local imports with hello before any run, listed by the Python runtime', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pkw-')));
    fs.mkdirSync(path.join(dir, 'pkg'));
    fs.writeFileSync(path.join(dir, 'pkg', '__init__.py'), '');
    fs.writeFileSync(path.join(dir, 'pkg', 'tools.py'), 'def twice(n):\n    return n * 2\n');
    const entry = path.join(dir, 'main.py');
    fs.writeFileSync(entry, 'import json\nfrom pkg import tools\nprint(tools.twice(2))\n');
    // distDir test/: the runtime resolves to test/../python, the checkout's source rather than a build in dist/
    server = new BridgeServer({ file: entry, port: 0, host: '127.0.0.1', runtime: 'python', python: 'python3', watch: false, initialRun: false, open: false, distDir: path.resolve(__dirname, '..'), stateDir: dir });
    await server.start();
    const page = await connect(Number(new URL(server.url).port));
    const sent = (await page.next((m) => m.type === 'file' && m.file.path === path.join(dir, 'pkg', 'tools.py'))) as Extract<BridgeToPage, { type: 'file' }>;
    expect(sent.file.content).toContain('def twice');
    expect(page.messages.filter((m) => m.type === 'file').map((m) => (m as Extract<BridgeToPage, { type: 'file' }>).file.path).sort()).toEqual([path.join(dir, 'pkg', '__init__.py'), path.join(dir, 'pkg', 'tools.py')]);
    // --no-run: nothing ran
    expect(page.messages.some((m) => m.type === 'run.begin')).toBe(false);
    page.ws.close();
  }, 20_000);

  it('names the served page build in hello, so a clean tab from an older build reloads', async () => {
    const { port, file } = await start();
    const web = path.join(path.dirname(file), 'web');
    fs.mkdirSync(web, { recursive: true });
    fs.writeFileSync(path.join(web, 'app.js'), 'old');
    const first = await connect(port);
    const before = (await first.next((m) => m.type === 'hello')) as Extract<BridgeToPage, { type: 'hello' }>;
    fs.writeFileSync(path.join(web, 'app.js'), 'rebuilt');
    const second = await connect(port);
    const after = (await second.next((m) => m.type === 'hello')) as Extract<BridgeToPage, { type: 'hello' }>;
    first.ws.close();
    second.ws.close();
    expect(before.build).toBeTruthy();
    expect(after.build).not.toBe(before.build);
    expect(staleBuild(before.build, after.build, false)).toBe(true);
    // unsaved edits in the tab keep it
    expect(staleBuild(before.build, after.build, true)).toBe(false);
    expect(staleBuild(after.build, after.build, false)).toBe(false);
  });

  it('profiles on a runtime of its own, serves the logs, and switches to a recent file', async () => {
    const { port, file } = await start();
    const page = await connect(port);
    await page.next((m) => m.type === 'event' && m.event.type === 'run.finished');
    page.ws.send(JSON.stringify({ type: 'profile' }));
    const prof = (await page.next((m) => m.type === 'profile')) as Extract<BridgeToPage, { type: 'profile' }>;
    expect(prof.profile.summary).toEqual({ totalMs: 2, rows: [{ name: 'add', file, line: 1, selfMs: 2, totalMs: 2.5, calls: 4 }] });
    const dl = await fetch(`http://127.0.0.1:${port}/api/profile`);
    expect(dl.status).toBe(200);
    expect(((await dl.json()) as { nodes: unknown[] }).nodes).toHaveLength(2);
    // the recorded run stayed the one on screen
    expect(page.messages.filter((m) => m.type === 'run.begin')).toHaveLength(1);

    page.ws.send(JSON.stringify({ type: 'file.read', path: LOG_PATH }));
    const logs = (await page.next((m) => m.type === 'file' && m.file.path === LOG_PATH)) as Extract<BridgeToPage, { type: 'file' }>;
    expect(logs.file.content).toMatch(/run w-1 of scratch\.py \(start\)/);

    // Open: only files of the runtime's language under the start file's directory
    const other = path.join(path.dirname(file), 'sub', 'other.py');
    fs.mkdirSync(path.dirname(other));
    fs.writeFileSync(other, 'print(2)\n');
    page.ws.send(JSON.stringify({ type: 'open', path: '/etc/hosts' }));
    expect(await page.next((m) => m.type === 'runner.error')).toMatchObject({ message: expect.stringMatching(/cannot open/) });
    page.ws.send(JSON.stringify({ type: 'open', path: other }));
    await page.next((m) => m.type === 'hello' && m.file.path === other);
    await page.next((m) => m.type === 'run.begin' && m.reason === 'open');
    page.ws.send(JSON.stringify({ type: 'recent' }));
    const recent = (await page.next((m) => m.type === 'recent')) as Extract<BridgeToPage, { type: 'recent' }>;
    expect(recent.files.map((f) => f.path)).toEqual([other, file]);
    expect(JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'recent.json'), 'utf8'))).toHaveLength(2);
    page.ws.close();
  });
});
