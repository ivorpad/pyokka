/**
 * The summary above a Why tree (src/shared/whySummary.ts): its state, the headline and the details,
 * each piece as the tree recorded it. A place is a link that moves the Time Machine to its step; the
 * signpost's and the fallback's action records the file again following objects, where the host can.
 */
import type { WhyPiece, WhySummary } from '../src-shared';

const BADGES: Record<WhySummary['state'], { label: string; tip: string }> = {
  answer: { label: 'Change found', tip: 'The recording saw the statement that changed this value in place.' },
  signpost: { label: 'Changed in between', tip: 'A call received a value that differs from the last one recorded for its argument.' },
  fallback: { label: 'No cause found', tip: 'Nothing in this chain changed through another name or differs from what a call received. That is not the same as nothing went wrong.' },
};

const FOLLOW_TIP = 'Runs the file once more, following each object across the names that hold it, so the tree can show the line that changed it (slower where it traces). The next run on save records the usual way again.';

function Piece({ p, onGoto }: { p: WhyPiece; onGoto: (step: number) => void }) {
  if (p.value !== undefined) return <code class="pk-why-sum-value">{p.value}</code>;
  if (p.step !== undefined) {
    const where = `#${p.step} ${p.file ?? '?'}:${p.line ?? '?'}`;
    return (
      <a class="pk-why-sum-step" href="#" title={`Time Machine to step ${p.step}`} onClick={(e) => (e.preventDefault(), onGoto(p.step!))}>
        {where}
      </a>
    );
  }
  if (p.name !== undefined) return <code class="pk-why-sum-name">{p.name}</code>;
  if (p.code !== undefined) return <code class="pk-why-sum-code">{p.code}</code>;
  return <>{p.t}</>;
}

function Sentence({ pieces, onGoto }: { pieces: readonly WhyPiece[]; onGoto: (step: number) => void }) {
  return (
    <>
      {pieces.map((p, i) => (
        <Piece key={i} p={p} onGoto={onGoto} />
      ))}
    </>
  );
}

export interface WhySummaryCardProps {
  summary: WhySummary;
  /** the tree's recording followed objects */
  followObjects?: boolean;
  onGoto: (step: number) => void;
  /** absent: the host cannot record again (the browser page) */
  onFollowObjects?: () => void;
}

export function WhySummaryCard({ summary, followObjects, onGoto, onFollowObjects }: WhySummaryCardProps) {
  const badge = BADGES[summary.state];
  return (
    <section class={`pk-why-sum pk-why-sum-${summary.state}`} aria-label="Why summary">
      <div class="pk-why-sum-badge" title={badge.tip}>
        <span>{badge.label}</span>
        <span class="pk-why-sum-kind">{followObjects ? 'objects followed' : 'quick recording'}</span>
      </div>
      <p class="pk-why-sum-head">
        <Sentence pieces={summary.headline} onGoto={onGoto} />
      </p>
      {summary.details.length > 0 && (
        <ul class="pk-why-sum-details">
          {summary.details.map((d, i) => (
            <li key={i}>
              <Sentence pieces={d} onGoto={onGoto} />
            </li>
          ))}
        </ul>
      )}
      {summary.action === 'followObjects' && onFollowObjects && (
        <button class="pk-why-sum-action" title={FOLLOW_TIP} onClick={onFollowObjects}>
          Record again, following objects
        </button>
      )}
    </section>
  );
}
