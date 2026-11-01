/** Local consistency for a call's identity, review boundary and recorded settlement. */
import type { Finding } from './inspect.js';
import type {
  PendingAction,
  WorkflowEvent,
  WorkflowPoint,
} from './group-types.js';
import { canonicalJson } from './hash.js';

function actionValue(action: PendingAction): unknown {
  return {
    callId: action.callId,
    tool: action.tool,
    arguments: action.arguments,
    cwd: action.cwd,
    route: action.route,
  };
}

export function checkPendingBoundary(
  events: readonly WorkflowEvent[],
  point: WorkflowPoint,
  pending: PendingAction,
): void {
  const own = events.filter((event) => event.sessionId === point.sessionId);
  if ('callEventId' in point.pending) {
    const id = point.pending.callEventId;
    const index = own.findIndex((event) => event.eventId === id);
    const previous = own[index - 1]?.eventId ?? null;
    if (point.cutoffEventId !== id && point.cutoffEventId !== previous)
      throw new Error(
        'recorded pending cutoff must be the call itself or its immediate real predecessor',
      );
    return;
  }
  const recorded = own.find(
    (event) => event.kind === 'call' && event.callId === pending.callId,
  );
  if (
    recorded?.kind === 'call' &&
    canonicalJson(actionValue(recorded)) !== canonicalJson(actionValue(pending))
  )
    throw new Error(
      'inline pending disagrees with the recorded action for the same callId',
    );
}

/** No inferred execution; missing settlements/results and multiple output channels stay legal. */
export function callSettlementProblems(
  events: readonly WorkflowEvent[],
  path: string,
): readonly Finding[] {
  const problems: Finding[] = [];
  const results = new Set<string>();
  const settled = new Set<string>();
  const blocked = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'result' && event.kind !== 'settlement') continue;
    const key = JSON.stringify([event.sessionId, event.callId]);
    const where = `${path}/events (eventId=${event.eventId})`;
    if (event.kind === 'result') {
      results.add(key);
      if (blocked.has(key))
        problems.push({
          path: where,
          message: `blocked call cannot have an execution result: ${key}`,
        });
    } else {
      if (settled.has(key))
        problems.push({
          path: where,
          message: `duplicate terminal settlement for call ${key}`,
        });
      settled.add(key);
      if (results.has(key))
        problems.push({
          path: where,
          message: `result precedes settlement for call ${key}`,
        });
      if (event.outcome === 'denied' || event.outcome === 'aborted')
        blocked.add(key);
    }
  }
  return problems;
}
