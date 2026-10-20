/**
 * The bridge's full value: a replay of the run copies a value whole and checks it against the
 * recording (session/fullValue.ts). `why` with `full: true` asks for the value on the tree's first
 * line (bridgeWhy.ts); `whole`, the 0.7.0 request, is kept for one release and asks for the value
 * when the step began, as it did. Every text that leaves goes through the bridge's redaction, as
 * `why` and `expand` do.
 */
import type { Session } from '../session/session';
import type { FullValueTarget } from '../shared/fullValueTarget';
import { sessionFullValue } from '../session/fullValueSession';
import { redact, redactValueNode } from '../util/redact';
import { BridgeError, awaitIdle, int, type Request } from './bridgeSupport';

export async function bridgeFullValue(session: Session, target: FullValueTarget): Promise<Record<string, unknown>> {
  const view = await sessionFullValue(session, { key: 'bridge', ...target });
  const { key: _key, value, difference, ...rest } = view;
  return {
    ...rest,
    summary: redact(view.summary),
    ...(value ? { value: redactValueNode(value) } : {}),
    ...(difference ? { difference: { ...difference, recorded: redact(difference.recorded), replay: redact(difference.replay) } } : {}),
  };
}

/** `whole {step, name}` (0.7.0): the value `name` had when step `step` began. */
export async function bridgeWhole(session: Session, req: Request): Promise<Record<string, unknown>> {
  const step = int(req.step);
  const name = typeof req.name === 'string' ? req.name.trim() : '';
  if (step === undefined || !name) throw new BridgeError('whole needs step and name', 'send {type: "why", step: N, name: "orders", full: true}: the why tree and the full value on its first line, copied by a replay of the run');
  await awaitIdle(session);
  return bridgeFullValue(session, { kind: 'at', step, name });
}
