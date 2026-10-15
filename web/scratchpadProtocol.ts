/**
 * The Scratchpad's shapes: the agent command (`ctl scratchpad ...`, MCP `pyokka_scratchpad`), the
 * state the page answers with, and a saved version. Inputs and Mocks are Python source text: Inputs
 * are assignments (`items = [1, 2]`), Mocks one dict `{target: value}` that unittest.mock applies.
 */

export const SCRATCH_OPS = ['open', 'experiment', 'create', 'state', 'update', 'run', 'restore', 'close', 'save', 'list', 'load', 'history', 'say'] as const;
export type ScratchOp = (typeof SCRATCH_OPS)[number];

export interface ScratchCommand {
  op: ScratchOp;
  id?: string;
  title?: string;
  /** load, history: a saved version; omitted, the latest */
  version?: number;
  /** open, experiment: the line whose function is copied (default: the paused frame's line); say: the line of the scratchpad's code the bubble goes under (default: its cursor line) */
  line?: number;
  /** say: an explanation shown in a bubble under `line` of the scratchpad's code; empty clears it */
  text?: string;
  code?: string;
  /** source text, or {name: Python expression} written as `name = expression` lines */
  inputs?: string | Record<string, string>;
  /** source text of one dict, or {target: Python expression} */
  mocks?: string | Record<string, string>;
  autoRun?: boolean;
}

/** What scratchpad_child.py reports (python/pyokka_runtime/scratchpad.py). */
export interface ScratchResult {
  values: { name: string; line: number; value: string; type: string }[];
  result?: string;
  output: string;
  error?: { type: string; message: string; stage: string; line?: number };
  traceback?: string;
  /** unavailable pause values the experiment touched */
  missing?: string[];
  mocks?: { target: string; calls: number }[];
  caps?: { values: boolean; output: boolean };
  sandbox?: ScratchSandbox;
  isolation?: string;
}

export interface ScratchSandbox {
  network: 'denied' | 'open';
  how: string;
}

export interface ScratchProvenance {
  file: string;
  line: number | null;
  function: string | null;
  runId: string;
  step: number;
  frame: number;
}

export interface ScratchState {
  id: string | null;
  title: string;
  open: boolean;
  file: string;
  code: string;
  inputs: string;
  mocks: string;
  /** pause values a fresh process cannot rebuild, by name, with the reason */
  unavailable: Record<string, string>;
  autoRun: boolean;
  revision: number;
  status: 'empty' | 'dirty' | 'scheduled' | 'running' | 'completed' | 'error' | 'closed';
  result: ScratchResult | null;
  error: string | null;
  provenance: ScratchProvenance | null;
  savedVersion: number;
  loadedVersion: number | null;
  saveError: string | null;
  sandbox: ScratchSandbox | null;
  /** an agent's explanation under a line of the scratchpad's code (op say), null when none */
  explainer?: { text: string; line: number } | null;
  /** the scratchpad never moves the paused program */
  liveExecutionChanged: false;
  scratchpads?: ScratchSummary[];
  history?: ScratchSummary[];
  entry?: ScratchEntry;
}

/** What Restore puts back: the copy as it was made. */
export interface ScratchBaseline {
  code: string;
  inputs: string;
  mocks: string;
}

export interface ScratchEntry {
  id: string;
  title: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  reason: string;
  state: ScratchState;
  baseline: ScratchBaseline;
}

export interface ScratchSummary {
  id: string;
  title: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  reason: string;
  file: string;
  status: ScratchState['status'];
  error: string | null;
}
