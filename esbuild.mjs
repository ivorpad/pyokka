import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info' };

const extension = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  // stamped into the activation log and the status bar tooltip so a stale extension host is obvious
  define: { __PYOKKA_BUILD__: JSON.stringify(new Date().toISOString().replace('T', ' ').slice(0, 19) + (production ? '' : ' dev')) },
};

const webview = {
  ...common,
  entryPoints: {
    panel: 'webview/main.tsx',
    'editor.worker': 'monaco-editor/esm/vs/editor/editor.worker.js',
  },
  outdir: 'dist/webview',
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  loader: { '.ttf': 'file', '.css': 'css' },
  jsx: 'automatic',
  jsxImportSource: 'preact',
  define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
};

mkdirSync('dist', { recursive: true });
// the Python runtime ships verbatim inside the extension
cpSync('python/pyokka_runtime', 'dist/python/pyokka_runtime', { recursive: true, filter: (p) => !p.includes('__pycache__') });
// the Narrate Tour prompt, shared with the skill (skills/ is not packaged); absent until 5.2 writes it
const TOUR_PROMPT = 'skills/pyokka/references/tour-prompt.md';
if (existsSync(TOUR_PROMPT)) {
  mkdirSync('dist/prompts', { recursive: true });
  cpSync(TOUR_PROMPT, 'dist/prompts/tour-prompt.md');
}
// codicons for the panel: node_modules is not packaged, so ship the font and stylesheet in dist
mkdirSync('dist/webview/codicons', { recursive: true });
for (const f of ['codicon.css', 'codicon.ttf']) cpSync(`node_modules/@vscode/codicons/dist/${f}`, `dist/webview/codicons/${f}`);

if (watch) {
  const ctxs = await Promise.all([esbuild.context(extension), esbuild.context(webview)]);
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
}
