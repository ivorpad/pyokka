import { describe, expect, it, vi } from 'vitest';
import * as net from 'node:net';
import { ctlConnectError, main } from '../../web/server';

/** `node dist/web/server.js ctl` printed `fetch failed` for a closed port and a sandbox-blocked one alike. */
describe('ctl connection errors', () => {
  it('tells a connection the system blocks from a closed port', () => {
    const blocked = Object.assign(new TypeError('fetch failed'), { cause: { code: 'EPERM' } });
    expect(ctlConnectError(blocked, 4777)).toContain('refused by the system (EPERM), not by a server: a sandbox without network access');
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    expect(ctlConnectError(refused, 4777)).toContain('no Pyokka page is served on 127.0.0.1:4777');
    expect(ctlConnectError(new Error('boom'), 1)).toBe('boom');
  });

  it('says no page is served when nothing listens on the port', async () => {
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await main(['ctl', '--port', String(port), 'state'])).toBe(2);
      expect(String(err.mock.calls[0]?.[0])).toContain(`no Pyokka page is served on 127.0.0.1:${port}`);
    } finally {
      err.mockRestore();
    }
  });
});
