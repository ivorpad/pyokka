import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const stamp = JSON.stringify(new Date().toISOString().replace('T', ' ').slice(0, 19) + (production ? '' : ' dev'));

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
  define: { __PYOKKA_BUILD__: stamp },
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

// Pyokka in a browser (docs/WEB.md): the bridge server and the page around the same panel
const webServer = {
  ...common,
  entryPoints: ['web/server.ts'],
  outfile: 'dist/web/server.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
};

const webPage = {
  ...webview,
  // source: the read-only tab a Cmd/Ctrl-clicked definition opens in (web/source.html)
  entryPoints: { app: 'web/main.tsx', source: 'web/source.ts' },
  outdir: 'dist/web',
  // the walkthrough and exceptions builders call node:path on the runtime's paths
  plugins: [{ name: 'path-shim', setup: (b) => b.onResolve({ filter: /^node:path$/ }, () => ({ path: new URL('web/pathShim.ts', import.meta.url).pathname })) }],
};

// a clean dist/: nothing an older build wrote ships by accident
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
// the Python runtime ships verbatim inside the extension
cpSync('python/pyokka_runtime', 'dist/python/pyokka_runtime', { recursive: true, filter: (p) => !p.includes('__pycache__') });
// codicons for the panel: node_modules is not packaged, so ship the font and stylesheet in dist
mkdirSync('dist/webview/codicons', { recursive: true });
for (const f of ['codicon.css', 'codicon.ttf']) cpSync(`node_modules/@vscode/codicons/dist/${f}`, `dist/webview/codicons/${f}`);
// the Narrate Tour prompt, shared with the skill (skills/ is not packaged)
const tourPrompt = 'skills/pyokka/references/tour-prompt.md';
if (existsSync(tourPrompt)) {
  mkdirSync('dist/prompts', { recursive: true });
  cpSync(tourPrompt, 'dist/prompts/tour-prompt.md');
}
mkdirSync('dist/web', { recursive: true });
cpSync('web/index.html', 'dist/web/index.html');
cpSync('web/source.html', 'dist/web/source.html');
cpSync('media/logo.png', 'dist/web/logo.png');

const builds = [extension, webview, webServer, webPage];
if (watch) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
