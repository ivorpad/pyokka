/**
 * The code an agent's reply carries, as the CLI's stops print it: the enclosing function with the
 * current line marked (`current`). A recording move gets the context slice's block, each line with
 * the step it ran at; a live pause gets the debugger's stop block. A reply that holds it can be
 * explained as it stands, without reading the file again.
 */
import { contextSliceForStep, type SliceBlock } from '../src/session/contextSlice';
import { stopBlock } from '../src/debug/stopBlock';
import type { PageHost } from './pageHost';

/** The block of the live pause; undefined while the program runs or its file cannot be read. */
export async function liveBlock(host: PageHost): Promise<SliceBlock | undefined> {
  const d = host.debug;
  const p = d.paused;
  const run = d.run;
  if (!d.active || !p || p.line === null || !run) return undefined;
  const path = d.pathOf(p.fileId);
  if (!path) return undefined;
  // the main file as this debug run executes it; any other file as the bridge reads it
  const lines = path === host.main?.path ? run.content.split(/\r?\n/) : await host.fetchPath(path);
  if (!lines) return undefined;
  return stopBlock({ paused: p, pathForFileId: (id) => d.pathOf(id), readSource: () => lines, functionAt: (id, line) => run.files.functionAt(id, line) });
}

/** The block around the Time Machine's step; undefined while it is off. */
export async function recordingBlock(host: PageHost): Promise<SliceBlock | undefined> {
  const run = host.run;
  const trace = run?.trace;
  if (!run || !trace || !host.nav.active) return undefined;
  const step = host.nav.step;
  if (!trace.valid(step)) return undefined;
  const loc = trace.location(step);
  if (!loc) return undefined;
  const lines = await host.fetchSource(loc.fileId);
  if (!lines) return undefined;
  const inputs = { trace, files: run.files, entriesByRid: run.logsByRid, coverage: run.coverage, errors: run.errors, readSource: (id: number) => (id === loc.fileId ? lines : undefined) };
  return contextSliceForStep(inputs, step)?.block;
}

/** `reply` with the block of the surface it describes: the live pause while the debugger has a run (or `live` asks for it), else the recording. */
export async function withBlock<T extends object>(host: PageHost, reply: T, surface: 'live' | 'active' = 'active'): Promise<T & { block?: SliceBlock }> {
  const block = surface === 'live' || host.debug.active ? await liveBlock(host) : await recordingBlock(host);
  return block ? { ...reply, block } : reply;
}
