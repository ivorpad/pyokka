// What render-code-history.cjs needs from npm, bundled once so a page renders with nothing
// installed: Handlebars, and Shiki cut down to Python, one theme and the JavaScript regex engine
// (no WASM). `scripts/build-render-deps.mjs` turns this into skills/pyokka/scripts/render-deps.cjs.
import Handlebars from 'handlebars/dist/cjs/handlebars.js';
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import python from '@shikijs/langs/python';
import githubDarkDimmed from '@shikijs/themes/github-dark-dimmed';

export { Handlebars };

let highlighter;
export const shiki = {
  bundledThemes: { 'github-dark-dimmed': githubDarkDimmed },
  async codeToTokens(code, options) {
    highlighter ??= await createHighlighterCore({ themes: [githubDarkDimmed], langs: [python], engine: createJavaScriptRegexEngine() });
    return highlighter.codeToTokens(code, options);
  },
};
