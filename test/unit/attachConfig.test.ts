import { describe, expect, it } from 'vitest';
import { parseAttach } from '../../src/debug/attachConfig';

describe('debugpy attach configuration', () => {
  it('requires a port and defaults to loopback without choosing an interpreter or program', () => {
    expect(parseAttach({ connect: { port: 5679 } })).toEqual({ connect: { host: '127.0.0.1', port: 5679 } });
    expect(parseAttach({ connect: { host: 'container.internal', port: 5679 } })).toEqual({ connect: { host: 'container.internal', port: 5679 } });
  });

  it.each([undefined, null, [], {}, { port: 0 }, { port: 65536 }, { port: 1.5 }, { port: '5679' }, { port: 5679, host: '' }, { port: 5679, host: 5 }, { port: 5679, host: ' host ' }])('refuses an invalid endpoint %j', (connect) => {
    expect(() => parseAttach({ connect })).toThrow(/connect/);
  });

  it('preserves multiple remote path mappings, including Windows paths and the remote cwd', () => {
    const pathMappings = [
      { localRoot: '/workspace/app', remoteRoot: '/srv/app' },
      { localRoot: 'C:\\Users\\dev\\lib', remoteRoot: '/srv/lib' },
      { localRoot: '/workspace/other', remoteRoot: '.' },
    ];
    expect(parseAttach({ connect: { port: 5679 }, pathMappings }).pathMappings).toEqual(pathMappings);
  });

  it.each([null, {}, [null], [{}], [{ localRoot: '/local' }], [{ localRoot: '', remoteRoot: '/app' }], [{ localRoot: '/local', remoteRoot: 42 }]])('refuses malformed path mappings %j', (pathMappings) => {
    expect(() => parseAttach({ connect: { port: 5679 }, pathMappings })).toThrow(/pathMappings/);
  });

  it.each([
    { record: true }, { recordFrom: 'handler' }, { replay: 'session' },
    { program: 'app.py' }, { module: 'app.server' }, { env: { TEST: '1' } },
    { args: [] }, { cwd: '/app' }, { envFile: '.env' }, { python: '/bin/python' },
    { stopOnEntry: true }, { breakOnException: 'raised' }, { libraryCode: true },
    { processId: 123 }, { listen: { port: 5679 } },
  ])('refuses options that cannot apply to this attach %j', (option) => {
    expect(() => parseAttach({ connect: { port: 5679 }, ...option })).toThrow(/attach/);
  });

  it('allows an explicit record: false and valid debugpy options', () => {
    expect(parseAttach({ connect: { port: 5679 }, record: false, justMyCode: false })).toMatchObject({ connect: { port: 5679 } });
  });
});
