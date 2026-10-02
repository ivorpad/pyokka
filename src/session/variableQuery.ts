/**
 * Host side of the variable history and the provenance tree: the source of a file of the run,
 * the statement bindings asked of the runner (cached on the run state, so a re-run starts
 * clean), and the queries that feed them to the pure builders in variableHistory.ts and
 * provenance.ts. Used by the panel's Variable pane and "why" tree, the Show Variable History and
 * Why This Value commands and the bridge's `var` and `why` requests.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import type { Provenance, StatementBinding, VariableHistory } from '../shared/protocol';
import type { Session } from './session';
import { indexBindings, matchesName, variableHistory, type HistoryOptions } from './variableHistory';
import { provenance } from './provenance';
import { log } from '../util/log';

/** Files whose bindings one query fetches at most: the main file, the project files and the files where the name was recorded. */
export const BINDINGS_FILE_CAP = 40;

/** Source lines of a file of the run: the content that ran for the main file, the editor buffer or the disk for the others. */
export function sourceLines(session: Session, fileId: number): string[] | undefined {
  if (fileId === session.mainFileId()) return session.state.content.split(/\r?\n/);
  const uri = session.uriForFileId(fileId);
  if (!uri) return undefined;
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (doc) return doc.getText().split(/\r?\n/);
  if (uri.scheme !== 'file') return undefined;
  try {
    return fs.readFileSync(uri.fsPath, 'utf8').split(/\r?\n/);
  } catch {
    return undefined;
  }
}

/** What each statement of a file of the run assigns and reads, by global range id; asked of the runner once per run and file. */
export function bindingsFor(session: Session, fileId: number): Promise<ReadonlyMap<number, StatementBinding> | undefined> {
  const st = session.state;
  let pending = st.bindings.get(fileId);
  if (!pending) {
    pending = (async (): Promise<ReadonlyMap<number, StatementBinding> | undefined> => {
      const file = st.files.get(fileId);
      const lines = sourceLines(session, fileId);
      if (!file || !lines || session.isDisposed) return undefined;
      try {
        return indexBindings(file, await session.runner.bindings(lines.join('\n')));
      } catch (err) {
        log.info(`[${session.displayName}] bindings for ${session.displayPath(fileId)}: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    })();
    st.bindings.set(fileId, pending);
  }
  return pending;
}

/**
 * The bindings a query about `name` needs: the main file, the instrumented project files, `extra`
 * (the file of a queried step) and the files where the name was recorded, capped. Undefined when
 * a new run replaced the state meanwhile.
 */
async function bindingsForQuery(session: Session, name: string, extra?: number): Promise<Map<number, ReadonlyMap<number, StatementBinding>> | undefined> {
  const st = session.state;
  const trace = st.trace;
  if (!trace) return undefined;
  const main = session.mainFileId();
  const wanted = new Set<number>();
  if (main !== undefined) wanted.add(main);
  for (const f of st.files.all()) if (f.instrumentedSource !== undefined) wanted.add(f.fileId);
  if (extra !== undefined && extra >= 0) wanted.add(extra);
  for (const entry of st.locals) {
    if (!entry.changes.some((c) => matchesName(c.name, name))) continue;
    const loc = trace.location(entry.step);
    if (loc) wanted.add(loc.fileId);
  }
  for (const [rid, entries] of st.entriesByRid) {
    if (!entries.some((e) => matchesName(e.context, name))) continue;
    const loc = st.files.locate(rid);
    if (loc) wanted.add(loc.fileId);
  }
  const bindings = new Map<number, ReadonlyMap<number, StatementBinding>>();
  await Promise.all(
    [...wanted].slice(0, BINDINGS_FILE_CAP).map(async (fileId) => {
      const table = await bindingsFor(session, fileId);
      if (table) bindings.set(fileId, table);
    }),
  );
  if (session.state !== st || session.isDisposed) return undefined;
  return bindings;
}

/**
 * Every recorded change of a variable (docs/PROTOCOL.md, "Variable history"): recorded locals,
 * logged values whose context is the name, and the statements that assign it. Undefined without
 * a trace, or when a new run replaced the state meanwhile.
 */
export async function sessionVariableHistory(session: Session, name: string, opts: HistoryOptions = {}): Promise<VariableHistory | undefined> {
  const st = session.state;
  const trace = st.trace;
  if (!trace) return undefined;
  const bindings = await bindingsForQuery(session, name);
  if (!bindings) return undefined;
  return variableHistory({ trace, files: st.files, entriesByRid: st.entriesByRid, locals: st.locals, bindings, mainFileId: session.mainFileId() }, name, opts);
}

/**
 * Why `name` had its value after `step` (docs/PROTOCOL.md, "Provenance"; an empty name explains
 * the statement). The inputs are the walkthrough's (the same fields `walkthroughInputs` in
 * bridgeSupport.ts builds, without the run's end, which the tree does not read) plus the
 * bindings and the entries by range id. Undefined without a trace, or when a new run replaced
 * the state meanwhile.
 */
export async function sessionProvenance(session: Session, step: number, name: string, depth?: number): Promise<Provenance | undefined> {
  const st = session.state;
  const trace = st.trace;
  if (!trace) return undefined;
  const bindings = await bindingsForQuery(session, name, trace.location(step)?.fileId);
  if (!bindings) return undefined;
  return provenance(
    {
      trace,
      files: st.files,
      entries: st.entries,
      locals: st.locals,
      errors: st.errors,
      mainFile: session.filePath,
      workspaceRoot: session.workspaceRoot,
      readSource: (fileId) => sourceLines(session, fileId),
      entriesByRid: st.entriesByRid,
      bindings,
      mainFileId: session.mainFileId(),
      ...(st.midRun ? { midRun: true } : {}),
    },
    { step, name, depth },
  );
}
