/**
 * The bridge's `whole` request: the value `name` had when step `step` began, copied whole by a
 * replay of the run and checked against the recording (session/wholeValue.ts). Every text that
 * leaves goes through the bridge's redaction, as `why` and `expand` do.
 */
import type { Session } from '../session/session';
import { sessionWholeValue } from '../session/wholeValueSession';
import { redact, redactValueNode } from '../util/redact';
import { BridgeError, awaitIdle, int, type Request } from './bridgeSupport';

export async function bridgeWhole(session: Session, req: Request): Promise<Record<string, unknown>> {
  const step = int(req.step);
  const name = typeof req.name === 'string' ? req.name.trim() : '';
  if (step === undefined || !name) throw new BridgeError('whole needs step and name', 'send {step: N, name: "orders"}: the value name had when step N began, copied whole by a replay of the run');
  await awaitIdle(session);
  const view = await sessionWholeValue(session, { key: 'bridge', kind: 'at', step, name });
  const { key: _key, value, difference, ...rest } = view;
  return {
    ...rest,
    summary: redact(view.summary),
    ...(value ? { value: redactValueNode(value) } : {}),
    ...(difference ? { difference: { ...difference, recorded: redact(difference.recorded), replay: redact(difference.replay) } } : {}),
  };
}
