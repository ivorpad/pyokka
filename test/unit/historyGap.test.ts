/** What Show Variable History and Why This Value say in a debug session that keeps no history (src/features/historyGap.ts). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { DebugSessionManager } from '../../src/debug/debugSessionManager';
import { historyGapMessage } from '../../src/features/historyGap';

vi.mock('vscode', () => ({ debug: { activeDebugSession: undefined } }));
vi.mock('../../src/debug/dapAdapter', () => ({ DEBUG_TYPE: 'pyokka' }));

const debugApi = vscode.debug as unknown as { activeDebugSession: unknown };
const sessions = (launch?: { program: string | null; module: string | null; record: boolean }): DebugSessionManager => ({ active: () => (launch ? { launch } : undefined) }) as unknown as DebugSessionManager;

beforeEach(() => {
  debugApi.activeDebugSession = undefined;
});

describe('historyGapMessage', () => {
  it('tells an attach, a module launch and a plain launch apart, with what gets a history', () => {
    debugApi.activeDebugSession = { type: 'pyokka', configuration: { request: 'attach' } };
    expect(historyGapMessage(sessions())).toBe('Pyokka: an attached session records no history, so there is no variable history or Why for it. Launch the file with Pyokka instead: Debug Current File (Recording), or `pyokka debug FILE --record`.');
    debugApi.activeDebugSession = undefined;
    expect(historyGapMessage(sessions({ program: null, module: 'app.server', record: false }))).toMatch(/^Pyokka: a module launch cannot record, because a recording runs on a file/);
    expect(historyGapMessage(sessions({ program: '/w/app.py', module: null, record: false }))).toMatch(/^Pyokka: this debug session records nothing.*`--record-from NAME` records only from that pause on\.$/);
  });

  it('says nothing when the session records or there is none, so the usual message stands', () => {
    expect(historyGapMessage(sessions({ program: '/w/app.py', module: null, record: true }))).toBeUndefined();
    expect(historyGapMessage(sessions())).toBeUndefined();
    debugApi.activeDebugSession = { type: 'python', configuration: { request: 'attach' } };
    expect(historyGapMessage(sessions())).toBeUndefined();
  });
});
