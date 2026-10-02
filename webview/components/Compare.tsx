/** Compare view: Monaco diff editor, left = earlier entry. */
import { useEffect, useRef } from 'preact/hooks';
import { formatText, valueCategory } from '../format';
import type { Entry, Theme } from '../model';
import { monaco, monacoTheme, READONLY_OPTIONS } from '../monaco';
import { IconButton } from './ui';

export interface CompareProps {
  left: { title: string; text: string };
  right: { title: string; text: string };
  theme: Theme;
  onClose: () => void;
}

export function canCompare(a: Entry | undefined, b: Entry | undefined): boolean {
  if (!a?.valueBag || !b?.valueBag) return false;
  const ca = valueCategory(a.valueBag.data);
  const cb = valueCategory(b.valueBag.data);
  return ca !== 'other' && ca === cb;
}

/** build the two sides from two entries, earlier step on the left */
export function compareSides(a: Entry, b: Entry): CompareProps['left'][] {
  const [l, r] = a.step <= b.step ? [a, b] : [b, a];
  const side = (e: Entry) => ({ title: `${e.file}:${e.line}:${e.col}${e.context ? `  ${e.context}` : ''}`, text: e.valueBag ? formatText(e.valueBag.data) : e.text });
  return [side(l), side(r)];
}

export function Compare(props: CompareProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = monaco.editor.createDiffEditor(host, {
      ...READONLY_OPTIONS,
      theme: monacoTheme(props.theme),
      renderSideBySide: true,
      originalEditable: false,
      enableSplitViewResizing: true,
      renderIndicators: true,
      diffWordWrap: 'off',
      ignoreTrimWhitespace: false,
      diffAlgorithm: 'advanced',
      renderOverviewRuler: false,
      useInlineViewWhenSpaceIsLimited: false,
    });
    editorRef.current = editor;
    return () => {
      const m = editor.getModel();
      editor.dispose();
      m?.original.dispose();
      m?.modified.dispose();
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const old = editor.getModel();
    editor.setModel({ original: monaco.editor.createModel(props.left.text, 'python'), modified: monaco.editor.createModel(props.right.text, 'python') });
    old?.original.dispose();
    old?.modified.dispose();
  }, [props.left.text, props.right.text]);

  useEffect(() => {
    monaco.editor.setTheme(monacoTheme(props.theme));
  }, [props.theme]);

  return (
    <section class="pk-pane pk-compare" aria-label="Compare">
      <header class="pk-pane-header">
        <span class="pk-pane-title">COMPARE</span>
        <span class="pk-compare-titles">
          <span title={props.left.title}>{props.left.title}</span>
          <span title={props.right.title}>{props.right.title}</span>
        </span>
        <span class="pk-toolbar">
          <IconButton icon="close" title="Close compare" onClick={props.onClose} />
        </span>
      </header>
      <div class="pk-editor-host" ref={hostRef} />
    </section>
  );
}

export function CompareUnavailable({ onClose }: { onClose: () => void }) {
  return (
    <section class="pk-pane pk-compare" aria-label="Compare">
      <header class="pk-pane-header">
        <span class="pk-pane-title">COMPARE</span>
        <span class="pk-toolbar">
          <IconButton icon="close" title="Close compare" onClick={onClose} />
        </span>
      </header>
      <div class="pk-empty">Diff is not available for these values</div>
    </section>
  );
}
