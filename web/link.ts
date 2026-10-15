/** The page's end of the bridge WebSocket: reconnects, and pairs `request`s with their `reply`. */
import type { RunnerMessage } from '../src/shared/protocol';
import type { BridgeToPage, PageToBridge, RequestBody } from './bridgeProtocol';

export class BridgeLink {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, (reply: RunnerMessage) => void>();
  private queue: string[] = [];
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
      for (const text of this.queue) ws.send(text);
      this.queue = [];
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
    const text = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text);
    else if (msg.type !== 'state') this.queue.push(text);
  }

  /** A host request relayed to the runtime; resolves with its reply, an `error` reply included. */
  request(body: RequestBody): Promise<RunnerMessage> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ type: 'request', id, body });
    });
  }

  /** The same, for the live debugger's run (its own runtime). */
  debugRequest(body: RequestBody): Promise<RunnerMessage> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ type: 'debug.request', id, body });
    });
  }
}
