/**
 * WALKTHROUGH section of the Output view: what happened, in order, one row per moment (step,
 * sentence, the values that mattered, the gloss when narrated). Clicking a moment moves the
 * Time Machine to its step; the active moment follows the current step and past ones dim.
 */
import type { PanelMoment, WalkthroughPanel } from '../src-shared';
import { Icon, IconButton, Repr } from './ui';

export interface WalkthroughProps {
  model: WalkthroughPanel | null;
  /** the Time Machine's current step, or null while it is inactive */
  currentStep: number | null;
  open: boolean;
  onToggle: () => void;
  onGoto: (step: number) => void;
  onNarrate: () => void;
  onOpen: (fileId: number, line: number, sideView: boolean) => void;
  /** also called on a click (the Execution Diagram selects the moment's node) */
  onSelectMoment?: (moment: PanelMoment) => void;
}

const KIND_ICON: Record<PanelMoment['kind'], string> = {
  start: 'play',
  end: 'debug-stop',
  call: 'arrow-right',
  tool: 'plug',
  decision: 'git-branch',
  value: 'symbol-variable',
  print: 'output',
  error: 'error',
};

/** Index of the moment the Time Machine is at: the last one whose step is at or before `step`. */
export function activeMomentIndex(moments: readonly PanelMoment[], step: number | null): number {
  if (step === null) return -1;
  let active = -1;
  for (let i = 0; i < moments.length; i++) if (moments[i]!.step <= step) active = i;
  return active;
}

export function Walkthrough({ model, currentStep, open, onToggle, onGoto, onNarrate, onOpen, onSelectMoment }: WalkthroughProps) {
  const moments = model?.moments ?? [];
  const active = activeMomentIndex(moments, currentStep);
  const narrated = moments.some((m) => m.gloss);
  const narrateTitle = !model ? 'Narrate: run the file first' : model.narrating ? 'Narrating… (one model call)' : !model.canNarrate ? 'Narrate: install claude or codex, set pyokka.explain.command, or sign in to Copilot' : narrated ? 'Narrated (one model call per run)' : 'Narrate: one model call adds a sentence per moment';
  return (
    <section class={`pk-pane pk-walkthrough${open ? '' : ' collapsed'}`} aria-label="Walkthrough">
      <header class="pk-pane-header" onClick={onToggle}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} class="pk-twistie" />
        <span class="pk-pane-title">
          WALKTHROUGH {model && <span class="pk-count">{model.shown < model.total ? `${model.shown} of ${model.total}` : model.total}</span>}
        </span>
        <span class="pk-toolbar">
          <IconButton icon="sparkle" title={narrateTitle} spin={!!model?.narrating} active={narrated} disabled={!model || model.narrating || !model.canNarrate || narrated} onClick={onNarrate} />
        </span>
      </header>
      {open && (
        <div class="pk-walkthrough-body">
          {model?.narrationError && (
            <div class="pk-notice pk-walkthrough-error" role="status">
              <Icon name="warning" />
              <span class="pk-notice-text">Narration failed: {model.narrationError}</span>
            </div>
          )}
          {!model || moments.length === 0 ? (
            <div class="pk-empty small">NO RUN YET</div>
          ) : (
            <div class="pk-walkthrough-list" role="list">
              {moments.map((m, i) => (
                <div
                  key={m.id}
                  role="listitem"
                  data-step={m.step}
                  class={`pk-moment kind-${m.kind}${i === active ? ' active' : ''}${active >= 0 && i < active ? ' past' : ''}`}
                  onClick={() => {
                    onSelectMoment?.(m);
                    onGoto(m.step);
                  }}
                  title={`Step ${m.step} · ${m.file}:${m.line} · click to move the Time Machine here`}
                >
                  <span class="pk-moment-step">#{m.step}</span>
                  <Icon name={KIND_ICON[m.kind]} class="pk-moment-icon" />
                  <div class="pk-moment-main">
                    <div class="pk-moment-text">
                      <span class="pk-moment-sentence">{m.text}</span>
                      <a
                        href="#"
                        class="pk-moment-loc"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onOpen(m.fileId, m.line, false);
                        }}
                      >
                        {m.file}:{m.line}
                      </a>
                    </div>
                    {m.values.filter((v) => v.role !== 'value').length > 0 && (
                      <div class="pk-moment-values">
                        {m.values
                          .filter((v) => v.role !== 'value')
                          .slice(0, 8)
                          .map((v, k) => (
                            <span key={k} class={`pk-moment-value role-${v.role}`}>
                              <span class="pk-moment-role">{v.role}</span> <Repr text={`${v.name} = ${v.text}`} />
                            </span>
                          ))}
                      </div>
                    )}
                    {m.gloss && <div class="pk-moment-gloss">{m.gloss}</div>}
                    {m.more ? <div class="pk-moment-more">≡ {m.more} more like this</div> : null}
                  </div>
                </div>
              ))}
              {model.truncated && <div class="pk-moment-more pk-walkthrough-truncated">… {model.total - model.shown} more moments; `pyokka walkthrough --from N --to M` lists a window</div>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
