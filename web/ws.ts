/**
 * The smallest WebSocket server the browser panel needs (RFC 6455): text frames both ways,
 * fragmented messages, ping/pong and close. No extensions, no binary messages. Kept in-tree so the
 * bridge adds no dependency.
 */
import * as crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** one message larger than this closes the socket (1009); a recorded trace of a long run is the biggest */
const MAX_MESSAGE = 64 * 1024 * 1024;

export function acceptKey(key: string): string {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/** Encode one unmasked server frame. */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

export interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** Decode as many complete frames as `buf` holds; returns them and the bytes left over. */
export function decodeFrames(buf: Buffer): { frames: Frame[]; rest: Buffer } {
  const frames: Frame[] = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off]!;
    const b1 = buf[off + 1]!;
    let len = b1 & 0x7f;
    let pos = off + 2;
    if (len === 126) {
      if (buf.length - pos < 2) break;
      len = buf.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (buf.length - pos < 8) break;
      const big = buf.readBigUInt64BE(pos);
      if (big > BigInt(MAX_MESSAGE)) throw new Error('frame too large');
      len = Number(big);
      pos += 8;
    }
    const masked = (b1 & 0x80) !== 0;
    const maskLen = masked ? 4 : 0;
    if (buf.length - pos < maskLen + len) break;
    const mask = masked ? buf.subarray(pos, pos + 4) : undefined;
    pos += maskLen;
    const payload = Buffer.from(buf.subarray(pos, pos + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
    off = pos + len;
  }
  return { frames, rest: buf.subarray(off) };
}

export class WebSocketConnection extends EventEmitter<{ message: [string]; close: [] }> {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private closed = false;

  constructor(private readonly socket: Duplex) {
    super();
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  get open(): boolean {
    return !this.closed;
  }

  send(text: string): void {
    if (this.closed) return;
    this.socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8')));
  }

  close(code = 1000): void {
    if (this.closed) return;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    try {
      this.socket.write(encodeFrame(0x8, body));
    } catch {
      /* already gone */
    }
    this.socket.end();
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let decoded: { frames: Frame[]; rest: Buffer };
    try {
      decoded = decodeFrames(this.buffer);
    } catch {
      this.close(1009);
      return;
    }
    this.buffer = decoded.rest;
    for (const f of decoded.frames) {
      switch (f.opcode) {
        case 0x0: // continuation
        case 0x1: // text
          this.fragments.push(f.payload);
          this.fragmentBytes += f.payload.length;
          if (this.fragmentBytes > MAX_MESSAGE) {
            this.close(1009);
            return;
          }
          if (f.fin) {
            const text = Buffer.concat(this.fragments).toString('utf8');
            this.fragments = [];
            this.fragmentBytes = 0;
            this.emit('message', text);
          }
          break;
        case 0x8:
          this.close();
          return;
        case 0x9:
          this.socket.write(encodeFrame(0xa, f.payload));
          break;
        case 0xa:
          break;
        default:
          this.close(1003); // binary or unknown: not spoken here
          return;
      }
    }
  }
}

/** Complete the upgrade handshake, or answer 400 and return undefined. */
export function upgrade(req: IncomingMessage, socket: Duplex): WebSocketConnection | undefined {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return undefined;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  return new WebSocketConnection(socket);
}
