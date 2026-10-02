/**
 * The constants and small helpers the DAP translator shares with its replay half: the
 * capabilities, the one thread, and how a pause, a frame id and a path read. No vscode import.
 */
import type { CompletionKind, ValueNode } from '../shared/protocol';
import { exceptionText, type ExceptionMode, type PausedInfo } from '../session/debugState';
import type { DapCapabilities, DapStoppedBody } from './dapTypes';

/** the debugger type of every Pyokka debug session: the debugger, a recording run and the Time Machine's replay */
export const DEBUG_TYPE = 'pyokka';

export const THREAD_ID = 1;

export const CAPABILITIES: DapCapabilities = {
  supportsConfigurationDoneRequest: true,
  supportsEvaluateForHovers: true,
  supportsConditionalBreakpoints: true,
  supportsSetVariable: true,
  supportTerminateDebuggee: true,
  supportsTerminateRequest: true,
  supportsStepBack: false,
  supportsRestartRequest: true,
  supportsCompletionsRequest: true,
  completionTriggerCharacters: ['.'],
  exceptionBreakpointFilters: [
    { filter: 'uncaught', label: 'Uncaught Exceptions', default: true },
    { filter: 'raised', label: 'Raised Exceptions', default: false },
  ],
  supportsExceptionInfoRequest: true,
  supportsFunctionBreakpoints: true,
};

/** The mode `exceptionBreakpointFilters` declares: what the session already does without being told. */
export const DEFAULT_EXCEPTION_MODE: ExceptionMode = 'uncaught';

/** the runtime's completion kinds as DAP `CompletionItemType`s */
export const DAP_COMPLETION_TYPES: Record<CompletionKind, string> = {
  variable: 'variable',
  attribute: 'field',
  function: 'function',
  method: 'method',
  property: 'property',
  class: 'class',
  module: 'module',
  builtin: 'function',
  keyword: 'keyword',
};

/** `initialize` for a session that can replay (a recording): the debug toolbar shows Step Back and Reverse Continue */
export const REPLAY_CAPABILITIES: DapCapabilities = { ...CAPABILITIES, supportsStepBack: true };

const REASONS: Record<PausedInfo['reason'], string> = { start: 'entry', breakpoint: 'breakpoint', step: 'step', watch: 'data breakpoint', pause: 'pause', exception: 'exception' };

/** The `stopped` event of a live pause at `where` (`helper.py:13`). */
export function pausedBody(info: PausedInfo, where: string): DapStoppedBody {
  const body: DapStoppedBody = { reason: REASONS[info.reason] ?? info.reason, threadId: THREAD_ID, allThreadsStopped: true, description: `Paused at ${where} (${describe(info)})` };
  if (info.watch) body.text = `${info.watch.exp} → ${info.watch.text}`;
  if (info.conditionError) body.text = info.conditionError;
  if (info.exception) body.text = `${info.exception.type}: ${info.exception.message}`;
  return body;
}

/**
 * The `stopped` event of a Time Machine move to a recorded step. No `preserveFocusHint`: with it
 * VS Code focuses no stack frame, and the Variables view of the side bar stays empty (measured in
 * VS Code 1.140). The cost is that the editor takes the focus at each move, as at any debugger stop.
 */
export function replayStoppedBody(step: number, where: string): DapStoppedBody {
  return { reason: 'step', threadId: THREAD_ID, allThreadsStopped: true, description: `Time Machine at step ${step}, ${where}` };
}

export function describe(info: PausedInfo): string {
  switch (info.reason) {
    case 'start':
      return 'start';
    case 'step':
      return `step ${info.kind ?? 'into'}`;
    case 'breakpoint':
      return info.breakpoint?.condition ? `breakpoint if ${info.breakpoint.condition}` : 'breakpoint';
    case 'watch':
      return info.watch ? `watch ${info.watch.exp}: ${info.watch.text}` : 'watch';
    case 'exception':
      return info.exception ? exceptionText(info.exception) : 'exception';
    default:
      return info.reason;
  }
}

export function hasChildren(node: ValueNode): boolean {
  return !!(node.props && node.props.length) || !!node.expandable || !!node.loadActionNode;
}

export function summary(node: ValueNode): string {
  return node.length !== undefined ? `${node.type} · ${node.length}` : node.type;
}

/** A DAP frame id (1-based here) as an index into the pause's frame chain. */
export function frameIndex(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 1 ? n - 1 : 0;
}

export function source(path: string | undefined): { name: string; path: string } | undefined {
  return path ? { name: basename(path) ?? path, path } : undefined;
}

export function basename(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}
