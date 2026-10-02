/**
 * HTTP view: one row per request of the run, listed live while it runs, with the initiator as a
 * file:line link (a click on the row moves the Time Machine to the request's step), a footer with
 * the totals and the recording, the mode dropdown and Open recording.
 */
import { useState } from 'preact/hooks';
import type { HttpMode, HttpPanel, HttpTableRow } from '../src-shared';
import { formatBytes, formatRecordedAt, formatSeconds, httpTableSummary } from '../src-shared';
import { HTTP_MODE_LABEL, httpModeItems } from './SettingsView';
import { IconButton, Menu, SourceLink } from './ui';

export interface HttpPaneProps {
  panel: HttpPanel | null;
  /** the session's HTTP mode: the dropdown's current item; `off` offers Replay when a recording exists */
  mode: HttpMode;
  /** Time Machine to a request's step (starts it when needed) */
  onGoto: (step: number) => void;
  onOpen: (fileId: number, line: number, col: number, sideView: boolean) => void;
  onMode: (mode: HttpMode) => void;
  onOpenRecording: () => void;
  onClose: () => void;
}

export function HttpPane({ panel, mode, onGoto, onOpen, onMode, onOpenRecording, onClose }: HttpPaneProps) {
  const [modeOpen, setModeOpen] = useState(false);
  return (
    <section class="pk-pane pk-http" aria-label="HTTP">
      <header class="pk-pane-header">
        <span class="pk-pane-title">
          HTTP {panel && <span class="pk-count">{panel.count}</span>}
        </span>
        <span class="pk-toolbar">
          <span class="pk-menu-anchor">
            <button type="button" class="pk-dropdown pk-http-mode" onClick={() => setModeOpen((o) => !o)}>
              {HTTP_MODE_LABEL[mode]}
              <i class="codicon codicon-chevron-down" />
            </button>
            {modeOpen && <Menu items={httpModeItems(mode, onMode)} onClose={() => setModeOpen(false)} align="right" />}
          </span>
          <IconButton icon="go-to-file" title="Open recording" disabled={!panel?.finished?.file} onClick={onOpenRecording} />
          <IconButton icon="close" title="Close" onClick={onClose} />
        </span>
      </header>
      <HttpBody panel={panel} mode={mode} onGoto={onGoto} onOpen={onOpen} onMode={onMode} />
    </section>
  );
}

function HttpBody({ panel, mode, onGoto, onOpen, onMode }: Pick<HttpPaneProps, 'panel' | 'mode' | 'onGoto' | 'onOpen' | 'onMode'>) {
  if (!panel) return <div class="pk-empty small">No run yet</div>;
  const rows = panel.requests;
  // a finished run without a tally: the plugin never observed the clients
  const untouched = !panel.running && !panel.finished && rows.length === 0;
  const fin = panel.finished;
  return (
    <div class="pk-http-body">
      {panel.running && <div class="pk-empty small">Running…</div>}
      {untouched ? (
        <div class="pk-empty small">HTTP clients untouched (pyokka.httpObserve is off)</div>
      ) : !panel.running && rows.length === 0 ? (
        <div class="pk-empty small">No HTTP requests in this run</div>
      ) : rows.length > 0 ? (
        <div class="pk-list pk-http-list" role="list">
          <div class="pk-row pk-http-row pk-http-head" aria-hidden="true">
            <span class="pk-http-n" />
            <span class="pk-http-name">Name</span>
            <span class="pk-http-method">Method</span>
            <span class="pk-http-status">Status</span>
            <span class="pk-http-initiator">Initiator</span>
            <span class="pk-http-size">Size</span>
            <span class="pk-http-time">Time</span>
            <span class="pk-http-source">Source</span>
          </div>
          {rows.map((r) => (
            <HttpRow key={`${r.n}:${r.source}:${r.ms}`} row={r} running={panel.running} onGoto={onGoto} onOpen={onOpen} />
          ))}
          {panel.truncated && <p class="pk-caption pk-caption-sub pk-http-hint">… {panel.count - rows.length} more requests; `pyokka http --live` lists them all.</p>}
        </div>
      ) : null}
      {(fin || rows.length > 0) && (
        <footer class="pk-http-footer">
          <div class="pk-http-summary">{httpTableSummary(panel)}</div>
          {mode === 'off' && fin?.exists && (
            <div class="pk-http-existing">
              A recording from {fin.recordedAt ? formatRecordedAt(fin.recordedAt) : 'an earlier run'} ({fin.entries ?? '?'} requests) exists ·{' '}
              <a
                href="#"
                class="pk-link"
                onClick={(e) => {
                  e.preventDefault();
                  onMode('replay');
                }}
              >
                Replay
              </a>
            </div>
          )}
        </footer>
      )}
    </div>
  );
}

function HttpRow({ row: r, running, onGoto, onOpen }: { row: HttpTableRow; running: boolean; onGoto: (step: number) => void; onOpen: HttpPaneProps['onOpen'] }) {
  const miss = r.source === 'miss';
  const error = miss || (r.status !== null && r.status >= 400);
  // rows of a run in flight point at steps the trace does not have yet
  const clickable = !running && r.step >= 0;
  const loc = r.location;
  const title = `${r.method} ${r.url}${r.recordedMs !== null ? ` · recorded ${formatSeconds(r.recordedMs)}` : ''}${clickable ? ` · click: Time Machine to step ${r.step}` : ''}`;
  return (
    <div class={`pk-row pk-http-row${error ? ' error' : ''}${clickable ? '' : ' static'}`} role="listitem" title={title} onClick={clickable ? () => onGoto(r.step) : undefined}>
      <span class="pk-http-n">#{r.n}</span>
      <span class="pk-http-name">{r.name}</span>
      <span class="pk-http-method">{r.method}</span>
      <span class={`pk-http-status${error ? ' pk-error-text' : ''}`}>{miss ? 'MISS' : r.status ?? '—'}</span>
      <span class="pk-http-initiator">
        {loc ? <SourceLink file={loc.file} line={loc.line} col={loc.col} showFile onOpen={(side) => onOpen(loc.fileId, loc.line, loc.col, side)} /> : <span class="pk-dim">{r.step >= 0 ? `#${r.step}` : '—'}</span>}
      </span>
      <span class="pk-http-size">{r.bytes === null ? '—' : formatBytes(r.bytes)}</span>
      <span class="pk-http-time">{formatSeconds(r.ms)}</span>
      <span class={`pk-http-source src-${r.source}`}>{r.source}</span>
    </div>
  );
}
