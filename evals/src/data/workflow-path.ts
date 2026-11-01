/** Structural path/prefix operations only; no business actions or authorization inference. */
import type {
  PendingAction,
  Workflow,
  WorkflowEvent,
  WorkflowPoint,
} from './group-types.js';

export function branchOf(item: { readonly branchId?: string }): string {
  return item.branchId ?? 'main';
}

/** Native session order is preserved; different sessions are never wall-clock sorted. */
export function sessionPrefix(
  events: readonly WorkflowEvent[],
  sessionId: string,
  cutoff: string | null,
): readonly WorkflowEvent[] {
  if (cutoff === null) return [];
  const own = events.filter((event) => event.sessionId === sessionId);
  const index = own.findIndex((event) => event.eventId === cutoff);
  if (index === -1)
    throw new Error(
      `cutoff ${cutoff} is not reachable in session ${sessionId}`,
    );
  return own.slice(0, index + 1);
}

/** A fork names the visible parent prefix per session, including empty prefixes. */
export function eventsOnPath(
  workflow: Workflow,
  branchId: string,
  visiting = new Set<string>(),
): readonly WorkflowEvent[] {
  if (visiting.has(branchId)) throw new Error(`branch cycle at ${branchId}`);
  if (branchId === 'main')
    return workflow.events.filter((event) => branchOf(event) === 'main');
  const branch = workflow.branches?.find((item) => item.branchId === branchId);
  if (branch === undefined) throw new Error(`unknown branch ${branchId}`);
  const ancestors = new Set(visiting).add(branchId);
  const parent = eventsOnPath(workflow, branch.parentBranchId, ancestors);
  const included = new Set<string>();
  const sessions = new Set<string>();
  for (const cutoff of branch.fork) {
    if (sessions.has(cutoff.sessionId))
      throw new Error(`duplicate fork session ${cutoff.sessionId}`);
    sessions.add(cutoff.sessionId);
    if (
      !workflow.sessions.some(
        (session) => session.sessionId === cutoff.sessionId,
      )
    ) {
      throw new Error(`unknown fork session ${cutoff.sessionId}`);
    }
    for (const event of sessionPrefix(parent, cutoff.sessionId, cutoff.eventId))
      included.add(event.eventId);
  }
  return [
    ...parent.filter((event) => included.has(event.eventId)),
    ...workflow.events.filter((event) => branchOf(event) === branchId),
  ];
}

export function pendingOf(
  workflow: Workflow,
  point: WorkflowPoint,
): PendingAction {
  if (!('callEventId' in point.pending)) return point.pending;
  const callEventId = point.pending.callEventId;
  const call = eventsOnPath(workflow, branchOf(point)).find(
    (event) => event.eventId === callEventId,
  );
  if (call?.kind !== 'call' || call.sessionId !== point.sessionId) {
    throw new Error(
      `pending call ${point.pending.callEventId} is not a call in session ${point.sessionId} on this path`,
    );
  }
  return {
    callId: call.callId,
    tool: call.tool,
    arguments: call.arguments,
    route: call.route,
    ...(call.cwd === undefined ? {} : { cwd: call.cwd }),
  };
}
