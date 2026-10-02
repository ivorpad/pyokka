/**
 * Build and screenshot the Debugger view's preview harness (test/visual/debuggerPreview.tsx), so
 * the view can be judged as pixels instead of as markup. Nothing here reaches `dist/` or the vsix:
 * `scripts/**` and `test/**` are both in `.vscodeignore`.
 *
 *   node scripts/preview-debugger-view.mjs [--prefix before] [--out DIR] [--no-shot]
 *
 * It bundles the harness with the same loaders `esbuild.mjs` uses for the panel, copies the codicon
 * font and stylesheet out of node_modules, writes one page per fixture state with a `:root` block of
 * Dark Modern `--vscode-*` values, and takes a headless Chrome screenshot of each. An unmapped
 * variable would fall back to the stylesheet's own default, so the pages also print nothing magenta
 * by accident: `MISSING` below is the colour to look for if one is ever added without a value.
 */
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PREFIX = flag('prefix', 'preview');
const OUT = flag('out', path.join(os.tmpdir(), 'pyokka-view-preview'));
const SHOT = !args.includes('--no-shot');
/* the view is contributed to `panel` only, so its real width is the editor's: 900 is a narrow panel,
   1900 is a wide monitor, and the two-column container query sits between them */
const SIZE = flag('size', '900,760');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/** the three fixture states, plus the paused one with the watch add row and the row actions shown */
const STATES = ['paused', 'running', 'exception', 'paused-add'];
const MISSING = '#ff00ff';

/** VS Code's Dark Modern, for the variables webview/*.css reads. */
const THEME = {
  'font-family': '-apple-system, BlinkMacSystemFont, sans-serif',
  'font-size': '13px',
  'editor-font-family': "Menlo, Monaco, 'Courier New', monospace",
  foreground: '#cccccc',
  descriptionForeground: '#9d9d9d',
  errorForeground: '#f85149',
  'icon-foreground': '#cccccc',
  focusBorder: '#0078d4',
  contrastBorder: 'transparent',
  'panel-background': '#181818',
  'panel-border': '#2b2b2b',
  'panelTitle-activeForeground': '#e7e7e7',
  'sideBarSectionHeader-foreground': '#cccccc',
  'sideBarSectionHeader-background': '#181818',
  'sideBarSectionHeader-border': '#2b2b2b',
  'editor-background': '#1f1f1f',
  'editor-foreground': '#cccccc',
  'editorError-foreground': '#f85149',
  'editorWarning-foreground': '#cca700',
  'editorInfo-foreground': '#3794ff',
  'inputValidation-warningBackground': '#352a05',
  'inputValidation-warningBorder': '#cca700',
  'inputValidation-errorBackground': '#5a1d1d',
  'inputValidation-errorBorder': '#be1100',
  'editorLineNumber-foreground': '#6e7681',
  'editorLineNumber-activeForeground': '#cccccc',
  'list-hoverBackground': '#2a2d2e',
  'list-activeSelectionBackground': '#04395e',
  'list-activeSelectionForeground': '#ffffff',
  'list-inactiveSelectionBackground': '#37373d',
  'textLink-foreground': '#4daafc',
  'textLink-activeForeground': '#4daafc',
  'toolbar-hoverBackground': '#5a5d5e4d',
  'toolbar-activeBackground': '#63666750',
  'dropdown-background': '#313131',
  'dropdown-border': '#3c3c3c',
  'dropdown-foreground': '#cccccc',
  'input-background': '#313131',
  'input-border': '#3c3c3c',
  'input-foreground': '#cccccc',
  'checkbox-background': '#313131',
  'checkbox-border': '#3c3c3c',
  'badge-background': '#616161',
  'badge-foreground': '#f8f8f8',
  'button-secondaryBackground': '#313131',
  'button-secondaryForeground': '#cccccc',
  'button-secondaryHoverBackground': '#3c3c3c',
  'widget-border': '#313131',
  'widget-shadow': '#0000005c',
  // the integrated terminal's palette: what the output pane paints stderr and decoded SGR with
  'terminal-ansiBlack': '#0c0c0c',
  'terminal-ansiRed': '#cd3131',
  'terminal-ansiGreen': '#0dbc79',
  'terminal-ansiYellow': '#e5e510',
  'terminal-ansiBlue': '#2472c8',
  'terminal-ansiMagenta': '#bc3fbc',
  'terminal-ansiCyan': '#11a8cd',
  'terminal-ansiWhite': '#e5e5e5',
  'terminal-ansiBrightBlack': '#666666',
  'terminal-ansiBrightRed': '#f14c4c',
  'terminal-ansiBrightGreen': '#23d18b',
  'terminal-ansiBrightYellow': '#f5f543',
  'terminal-ansiBrightBlue': '#3b8eea',
  'terminal-ansiBrightMagenta': '#d670d6',
  'terminal-ansiBrightCyan': '#29b8db',
  'terminal-ansiBrightWhite': '#e5e5e5',
  'editorWidget-background': '#202020',
  'editorWidget-border': '#454545',
  'editorHoverWidget-background': '#202020',
  'editorHoverWidget-border': '#454545',
  'editorHoverWidget-foreground': '#cccccc',
  'editorSuggestWidget-background': '#202020',
  'editorSuggestWidget-border': '#454545',
  'editorSuggestWidget-foreground': '#cccccc',
  'editorSuggestWidget-selectedBackground': '#04395e',
  'editorSuggestWidget-selectedForeground': '#ffffff',
  'menu-background': '#1f1f1f',
  'menu-foreground': '#cccccc',
  'menu-border': '#454545',
  'menu-selectionBackground': '#0078d4',
  'menu-selectionForeground': '#ffffff',
  'debugIcon-breakpointForeground': '#e51400',
  'debugIcon-breakpointDisabledForeground': '#848484',
  'debugIcon-breakpointUnverifiedForeground': '#848484',
  'debugTokenExpression-name': '#c586c0',
  'debugTokenExpression-value': '#cccccc99',
  'debugTokenExpression-string': '#ce9178',
  'debugTokenExpression-boolean': '#4e94ce',
  'debugTokenExpression-number': '#b5cea8',
  'debugTokenExpression-type': '#4ec9b0',
  'debugTokenExpression-error': '#f48771',
  'charts-blue': '#4daafc',
  'charts-green': '#89d185',
  'charts-orange': '#d18616',
  'charts-purple': '#b180d7',
  'charts-yellow': '#cca700',
  'sash-hoverBorder': '#0078d4',
  'terminal-ansiCyan': '#11a8cd',
  'symbolIcon-variableForeground': '#75beff',
};

const root = path.resolve(import.meta.dirname, '..');
mkdirSync(OUT, { recursive: true });

/** Every `--vscode-*` the stylesheets read, so an unmapped one shows up rather than hiding. */
function variables() {
  const css = ['webview/styles.css', 'webview/debug.css'].map((f) => readFileSync(path.join(root, f), 'utf8')).join('\n');
  const used = new Set([...css.matchAll(/var\(--vscode-([a-zA-Z0-9-]+)/g)].map((m) => m[1]));
  const lines = [];
  for (const name of [...used].sort()) lines.push(`  --vscode-${name}: ${THEME[name] ?? MISSING};`);
  const unmapped = [...used].filter((n) => !THEME[n]);
  if (unmapped.length) console.warn(`unmapped (${MISSING} in the page): ${unmapped.join(', ')}`);
  return `:root {\n${lines.join('\n')}\n}`;
}

await esbuild.build({
  entryPoints: { preview: 'test/visual/debuggerPreview.tsx' },
  outdir: OUT,
  bundle: true,
  format: 'iife',
  target: 'es2022',
  platform: 'browser',
  loader: { '.ttf': 'file', '.css': 'css' },
  jsx: 'automatic',
  jsxImportSource: 'preact',
  define: { 'process.env.NODE_ENV': '"development"' },
  absWorkingDir: root,
  logLevel: 'warning',
});

for (const f of ['codicon.css', 'codicon.ttf']) copyFileSync(path.join(root, 'node_modules/@vscode/codicons/dist', f), path.join(OUT, f));
for (const f of ['styles.css', 'debug.css']) copyFileSync(path.join(root, 'webview', f), path.join(OUT, f));

const vars = variables();
const pages = [];
for (const state of STATES) {
  // the add page forces the hover-only affordances on, so a still image can show them
  const forced =
    state === 'paused-add'
      ? `.pk-dbg-head-actions .pk-icon-btn, .pk-dbg-row-actions { opacity: 1 !important; }\n.pk-dbg-row:nth-child(1) { background: var(--vscode-list-hoverBackground); }`
      : '';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Debugger view: ${state}</title>
<link rel="stylesheet" href="codicon.css">
<link rel="stylesheet" href="styles.css">
<link rel="stylesheet" href="debug.css">
<style>
${vars}
html, body { margin: 0; padding: 0; height: 100%; }
/* the panel is a flex column inside the webview; the preview gives it the same box */
/* the panel puts the view in .pk-content, a row flex box, so it stretches to the full height there */
    #root { display: flex; flex: 1; min-height: 0; min-width: 0; height: 100%; overflow: hidden; }
${forced}
</style>
</head>
<body>
<div id="root"></div>
<script src="preview.js"></script>
</body>
</html>
`;
  const file = path.join(OUT, `${state}.html`);
  writeFileSync(file, html);
  pages.push({ state, file });
}

if (!SHOT) {
  console.log(`pages in ${OUT} (no screenshots asked for)`);
  process.exit(0);
}

for (const { state, file } of pages) {
  const png = path.join(OUT, `${PREFIX}-${state}.png`);
  // without a virtual-time budget Chrome can shoot before preact rendered and the PNG is a blank frame
  const query = state === 'paused-add' ? 'state=paused&add=1' : `state=${state}`;
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--virtual-time-budget=3000', `--window-size=${SIZE}`, `--screenshot=${png}`, `file://${file}?${query}`], { stdio: 'ignore' });
  console.log(png);
}
