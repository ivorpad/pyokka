import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeLink } from '../../web/link';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  constructor(_url: string) { FakeSocket.instances.push(this); }
  send(text: string): void { this.sent.push(text); }
  open(): void { this.readyState = 1; this.onopen?.(); }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); FakeSocket.instances = []; });

describe('BridgeLink owned requests', () => {
  it.each(['request', 'debugRequest'] as const)('removes the %s resolver and queued send on cancellation', async (method) => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const link = new BridgeLink('ws://test', () => {}, () => {});
    const controller = new AbortController();
    const result = link[method]({ type: 'evaluate', runId: 'run', expression: 'x' }, controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow(/cancel/i);
    expect((link as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0);
    FakeSocket.instances[0]!.open();
    expect(FakeSocket.instances[0]!.sent).toEqual([]);
    const next = link[method]({ type: 'evaluate', runId: 'run', expression: 'y' });
    const request = JSON.parse(FakeSocket.instances[0]!.sent[0]!);
    FakeSocket.instances[0]!.onmessage?.({ data: JSON.stringify({ type: 'reply', id: request.id, reply: { type: 'evaluated', id: 1, text: 'later' } }) });
    expect(await next).toMatchObject({ text: 'later' });
  });

  it('does not send a request whose signal was already aborted', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const link = new BridgeLink('ws://test', () => {}, () => {});
    FakeSocket.instances[0]!.open();
    const controller = new AbortController(); controller.abort();
    await expect(link.debugRequest({ type: 'evaluate', runId: 'run', expression: 'x' }, controller.signal)).rejects.toThrow(/cancel/i);
    expect(FakeSocket.instances[0]!.sent).toEqual([]);
  });

  it.each(['request', 'debugRequest'] as const)('releases an already dispatched %s without stopping shared work', async (method) => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const link = new BridgeLink('ws://test', () => {}, () => {});
    const socket = FakeSocket.instances[0]!;
    socket.open();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const result = link[method]({ type: 'evaluate', runId: 'run', expression: 'x' }, controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow(/dispatched work may still continue/);
    expect((link as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(socket.sent.map(text => JSON.parse(text).type)).toEqual([method === 'request' ? 'request' : 'debug.request']);
  });

  it('removes the abort listener after a reply and ignores a subsequent abort', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const link = new BridgeLink('ws://test', () => {}, () => {});
    const socket = FakeSocket.instances[0]!;
    socket.open();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const result = link.request({ type: 'evaluate', runId: 'run', expression: 'x' }, controller.signal);
    const { id } = JSON.parse(socket.sent[0]!);
    socket.onmessage?.({ data: JSON.stringify({ type: 'reply', id, reply: { type: 'error', id, message: 'runtime refusal' } }) });
    await expect(result).resolves.toMatchObject({ message: 'runtime refusal' });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect((link as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0);
    controller.abort();
    await expect(result).resolves.toMatchObject({ message: 'runtime refusal' });
  });

  it('cleans up on disconnect and reconnects with normal queued sends intact', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    const link = new BridgeLink('ws://test', () => {}, () => {});
    const socket = FakeSocket.instances[0]!;
    socket.open();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const result = link.debugRequest({ type: 'evaluate', runId: 'run', expression: 'x' }, controller.signal);
    socket.readyState = 3;
    socket.onclose?.();
    await expect(result).resolves.toMatchObject({ type: 'error', message: 'the Pyokka bridge went away' });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect((link as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0);
    link.send({ type: 'run', content: 'result = 42' });
    await vi.advanceTimersByTimeAsync(500);
    const nextSocket = FakeSocket.instances[1]!;
    nextSocket.open();
    expect(nextSocket.sent.map(text => JSON.parse(text))).toEqual([{ type: 'run', content: 'result = 42' }]);
    const next = link.request({ type: 'evaluate', runId: 'next', expression: 'y' });
    const { id } = JSON.parse(nextSocket.sent[1]!);
    nextSocket.onmessage?.({ data: JSON.stringify({ type: 'reply', id, reply: { type: 'error', id, message: 'later reply' } }) });
    await expect(next).resolves.toMatchObject({ message: 'later reply' });
  });

  it.each([false, true])('cleans up a send error with an initially open socket=%s', async (open) => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const link = new BridgeLink('ws://test', () => {}, () => {});
    const socket = FakeSocket.instances[0]!;
    if (open) socket.open();
    vi.spyOn(socket, 'send').mockImplementationOnce(() => { throw new Error('socket send failed'); });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const result = link.request({ type: 'evaluate', runId: 'run', expression: 'x' }, controller.signal);
    const rejected = expect(result).rejects.toThrow('socket send failed');
    if (!open) expect(() => socket.open()).not.toThrow();
    await rejected;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect((link as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0);
    const next = link.request({ type: 'evaluate', runId: 'run', expression: 'y' });
    const { id } = JSON.parse(socket.sent[0]!);
    socket.onmessage?.({ data: JSON.stringify({ type: 'reply', id, reply: { type: 'error', id, message: 'later reply' } }) });
    await expect(next).resolves.toMatchObject({ message: 'later reply' });
  });
});
