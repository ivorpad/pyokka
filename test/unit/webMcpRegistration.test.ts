import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerWebMcp, webMcpTools } from '../../web/agent';
import { setup, SOURCE, runEvents } from './webPageFakes';
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
    expect(tools.size).toBe(16);
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


it('declares truthful hints and concise, described inputs', () => {
  for (const tool of webMcpTools(host, link)) {
    expect(tool.description.length, tool.name).toBeLessThanOrEqual(500);
    const check = (schema: any): void => {
      for (const [name, property] of Object.entries(schema.properties ?? {}) as [string, any][]) {
        expect(property.description, `${tool.name}.${name}`).toEqual(expect.any(String));
        expect(property.description.length, `${tool.name}.${name}`).toBeLessThanOrEqual(150);
        check(property);
      }
    };
    check(tool.inputSchema);
  }
  const tools = new Map(webMcpTools(host, link).map((tool) => [tool.name, tool]));
  expect(tools.get('pyokka_var')!.annotations.readOnlyHint).toBeUndefined();
  expect(tools.get('pyokka_why')!.annotations.readOnlyHint).toBeUndefined();
  expect(tools.get('pyokka_say')!.annotations.untrustedContentHint).toBe(true);
  expect(tools.get('pyokka_breakpoint')!.annotations.untrustedContentHint).toBe(true);
  expect(tools.get('pyokka_eval')!.description).toContain('paused');
});

it('uses the native invocation signal, distinct from registration teardown', async () => {
  const registerTool = vi.fn();
  vi.stubGlobal('document', { modelContext: { registerTool } });
  const say = vi.fn();
  const page = { debug: { active: false }, say, state: () => ({ context: { source: 'recording' } }) } as unknown as PageHost;
  registerWebMcp(page, link);
  const [tool, registration] = registerTool.mock.calls.find(([tool]) => tool.name === 'pyokka_say')!;
  const invocation = new AbortController(); invocation.abort();
  expect(await tool.execute({ text: 'never' }, { signal: invocation.signal })).toMatchObject({ isError: true, error: expect.stringMatching(/cancel/i) });
  expect(say).not.toHaveBeenCalled();
  expect(registration.signal.aborted).toBe(false);
});


describe('bounded WebMCP callbacks', () => {
  it.each(['native', 'legacy'] as const)('bounds a large %s reply and reads its immutable details without repeating the action', async (surface) => {
    const { host: page, link: transport } = setup();
    const registerTool = vi.fn();
    vi.stubGlobal('document', surface === 'native' ? { modelContext: { registerTool } } : {});
    vi.stubGlobal('navigator', surface === 'legacy' ? { modelContext: { registerTool } } : {});
    const original = page.state.bind(page);
    const authored = '"\\\n🐨'.repeat(1000);
    page.state = () => ({ ...original(), output: authored });
    const say = vi.spyOn(page, 'say');
    registerWebMcp(page, transport);
    const tools = new Map(registerTool.mock.calls.map(([tool]) => [tool.name, tool]));
    const decode = (result: any): any => surface === 'native' ? result : JSON.parse(result.content[0].text);
    const raw = await tools.get('pyokka_say')!.execute({ text: 'once' });
    expect(JSON.stringify(raw).length).toBeLessThanOrEqual(1500);
    const summary = decode(raw);
    expect(summary).toMatchObject({ bounded: true, outcome: 'completed', cursor: expect.any(String) });
    const cursor = summary.cursor;
    const first = await tools.get('pyokka_result')!.execute({ cursor });
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(1500);
    expect(await tools.get('pyokka_result')!.execute({ cursor })).toEqual(first);
    expect(say).toHaveBeenCalledTimes(1);
    const entries = [...decode(first).entries];
    let next = decode(first).next_cursor;
    while (next) { const page = decode(await tools.get('pyokka_result')!.execute({ cursor: next })); entries.push(...page.entries); next = page.next_cursor; }
    const output = entries.find((entry: any) => entry.key === 'output');
    expect(output.value.ref).toEqual(expect.any(String));
    const chunk = decode(await tools.get('pyokka_result')!.execute({ cursor: output.value.ref }));
    expect(authored.startsWith(chunk.text)).toBe(true);
    expect(page.state().output).toBe(authored);
    const oldRead = tools.get('pyokka_result')!;
    registerWebMcp(page, transport);
    expect(decode(await oldRead.execute({ cursor })).isError).toBe(true);
    expect(say).toHaveBeenCalledTimes(1);
  });
});


describe.each(['native', 'legacy'] as const)('%s registered callback budgets', (surface) => {
it.each([
  ['pyokka_state', {}], ['pyokka_goto', { step: 1 }], ['pyokka_step', { kind: 'into' }],
  ['pyokka_line', { line: 2 }], ['pyokka_say', { text: 'once' }], ['pyokka_run', {}],
  ['pyokka_eval', { expression: 'x' }], ['pyokka_var', { name: 's' }], ['pyokka_why', { name: 's', step: 4 }],
  ['pyokka_watch', { exp: 's' }], ['pyokka_breakpoint', { line: 2 }], ['pyokka_story', {}],
  ['pyokka_profile', {}], ['pyokka_debug', { op: 'state' }], ['pyokka_scratchpad', { op: 'state' }],
] as const)('bounds the registered %s callback and leaves its raw host state intact', async (name, input) => {
  const { host: page, link: transport } = setup();
  const registerTool = vi.fn();
  vi.stubGlobal('document', surface === 'native' ? { modelContext: { registerTool } } : {});
  vi.stubGlobal('navigator', surface === 'legacy' ? { modelContext: { registerTool } } : {});
  const large = '\\"🐨'.repeat(1500);
  const original = page.state.bind(page);
  page.state = () => ({ ...original(), output: large });
  page.rerunAndWait = async () => {};
  page.panes.variableHistory = async () => ({ name: large, changes: [], total: 0, truncated: false, recordedLocals: true });
  page.panes.queryVariable = async () => {};
  page.panes.provenance = async () => ({ root: { name: large } }) as any;
  page.panes.queryWhy = async () => {};
  page.panes.watchRows = () => [{ id: 'watch', exp: large }];
  page.debug.specs = () => [{ path: '/w/demo.py', line: 2, condition: large }];
  page.openStory = async () => true;
  page.storyText = () => ({ text: large, rows: 1000, step: null, row: null });
  page.profileRun = async () => ({ summary: { totalMs: 10, rows: [{ name: large, file: '/w/demo.py', line: 1, selfMs: 1, totalMs: 1, calls: 1 }] } });
  if (name === 'pyokka_debug') {
    page.debug.run = { ...page.run, running: false, errors: [{ message: large }] } as any;
    page.debug.state = () => null;
  }
  page.onScratchpad = async () => ({ output: large }) as any;
  transport.request = async () => ({ type: 'evaluated', id: 1, text: large, valueBag: { runtimeKey: 'k', data: { type: 'str', value: large, id: 'v', queryPath: [] } } });
  registerWebMcp(page, transport);
  const tools = new Map(registerTool.mock.calls.map(([tool]) => [tool.name, tool]));
  const raw = await tools.get(name)!.execute(input);
  expect(JSON.stringify(raw).length).toBeLessThanOrEqual(1500);
  const result = surface === 'native' ? raw : JSON.parse(raw.content[0].text);
  expect(result).toMatchObject({ bounded: true, outcome: 'completed', cursor: expect.any(String) });
  const before = transport.sent.length;
  const read = await tools.get('pyokka_result')!.execute({ cursor: result.cursor });
  expect(JSON.stringify(read).length).toBeLessThanOrEqual(1500);
  expect(transport.sent.length).toBe(before);
  expect(page.state().output).toBe(large);
});
});

it.each(['native', 'legacy'] as const)('bounds authored %s errors and keeps their failure outcome with retrievable details', async (surface) => {
  const { host: page, link: transport } = setup();
  const registerTool = vi.fn();
  vi.stubGlobal('document', surface === 'native' ? { modelContext: { registerTool } } : {});
  vi.stubGlobal('navigator', surface === 'legacy' ? { modelContext: { registerTool } } : {});
  const message = 'authored failure \\"'.repeat(1000);
  transport.request = async () => ({ type: 'error', id: 1, message });
  registerWebMcp(page, transport);
  const tool = registerTool.mock.calls.find(([tool]) => tool.name === 'pyokka_eval')![0];
  const raw = await tool.execute({ expression: 'x' });
  expect(JSON.stringify(raw).length).toBeLessThanOrEqual(1500);
  if (surface === 'legacy') expect(raw.isError).toBe(true);
  const result = surface === 'native' ? raw : JSON.parse(raw.content[0].text);
  expect(result).toMatchObject({ bounded: true, isError: true, outcome: 'failed', cursor: expect.any(String) });
});

it('reports unknown outcome for cancelled dispatched scratchpad work and keeps status usable', async () => {
  const { host: page, link: transport } = setup();
  const registerTool = vi.fn();
  vi.stubGlobal('document', { modelContext: { registerTool } });
  let dispatched!: () => void;
  const started = new Promise<void>((resolve) => { dispatched = resolve; });
  page.onScratchpad = async (_command, options) => {
    options?.onDispatch?.();
    dispatched();
    return new Promise(() => {});
  };
  registerWebMcp(page, transport);
  const tools = new Map(registerTool.mock.calls.map(([tool]) => [tool.name, tool]));
  const controller = new AbortController();
  const answer = tools.get('pyokka_scratchpad')!.execute({ op: 'run' }, { signal: controller.signal });
  await started;
  controller.abort();
  expect(await answer).toMatchObject({ isError: true, outcome: 'unknown' });
  expect(await tools.get('pyokka_state')!.execute({})).toBeDefined();
});


it('keeps the continuation signature equal to its reviewed schema artifact', () => {
  const artifact = JSON.parse(readFileSync(join(__dirname, '../webmcp/schema.json'), 'utf8'));
  const runtime = webMcpTools(host, link).find((tool) => tool.name === 'pyokka_result')!;
  expect(runtime.inputSchema).toEqual(artifact.tools[0].inputSchema);
  expect(runtime.annotations).toEqual(artifact.tools[0].annotations);
});


it('preserves a completed producing-action outcome when native delivery is cancelled', async () => {
  const { host: page, link: transport, feed } = setup();
  const registerTool = vi.fn();
  vi.stubGlobal('document', { modelContext: { registerTool } });
  registerWebMcp(page, transport);
  const tool = registerTool.mock.calls.find(([tool]) => tool.name === 'pyokka_run')![0];
  const controller = new AbortController();
  const answer = tool.execute({}, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const request = transport.sent.find((message) => message.type === 'run') as { requestId: string };
  feed({ type: 'run.begin', runId: 'completed', requestId: request.requestId, reason: 'edit', content: SOURCE });
  for (const event of runEvents('completed')) feed({ type: 'event', event });
  controller.abort();
  expect(await answer).toMatchObject({ isError: true, outcome: 'completed' });
});
