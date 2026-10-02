import { StringDecoder } from 'node:string_decoder';

/**
 * Incremental NDJSON decoder. Handles chunks that split a line (and a UTF-8 sequence)
 * anywhere. Lines that are not valid JSON are surfaced through `onBadLine`.
 */
export class NdjsonDecoder {
  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');

  constructor(private readonly onBadLine?: (line: string, err: unknown) => void) {}

  push(chunk: Buffer | string): unknown[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const out: unknown[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch (err) {
        this.onBadLine?.(line, err);
      }
    }
    return out;
  }

  /** Flush a trailing line without a newline (stream end). */
  end(): unknown[] {
    const rest = this.buffer + this.decoder.end();
    this.buffer = '';
    if (!rest.trim()) return [];
    try {
      return [JSON.parse(rest)];
    } catch (err) {
      this.onBadLine?.(rest, err);
      return [];
    }
  }
}

export function encodeNdjson(message: unknown): string {
  return JSON.stringify(message) + '\n';
}
