/**
 * VARIABLE pane: the history of one name, every step where it changed with the new value and
 * what the statement read. A row moves the Time Machine to its step; a read name becomes the
 * next query, so the user walks backwards one statement at a time. A recorded row's "Full
 * value" replays the run and shows the copy under the row, where opening it moves nothing.
 */
import { useEffect, useState } from 'preact/hooks';
import type { PanelSettings, VariableChange, VariableView } from '../src-shared';
import type { FullValueView } from '../../src/shared/replayProtocol';
import { Icon, IconButton, Repr, SourceLink } from './ui';
import { FullValue } from './FullValue';

/** What a "Full value" button asks the host (`fullValue.query` without its type). */
export interface FullValueAsk {
  key: string;
  kind: 'change' | 'at';
  step: number;
  name: string;
  scopeId?: number;
  text?: string;
}

/** The pane's key for a row's full value: one per recorded change. */
export function changeKey(c: Pick<VariableChange, 'step' | 'scopeId' | 'name'>): string {
  return `change:${c.step}:${c.scopeId}:${c.name}`;
}

/** A row whose value the recorder kept can be replayed for the whole of it. */
export function canAskFull(c: Pick<VariableChange, 'source' | 'text'>): boolean {
  return c.source === 'locals' && c.text !== undefined;
}

export interface VariablePaneProps {
  view: VariableView | null;
  /** the run's phase and the step the Time Machine shows (inspection.ts), while it is on */
  inspection?: string;
  settings: PanelSettings;
  showFileName: boolean;
  /** ask the host for a name's history; an empty name clears the pane */
  onQuery: (name: string) => void;
  /** Time Machine to a step (starts it when needed) */
  onGoto: (step: number) => void;
  onOpen: (fileId: number, line: number, col: number, sideView: boolean) => void;
  /** the row's "Why" button: the provenance of the value the row's statement produced (`logId` when a logged value backs the row) */
  onWhy: (step: number, name: string, logId?: string) => void;
  /** switch the session's Record Variable Changes on */
  onEnableRecordLocals: () => void;
  onClose: () => void;
  /** replayed full values by key (`changeKey`); absent: the host has no replay (the browser page) */
  fullValues?: Record<string, FullValueView>;
  onFull?: (ask: FullValueAsk) => void;
}

export function VariablePane(props: VariablePaneProps) {
  const queried = props.view?.name ?? '';
  const [text, setText] = useState(queried);
  // a query the host started (the Show Variable History command) or a read the user clicked lands in the input
  useEffect(() => {
    setText(queried);
  }, [queried]);
  const submit = (): void => props.onQuery(text.trim());
  const history = props.view?.history ?? null;
  return (
    <section class="pk-pane pk-variable" aria-label="Variable">
      <header class="pk-pane-header">
        <span class="pk-pane-title">
          VARIABLE {history && <span class="pk-count">{history.total}</span>}
        </span>
        {props.inspection && <span class="pk-inspection">{props.inspection}</span>}
        <span class="pk-toolbar">
          <IconButton icon="close" title="Close" onClick={props.onClose} />
        </span>
      </header>
      <div class="pk-variable-body">
        <form
          class="pk-variable-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            class="pk-input"
            type="text"
            value={text}
            placeholder="Variable name: dt, self.balance, r.output_parsed.date"
            spellcheck={false}
            aria-label="Variable name"
            onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
          />
          <IconButton icon="search" title="Show history" onClick={submit} />
        </form>
        {!props.settings.recordLocals && (
          <p class="pk-caption pk-caption-sub">
            Only logged values and assignment sites are known.{' '}
            <a
              href="#"
              class="pk-link"
              onClick={(e) => {
                e.preventDefault();
                props.onEnableRecordLocals();
              }}
            >
              Record Variable Changes
            </a>{' '}
            records every change on the next run.
          </p>
        )}
        <VariableBody {...props} />
      </div>
    </section>
  );
}

function VariableBody(props: VariablePaneProps) {
  const view = props.view;
  if (!view || !view.name) return <p class="pk-caption pk-caption-sub pk-variable-hint">Type a name above, or put the cursor on one and run "Pyokka: Show Variable History".</p>;
  if (view.error) {
    return (
      <div class="pk-notice" role="status">
        <Icon name="warning" />
        <span class="pk-notice-text">{view.error}</span>
      </div>
    );
  }
  const history = view.history;
  if (!history) return <div class="pk-empty small">LOOKING UP {view.name}…</div>;
  if (history.changes.length === 0) {
    return (
      <p class="pk-caption pk-caption-sub pk-variable-hint">
        No recorded change of <code>{view.name}</code>: no statement that assigns it ran, and no value was logged under that name.
        {!history.recordedLocals && ' The run recorded no locals; Record Variable Changes captures every change on the next run.'}
      </p>
    );
  }
  return (
    <div class="pk-list pk-variable-list" role="list">
      {history.changes.map((c) => (
        history.pauses ? (
          <PauseRow key={`${c.step}:${c.name}`} change={c} showFileName={props.showFileName} />
        ) : (
          <ChangeRow key={`${c.step}:${c.name}`} change={c} showFileName={props.showFileName} onGoto={props.onGoto} onOpen={props.onOpen} onQuery={props.onQuery} onWhy={props.onWhy} full={props.fullValues?.[changeKey(c)]} onFull={props.onFull} />
        )
      ))}
      {history.truncated && (
        <p class="pk-caption pk-caption-sub pk-variable-hint">
          {history.total - history.changes.length} more changes; the CLI narrows them: <code>pyokka var --live {view.name} --file F</code>.
        </p>
      )}
    </div>
  );
}

/** A value at a live debugger pause (the browser page): no step to go to and no trace to ask Why. */
function PauseRow({ change: c, showFileName }: { change: VariableChange; showFileName: boolean }) {
  const where = `${showFileName ? c.file : c.file.split(/[\\/]/).pop()}:${c.line}`;
  return (
    <div class="pk-variable-change" role="listitem">
      <div class="pk-row pk-variable-row" title={`The value at pause ${c.step} of the live debugger, ${c.file}:${c.line}`}>
        <span class="pk-variable-step">pause {c.step}</span>
        <span class="pk-variable-what">
          <span class="pk-variable-name">{c.name}</span>
          {' = '}
          <Repr text={c.text ?? ''} />
        </span>
        <span class="pk-variable-fn">{c.function}</span>
        <span class="pk-dim">{where}</span>
      </div>
    </div>
  );
}

function ChangeRow({ change: c, showFileName, onGoto, onOpen, onQuery, onWhy, full, onFull }: { change: VariableChange; showFileName: boolean; onGoto: (step: number) => void; onOpen: VariablePaneProps['onOpen']; onQuery: (name: string) => void; onWhy: VariablePaneProps['onWhy']; full?: FullValueView; onFull?: (ask: FullValueAsk) => void }) {
  const ask = onFull && canAskFull(c) ? (): void => onFull({ key: changeKey(c), kind: 'change', step: c.step, name: c.name, scopeId: c.scopeId, text: c.text }) : undefined;
  return (
    <div class="pk-variable-change" role="listitem">
      <div class="pk-row pk-variable-row" title={`Time Machine to step ${c.step}`} onClick={() => onGoto(c.step)}>
        <span class="pk-variable-step">#{c.step}</span>
        <span class="pk-variable-what">
          <span class="pk-variable-name">{c.name}</span>
          {c.text !== undefined ? (
            <>
              {' = '}
              <Repr text={c.text} />
              {c.unchanged && <span class="pk-dim"> (unchanged)</span>}
            </>
          ) : (
            <span class="pk-dim"> assigned here (value not recorded)</span>
          )}
        </span>
        <span class="pk-variable-fn">{c.function}</span>
        <SourceLink file={c.file} line={c.line} col={0} showFile={showFileName} onOpen={(side) => onOpen(c.fileId, c.line, 0, side)} />
        {ask && (
          <IconButton
            icon="list-tree"
            title={`Full value of ${c.name}: replays the run in a separate process up to this step and copies all of it (network answers come from the HTTP recording; files it writes are written again)`}
            class="pk-full-btn"
            spin={full?.status === 'pending'}
            onClick={ask}
          />
        )}
        <IconButton icon="question" title={`Why this value at #${c.step}`} class="pk-why" onClick={() => onWhy(c.step, c.name, c.logId)} />
      </div>
      {c.reads && c.reads.length > 0 && (
        <div class="pk-variable-reads">
          <Icon name="arrow-left" />
          {c.reads.map((r) => (
            <button key={r.name} type="button" class="pk-variable-read" title={`History of ${r.name}`} onClick={() => onQuery(r.name)}>
              <span class="pk-variable-name">{r.name}</span>
              {r.text !== undefined ? (
                <>
                  {' = '}
                  <Repr text={r.text} />
                </>
              ) : (
                <span class="pk-dim"> = ?</span>
              )}
            </button>
          ))}
        </div>
      )}
      {full && <FullValue key={`${full.key}:${full.status}`} view={full} />}
    </div>
  );
}
