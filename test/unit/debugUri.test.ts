import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { AT_UNREADABLE, debugUri, parseAt, parseDebugUri, parseLaunch, URI_AUTHORITY } from '../../src/debug/debugSessionState';

const root = path.resolve('/ws');
const app = path.join(root, 'app.py');

describe('debugUri / parseDebugUri', () => {
  it('round-trips a whole launch', () => {
    const launch = parseLaunch({ program: app, args: ['--port', '8000'], cwd: root, env: { PORT: '8000' }, python: '/v/bin/python', stopOnEntry: true, libraryCode: true, breakOnException: 'raised' });
    const uri = debugUri(launch, 'app.py:42');
    expect(uri.startsWith(`vscode://${URI_AUTHORITY}/debug?`)).toBe(true);
    const back = parseDebugUri(uri);
    expect(back.launch).toEqual(launch);
    expect(back.at).toBe('app.py:42');
  });

  it('encodes every value and reads the query alone too', () => {
    const launch = parseLaunch({ program: path.join(root, 'my app.py'), args: ['a b', '"c"'], cwd: root, env: { 'A B': 'c&d' } });
    const uri = debugUri(launch);
    expect(uri).not.toContain(' ');
    const query = uri.slice(uri.indexOf('?') + 1);
    expect(parseDebugUri(query).launch).toEqual(launch);
  });

  it('leaves out the flags that are off and reads them back as false', () => {
    const launch = parseLaunch({ program: app, cwd: root });
    const uri = debugUri(launch);
    expect(uri).not.toContain('stopOnEntry');
    expect(uri).not.toContain('record');
    expect(uri).not.toContain('libraryCode');
    expect(uri).not.toContain('breakOnException');
    const back = parseDebugUri(uri).launch;
    expect(back.stopOnEntry).toBe(false);
    expect(back.record).toBe(false);
    expect(back.libraryCode).toBe(false);
    expect(back.breakOnException).toBe('uncaught');
    expect(parseDebugUri(debugUri(parseLaunch({ program: app, cwd: root, stopOnEntry: true }))).launch.stopOnEntry).toBe(true);
  });

  it('carries a module launch with no program', () => {
    const launch = parseLaunch({ module: 'app.server', args: ['--port', '8000'], cwd: root });
    const back = parseDebugUri(debugUri(launch)).launch;
    expect(back).toEqual(launch);
    expect(back.program).toBeUndefined();
  });

  it('reports a malformed args or env instead of starting anything', () => {
    expect(() => parseDebugUri(`program=${encodeURIComponent(app)}&args=%5B%22--port`)).toThrow(/"args" is not JSON/);
    expect(() => parseDebugUri(`program=${encodeURIComponent(app)}&args=%7B%7D`)).toThrow(/"args" must be a JSON array/);
    expect(() => parseDebugUri(`program=${encodeURIComponent(app)}&env=%5B%5D`)).toThrow(/"env" must be a JSON object/);
    expect(() => parseDebugUri(`program=${encodeURIComponent(app)}&env=%7B%22A%22%3A1%7D`)).toThrow(/"env" must be a JSON object/);
    expect(() => parseDebugUri('cwd=%2Fws')).toThrow(/needs "program"/);
  });
});

describe('parseAt', () => {
  it('reads FILE:LINE in both forms and a function name in both its forms', () => {
    expect(parseAt('app.py:42')).toEqual({ file: 'app.py', line: 42 });
    expect(parseAt(`${app}:6`)).toEqual({ file: app, line: 6 });
    // a bare name and a qualified method are a function breakpoint the runtime resolves
    expect(parseAt('rrf')).toEqual({ function: 'rrf' });
    expect(parseAt('Ranker.rank')).toEqual({ function: 'Ranker.rank' });
    expect(parseAt('  rrf  ')).toEqual({ function: 'rrf' });
    // `app.py:0` and `app.py:x` are neither: `app.py` is not an identifier chain and the line is not one
    expect(parseAt('app.py:0')).toBeUndefined();
    expect(parseAt('app.py:x')).toBeUndefined();
    expect(parseAt('')).toBeUndefined();
    expect(parseAt('9lives')).toBeUndefined();
    expect(AT_UNREADABLE).toBe('--at wants FILE:LINE or a function name');
  });
});


describe('parseDebugUri with several --at', () => {
  it('keeps the first as `at` and the rest, in order, as `also`', () => {
    const parsed = parseDebugUri('program=%2Fw%2Fapp.py&at=load&at=%2Fw%2Fstage.py%3A3&at=score');
    expect(parsed.at).toBe('load');
    expect(parsed.also).toEqual(['/w/stage.py:3', 'score']);
  });
  it('has no `also` for a single --at', () => {
    expect(parseDebugUri('program=%2Fw%2Fapp.py&at=load').also).toBeUndefined();
  });
});
