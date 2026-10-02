/**
 * The slice of the Debug Adapter Protocol the Pyokka adapter speaks, hand-written so no
 * dependency is needed. Field names follow the specification (microsoft.github.io/debug-adapter-protocol).
 */

export interface DapRequest {
  seq: number;
  type: 'request';
  command: string;
  arguments?: Record<string, unknown>;
}

export interface DapResponse {
  seq: number;
  type: 'response';
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: unknown;
}

export interface DapEvent {
  seq: number;
  type: 'event';
  event: string;
  body?: unknown;
}

export type DapMessage = DapRequest | DapResponse | DapEvent;

export interface DapCapabilities {
  supportsConfigurationDoneRequest: boolean;
  supportsEvaluateForHovers: boolean;
  supportsConditionalBreakpoints: boolean;
  supportsSetVariable: boolean;
  supportTerminateDebuggee: boolean;
  supportsTerminateRequest: boolean;
  supportsStepBack: boolean;
  /** without it VS Code's Restart button terminates the session and relaunches it instead of sending `restart` */
  supportsRestartRequest: boolean;
  /** the Watch pane and the Debug Console ask `completions` while typing */
  supportsCompletionsRequest: boolean;
  completionTriggerCharacters?: string[];
  /** the checkboxes of the Breakpoints view; `setExceptionBreakpoints` reports which are ticked */
  exceptionBreakpointFilters?: DapExceptionBreakpointFilter[];
  /** the "Exception has occurred" banner asks `exceptionInfo` for the type and the message */
  supportsExceptionInfoRequest: boolean;
  /** the Breakpoints view's "Add Function Breakpoint", and what `--at NAME` shows up as */
  supportsFunctionBreakpoints?: boolean;
}

/** One checkbox in the Breakpoints view ("Uncaught Exceptions", "Raised Exceptions"). */
export interface DapExceptionBreakpointFilter {
  filter: string;
  label: string;
  default?: boolean;
}

/** The `exceptionInfo` reply: what the banner over the paused frame shows. */
export interface DapExceptionInfoBody {
  exceptionId: string;
  description?: string;
  breakMode: 'never' | 'always' | 'unhandled' | 'userUnhandled';
  details?: { message?: string; typeName?: string };
}

/** One `completions` target: `start`/`length` say what part of the request's `text` the label replaces. */
export interface DapCompletionItem {
  label: string;
  text?: string;
  type?: string;
  detail?: string;
  start?: number;
  length?: number;
}

export interface DapSource {
  name?: string;
  path?: string;
}

export interface DapStackFrame {
  id: number;
  name: string;
  source?: DapSource;
  line: number;
  column: number;
  presentationHint?: 'normal' | 'label' | 'subtle';
}

export interface DapScope {
  name: string;
  presentationHint?: 'locals';
  variablesReference: number;
  expensive: boolean;
}

export interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  evaluateName?: string;
  indexedVariables?: number;
  namedVariables?: number;
}

export interface DapBreakpoint {
  verified: boolean;
  line?: number;
  message?: string;
}

export interface DapStoppedBody {
  reason: string;
  description?: string;
  threadId: number;
  allThreadsStopped: boolean;
  text?: string;
  /** the client keeps the focus where it is (a Time Machine move from the panel or the Code Story) */
  preserveFocusHint?: boolean;
}
