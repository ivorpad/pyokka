/**
 * The bridge's `why {step, name?, depth?, full?}`: the provenance tree of a value (docs/PROTOCOL.md,
 * "Provenance"), and with `full: true` the full value on its first line under `full`, copied by a
 * replay of the run in a runner of its own (bridgeFull.ts). The replay runs the program again, so
 * it is only ever asked for, never implied.
 */
import type { Session } from '../session/session';
import type { TraceModel } from '../timeMachine/traceModel';
import { sessionProvenance } from '../session/variableQuery';
import { whyFullTarget } from '../shared/fullValueTarget';
import { bridgeFullValue } from './bridgeFull';
import { BridgeError, awaitIdle, int, redactProvenance, type Request } from './bridgeSupport';

export async function bridgeWhy(session: Session, req: Request, traceOf: () => TraceModel): Promise<Record<string, unknown>> {
  const step = int(req.step);
  if (step === undefined) throw new BridgeError('why needs step', 'send {step: N, name?: "total", depth?: 5, full?: true}: the step of a var change, or of the Time Machine; name empty explains the statement');
  const name = typeof req.name === 'string' ? req.name.trim() : '';
  const full = req.full === true;
  if (full && !name) throw new BridgeError('full needs a name', 'send {step: N, name: "orders", full: true}: the full value of the name the tree explains');
  await awaitIdle(session);
  const trace = traceOf(); // throws the "no trace" error with its hint
  if (!trace.valid(step)) throw new BridgeError(`step ${step} is out of range`, `steps are 0..${trace.count - 1}`);
  const tree = await sessionProvenance(session, step, name, int(req.depth));
  if (!tree) throw new BridgeError('no execution trace', 'run the file first (save, or Re-execute)');
  const out: Record<string, unknown> = { ...redactProvenance(tree) };
  if (full) out.full = await bridgeFullValue(session, whyFullTarget(tree));
  return out;
}
