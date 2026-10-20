import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { debugDocument, restartDebugging } from '../../src/debug/dapAdapter';
import type { LaunchConfig } from '../../src/debug/debugSessionState';
import type { Session } from '../../src/session/session';

vi.mock('vscode', () => ({
  debug: { startDebugging: vi.fn(async () => true) },
  workspace: { getWorkspaceFolder: vi.fn(() => ({ uri: { fsPath: '/local' } })) },
  Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath }) },
}));
vi.mock('../../src/session/sessionManager', () => ({ interpreterRefusal: vi.fn() }));
vi.mock('../../src/util/log', () => ({ log: { error: vi.fn() } }));

const document = { uri: { scheme: 'file', fsPath: '/local/app.py' } } as vscode.TextDocument;
const launch: LaunchConfig = {
  program: '/local/app.py', args: ['--port', '8000'], env: { MODE: 'test' },
  cwd: '/app', python: '/opt/venv/bin/python',
  transport: { command: 'podman', args: ['exec', '-i', 'app', 'pyokka-wrapper'] },
  pathMappings: [{ localRoot: '/local', remoteRoot: '/app' }],
  stopOnEntry: true, breakOnException: 'raised', libraryCode: true, record: true,
  recordFrom: 'main',
};

function completedSession(): Session {
  return {
    document, launch, running: false, stopDebug: vi.fn(),
    debug: { runId: 'finished' }, state: { runId: 'finished' },
    debugCtl: { recordFrom: { function: 'main' } },
  } as unknown as Session;
}

beforeEach(() => vi.clearAllMocks());

describe('restarting a completed recording', () => {
  it('reuses the container launch after its debug adapter has detached', async () => {
    await restartDebugging(completedSession());
    expect(vscode.debug.startDebugging).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining(launch),
    );
  });

  it('overrides only explicitly supplied options, including false', async () => {
    await debugDocument(document, completedSession(), { stopOnEntry: false, recordFrom: 'other' });
    expect(vscode.debug.startDebugging).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ ...launch, stopOnEntry: false, recordFrom: 'other' }),
    );
    expect(launch.stopOnEntry).toBe(true);
    expect(launch.recordFrom).toBe('main');
  });

  it('preserves recording mode when options are omitted and permits an explicit mode change', async () => {
    await debugDocument(document, completedSession());
    expect(vi.mocked(vscode.debug.startDebugging).mock.lastCall?.[1]).toMatchObject(launch);
    await debugDocument(document, completedSession(), { record: false });
    expect(vi.mocked(vscode.debug.startDebugging).mock.lastCall?.[1]).toMatchObject({ record: false });
  });

  it('keeps the defaults for a document without a launch configuration', async () => {
    await debugDocument(document);
    expect(vi.mocked(vscode.debug.startDebugging).mock.lastCall?.[1]).toMatchObject({
      program: '/local/app.py', cwd: '/local', stopOnEntry: false,
      breakOnException: 'uncaught', libraryCode: false, record: false,
    });
  });
});
