import type { Range4, ValueBag } from '../shared/protocol';

export type RunMode = 'auto' | 'onSave' | 'onDemand';
export type SessionStatus = 'idle' | 'running' | 'done' | 'failed';

export interface WatchEntry {
  id: string;
  exp: string;
  range?: Range4;
  fileId?: number;
  /** step -> value (filled by `watch` events for the requested window) */
  values: Map<number, { valueBag?: ValueBag; text?: string; error?: string; note?: string; needsRun?: boolean }>;  // `text` when the value came from the paused frame or a recorded variable (the runtime's repr); `note` says where a recorded one comes from; `needsRun`: one run of the file would record it
}

/** Time Machine state kept on the session so decorations and the panel can read it. */
export interface NavState {
  active: boolean;
  currentStep: number;
  autoPlaying: boolean;
  deadEnd: boolean;
  showCallStack: boolean;
  selectedFrame: number;
  codePreview: boolean;
  echo: boolean;
  /** cached echo steps for the current step */
  echoSteps: number[];
  /** Auto Log was switched on by the Time Machine and must be switched off when it stops */
  autoLogByTimeMachine?: boolean;
  /** the last traceContext sent to the runner (for watch windows) */
  requestedStep?: number;
  prefetch: number;
}

export function freshNavState(): NavState {
  return { active: false, currentStep: -1, autoPlaying: false, deadEnd: false, showCallStack: false, selectedFrame: 0, codePreview: true, echo: true, echoSteps: [], prefetch: 10 };
}
