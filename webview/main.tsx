/** Pyokka panel entry point. The host injects `window.__pyokka = { workerUri, codiconsUri }` before this script. */
import { render } from 'preact';
import { App } from './App';
import { bootMonaco } from './monaco';
import './styles.css';
import './http.css';
import './exec-story.css';
import './debug.css';

function injectCodicons(): void {
  const uri = window.__pyokka?.codiconsUri;
  if (!uri || document.querySelector('link[data-pyokka-codicons]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = uri;
  link.dataset.pyokkaCodicons = '1';
  document.head.appendChild(link);
}

injectCodicons();
bootMonaco();

const root = document.getElementById('root') ?? (() => {
  const el = document.createElement('div');
  el.id = 'root';
  document.body.appendChild(el);
  return el;
})();

render(<App />, root);
