/**
 * TOUR section of the Output view: the run's chapters (`pyokka tour`, docs/TOUR.md) as a map and
 * as folding groups, each chapter's stops as rows. Only the open chapter is expanded; it follows
 * the Time Machine. A stop's values are folded under it. Clicking a stop moves the Time Machine
 * there. Narrate Tour (the sparkle) is one model call that titles and explains the picked stops.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { PanelTourStop, TourPanel } from '../src-shared';
import { chapterStops, EMPTY_FOLD, fmtStep, follow, followedChapter, hereStopId, isChapterOpen, llmLabel, stopsLabel, toggleChapter, type TourFold } from '../tourView';
import { Icon, IconButton, Repr } from './ui';

export interface TourProps {
  model: TourPanel | null;
  /** the Time Machine's current step, or null while it is inactive */
  currentStep: number | null;
  open: boolean;
  onToggle: () => void;
  onGoto: (stop: PanelTourStop) => void;
  onNarrate: () => void;
  onOpen: (fileId: number, line: number, file: string) => void;
  /** the no-locals notice's link: Record Variable Changes on, and one run */
  onRecordLocals: () => void;
}

function narrateTitle(model: TourPanel | null): string {
  if (!model || model.status !== 'ready') return 'Narrate Tour: wait for the tour';
  if (model.narrating) return 'Narrating the tour… (one model call)';
  if (!model.canNarrate) return 'Narrate Tour: install claude or codex, set pyokka.explain.command, or sign in to Copilot';
  if (model.narrated) return 'Narrated (one model call per run)';
  return 'Narrate Tour: one model call picks the stops that tell the story and explains each';
}

export function Tour({ model, currentStep, open, onToggle, onGoto, onNarrate, onOpen, onRecordLocals }: TourProps) {
  const ready = model?.status === 'ready' ? model : null;
  const followed = ready ? followedChapter(ready, currentStep) : null;
  const here = ready ? hereStopId(ready, currentStep) : null;
  const [fold, setFold] = useState<TourFold>(() => follow(EMPTY_FOLD, followed));
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [allIn, setAllIn] = useState<ReadonlySet<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  /** the fold this render shows: a new followed chapter drops the toggles at once, not one render late */
  const shown = follow(fold, followed);

  useEffect(() => setFold(shown), [shown]);
  useEffect(() => {
    if (!open || !here) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-stop="${here}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [here, open, shown]);

  const flip = (set: ReadonlySet<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const count = ready ? (ready.narrated ? ready.stops.filter((s) => s.picked).length : ready.stops.length) : null;
  return (
    <section class={`pk-pane pk-walkthrough pk-tour${open ? '' : ' collapsed'}`} aria-label="Tour">
      <header class="pk-pane-header" onClick={onToggle}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} class="pk-twistie" />
        <span class="pk-pane-title">
          TOUR {count !== null && <span class="pk-count">{ready?.narrated ? `${count} stops` : `${ready?.chapters.length} chapters · ${count} stops`}</span>}
        </span>
        <span class="pk-toolbar">
          <IconButton icon="sparkle" title={narrateTitle(model)} spin={!!model?.narrating} active={!!ready?.narrated} disabled={!ready || ready.narrating || !ready.canNarrate || ready.narrated} onClick={onNarrate} />
        </span>
      </header>
      {open && (
        <div class="pk-walkthrough-body" ref={listRef}>
          {model?.narrationError && (
            <div class="pk-notice pk-walkthrough-error" role="status">
              <Icon name="warning" />
              <span class="pk-notice-text">Narrate Tour failed: {model.narrationError}</span>
            </div>
          )}
          {!model ? (
            <div class="pk-empty small">NO RUN YET</div>
          ) : model.status === 'computing' ? (
            <div class="pk-empty small">COMPUTING THE TOUR…</div>
          ) : model.status === 'error' ? (
            <div class="pk-notice pk-walkthrough-error" role="status">
              <Icon name="warning" />
              <span class="pk-notice-text">No tour: {model.error}</span>
            </div>
          ) : (
            <div class="pk-tour-body">
              {model.noLocals && (
                <div class="pk-notice pk-tour-locals" role="status">
                  <Icon name="info" />
                  <span class="pk-notice-text">
                    This run recorded no variable changes, so calls show no arguments and repeated calls fold into one stop.{' '}
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        onRecordLocals();
                      }}
                    >
                      Record them and run again
                    </a>
                  </span>
                </div>
              )}
              {model.intro && <p class="pk-tour-intro">{model.intro}</p>}
              <ol class="pk-tour-map" aria-label="Chapters">
                {model.chapters.map((ch) => (
                  <li key={ch.id} class={ch.id === followed ? 'current' : ''} onClick={() => setFold(toggleChapter(shown, ch.id))} title="Open or fold this chapter">
                    <span class="pk-tour-n">{ch.n}</span>
                    <span class="pk-tour-map-title">{ch.title}</span>
                    <span class="pk-tour-meta">
                      steps {fmtStep(ch.first)} to {fmtStep(ch.last)} · {llmLabel(ch.llm)}
                    </span>
                  </li>
                ))}
              </ol>
              {model.chapters.map((ch) => {
                const isOpen = isChapterOpen(shown, ch.id);
                const showAll = allIn.has(ch.id);
                const stops = chapterStops(model, ch.id, showAll);
                return (
                  <div key={ch.id} class={`pk-tour-chapter${isOpen ? ' open' : ''}${ch.id === followed ? ' current' : ''}`} data-chapter={ch.id}>
                    <div class="pk-tour-chapter-head" onClick={() => setFold(toggleChapter(shown, ch.id))}>
                      <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} class="pk-twistie" />
                      <span class="pk-tour-chapter-title">
                        {ch.n}. {ch.title}
                      </span>
                      <span class="pk-tour-meta">
                        steps {fmtStep(ch.first)} to {fmtStep(ch.last)} · {llmLabel(ch.llm)} · {stopsLabel(model.narrated ? ch.picked : ch.stops)}
                      </span>
                    </div>
                    {isOpen && (
                      <div class="pk-tour-chapter-body">
                        {ch.text && <p class="pk-tour-chapter-text">{ch.text}</p>}
                        {stops.map((s) => (
                          <Stop key={s.id} stop={s} here={s.id === here} unfolded={unfolded.has(s.id)} onUnfold={() => setUnfolded((u) => flip(u, s.id))} onGoto={onGoto} onOpen={onOpen} />
                        ))}
                        {model.narrated && ch.stops > ch.picked && (
                          <a
                            href="#"
                            class="pk-tour-more"
                            onClick={(e) => {
                              e.preventDefault();
                              setAllIn((a) => flip(a, ch.id));
                            }}
                          >
                            {showAll ? 'only the picked stops' : `all ${ch.stops} candidates`}
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Stop({ stop: s, here, unfolded, onUnfold, onGoto, onOpen }: { stop: PanelTourStop; here: boolean; unfolded: boolean; onUnfold: () => void; onGoto: (s: PanelTourStop) => void; onOpen: TourProps['onOpen'] }) {
  return (
    <div class={`pk-tour-stop${here ? ' here' : ''}${s.picked ? ' picked' : ''}`} data-stop={s.id} data-step={s.step} role="listitem" onClick={() => onGoto(s)} title={`Step ${s.step} · ${s.file}:${s.line} · ${s.signal} · click to move the Time Machine here`}>
      <div class="pk-tour-stop-title">
        {here && <span class="pk-tour-here">you are here</span>}
        <span>{s.title}</span>
      </div>
      <div class="pk-tour-meta">
        <a
          href="#"
          class="pk-moment-loc"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onOpen(s.fileId, s.line, s.file);
          }}
        >
          {s.file}:{s.line}
        </a>{' '}
        · {s.function} · #{s.step}
      </div>
      {s.text && <div class="pk-tour-stop-text">{s.text}</div>}
      {s.quote && (
        <blockquote class="pk-tour-quote">
          <Repr text={s.quote.text} />
          <span class="pk-tour-meta"> from {s.quote.name}</span>
        </blockquote>
      )}
      {s.short && !unfolded && (
        <div class="pk-moment-values">
          <Repr text={s.short} />
        </div>
      )}
      {(s.values.length > 0 || s.statement) && (
        <a
          href="#"
          class="pk-tour-more"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onUnfold();
          }}
        >
          {unfolded ? 'fold values' : `values (${s.values.length})`}
        </a>
      )}
      {unfolded && (
        <div class="pk-tour-values" onClick={(e) => e.stopPropagation()}>
          <div class="pk-tour-value">
            <span class="pk-moment-role">statement</span> <Repr text={s.statement} />
          </div>
          {s.values.map((v, k) => (
            <div key={k} class="pk-tour-value">
              <span class="pk-moment-role">{v.name}</span> <Repr text={v.text + (v.cut ? ' …' : '')} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
