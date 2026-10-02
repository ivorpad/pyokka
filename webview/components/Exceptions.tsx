/**
 * EXCEPTIONS section of the Output view: every exception the last run raised, where it was raised,
 * where it was caught and how often (docs/PROTOCOL.md, "Exceptions report"). Uncaught rows first;
 * clicking a row moves the Time Machine to the raising step, the locations open the file, and a
 * broad handler (`except:`, `except Exception`) is a badge on its row.
 */
import type { ExceptionRow, ExceptionSite, ExceptionsPanel } from '../src-shared';
import { Icon } from './ui';

export interface ExceptionsProps {
  model: ExceptionsPanel | null;
  open: boolean;
  onToggle: () => void;
  onGoto: (step: number) => void;
  onOpen: (fileId: number, line: number, sideView: boolean) => void;
}

/** The row's icon: uncaught rows look like error entries, a broad handler warns, a specific one passed. */
export function rowIcon(row: ExceptionRow): string {
  if (row.kind === 'uncaught') return 'error';
  return row.handledAt?.broad ? 'warning' : 'pass';
}

function Site({ site, onOpen }: { site: ExceptionSite; onOpen: ExceptionsProps['onOpen'] }) {
  return (
    <>
      <a
        href="#"
        class="pk-exception-loc"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onOpen(site.fileId, site.line, false);
        }}
      >
        {site.file ?? '<unknown>'}:{site.line}
      </a>{' '}
      <span class="pk-exception-fn">{site.function}</span>
    </>
  );
}

function Row({ row, onGoto, onOpen }: { row: ExceptionRow; onGoto: ExceptionsProps['onGoto']; onOpen: ExceptionsProps['onOpen'] }) {
  const broad = !!row.handledAt?.broad;
  return (
    <div
      role="listitem"
      data-step={row.step}
      class={`pk-moment pk-exception kind-${row.kind}${broad ? ' broad' : ''}`}
      onClick={() => onGoto(row.step)}
      title={`Step ${row.step} · ${row.raisedAt.file ?? '<unknown>'}:${row.raisedAt.line} · click to move the Time Machine here`}
    >
      <span class="pk-moment-step">#{row.step}</span>
      <Icon name={rowIcon(row)} class="pk-moment-icon" />
      <div class="pk-moment-main">
        <div class="pk-exception-text">
          <span class="pk-exception-type">{row.errorType}</span>
          {row.message && (
            <>
              : <span class="pk-error-text pk-exception-message">{row.message}</span>
            </>
          )}
          {row.count > 1 && <span class="pk-exception-count">×{row.count}</span>}
        </div>
        <div class="pk-exception-where">
          raised <Site site={row.raisedAt} onOpen={onOpen} />
          {row.kind === 'uncaught' ? (
            <> · uncaught</>
          ) : row.handledAt ? (
            <>
              {' · caught '}
              <Site site={row.handledAt} onOpen={onOpen} />
              {broad && <span class="pk-badge">broad handler</span>}
            </>
          ) : (
            <> · caught outside stepped code</>
          )}
        </div>
      </div>
    </div>
  );
}

export function Exceptions({ model, open, onToggle, onGoto, onOpen }: ExceptionsProps) {
  const rows = model?.rows ?? [];
  return (
    <section class={`pk-pane pk-exceptions${open ? '' : ' collapsed'}`} aria-label="Exceptions">
      <header class="pk-pane-header" onClick={onToggle}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} class="pk-twistie" />
        <span class="pk-pane-title">
          EXCEPTIONS {model && <span class="pk-count">{model.total}</span>}
        </span>
      </header>
      {open && (
        <div class="pk-exceptions-body">
          {!model ? (
            <div class="pk-empty small">NO RUN YET</div>
          ) : rows.length === 0 ? (
            <div class="pk-empty small">NO EXCEPTIONS</div>
          ) : (
            <div class="pk-exceptions-list" role="list">
              {rows.map((row) => (
                <Row key={row.id} row={row} onGoto={onGoto} onOpen={onOpen} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
