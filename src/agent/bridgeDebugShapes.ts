/**
 * The shapes the debugger's bridge replies are built from (docs/PROTOCOL.md, "Debugging over the
 * bridge"): path resolution both ways, the `paused` payload, the breakpoint and watch echoes, the
 * output tail. vscode-free and pure, so vitest covers them (test/unit/bridgeDebug.test.ts); both
 * the run socket (bridgeDebug.ts) and the debug socket (bridgeDebugReply.ts) use them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Session } from '../session/session';
import { type BreakpointSpec, type BreakWatchSpec, type DebugBreakpointEcho, type ExceptionMode, type LocalVar, type PausedInfo } from '../session/debugState';
import { parseAt } from '../debug/debugSessionState';
import { redact, redactValueBag } from '../util/redact';
import { int, type Request } from './bridgeSupport';

/** How much of the program's output a stop reply carries: the tail, not the whole run. */
export const OUTPUT_TAIL = 4_000;

/** What the shaping needs from a session (structural, so tests need no Session). */
export interface PathContext {
  workspaceRoot: string;
  filePath: string;
  displayName: string;
  runFiles: () => { fileId: number; path: string }[];
}

export function pathContext(session: Session): PathContext {
  return { workspaceRoot: session.workspaceRoot, filePath: session.filePath, displayName: session.displayName, runFiles: () => session.files.all().map((f) => ({ fileId: f.fileId, path: f.path })) };
}

/** A path as the bridge prints it: workspace-relative inside the workspace, absolute elsewhere. */
export function displayFile(ctx: PathContext, abs: string): string {
  if (ctx.workspaceRoot) {
    const rel = path.relative(ctx.workspaceRoot, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return abs;
}

/**
 * A `file` request field to an absolute path: the display name, an absolute path, a workspace-relative
 * path, or the basename of one file of the run. The file need not be in the run yet: a breakpoint on
 * a module before its import is resolved by the runtime when the module is instrumented.
 */
export function resolveFile(ctx: PathContext, file: unknown, exists: (p: string) => boolean = fs.existsSync): string {
  if (typeof file !== 'string' || !file.trim()) return ctx.filePath;
  const f = file.trim();
  if (f === ctx.displayName || f === path.basename(ctx.filePath)) return ctx.filePath;
  if (path.isAbsolute(f)) return f;
  const base = ctx.workspaceRoot || path.dirname(ctx.filePath);
  const relative = path.resolve(base, f);
  if (exists(relative)) return relative;
  const byName = ctx.runFiles().filter((r) => r.path === relative || r.path.endsWith(`${path.sep}${f}`) || path.basename(r.path) === f);
  if (byName.length === 1) return byName[0]!.path;
  return relative;
}

export interface BreakItem {
  path: string;
  line: number;
  condition?: string;
}

/** `[{file | path, line, condition?}]` from a request into absolute specs; entries without a line are dropped. */
export function parseBreakItems(ctx: PathContext, items: unknown, exists?: (p: string) => boolean): BreakItem[] {
  if (!Array.isArray(items)) return [];
  const out: BreakItem[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const line = int(o.line);
    if (line === undefined || line < 1) continue;
    const item: BreakItem = { path: resolveFile(ctx, o.file ?? o.path, exists), line };
    const condition = typeof o.condition === 'string' ? o.condition.trim() : '';
    if (condition) item.condition = condition;
    out.push(item);
  }
  return out;
}

/**
 * The `breakpoints` reply: every breakpoint the run knows, annotated from the runtime's echo when
 * there is one. A function breakpoint (`--at NAME`) carries `function` and learns its `file` and
 * `line` from the echo, because the runtime is what resolves the name.
 */
export function breakpointReply(ctx: PathContext, list: readonly BreakpointSpec[], echo: readonly DebugBreakpointEcho[] | undefined): Record<string, unknown>[] {
  return list.map((bp) => {
    const e = echo?.find((x) => (bp.function !== undefined ? x.function === bp.function : x.function === undefined && x.path === bp.path && x.line === bp.line && (x.condition ?? '') === (bp.condition ?? '')));
    const out: Record<string, unknown> = {};
    if (bp.function !== undefined) out.function = bp.function;
    // an unresolved function spec is echoed as `{path: "", line: 0}`: that is not a file and not a line
    const file = bp.path ?? (e?.path || undefined) ?? (e?.fileId ? ctx.runFiles().find((f) => f.fileId === e.fileId)?.path : undefined);
    if (file) out.file = displayFile(ctx, file);
    const line = bp.line ?? e?.resolvedLine ?? (e?.line || undefined);
    if (line) out.line = line;
    if (bp.condition) out.condition = bp.condition;
    if (e) {
      if (e.rid !== undefined) out.rid = e.rid;
      if (e.fileId !== undefined) out.fileId = e.fileId;
      if (e.resolvedLine !== undefined) out.resolvedLine = e.resolvedLine;
      if (e.error) out.error = e.error;
    }
    return out;
  });
}

/**
 * `continue --to FILE:LINE`: the `to` field of a `continue` request as an absolute file and line.
 * Undefined when the request does not ask for one; a `to` that names no line is an error the
 * caller reports, because silently continuing to the next breakpoint is the wrong answer.
 */
export function parseTo(ctx: PathContext, value: unknown, exists?: (p: string) => boolean): { file: string; line: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  const line = int(o.line);
  if (line === undefined || line < 1) return undefined;
  return { file: resolveFile(ctx, o.file ?? o.path, exists), line };
}

/**
 * `break --at NAME` and `--at FILE:LINE`: the `at` field of a request. A function name becomes a
 * `{function}` spec the runtime resolves; `FILE:LINE` becomes an ordinary breakpoint item.
 */
export function parseAtItem(ctx: PathContext, value: unknown, exists?: (p: string) => boolean): { function: string } | BreakItem | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const spec = parseAt(value);
  if (!spec) return undefined;
  if ('function' in spec) return { function: spec.function };
  return { path: resolveFile(ctx, spec.file, exists), line: spec.line };
}

/** The `exceptions` field of a request: the mode it asks for, or undefined when it does not ask. */
export function exceptionMode(value: unknown): ExceptionMode | undefined {
  return value === 'off' || value === 'uncaught' || value === 'raised' ? value : undefined;
}

/** `paused` as the bridge sends it: the runtime's info plus the absolute `file`, the breakpoint's `file` relative, values redacted. */
export function pausedReply(ctx: PathContext, info: PausedInfo): Record<string, unknown> {
  const file = ctx.runFiles().find((f) => f.fileId === info.fileId)?.path ?? ctx.filePath;
  const out: Record<string, unknown> = { ...info, file };
  if (info.breakpoint) out.breakpoint = { ...info.breakpoint, ...(info.breakpoint.path ? { file: displayFile(ctx, info.breakpoint.path) } : {}) };
  if (info.watch) out.watch = { ...info.watch, text: redact(info.watch.text) };
  if (info.conditionError) out.conditionError = redact(info.conditionError);
  if (info.exception) out.exception = { ...info.exception, message: redact(info.exception.message) };
  return out;
}

/**
 * What the program printed so far as a stop reply carries it: the last `limit` characters of
 * stdout and stderr as the runtime interleaved them, redacted; `truncated` says the head was cut.
 */
export function outputTail(output: string, limit = OUTPUT_TAIL): { text: string; truncated: boolean } {
  const truncated = output.length > limit;
  return { text: redact(truncated ? output.slice(output.length - limit) : output), truncated };
}

/**
 * The frame's variables: name and text, plus the shape the runtime's value node gives (`type`, and
 * `length` for a sized value) so a reader can say "a list of 2" without the whole bag. A masked
 * value keeps its name and its masked text only.
 */
export function localsReply(vars: readonly LocalVar[], valueBag: boolean): Record<string, unknown>[] {
  return vars.map((v) => {
    const out: Record<string, unknown> = { name: v.name, text: redact(v.text) };
    const node = v.valueBag?.data;
    if (node && !node.secret) {
      out.type = node.type;
      if (typeof node.length === 'number') out.length = node.length;
    }
    if (valueBag && v.valueBag) out.valueBag = redactValueBag(v.valueBag);
    return out;
  });
}

export function nextWatchId(existing: readonly BreakWatchSpec[]): string {
  let max = 0;
  for (const w of existing) {
    const m = /^w(\d+)$/.exec(w.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `w${max + 1}`;
}

/** `add` / `set` items without `breakWhen`: displayed watch expressions (the panel's), evaluated at the current step. */
export function displayWatchItems(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const exp = typeof o.exp === 'string' ? o.exp.trim() : '';
    if (exp && o.breakWhen === undefined) out.push(exp);
  }
  return out;
}

/** A value node's one-line text when the runtime's repr is not at hand: scalars print their value, the rest their type. */
export function nodeText(node: { value?: unknown; type?: string } | undefined): string | undefined {
  if (!node) return undefined;
  if (node.value !== undefined && node.value !== null) return String(node.value);
  return node.type;
}

/** The session's break-when watches after `set` / `add` / `remove`; ids `w1`, `w2`, ... when the request has none. Items without `breakWhen` are displayed watches (`displayWatchItems`). */
export function applyWatchRequest(current: readonly BreakWatchSpec[], req: Request): BreakWatchSpec[] {
  let next = current.map((w) => ({ ...w }));
  const parse = (items: unknown, base: readonly BreakWatchSpec[]): BreakWatchSpec[] => {
    if (!Array.isArray(items)) return [];
    const out: BreakWatchSpec[] = [];
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const o = it as Record<string, unknown>;
      const exp = typeof o.exp === 'string' ? o.exp.trim() : '';
      if (!exp || (o.breakWhen !== 'true' && o.breakWhen !== 'change')) continue;
      const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : nextWatchId([...base, ...out]);
      out.push({ id, exp, breakWhen: o.breakWhen === 'true' ? 'true' : 'change' });
    }
    return out;
  };
  if (Array.isArray(req.set)) next = parse(req.set, []);
  if (Array.isArray(req.add)) next = [...next, ...parse(req.add, next)];
  if (Array.isArray(req.remove)) {
    const ids = new Set(req.remove.map(String));
    next = next.filter((w) => !ids.has(w.id));
  }
  return next;
}

