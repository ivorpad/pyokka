import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.fn();
vi.mock('node:child_process', () => ({ execFile: (...args: unknown[]) => execFile(...args) }));
vi.mock('vscode', () => ({ workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }), workspaceFolders: [] }, extensions: { getExtension: () => undefined }, window: {} }));
vi.mock('../../src/util/log', () => ({ log: { info: () => undefined, warn: () => undefined, error: () => undefined } }));
vi.mock('../../src/config/settings', () => ({ setting: (_k: string, fallback: unknown) => fallback }));
vi.mock('../../src/runtime/pythonDiscovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/runtime/pythonDiscovery')>()),
  // this machine has no Command Line Tools behind /usr/bin/python3
  isApplePlaceholder: (exe: string) => exe === '/usr/bin/python3' || exe === 'python3',
}));

const { probeVersion, invalidateVersionCache } = await import('../../src/runtime/interpreter');

describe('probing an interpreter', () => {
  beforeEach(() => {
    execFile.mockReset();
    invalidateVersionCache();
  });

  it("never runs Apple's placeholder, which would open the Command Line Tools dialog", async () => {
    expect(await probeVersion('/usr/bin/python3')).toBeUndefined();
    expect(await probeVersion('python3')).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('runs any other interpreter once for its version', async () => {
    execFile.mockImplementation((_exe: string, _args: string[], _opts: object, cb: (err: Error | null, out: string) => void) => cb(null, '3.13.1\n'));
    expect(await probeVersion('/opt/homebrew/bin/python3.13')).toEqual([3, 13, 1]);
    expect(await probeVersion('/opt/homebrew/bin/python3.13')).toEqual([3, 13, 1]);
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});
