/**
 * Decoration types with Quokka's exact styles. Created once per activation.
 */
import * as vscode from 'vscode';
import { CoverageState } from '../shared/protocol';
import { pyokkaConfig } from '../config/settings';

export type InlineKind = 'log' | 'system' | 'error';

export interface CoverageColors {
  covered: string;
  notCovered: string;
  partiallyCovered: string;
  errorSource: string;
  errorPath: string;
}

export const DEFAULT_COLORS: CoverageColors = {
  covered: '#62b455',
  notCovered: '#cccccc',
  partiallyCovered: '#d2a032',
  errorSource: '#fe536a',
  errorPath: '#ffa0a0',
};

type AttachmentOverride = Partial<Record<'border' | 'borderColor' | 'fontStyle' | 'fontWeight' | 'textDecoration' | 'color' | 'backgroundColor' | 'margin' | 'width' | 'height', string | null>>;

const INLINE_DEFAULTS: Record<'light' | 'dark', Record<InlineKind, vscode.ThemableDecorationAttachmentRenderOptions>> = {
  dark: {
    log: { color: 'rgba(86, 156, 214, 1)', margin: '1.2em' },
    system: { color: 'rgb(153, 153, 153)', margin: '1.2em' },
    error: { color: '#fe536a', margin: '1.2em' },
  },
  light: {
    log: { color: '#0000ff', margin: '1.2em' },
    system: { color: 'rgb(153, 153, 153)', margin: '1.2em' },
    error: { color: '#c80000', margin: '1.2em' },
  },
};

function attachment(theme: 'light' | 'dark', kind: InlineKind): vscode.ThemableDecorationAttachmentRenderOptions {
  const override = pyokkaConfig().get<AttachmentOverride>(`${theme}Theme.${kind}.decorationAttachmentRenderOptions`, {});
  const out: Record<string, string> = { ...(INLINE_DEFAULTS[theme][kind] as Record<string, string>) };
  for (const [k, v] of Object.entries(override ?? {})) if (typeof v === 'string' && v) out[k] = v;
  return out as vscode.ThemableDecorationAttachmentRenderOptions;
}

export interface DecorationTypes {
  coverage: Record<CoverageState, vscode.TextEditorDecorationType>;
  coverageStale: Record<CoverageState, vscode.TextEditorDecorationType>;
  inline: Record<InlineKind, vscode.TextEditorDecorationType>;
  /** dimmed variant for values that belong to other Time Machine steps */
  inlineDim: Record<InlineKind, vscode.TextEditorDecorationType>;
  currentStep: vscode.TextEditorDecorationType;
  deadEnd: vscode.TextEditorDecorationType;
  callStackFrame: vscode.TextEditorDecorationType;
  scopeLine: vscode.TextEditorDecorationType;
  echo: vscode.TextEditorDecorationType;
  watch: vscode.TextEditorDecorationType;
  /** box on the Code Story row of the current Time Machine step, over the step's own range */
  storyCurrent: vscode.TextEditorDecorationType;
  /** Code Story columns outside the block's step ranges: the line number, context lines, what a pass did not run */
  storyContext: vscode.TextEditorDecorationType;
  dispose(): void;
}

function iconUri(context: vscode.ExtensionContext, name: string, color: string, defaultColor: string, stale: boolean): vscode.Uri {
  if (color.toLowerCase() === defaultColor.toLowerCase()) {
    return vscode.Uri.joinPath(context.extensionUri, 'media', 'icons', `${stale ? 'last.' : ''}${name}.svg`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="${color}"${stale ? ' opacity="0.35"' : ''}/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

export function createDecorationTypes(context: vscode.ExtensionContext): DecorationTypes {
  const colors = { ...DEFAULT_COLORS, ...pyokkaConfig().get<Partial<CoverageColors>>('colors', {}) };
  const names: Record<CoverageState, keyof CoverageColors> = {
    [CoverageState.NotRun]: 'notCovered',
    [CoverageState.Covered]: 'covered',
    [CoverageState.Partial]: 'partiallyCovered',
    [CoverageState.ErrorSource]: 'errorSource',
    [CoverageState.ErrorPath]: 'errorPath',
  };
  const mk = (stale: boolean): Record<CoverageState, vscode.TextEditorDecorationType> => {
    const out = {} as Record<CoverageState, vscode.TextEditorDecorationType>;
    for (const state of [CoverageState.NotRun, CoverageState.Covered, CoverageState.Partial, CoverageState.ErrorSource, CoverageState.ErrorPath]) {
      const name = names[state];
      out[state] = vscode.window.createTextEditorDecorationType({
        gutterIconPath: iconUri(context, name, colors[name], DEFAULT_COLORS[name], stale),
        gutterIconSize: 'contain',
        overviewRulerLane: state === CoverageState.ErrorSource ? vscode.OverviewRulerLane.Left : undefined,
        overviewRulerColor: state === CoverageState.ErrorSource ? colors.errorSource : undefined,
      });
    }
    return out;
  };
  const inline = {} as Record<InlineKind, vscode.TextEditorDecorationType>;
  const inlineDim = {} as Record<InlineKind, vscode.TextEditorDecorationType>;
  const dim = (a: vscode.ThemableDecorationAttachmentRenderOptions): vscode.ThemableDecorationAttachmentRenderOptions => ({ ...a, textDecoration: 'none; opacity: 0.45' });
  for (const kind of ['log', 'system', 'error'] as InlineKind[]) {
    inline[kind] = vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      light: { after: attachment('light', kind) },
      dark: { after: attachment('dark', kind) },
    });
    inlineDim[kind] = vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      light: { after: dim(attachment('light', kind)) },
      dark: { after: dim(attachment('dark', kind)) },
    });
  }
  const line = (dark: string, light: string, extra: vscode.DecorationRenderOptions = {}): vscode.TextEditorDecorationType =>
    vscode.window.createTextEditorDecorationType({ isWholeLine: true, dark: { backgroundColor: dark }, light: { backgroundColor: light }, ...extra });
  const types: DecorationTypes = {
    coverage: mk(false),
    coverageStale: mk(true),
    inline,
    inlineDim,
    currentStep: line('rgba(255,255,0,0.2)', 'rgba(255,255,102,0.45)', { overviewRulerColor: 'rgba(255,255,0,0.6)', overviewRulerLane: vscode.OverviewRulerLane.Full }),
    deadEnd: line('rgba(255,0,0,0.2)', 'rgba(255,0,52,0.35)'),
    callStackFrame: line('rgba(122,189,122,0.3)', 'rgba(206,231,206,0.45)'),
    scopeLine: vscode.window.createTextEditorDecorationType({ dark: { backgroundColor: 'rgba(255,255,255,0.07)' }, light: { backgroundColor: 'rgba(0,0,0,0.06)' }, fontWeight: 'bold' }),
    echo: vscode.window.createTextEditorDecorationType({ dark: { backgroundColor: 'rgba(255,255,0,0.08)', border: '1px dashed rgba(255,255,0,0.35)' }, light: { backgroundColor: 'rgba(255,255,102,0.2)', border: '1px dashed rgba(180,160,0,0.5)' }, borderRadius: '2px' }),
    watch: vscode.window.createTextEditorDecorationType({ border: '1px solid rgba(214,179,59,1)', borderRadius: '2px' }),
    // the editor's current step is a whole-line band; the story boxes the range instead (T1)
    storyCurrent: vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      borderWidth: '1px',
      borderStyle: 'solid',
      borderRadius: '2px',
      dark: { backgroundColor: 'rgba(255,255,0,0.2)', borderColor: 'rgba(255,255,0,0.6)' },
      light: { backgroundColor: 'rgba(255,255,102,0.45)', borderColor: 'rgba(180,160,0,0.7)' },
    }),
    storyContext: vscode.window.createTextEditorDecorationType({ opacity: '0.45', rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed }),
    dispose() {
      for (const t of Object.values(types.coverage)) t.dispose();
      for (const t of Object.values(types.coverageStale)) t.dispose();
      for (const t of Object.values(types.inline)) t.dispose();
      for (const t of Object.values(types.inlineDim)) t.dispose();
      types.currentStep.dispose();
      types.deadEnd.dispose();
      types.callStackFrame.dispose();
      types.scopeLine.dispose();
      types.echo.dispose();
      types.watch.dispose();
      types.storyCurrent.dispose();
      types.storyContext.dispose();
    },
  };
  return types;
}
