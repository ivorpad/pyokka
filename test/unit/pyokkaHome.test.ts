import { afterEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { pyokkaHome } from '../../src/util/paths';
import { libraryCacheDir } from '../../src/features/libraryCache';
import { sessionsDir, socketPathFor } from '../../src/agent/bridgeSupport';

// libraryCache imports vscode for its command; the resolver under test never touches it
vi.mock('vscode', () => ({}));

describe('pyokkaHome', () => {
  it('is ~/.pyokka when PYOKKA_HOME is unset or empty', () => {
    expect(pyokkaHome({})).toBe(path.join(os.homedir(), '.pyokka'));
    expect(pyokkaHome({ PYOKKA_HOME: '' })).toBe(path.join(os.homedir(), '.pyokka'));
  });

  it('takes PYOKKA_HOME as an absolute path, expanding a leading ~', () => {
    expect(pyokkaHome({ PYOKKA_HOME: '/tmp/pk-home' })).toBe('/tmp/pk-home');
    expect(pyokkaHome({ PYOKKA_HOME: '~/pk-home' })).toBe(path.join(os.homedir(), 'pk-home'));
    expect(pyokkaHome({ PYOKKA_HOME: '~' })).toBe(os.homedir());
    expect(pyokkaHome({ PYOKKA_HOME: 'rel/home' })).toBe(path.resolve('rel/home'));
  });

  it('moves the library cache with it unless PYOKKA_CACHE_DIR says otherwise', () => {
    expect(libraryCacheDir({ PYOKKA_HOME: '/tmp/pk-home' })).toBe('/tmp/pk-home/cache');
    expect(libraryCacheDir({ PYOKKA_HOME: '/tmp/pk-home', PYOKKA_CACHE_DIR: '/tmp/c' })).toBe('/tmp/c');
  });
});

describe('sessionsDir', () => {
  const saved = { home: process.env['PYOKKA_HOME'], sessions: process.env['PYOKKA_SESSIONS_DIR'] };
  afterEach(() => {
    for (const [key, value] of [['PYOKKA_HOME', saved.home], ['PYOKKA_SESSIONS_DIR', saved.sessions]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('is <PYOKKA_HOME>/sessions, the directory the CLI reads, and PYOKKA_SESSIONS_DIR wins', () => {
    delete process.env['PYOKKA_SESSIONS_DIR'];
    process.env['PYOKKA_HOME'] = '/tmp/pk-home';
    expect(sessionsDir()).toBe('/tmp/pk-home/sessions');
    process.env['PYOKKA_SESSIONS_DIR'] = '/tmp/pk-sessions';
    expect(sessionsDir()).toBe('/tmp/pk-sessions');
  });
});

describe('socketPathFor', () => {
  it('puts the socket beside its descriptor when the path fits in sun_path', () => {
    expect(socketPathFor('/tmp/pk/sessions', '123-1')).toBe('/tmp/pk/sessions/123-1.sock');
  });

  it('falls back to a short temp path when the home is too deep for a Unix socket', () => {
    const deep = path.join('/tmp', 'x'.repeat(120), 'sessions');
    const sock = socketPathFor(deep, '123-d1');
    expect(path.dirname(sock)).toBe(os.tmpdir());
    expect(path.basename(sock)).toMatch(/^pyokka-123-d1-[0-9a-f]{6}\.sock$/);
    expect(Buffer.byteLength(sock)).toBeLessThanOrEqual(103);
  });
});
