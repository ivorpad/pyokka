/** The debugger pane's VARIABLES column: which values open, and what an opened one shows. */
import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import { ValueTree, valueExpandable } from '../../web/debugPane';
import type { ValueNode } from '../../src/shared/protocol';

const noExpand = { expandNode: () => Promise.resolve(null) };
const str = (value: string): ValueNode => ({ type: 'str', value, length: value.length, id: 's', queryPath: [] });

describe('ValueTree', () => {
  it('opens long and multi-line strings, not short ones', () => {
    expect(valueExpandable(str('short'))).toBe(false);
    expect(valueExpandable(str('x'.repeat(81)))).toBe(true);
    expect(valueExpandable(str('one\ntwo'))).toBe(true);
  });

  it('shows an opened dict one level down, each child a coloured row', () => {
    const node: ValueNode = {
      type: 'dict', value: "{'a': 1, 'b': [2, 3]}", length: 2, id: 'd', queryPath: [],
      props: [
        { name: 'a', type: 'int', value: '1', id: 'd1', queryPath: ['_p_a'] },
        { name: 'b', type: 'list', value: '[2, 3]', length: 2, capped: true, expandable: true, id: 'd2', queryPath: ['_p_b'] },
      ],
    };
    const html = render(<ValueTree node={node} name="cfg" debug={noExpand} initialOpen />);
    const children = html.slice(html.indexOf('pkw-value-children'));
    expect(children).toMatch(/pkw-value-name">a<.*pkw-token-num">1</);
    // the nested list is a closed toggle: its items come from the runtime when clicked
    expect(children).toMatch(/aria-label="Inspect b" aria-expanded="false"/);
    expect(children).not.toContain('pkw-value-name">0<');
  });
});
