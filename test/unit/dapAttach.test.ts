import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { SessionManager } from '../../src/session/sessionManager';
import type { DebugSessionManager } from '../../src/debug/debugSessionManager';
import { registerDapAdapter } from '../../src/debug/dapAdapter';

vi.mock('vscode', () => ({
  debug: { registerDebugAdapterDescriptorFactory: vi.fn(), registerDebugConfigurationProvider: vi.fn() },
  window: { activeTextEditor: { document: { uri: { scheme: 'file', fsPath: '/local/unrelated.py' } } }, showErrorMessage: vi.fn() },
  workspace: { workspaceFolders: [] },
  EventEmitter: class { event = vi.fn(); dispose = vi.fn(); },
  DebugAdapterServer: class { constructor(public port: number, public host: string) {} },
  DebugAdapterInlineImplementation: class { constructor(public implementation: unknown) {} },
}));
vi.mock('../../src/session/sessionManager', () => ({ interpreterRefusal: vi.fn() }));
vi.mock('../../src/util/log', () => ({ log: { error: vi.fn() } }));

let factory: vscode.DebugAdapterDescriptorFactory;
let provider: vscode.DebugConfigurationProvider;
const config = (extra: Record<string, unknown> = {}): vscode.DebugConfiguration => ({
  type: 'pyokka', request: 'attach', name: 'running server', connect: { port: 5679 }, ...extra,
});
const cancel = { isCancellationRequested: false } as vscode.CancellationToken;

beforeEach(() => {
  vi.clearAllMocks();
  registerDapAdapter({} as SessionManager, { get: () => undefined } as unknown as DebugSessionManager);
  factory = vi.mocked(vscode.debug.registerDebugAdapterDescriptorFactory).mock.calls[0]![1];
  provider = vi.mocked(vscode.debug.registerDebugConfigurationProvider).mock.calls[0]![1];
});

describe('debugpy attach routing', () => {
  it('leaves attach alone before VS Code substitutes variables, even with an active editor', async () => {
    const raw = config({ connect: { host: '${input:host}', port: '${input:port}' }, pathMappings: [{ localRoot: '${workspaceFolder}', remoteRoot: '/app' }] });
    expect(await provider.resolveDebugConfiguration!(undefined, raw, cancel)).toEqual(raw);
    expect(raw.program).toBeUndefined();
  });

  it('validates after substitution and preserves debugpy options and path mappings', async () => {
    const raw = config({ justMyCode: false, subProcess: false, pathMappings: [{ localRoot: '/local', remoteRoot: '/app' }] });
    const resolved = await provider.resolveDebugConfigurationWithSubstitutedVariables!(undefined, raw, cancel);
    expect(resolved).toEqual({ ...raw, connect: { host: '127.0.0.1', port: 5679 } });
    expect(resolved?.program).toBeUndefined();
  });

  it('connects directly to the debugpy endpoint instead of constructing a Pyokka launch', async () => {
    const descriptor = await factory.createDebugAdapterDescriptor({ configuration: config() } as vscode.DebugSession, undefined);
    expect(descriptor).toBeInstanceOf(vscode.DebugAdapterServer);
    expect(descriptor).toMatchObject({ host: '127.0.0.1', port: 5679 });
  });

  it('reports invalid attach without opening a session or echoing its values', async () => {
    const resolved = await provider.resolveDebugConfigurationWithSubstitutedVariables!(undefined, config({ connect: { port: 0 } }), cancel);
    expect(resolved).toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringMatching(/connect.port/));
  });

  it('keeps ordinary launches on the inline adapter and does not validate them as attach', async () => {
    const launch = config({ request: 'launch', program: '/local/app.py' });
    expect(await provider.resolveDebugConfigurationWithSubstitutedVariables!(undefined, launch, cancel)).toBe(launch);
    const descriptor = await factory.createDebugAdapterDescriptor({ configuration: launch } as vscode.DebugSession, undefined);
    expect(descriptor).toBeInstanceOf(vscode.DebugAdapterInlineImplementation);
  });
});
