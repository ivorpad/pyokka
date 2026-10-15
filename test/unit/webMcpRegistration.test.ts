import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerWebMcp } from '../../web/agent';
import type { Link, PageHost } from '../../web/pageHost';

const host = {} as PageHost;
const link = {} as Link;
afterEach(() => vi.unstubAllGlobals());

describe('WebMCP registration', () => {
  it('registers on document.modelContext, the current draft, before the older navigator one', () => {
    const registerTool = vi.fn();
    const legacy = vi.fn();
    vi.stubGlobal('document', { modelContext: { registerTool } });
    vi.stubGlobal('navigator', { modelContext: { registerTool: legacy } });
    expect(registerWebMcp(host, link)).toBe(true);
    expect(legacy).not.toHaveBeenCalled();
    expect(registerTool.mock.calls.map(([t]) => (t as { name: string }).name)).toContain('pyokka_state');
  });

  it('still registers on an older navigator.modelContext, and reports false without either', () => {
    vi.stubGlobal('document', {});
    const provideContext = vi.fn();
    vi.stubGlobal('navigator', { modelContext: { provideContext } });
    expect(registerWebMcp(host, link)).toBe(true);
    expect(provideContext).toHaveBeenCalledOnce();
    vi.stubGlobal('navigator', {});
    expect(registerWebMcp(host, link)).toBe(false);
  });

  it('on the draft resolves with the answer itself, and a refusal with isError and its reason', async () => {
    const registerTool = vi.fn();
    vi.stubGlobal('document', { modelContext: { registerTool } });
    const page = { debug: { active: false }, state: () => ({ step: 3, context: { source: 'recording' } }) } as unknown as PageHost;
    expect(registerWebMcp(page, link)).toBe(true);
    const tools = new Map(registerTool.mock.calls.map(([t]) => [(t as { name: string }).name, t as { title: string; annotations: Record<string, boolean>; execute: (i: object) => Promise<unknown> }]));
    expect(tools.size).toBe(15);
    const state = tools.get('pyokka_state')!;
    expect(state.title).toBe('Time Machine state');
    expect(state.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
    expect(tools.get('pyokka_run')!.annotations).toEqual({ consequentialHint: true, untrustedContentHint: true });
    expect(await state.execute({})).toEqual({ step: 3, context: { source: 'recording' } });
    // a stale expectation is refused before the command runs; the reason reaches the agent
    expect(await state.execute({ expect: { step: 9 } })).toEqual({ isError: true, error: expect.stringContaining('stale context: step') });
    expect(await tools.get('pyokka_scratchpad')!.execute({ op: 'say', text: 'hi' })).toEqual({ isError: true, error: 'this page has no Scratchpad' });
  });

  it('registers with one AbortSignal, aborted when the page registers again, and reports a later rejection', async () => {
    const registerTool = vi.fn((tool: { name: string }) => (tool.name === 'pyokka_say' ? Promise.reject(new Error('Duplicate tool name')) : Promise.resolve()));
    vi.stubGlobal('document', { modelContext: { registerTool } });
    const refused: string[] = [];
    expect(registerWebMcp(host, link, (name, err) => refused.push(`${name}: ${(err as Error).message}`))).toBe(true);
    const signal = (registerTool.mock.calls[0] as unknown as [unknown, { signal: AbortSignal }])[1].signal;
    expect(signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(refused).toEqual(['pyokka_say: Duplicate tool name']);
    registerWebMcp(host, link);
    expect(signal.aborted).toBe(true);
  });
});

