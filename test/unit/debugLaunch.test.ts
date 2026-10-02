import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { launchKey, launchLine, launchName, launchReply, parseLaunch, substitute } from '../../src/debug/debugSessionState';
import { entryPause } from '../../src/session/debugState';

const root = path.resolve('/ws');
const app = path.join(root, 'app.py');

describe('parseLaunch', () => {
  it('fills every attribute with its default', () => {
    const l = parseLaunch({ program: app });
    expect(l).toEqual({ program: app, args: [], cwd: root, env: {}, stopOnEntry: false, breakOnException: 'uncaught', libraryCode: false, record: false });
  });

  it('resolves ${file} and ${workspaceFolder} and makes program absolute', () => {
    expect(substitute('${workspaceFolder}/app.py', { workspaceRoot: root })).toBe(`${root}/app.py`);
    const l = parseLaunch({ program: '${file}', cwd: '${workspaceFolder}' }, { activeFile: app, workspaceRoot: root });
    expect(l.program).toBe(app);
    expect(l.cwd).toBe(root);
    // a relative program is resolved against the process, as VS Code's own debuggers do
    expect(parseLaunch({ program: 'app.py' }).program).toBe(path.resolve('app.py'));
  });

  it('reads args, env, python, the exception mode and the toggles', () => {
    const l = parseLaunch({ module: 'app.server', args: ['--port', 8000], env: { PORT: 8000 }, python: '/v/bin/python', cwd: root, stopOnEntry: true, breakOnException: 'raised', libraryCode: true });
    expect(l).toEqual({ module: 'app.server', args: ['--port', '8000'], env: { PORT: '8000' }, python: '/v/bin/python', cwd: root, stopOnEntry: true, breakOnException: 'raised', libraryCode: true, record: false });
    // an unknown mode falls back to the default rather than reaching the runtime
    expect(parseLaunch({ program: app, breakOnException: 'sometimes' }).breakOnException).toBe('uncaught');
  });

  it('refuses a launch with neither program nor module, and a module that is a path', () => {
    expect(() => parseLaunch({})).toThrow(/needs "program"/);
    expect(() => parseLaunch({ module: 'app/server.py' })).toThrow(/dotted module name/);
  });

  it('refuses a module launch with record: true and names record: false', () => {
    expect(() => parseLaunch({ module: 'app.server', record: true })).toThrow(/"record": false/);
    // module wins over program, as the runtime does
    expect(parseLaunch({ program: app, module: 'app.server' }).program).toBeUndefined();
  });

  it('names and prints a launch', () => {
    expect(launchName(parseLaunch({ program: app }))).toBe('app.py');
    expect(launchName(parseLaunch({ module: 'app.server' }))).toBe('-m app.server');
    expect(launchLine(parseLaunch({ module: 'app.server', args: ['--port', '8000'], python: '/v/bin/python', cwd: root }))).toBe('/v/bin/python -m app.server --port 8000');
    // a launch that names no interpreter prints none: the session fills it in once it resolved one
    expect(launchLine(parseLaunch({ module: 'app.server', args: ['--port', '8000'], cwd: root }))).toBe('-m app.server --port 8000');
    expect(launchReply(parseLaunch({ program: app }))).toMatchObject({ program: app, module: null, python: null, record: false });
  });
});

describe('launchKey', () => {
  const real = (p: string): string => p; // no realpath in the test: the key's other half is what matters

  it('is the program (or the module) and the working directory', () => {
    expect(launchKey(parseLaunch({ program: app }), real)).toBe(`f:${app}|${root}`);
    expect(launchKey(parseLaunch({ module: 'app.server', cwd: root }), real)).toBe(`m:app.server|${root}`);
  });

  it('ignores args and separates by cwd', () => {
    const a = parseLaunch({ program: app, args: ['--port', '8000'] });
    const b = parseLaunch({ program: app, args: ['--port', '9000'] });
    expect(launchKey(a, real)).toBe(launchKey(b, real));
    const elsewhere = parseLaunch({ program: app, cwd: path.join(root, 'sub') });
    expect(launchKey(elsewhere, real)).not.toBe(launchKey(a, real));
  });
});

describe('entryPause for an agent cold start', () => {
  it('stops at the first statement only when nothing else can stop the program', () => {
    // a cold start has no run, so any enabled breakpoint can still hit: the run goes to it
    expect(entryPause({}, [], [], { anyFile: true })).toBe(true);
    expect(entryPause({}, [{ path: app, line: 12 }], [], { anyFile: true })).toBe(false);
    expect(entryPause({ stopOnEntry: true }, [{ path: app, line: 12 }], [], { anyFile: true })).toBe(true);
    // a breakpoint in a file that is not the program's still counts: the run may import it
    expect(entryPause({}, [{ path: path.join(root, 'lib', 'rank.py'), line: 3 }], [], { anyFile: true })).toBe(false);
    // the run-all rule is unchanged: only a breakpoint in the run's own files counts
    expect(entryPause({}, [{ path: app, line: 12 }], [])).toBe(true);
    expect(entryPause({}, [{ path: app, line: 12 }], [app])).toBe(false);
  });
});
