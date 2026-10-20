import { describe, expect, it } from 'vitest';
import { TransportPaths } from '../../src/runtime/transportPaths';
import { parseLaunch, launchKey, debugUri, parseDebugUri } from '../../src/debug/debugSessionState';

const mappings = [{ localRoot: '/local/app', remoteRoot: '/var/task' }, { localRoot: '/local/app/lib', remoteRoot: '/opt/lib' }];

describe('container paths', () => {
  const paths = new TransportPaths(mappings);
  it('uses the longest directory match, keeps sibling prefixes separate, and maps both ways', () => {
    expect(paths.toRemote('/local/app/main.py')).toBe('/var/task/main.py');
    expect(paths.toRemote('/local/app/lib/util.py')).toBe('/opt/lib/util.py');
    expect(paths.toLocal('/opt/lib/util.py')).toBe('/local/app/lib/util.py');
    expect(paths.toLocal('/var/task/main.py')).toBe('/local/app/main.py');
    expect(paths.toLocal('/var/task2/main.py')).toBe('/var/task2/main.py');
    expect(() => paths.toRemote('/local/other.py', true)).toThrow(/pathMappings/);
  });

  it('maps Windows source roots to POSIX container roots', () => {
    const windows = new TransportPaths([{ localRoot: 'C:\\work\\app', remoteRoot: '/var/task' }]);
    expect(windows.toRemote('C:\\work\\app\\main.py')).toBe('/var/task/main.py');
    expect(windows.toLocal('/var/task/main.py')).toBe('C:\\work\\app\\main.py');
  });

  it('translates run sources, workspace, breakpoints and recordFrom, keeping remote cwd and program data intact', () => {
    const request = { type: 'run', file: { path: '/local/app/main.py', content: 'path = "/local/app"' }, workspaceRoot: '/local/app', cwd: '/var/task',
      projectFiles: [{ path: '/local/app/lib/util.py', content: 'x = 1' }], breakpoints: [{ path: '/local/app/main.py', line: 5 }],
      config: { recordFrom: { path: '/local/app/main.py', line: 3 } }, argv: ['/local/app'], env: { EXAMPLE: '/local/app' } };
    expect(paths.outbound(request)).toEqual({ ...request, file: { ...request.file, path: '/var/task/main.py' }, workspaceRoot: '/var/task',
      projectFiles: [{ path: '/opt/lib/util.py', content: 'x = 1' }], breakpoints: [{ path: '/var/task/main.py', line: 5 }],
      config: { recordFrom: { path: '/var/task/main.py', line: 3 } } });
    expect(request.file.path).toBe('/local/app/main.py');
    expect(paths.outbound({ type: 'debug', action: 'breakpoints', set: [{ path: '/local/app/main.py', line: 8 }, { function: 'main' }] }))
      .toMatchObject({ set: [{ path: '/var/task/main.py', line: 8 }, { function: 'main' }] });
  });

  it('translates protocol locations before recordings, stack frames and values reach the editor', () => {
    expect(paths.inbound({ type: 'file.instrumented', path: '/var/task/main.py' })).toMatchObject({ path: '/local/app/main.py' });
    expect(paths.inbound({ type: 'debug.paused', stack: [{ path: '/var/task/main.py' }], breakpoint: { path: '/var/task/main.py' } }))
      .toMatchObject({ stack: [{ path: '/local/app/main.py' }], breakpoint: { path: '/local/app/main.py' } });
    expect(paths.inbound({ type: 'error', message: '/var/task', stack: [{ path: '/opt/lib/util.py' }] }))
      .toMatchObject({ message: '/var/task', stack: [{ path: '/local/app/lib/util.py' }] });
    expect(paths.inbound({ type: 'debug.result', breakpoints: [{ path: '/var/task/main.py' }], locals: [{ name: 'path', text: '/var/task', valueBag: { data: { type: 'function', value: '/var/task', functionLocation: { path: '/var/task/main.py', line: 1 } } } }] }))
      .toMatchObject({ breakpoints: [{ path: '/local/app/main.py' }], locals: [{ text: '/var/task', valueBag: { data: { value: '/var/task', functionLocation: { path: '/local/app/main.py' } } } }] });
  });
});

describe('container launch configuration', () => {
  const raw = { program: '/local/app/main.py', cwd: '/var/task', python: '/var/lang/bin/python',
    transport: { command: 'podman', args: ['exec', '-i', 'example', '/var/task/wrapper.sh'] }, pathMappings: mappings, record: true };
  it('preserves transport, remote cwd/interpreter and local program through URI round trips', () => {
    const launch = parseLaunch(raw);
    expect(launch).toMatchObject(raw);
    expect(parseDebugUri(debugUri(launch)).launch).toEqual(launch);
    expect(launchKey(launch)).not.toBe(launchKey(parseLaunch({ ...raw, transport: { ...raw.transport, args: ['exec', '-i', 'other'] } })));
  });
  it('substitutes workspace paths without resolving the container interpreter on the host', () => {
    const launch = parseLaunch({ ...raw, python: 'python3', program: '${workspaceFolder}/main.py', pathMappings: [{ localRoot: '${workspaceFolder}', remoteRoot: '/var/task' }] }, { workspaceRoot: '/local/app' });
    expect(launch.python).toBe('python3');
    expect(launch.program).toBe('/local/app/main.py');
    expect(launch.pathMappings).toEqual([{ localRoot: '/local/app', remoteRoot: '/var/task' }]);
  });
  it.each([{ transport: {} }, { transport: { command: 'podman', args: '-i' } }, { pathMappings: [] }, { pathMappings: [{ localRoot: '/local/app', remoteRoot: '.' }] }])('refuses incomplete container launch %j', (bad) => {
    expect(() => parseLaunch({ ...raw, ...bad })).toThrow(/transport|pathMappings/);
  });
});
