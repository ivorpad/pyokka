/**
 * The debugger in the Time Machine view (docs/HANDOFF-debugger.md): the header that says where the
 * run is paused and why, and the "not run yet" block past the frontier on the strips. The paused
 * frame's variables are VS Code's Variables view, over the same debug session.
 */
import { debugHeader } from '../debugView';
import type { DebugPanelInfo } from '../src-shared';

export function DebugStatus({ debug }: { debug: DebugPanelInfo | undefined }) {
  const text = debugHeader(debug);
  if (!text || !debug) return null;
  if (!debug.paused) return <div class="pk-debug-status running">{text}</div>;
  const lead = debug.location ? `Paused at ${debug.location}` : '';
  return (
    <div class="pk-debug-status">
      {lead ? (
        <>
          Paused at <b>{debug.location}</b>
          {text.slice(lead.length)}
        </>
      ) : (
        text
      )}
    </div>
  );
}

/** The hatched block past the frontier: the program has not run there yet. */
export function AheadBlock({ kind, width }: { kind: 'timeline' | 'steps'; width?: number }) {
  return (
    <div class={kind === 'timeline' ? 'pk-tl-ahead' : 'pk-step-ahead'} style={width ? { width: `${width}px` } : undefined} title="Ahead of the frontier: nothing has run yet">
      not run yet
    </div>
  );
}
