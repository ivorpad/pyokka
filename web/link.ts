/** The page's end of the bridge WebSocket: reconnects, and pairs `request`s with their `reply`. */
import type { RunnerMessage } from '../src/shared/protocol';
import type { BridgeToPage, PageToBridge, RequestBody } from './bridgeProtocol';

export class BridgeLink {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, (reply: RunnerMessage) => void>();
  private queue: { text: string; failed?: (error: unknown) => void }[] = [];
  private retry = 0;

  constructor(
    private readonly url: string,
    private readonly onMessage: (msg: BridgeToPage) => void,
    private readonly onStatus: (connected: boolean) => void,
  ) {
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.onStatus(true);
      while (this.queue.length) {
        const queued = this.queue.shift()!;
        try { ws.send(queued.text); } catch (error) {
          if (queued.failed) queued.failed(error);
          else throw error;
        }
      }
    };
    ws.onmessage = (ev) => {
      let msg: BridgeToPage;
      try {
        msg = JSON.parse(String(ev.data)) as BridgeToPage;
      } catch {
        return;
      }
      if (msg.type === 'reply') {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p(msg.reply);
        }
        return;
      }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      this.onStatus(false);
      for (const [id, p] of this.pending) p({ type: 'error', id, message: 'the Pyokka bridge went away' });
      this.pending.clear();
      // the bridge restarts with `pyokka-web`; keep trying, slower each time
      const delay = Math.min(500 * 2 ** this.retry++, 5000);
      setTimeout(() => this.connect(), delay);
    };
  }

  send(msg: PageToBridge): void {
    this.dispatch(msg);
  }

  private dispatch(msg: PageToBridge, failed?: (error: unknown) => void): void {
    const text = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text);
    else if (msg.type !== 'state') this.queue.push({ text, failed });
  }

  /** A host request relayed to the runtime; resolves with its reply, an `error` reply included. */
  request(body: RequestBody, signal?: AbortSignal): Promise<RunnerMessage> {
    return this.relay('request', body, signal);
  }

  /** The same, for the live debugger's run (its own runtime). */
  debugRequest(body: RequestBody, signal?: AbortSignal): Promise<RunnerMessage> {
    return this.relay('debug.request', body, signal);
  }

  private relay(type: 'request' | 'debug.request', body: RequestBody, signal?: AbortSignal): Promise<RunnerMessage> {
    if (signal?.aborted) return Promise.reject(new Error('bridge request cancelled before dispatch'));
    const id = this.nextId++;
    const message: PageToBridge = { type, id, body };
    const text = JSON.stringify(message);
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        this.pending.delete(id);
        signal?.removeEventListener('abort', aborted);
        const index = this.queue.findIndex(queued => queued.text === text);
        if (index >= 0) this.queue.splice(index, 1);
      };
      const aborted = (): void => { cleanup(); reject(new Error('bridge request cancelled; dispatched work may still continue')); };
      this.pending.set(id, (reply) => { cleanup(); resolve(reply); });
      signal?.addEventListener('abort', aborted, { once: true });
      const failed = (error: unknown): void => { cleanup(); reject(error); };
      try { this.dispatch(message, failed); } catch (error) { failed(error); }
    });
  }
}
