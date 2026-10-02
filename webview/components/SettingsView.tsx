/** SETTINGS view: the current session's settings, applied immediately; a button saves them as the defaults. */
import { useState } from 'preact/hooks';
import { DEFAULT_SETTINGS } from '../model';
import type { PanelSettings } from '../src-shared';
import { Checkbox, IconButton, Menu, type MenuItem } from './ui';

export const RUN_MODE_LABEL: Record<PanelSettings['runMode'], string> = {
  auto: 'Automatic',
  onSave: 'On save',
  onDemand: 'On demand',
};

/** the HTTP dropdown's labels; the button shows the current one */
export const HTTP_MODE_LABEL: Record<PanelSettings['http'], string> = {
  off: 'HTTP Off',
  record: 'HTTP Record',
  replay: 'HTTP Replay',
};

/** the HTTP dropdown's items, shared with the HTTP view */
export function httpModeItems(current: PanelSettings['http'], onSelect: (mode: PanelSettings['http']) => void): MenuItem[] {
  return (Object.keys(HTTP_MODE_LABEL) as PanelSettings['http'][]).map((m) => ({
    label: HTTP_MODE_LABEL[m],
    toggle: true,
    checked: current === m,
    onSelect: () => onSelect(m),
  }));
}

/** Run-timeout choices offered in the dropdown, in ms; 0 is "no limit". */
export const RUN_TIMEOUT_PRESETS = [30_000, 60_000, 120_000, 300_000, 600_000, 0];

/** `30 s`, `2 min`, `1.5 min`, `No limit`. */
export function timeoutLabel(ms: number): string {
  if (ms <= 0) return 'No limit';
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} s`.replace('.0 s', ' s');
  const min = Math.round(ms / 6_000) / 10;
  return `${min} min`.replace('.0 min', ' min');
}

export interface SettingsViewProps {
  settings: PanelSettings;
  /** applies to the current session (or the defaults when no session is bound) */
  onUpdate: (patch: Partial<PanelSettings>) => void;
  /** writes the given values to the user settings (defaults for new files) */
  onSaveDefaults: (settings: PanelSettings) => void;
  onCommand: (command: string) => void;
}

export function SettingsView({ settings, onUpdate, onSaveDefaults, onCommand }: SettingsViewProps) {
  const [modeOpen, setModeOpen] = useState(false);
  const [timeoutOpen, setTimeoutOpen] = useState(false);
  const [httpOpen, setHttpOpen] = useState(false);
  const timeoutChoices = RUN_TIMEOUT_PRESETS.includes(settings.runTimeoutMs) ? RUN_TIMEOUT_PRESETS : [...RUN_TIMEOUT_PRESETS.filter((ms) => ms > 0), settings.runTimeoutMs, 0].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
  const timeoutItems: MenuItem[] = timeoutChoices.map((ms) => ({
    label: timeoutLabel(ms),
    toggle: true,
    checked: settings.runTimeoutMs === ms,
    onSelect: () => onUpdate({ runTimeoutMs: ms }),
  }));
  const modeItems: MenuItem[] = (Object.keys(RUN_MODE_LABEL) as PanelSettings['runMode'][]).map((m) => ({
    label: RUN_MODE_LABEL[m],
    toggle: true,
    checked: settings.runMode === m,
    onSelect: () => onUpdate({ runMode: m }),
  }));
  const httpItems = httpModeItems(settings.http, (http) => onUpdate({ http }));
  return (
    <section class="pk-pane pk-settings" aria-label="Settings">
      <header class="pk-pane-header">
        <span class="pk-pane-title">SETTINGS</span>
        <span class="pk-toolbar">
          <IconButton icon="save" title="Save as defaults for new files" onClick={() => onSaveDefaults(settings)} />
          <IconButton icon="discard" title="Reset to defaults" onClick={() => onUpdate({ ...DEFAULT_SETTINGS, runMode: settings.runMode })} />
          <IconButton icon="history" title="View Recent Files" onClick={() => onCommand('pyokka.viewRecentFiles')} />
        </span>
      </header>
      <div class="pk-settings-body">
        <p class="pk-caption">Settings of this session; they apply immediately. Save them as the defaults for new files with the save button. The run mode is per session and is never saved: new files get the smart default (project files run on save, scratch files automatically).</p>
        <Checkbox checked={settings.autoLog} onChange={(v) => onUpdate({ autoLog: v })} label="Auto Log All Values" />
        <Checkbox checked={settings.valuePeek} onChange={(v) => onUpdate({ valuePeek: v })} label="Value Peek" />
        <Checkbox checked={settings.showValueOnSelection} onChange={(v) => onUpdate({ showValueOnSelection: v })} label="Show Value On Selection" />
        <Checkbox checked={settings.showSingleInlineValue} onChange={(v) => onUpdate({ showSingleInlineValue: v })} label="Show Last Displayed Value Only" />
        <Checkbox checked={settings.libraryCode} onChange={(v) => onUpdate({ libraryCode: v })} label="Step Into Library Code (instruments third-party packages on the next run)" />
        <Checkbox checked={settings.maskSecrets} onChange={(v) => onUpdate({ maskSecrets: v })} label="Mask Secrets (API keys, passwords and tokens are replaced before they leave the run; off shows them on the next run)" />
        <Checkbox checked={settings.recordLocals} onChange={(v) => onUpdate({ recordLocals: v })} label="Record Variable Changes (every changed local at every step, for the Variable pane and Step Variables; costs CPU on hot loops; the next run records)" />
        <div class="pk-settings-group">Run Mode</div>
        <span class="pk-menu-anchor">
          <button type="button" class="pk-dropdown" onClick={() => setModeOpen((o) => !o)}>
            Run {RUN_MODE_LABEL[settings.runMode]}
            <i class="codicon codicon-chevron-down" />
          </button>
          {modeOpen && <Menu items={modeItems} onClose={() => setModeOpen(false)} align="left" />}
        </span>
        <div class="pk-settings-group">Run Timeout</div>
        <p class="pk-caption pk-caption-sub">A run is killed after this long, waiting on the network included. Use a longer limit for a file that calls an API or an agent. The next run uses the new value. It never applies to a debug session: a program with the debugger attached runs and pauses for as long as you need.</p>
        <span class="pk-menu-anchor">
          <button type="button" class="pk-dropdown" onClick={() => setTimeoutOpen((o) => !o)}>
            Timeout {timeoutLabel(settings.runTimeoutMs)}
            <i class="codicon codicon-chevron-down" />
          </button>
          {timeoutOpen && <Menu items={timeoutItems} onClose={() => setTimeoutOpen(false)} align="left" />}
        </span>
        <div class="pk-settings-group">HTTP</div>
        <p class="pk-caption pk-caption-sub">Record writes every HTTP exchange of the next run to .pyokka/replay/ in the workspace (httpx, requests, urllib). Replay answers from that recording without touching the network: a re-run costs nothing and returns the same values. Both apply to the next run.</p>
        <span class="pk-menu-anchor">
          <button type="button" class="pk-dropdown" onClick={() => setHttpOpen((o) => !o)}>
            {HTTP_MODE_LABEL[settings.http]}
            <i class="codicon codicon-chevron-down" />
          </button>
          {httpOpen && <Menu items={httpItems} onClose={() => setHttpOpen(false)} align="left" />}
        </span>
      </div>
    </section>
  );
}
