/** The Why summary card (components/WhySummaryCard.tsx) over the orders fixture's summaries, as the Python builder wrote them. */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import type { Provenance } from '../../../src/shared/protocol';
import { WhySummaryCard } from '../../../webview/components/WhySummaryCard';

const noop = (): void => undefined;
const tree = (file: string, name: string): Provenance =>
  (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', file), 'utf8')) as { cases: { name: string; result: Provenance }[] }).cases.find((c) => c.name === name)!.result;

describe('the Why summary card', () => {
  it('answers with the line that changed the shared object, each place a Time Machine link', () => {
    const t = tree('shared.json', 'amount');
    const html = render(<WhySummaryCard summary={t.summary!} followObjects={!!t.followObjects} onGoto={noop} onFollowObjects={noop} />);
    expect(html).toContain('Change found');
    expect(html).toContain('objects followed');
    expect(html).toMatch(/<code class="pk-why-sum-code">line\[&quot;qty&quot;\] \+= 1<\/code>/);
    expect(html).toContain('title="Time Machine to step 23"');
    expect(html).not.toContain('pk-why-sum-action'); // nothing left to follow
  });

  it('signposts the value that differs, and offers to record again where the host can', () => {
    const t = tree('shared-default.json', 'amount');
    const html = render(<WhySummaryCard summary={t.summary!} onGoto={noop} onFollowObjects={noop} />);
    expect(html).toContain('Changed in between');
    expect(html).toContain('quick recording');
    expect(html).toContain('class="pk-why-sum-action"');
    expect(render(<WhySummaryCard summary={t.summary!} onGoto={noop} />)).not.toContain('pk-why-sum-action'); // the browser page
  });

  it('says no cause was found, and what the recording could not see', () => {
    const t = tree('shared-default.json', 'ledger.totals');
    const html = render(<WhySummaryCard summary={t.summary!} onGoto={noop} />);
    expect(html).toContain('No cause found');
    expect(html).toContain('shows nothing inside it');
  });
});
