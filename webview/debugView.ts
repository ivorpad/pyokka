/**
 * Pure helpers for the debugger in the Time Machine view (docs/HANDOFF-debugger.md): the header
 * sentence for a pause. No DOM, so vitest covers them (test/unit/webview/debugView.test.tsx).
 */
import type { DebugPanelInfo } from './src-shared';

/** "breakpoint if i == 3 · condition failed: NameError", "watch w1 payload is None turned true", "uncaught ValueError: too big: 3", ... */
export function pausedPhrase(d: DebugPanelInfo): string {
  switch (d.reason) {
    case 'start':
      return 'start of the run';
    case 'breakpoint': {
      let s = 'breakpoint';
      if (d.breakpoint?.condition) s += ` if ${d.breakpoint.condition}`;
      if (d.conditionError) s += ` · condition failed: ${d.conditionError}`;
      return s;
    }
    case 'step':
      return `step ${d.kind ?? 'into'}`;
    case 'watch': {
      const w = d.watch;
      if (!w) return 'watch';
      return w.breakWhen === 'true' ? `watch ${w.id} ${w.exp} turned true` : `watch ${w.id} ${w.exp} changed to ${w.text}`;
    }
    case 'pause':
      return 'paused on request';
    case 'exception': {
      const e = d.exception;
      return e ? `${e.uncaught ? 'uncaught' : 'raised'} ${e.type}: ${e.message}` : 'exception';
    }
    default:
      return d.reason ?? '';
  }
}

/** The header line of the Time Machine view while a debug run is paused or running; '' otherwise. */
export function debugHeader(d: DebugPanelInfo | undefined): string {
  if (!d || !d.active) return '';
  if (!d.paused) return 'Debug: running…';
  const where = d.location ? `Paused at ${d.location}` : 'Paused';
  const step = d.frontier !== undefined ? ` · step ${d.frontier}` : '';
  return `${where} · ${pausedPhrase(d)}${step} · behind the frontier the recording replays, ahead nothing has run`;
}
