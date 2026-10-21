/**
 * How to read a Why tree: the legend the Why header's help button opens above the tree
 * (components/Details.tsx). Each row is one mark the tree prints (render.py `render_why`,
 * src/shared/provenanceText.ts), with what it means.
 */

const ROWS: ReadonlyArray<readonly [mark: string, meaning: string]> = [
  ['name = value   #33 main.py:12', 'The value you asked about, the step that made it, and that statement. Each line below explains the line above it.'],
  ['← name = value', 'A name that statement read. One indent further right is one step further back.'],
  ['↳ f #34–#40   in … out …', 'A call that statement made: the steps it ran, its arguments and what it returned.'],
  ['#N', 'A step: click it to move the Time Machine there.'],
  ['def file:line', 'A function or class: where it is defined.'],
  ['passed bo at #33 main.py:12', 'A parameter: the argument the call passed for it. The line below it is that argument, at the call.'],
  ['[x is y, shared since #17]', 'x holds the object that y changed, since step 17 (recorded with followObjects).'],
  ['(guessed)', 'Taken from the source or a call’s parameters, not seen being made. Check it before you rely on it.'],
  ['…', 'Cut to fit the line. The tree button in this header (Rerun value) gets all of it.'],
];

export function WhyLegend() {
  return (
    <div class="pk-why-legend" role="note" aria-label="How to read this tree">
      <dl>
        {ROWS.map(([mark, meaning]) => (
          <div key={mark} class="pk-why-legend-row">
            <dt>
              <code>{mark}</code>
            </dt>
            <dd>{meaning}</dd>
          </div>
        ))}
      </dl>
      <p>
        The last line says the tree in one sentence. When a value in the tree differs from what a call below it received, it
        changed through another name: record again with <code>"followObjects": true</code> to see the line that changed it.
      </p>
    </div>
  );
}
