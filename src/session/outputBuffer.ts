/**
 * What a program printed, as both products keep it: the last `OUTPUT_KEPT` characters in arrival
 * order. A run-all session keeps it per run (`RunState.output`), a debug session per session
 * (`DebugSession.output`), and a program that prints in a loop must not grow the host either way.
 *
 * `OutputLog` is the same window kept as tagged, redacted chunks instead of one string, so the
 * Debugger view can tell stdout from stderr, stamp each line with when it arrived, and be sent the
 * bytes that are new rather than the whole buffer ten times a second
 * (docs/design/debugger-product.md, 5.6). `DebugSession` keeps both: the string is what stop
 * replies, the agent bridge and the CLI read.
 *
 * Redaction is why the log is split into committed lines and one open line rather than a plain
 * chunk list. `redact()` matches whole tokens and `key: value` pairs, so a secret that straddles
 * two writes is only caught if the redactor sees both halves at once; the old code got that for
 * free by re-scanning the entire 64 KB on every push. Here a line is redacted when it *completes*,
 * with the previous line as context (which covers `password:\nhunter2`), and the incomplete
 * trailing line is redacted afresh and sent whole every time — never as a delta — so a token stream
 * still updates live without a secret ever being sent one half at a time. The cost is one line
 * resent per flush instead of 64 KB.
 */
import { redact } from '../util/redact';

/** How much of a program's output is kept: the tail, not the whole run. */
export const OUTPUT_KEPT = 64 * 1024;

/** `text` appended to `output`, cut to the last `limit` characters. */
export function appendOutput(output: string, text: string, limit = OUTPUT_KEPT): string {
  return output.length + text.length > limit ? (output + text).slice(-limit) : output + text;
}

/** One run of bytes from one stream, stamped with when it arrived. */
export interface OutputChunk {
  stream: 'stdout' | 'stderr';
  text: string;
  /** ms since the run started */
  t: number;
}

/** A committed chunk plus where its first character sits in the run's committed output. */
interface KeptChunk extends OutputChunk {
  start: number;
}

/**
 * `seq` is an offset into the committed, redacted output — not a chunk index and not a raw byte
 * count. Redaction changes lengths, and coalescing grows the last chunk in place, so only the
 * length of what has actually been handed out is a number both sides can agree on. A consumer
 * holding `seq` asks for `since(seq)` and gets exactly the committed text it has not seen, or null
 * when what it missed was already cut from the head and the whole window has to be resent.
 */
export class OutputLog {
  private list: KeptChunk[] = [];
  private kept = 0;
  private committed = 0;
  private droppedChars = 0;
  private printed = 0;
  private lastAt: number | null = null;

  /**
   * The incomplete trailing line, split into the part already redacted and the raw tail that has
   * not been. Keeping the tail short is what makes a token stream cheap, and it still is now that
   * `redact()` is linear: `openLine()` runs on every flush, so re-redacting the whole line each
   * time would be O(line) per flush and O(line²) over a line that grows a token at a time.
   */
  private open: { stream: 'stdout' | 'stderr'; t: number; safe: string; raw: string } | null = null;
  /** the end of the previous committed line, as context for the redactor */
  private lookback = '';

  constructor(
    private readonly limit = OUTPUT_KEPT,
    private readonly coalesceMs = 100,
  ) {}

  /** Committed characters handed out so far; a delta is keyed by this. */
  get seq(): number {
    return this.committed;
  }

  /** Characters cut from the head of the window. */
  get dropped(): number {
    return this.droppedChars;
  }

  /** Bytes the program has printed in this run, cut or not. */
  get bytes(): number {
    return this.printed;
  }

  /** When the last byte arrived (ms since the run started), null when nothing has printed. */
  get lastOutputAt(): number | null {
    return this.lastAt;
  }

  /** The committed window, oldest first, already redacted. */
  all(): OutputChunk[] {
    return this.list.map((c) => ({ stream: c.stream, text: c.text, t: c.t }));
  }

  /** The incomplete trailing line, redacted, or null when the last byte was a newline. */
  openLine(): OutputChunk | null {
    const o = this.open;
    if (!o) return null;
    return { stream: o.stream, text: o.safe + redactWithContext(tail(o.safe), o.raw), t: o.t };
  }

  /** Committed lines before offset `seq`, of the window the log still holds. */
  linesBefore(seq: number): number {
    let n = 0;
    for (const c of this.list) {
      if (c.start >= seq) break;
      const text = c.start + c.text.length <= seq ? c.text : c.text.slice(0, seq - c.start);
      for (let i = 0; i < text.length; i++) if (text[i] === '\n') n++;
    }
    return n;
  }

  /** The committed text after offset `seq`; empty when the caller is current, null when it was cut. */
  since(seq: number): OutputChunk[] | null {
    if (seq === this.committed) return [];
    if (seq > this.committed) return null; // the caller is ahead: a run it has not seen reset us
    const first = this.list[0];
    if (!first || seq < first.start) return null; // what it missed is gone from the head
    const out: OutputChunk[] = [];
    for (const c of this.list) {
      const end = c.start + c.text.length;
      if (end <= seq) continue;
      out.push({ stream: c.stream, text: c.text.slice(Math.max(0, seq - c.start)), t: c.t });
    }
    return out;
  }

  /**
   * Append a write. Complete lines are redacted and committed; the rest becomes the open line.
   * Every committed chunk ends on a newline, so a committed chunk is always whole lines.
   */
  append(stream: 'stdout' | 'stderr', text: string, t: number): void {
    if (!text) return;
    this.printed += text.length;
    this.lastAt = t;

    // a write on the other stream ends the open line where it stands: the two are separate rows.
    // The newline is added so every committed chunk ends on one, which is what lets a reader treat
    // a chunk as whole lines and never have to join one across two of them.
    const open = this.open;
    if (open && open.stream !== stream) {
      this.commit(open.stream, open.safe, `${open.raw}\n`, open.t);
      this.open = null;
    }

    const safe = this.open?.safe ?? '';
    const raw = (this.open?.raw ?? '') + text;
    const startedAt = this.open?.t ?? t;
    const cut = raw.lastIndexOf('\n');
    if (cut === -1) {
      this.open = { stream, t: startedAt, safe, raw };
      this.promote();
      return;
    }
    this.commit(stream, safe, raw.slice(0, cut + 1), startedAt);
    const rest = raw.slice(cut + 1);
    this.open = rest ? { stream, t, safe: '', raw: rest } : null;
  }

  /**
   * Move all but the last `RAW_TAIL` characters of the open line into its redacted half, so what
   * `openLine()` has to redact on each flush stays bounded however long the line grows. The tail
   * that stays raw is longer than any pattern `redact()` matches, so a secret can never be split
   * across the promotion and missed.
   */
  private promote(): void {
    const o = this.open;
    if (!o || o.raw.length <= RAW_MAX) return;
    const keep = o.raw.slice(o.raw.length - RAW_TAIL);
    o.safe += this.redactRun(tail(o.safe), o.raw.slice(0, o.raw.length - RAW_TAIL));
    o.raw = keep;
  }

  /** Forget everything: a fresh run in the same session. */
  reset(): void {
    this.list = [];
    this.kept = 0;
    this.committed = 0;
    this.droppedChars = 0;
    this.printed = 0;
    this.lastAt = null;
    this.open = null;
    this.lookback = '';
  }

  /**
   * Redact one or more complete lines with the previous line as context, then append them. The
   * context is fed to the redactor and dropped again, so a `key:` on one line still redacts the
   * value on the next without rewriting text that was already handed out.
   */
  private commit(stream: 'stdout' | 'stderr', done: string, raw: string, t: number): void {
    const text = done + this.redactRun(done ? tail(done) : this.lookback, raw);
    this.lookback = tail(lastLine(text));
    if (!text) return;
    const last = this.list[this.list.length - 1];
    if (last && last.stream === stream && t - last.t < this.coalesceMs) last.text += text;
    else this.list.push({ stream, text, t, start: this.committed });
    this.committed += text.length;
    this.kept += text.length;
    this.trim();
  }

  /**
   * Redact a run of text in bounded slices, carrying the end of each redacted slice into the next
   * as context. The carried context is what keeps a secret that straddles a slice boundary from
   * slipping between two calls.
   *
   * The slicing was originally here because `redact()` backtracked quadratically in the length of
   * its input: 64 KB on one line took around 100 s. That is fixed at the source (the lookbehind in
   * `src/util/redact.ts`, and the same one in the Python twin), and 64 KB now costs single-digit
   * milliseconds whether it arrives as one line or as a thousand. The slices stay because they
   * bound the worst case cheaply and cost nothing, not because the redactor still needs them.
   */
  private redactRun(context: string, text: string): string {
    if (text.length <= SLICE) return redactWithContext(context, text);
    let out = '';
    let ctx = context;
    for (let i = 0; i < text.length; i += SLICE) {
      const safe = redactWithContext(ctx, text.slice(i, i + SLICE));
      out += safe;
      ctx = tail(safe);
    }
    return out;
  }

  /** Cut from the head until the window fits, splitting the oldest chunk rather than dropping it whole. */
  private trim(): void {
    while (this.kept > this.limit && this.list.length) {
      const head = this.list[0]!;
      const over = this.kept - this.limit;
      if (head.text.length <= over) {
        this.list.shift();
        this.kept -= head.text.length;
        this.droppedChars += head.text.length;
      } else {
        head.text = head.text.slice(over);
        head.start += over;
        this.kept -= over;
        this.droppedChars += over;
      }
    }
  }
}

/** How much redacted text is carried into the next call as context; longer than any pattern matched. */
const CONTEXT = 256;

/** The most text handed to `redact()` at once: a cheap bound on its worst case. */
const SLICE = 1024;

/** How much of the open line stays raw between flushes, and when the rest is promoted. */
const RAW_TAIL = CONTEXT;
const RAW_MAX = SLICE;

/** The end of `text`, as much as the redactor needs to see of what came before. */
function tail(text: string): string {
  return text.length <= CONTEXT ? text : text.slice(text.length - CONTEXT);
}

/**
 * `raw` redacted as if `context` preceded it, with the context removed again. The patterns that can
 * reach across a newline are `Bearer\n<token>` and `key:\n<value>`, and in both the replacement
 * lands wholly inside `raw`, so cutting the context back off is exact. If a pattern ever did rewrite
 * the context — which would mean text already handed out — the cut would land mid-replacement, so
 * that case falls back to redacting `raw` on its own rather than emitting a mangled line.
 */
function redactWithContext(context: string, raw: string): string {
  if (!context) return redact(raw);
  const head = redact(context);
  const both = redact(context + raw);
  return both.startsWith(head) ? both.slice(head.length) : redact(raw);
}

/** The last line of `text`, without its newline; '' when it ends on one. */
function lastLine(text: string): string {
  const end = text.endsWith('\n') ? text.length - 1 : text.length;
  const start = text.lastIndexOf('\n', end - 1);
  return text.slice(start + 1, end);
}
