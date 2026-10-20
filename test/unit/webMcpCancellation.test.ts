import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerWebMcp } from '../../web/agent';
import { completeValue, post } from '../../web/scratchpadClient';
import type { Link, PageHost } from '../../web/pageHost';
import type { WebMCP } from 'webmcp-types';

afterEach(() => vi.unstubAllGlobals());

describe('scratchpad cancellable transport', () => {
  it('forwards the native callback signal through the scratchpad callback into fetch', async () => {
    const callbacks = new Map<string, WebMCP.ToolExecuteCallback>();
    vi.stubGlobal('document', { modelContext: { registerTool: (tool: WebMCP.ModelContextTool) => callbacks.set(tool.name, tool.execute) } });
    vi.stubGlobal('navigator', {});
    const fetch = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
    vi.stubGlobal('fetch', fetch);
    const onScratchpad = vi.fn((_cmd, options) => post('format', { code: 'result = 1' }, options.signal));
    const host = { debug: { active: false }, idle: async () => {}, state: () => ({}), onScratchpad } as unknown as PageHost;
    registerWebMcp(host, {} as Link);
    const abort = new AbortController();
    const answer = callbacks.get('pyokka_scratchpad')!({ op: 'experiment', code: 'result = 1' }, { signal: abort.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const forwarded = onScratchpad.mock.calls[0]![1].signal as AbortSignal;
    expect(forwarded.aborted).toBe(false);
    expect(fetch.mock.calls[0]![1].signal).toBe(forwarded);
    abort.abort();
    expect(await answer).toMatchObject({ isError: true, error: expect.stringMatching(/cancel/i) });
    expect(forwarded.aborted).toBe(true);
  });

  it('avoids dispatch for pre-aborted transport and cleans cancellation listeners after success', async () => {
    const abort = new AbortController();
    const add = vi.spyOn(abort.signal, 'addEventListener');
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    const fetch = vi.fn(async () => ({ ok: true, text: async () => '{"code":"result = 1"}' }));
    vi.stubGlobal('fetch', fetch);
    expect(await post('format', {}, abort.signal)).toEqual({ code: 'result = 1' });
    expect(remove.mock.calls.map(([event, fn]) => [event, fn])).toEqual(add.mock.calls.map(([event, fn]) => [event, fn]));
    abort.abort();
    await expect(post('run', {}, abort.signal)).rejects.toThrow(/cancel/i);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('retires owned waiters when a transport never replies and ignores a late body', async () => {
    let body!: (text: string) => void;
    const abort = new AbortController();
    const add = vi.spyOn(abort.signal, 'addEventListener');
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: () => new Promise<string>((resolve) => { body = resolve; }) })));
    const work = post('run', {}, abort.signal);
    const rejected = expect(work).rejects.toThrow(/cancel/i);
    await vi.waitFor(() => expect(body).toBeTypeOf('function'));
    abort.abort();
    await rejected;
    expect(remove.mock.calls.map(([, fn]) => fn)).toEqual(add.mock.calls.map(([, fn]) => fn));
    body('{"output":"late"}');
    await Promise.resolve();
  });

  it('cancels local-value expansion without issuing later debugger requests', async () => {
    const abort = new AbortController();
    const debugRequest = vi.fn(() => new Promise<never>(() => {}));
    const work = completeValue({ debugRequest } as unknown as Link, 'run', { type: 'list', id: 'value', expandable: true } as any, 0, { expansions: 5 }, abort.signal);
    const rejected = expect(work).rejects.toThrow(/cancel/i);
    abort.abort();
    await rejected;
    expect(debugRequest).toHaveBeenCalledOnce();
    expect(debugRequest).toHaveBeenCalledWith(expect.objectContaining({ type: 'expand' }), abort.signal);
  });
});
