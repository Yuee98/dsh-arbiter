/** Identity, reference and actual-prefix validation for one root. */
import {
  checkPendingBoundary,
  callSettlementProblems,
} from './workflow-calls.js';
import type { Finding } from './inspect.js';
import type { Workflow, WorkflowEvent } from './group-types.js';
import {
  branchOf,
  branchIsAncestor,
  requirePointOnPath,
  eventsOnPath,
  pendingOf,
  sessionPrefix,
} from './workflow-path.js';

export function duplicateFindings<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  path: string,
  kind: string,
): readonly Finding[] {
  const seen = new Set<string>();
  const problems: Finding[] = [];
  items.forEach((item, index) => {
    const id = idOf(item);
    if (seen.has(id))
      problems.push({
        path: `${path}/${String(index)}`,
        message: `duplicate ${kind} ${id}`,
      });
    seen.add(id);
  });
  return problems;
}

function pathProblems(
  events: readonly WorkflowEvent[],
  path: string,
): readonly Finding[] {
  const problems: Finding[] = [];
  const sequence = new Map<string, number>();
  const calls = new Set<string>();
  const asks = new Set<string>();
  for (const event of events) {
    const where = `${path}/events (eventId=${event.eventId})`;
    const previous = sequence.get(event.sessionId);
    if (previous !== undefined && event.seq <= previous)
      problems.push({
        path: where,
        message: `session ${event.sessionId} seq ${String(event.seq)} is not after ${String(previous)}`,
      });
    sequence.set(event.sessionId, event.seq);
    const callKey =
      'callId' in event
        ? JSON.stringify([event.sessionId, event.callId])
        : null;
    const askKey =
      'askId' in event
        ? JSON.stringify([event.sessionId, event.askId])
        : event.kind === 'message' && event.replyToAskId !== undefined
          ? JSON.stringify([event.sessionId, event.replyToAskId])
          : null;
    if (callKey !== null) {
      if (event.kind === 'call') {
        if (calls.has(callKey))
          problems.push({ path: where, message: `duplicate call ${callKey}` });
        calls.add(callKey);
      } else if (!calls.has(callKey))
        problems.push({
          path: where,
          message: `call ${callKey} must exist earlier on the same session/path`,
        });
    }
    if (askKey !== null) {
      if (event.kind === 'ask') {
        if (asks.has(askKey))
          problems.push({ path: where, message: `duplicate ask ${askKey}` });
        asks.add(askKey);
      } else if (!asks.has(askKey))
        problems.push({
          path: where,
          message: `ask ${askKey} must exist earlier on the same session/path`,
        });
    }
    if (
      event.kind === 'ask' &&
      event.channel === 'approval' &&
      event.callId === undefined
    )
      problems.push({
        path: where,
        message: 'approval ask must bind a callId',
      });
    if (
      event.kind === 'message' &&
      ((event.source === 'human' && event.role !== 'user') ||
        (event.source === 'agent' && event.role !== 'assistant') ||
        (event.source === 'parent-relay' && event.role !== 'user'))
    )
      problems.push({
        path: where,
        message: 'message source and role disagree; relay is not human',
      });
    if (
      event.kind === 'message' &&
      event.replyToAskId !== undefined &&
      event.source !== 'human'
    )
      problems.push({
        path: where,
        message: 'only an actual human message may bind a human answer',
      });
  }
  return problems;
}

function sessionProblems(workflow: Workflow, path: string): readonly Finding[] {
  const problems: Finding[] = [
    ...duplicateFindings(
      workflow.sessions,
      (session) => session.sessionId,
      `${path}/sessions`,
      'session',
    ),
  ];
  const byId = new Map(
    workflow.sessions.map((session) => [session.sessionId, session]),
  );
  for (const session of workflow.sessions) {
    const seen = new Set<string>();
    let current: string | undefined = session.sessionId;
    while (current !== undefined) {
      if (seen.has(current)) {
        problems.push({
          path: `${path}/sessions`,
          message: `parent session cycle at ${current}`,
        });
        break;
      }
      seen.add(current);
      const value = byId.get(current);
      if (value === undefined) {
        problems.push({
          path: `${path}/sessions`,
          message: `unknown parent session ${current}`,
        });
        break;
      }
      current = value.parentSessionId;
    }
  }
  workflow.events.forEach((event, index) => {
    if (event.kind === 'message' && event.source === 'parent-relay') {
      const parent = byId.get(event.sessionId)?.parentSessionId;
      if (parent === undefined)
        problems.push({
          path: `${path}/events/${String(index)}`,
          message: 'relay requires a direct parent session',
        });
      else if (event.senderSessionId !== parent)
        problems.push({
          path: `${path}/events/${String(index)}`,
          message: 'relay sender must be the direct parent session',
        });
    } else if (event.kind === 'message' && event.senderSessionId !== undefined)
      problems.push({
        path: `${path}/events/${String(index)}`,
        message: 'senderSessionId belongs only to parent-relay messages',
      });
    if (!byId.has(event.sessionId))
      problems.push({
        path: `${path}/events/${String(index)}`,
        message: `event ${event.eventId} names unknown session ${event.sessionId}`,
      });
  });
  return problems;
}

function pointProblems(workflow: Workflow, path: string): readonly Finding[] {
  const problems: Finding[] = [];
  const points = new Map(
    workflow.points.map((point) => [point.pointId, point]),
  );
  workflow.points.forEach((point, index) => {
    const where = `${path}/points/${String(index)} (pointId=${point.pointId})`;
    try {
      const session = workflow.sessions.find(
        (item) => item.sessionId === point.sessionId,
      );
      if (session === undefined)
        throw new Error(`unknown point session ${point.sessionId}`);
      const events = eventsOnPath(workflow, branchOf(point));
      const pending = pendingOf(workflow, point);
      if (pending.route !== 'reviewer')
        throw new Error(
          `point must bind a reviewer call, found ${pending.route}`,
        );
      const own = sessionPrefix(events, point.sessionId, point.cutoffEventId);
      if (
        !('callEventId' in point.pending) &&
        own.some(
          (event) => event.kind === 'call' && event.callId === pending.callId,
        )
      )
        throw new Error(
          'pending call already exists in prefix; reference its callEventId instead',
        );
      if (
        own.some(
          (event) =>
            (event.kind === 'result' || event.kind === 'settlement') &&
            event.callId === pending.callId,
        )
      )
        throw new Error(
          `pending call ${pending.callId} already has a result/settlement in this cutoff`,
        );
      checkPendingBoundary(events, point, pending);
      if (
        session.parentSessionId !== undefined &&
        point.parentRead === undefined
      )
        throw new Error(
          'child point must record its actual parent read, including unavailable',
        );
      if (point.parentRead !== undefined) {
        if (point.parentRead.sessionId !== session.parentSessionId)
          throw new Error(
            'parent read must belong to the direct parent session',
          );
        if (
          point.parentRead.status === 'unavailable' &&
          point.parentRead.cutoffEventId !== null
        )
          throw new Error('unavailable parent cannot expose a prefix');
        sessionPrefix(
          events,
          point.parentRead.sessionId,
          point.parentRead.cutoffEventId,
        );
      }
      const seen = new Set([point.pointId]);
      let previous = point.predecessorPointId;
      while (previous !== undefined) {
        if (seen.has(previous))
          throw new Error(`point predecessor cycle at ${previous}`);
        seen.add(previous);
        const target = points.get(previous);
        if (target === undefined)
          throw new Error(`unknown predecessor point ${previous}`);
        if (!branchIsAncestor(workflow, branchOf(target), branchOf(point)))
          throw new Error(`predecessor branch is not an ancestor: ${previous}`);
        requirePointOnPath(events, target);
        if (target.sessionId === point.sessionId) {
          const previousPrefix = sessionPrefix(
            events,
            target.sessionId,
            target.cutoffEventId,
          );
          const previousSeq = previousPrefix.at(-1)?.seq ?? -1;
          const currentSeq = own.at(-1)?.seq ?? -1;
          if (previousSeq > currentSeq)
            throw new Error(`future predecessor point ${previous}`);
          if ('callEventId' in target.pending) {
            const previousCallId = target.pending.callEventId;
            const previousCall = events.find(
              (event) => event.eventId === previousCallId,
            );
            if (previousCall === undefined)
              throw new Error(`predecessor ${previous} is on another branch`);
            const currentCallId =
              'callEventId' in point.pending ? point.pending.callEventId : null;
            const currentCall = events.find(
              (event) => event.eventId === currentCallId,
            );
            if (previousCall.seq >= (currentCall?.seq ?? currentSeq + 1))
              throw new Error(`future predecessor point ${previous}`);
          }
        }
        previous = target.predecessorPointId;
      }
    } catch (error) {
      problems.push({
        path: where,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  for (const relation of workflow.relations ?? []) {
    for (const pointId of relation.pointIds)
      if (!points.has(pointId))
        problems.push({
          path: `${path}/relations (relationId=${relation.relationId})`,
          message: `unknown relation point ${pointId}`,
        });
  }
  return problems;
}

export function checkWorkflow(
  workflow: Workflow,
  path: string,
): readonly Finding[] {
  const problems = [
    ...sessionProblems(workflow, path),
    ...duplicateFindings(
      workflow.events,
      (event) => event.eventId,
      `${path}/events`,
      'event',
    ),
    ...duplicateFindings(
      workflow.points,
      (point) => point.pointId,
      `${path}/points`,
      'point',
    ),
    ...duplicateFindings(
      workflow.points,
      (point) => point.primaryViewId,
      `${path}/points`,
      'view',
    ),
    ...duplicateFindings(
      workflow.branches ?? [],
      (branch) => branch.branchId,
      `${path}/branches`,
      'branch',
    ),
    ...duplicateFindings(
      workflow.relations ?? [],
      (relation) => relation.relationId,
      `${path}/relations`,
      'relation',
    ),
  ];
  const branches = [
    'main',
    ...(workflow.branches ?? []).map((branch) => branch.branchId),
  ];
  if (workflow.branches?.some((branch) => branch.branchId === 'main') === true)
    problems.push({
      path: `${path}/branches`,
      message: 'main is the built-in branch, not a declaration',
    });
  for (const event of workflow.events)
    if (!branches.includes(branchOf(event)))
      problems.push({
        path: `${path}/events (eventId=${event.eventId})`,
        message: `unknown branch ${branchOf(event)}`,
      });
  for (const branch of branches) {
    try {
      const events = eventsOnPath(workflow, branch);
      problems.push(
        ...pathProblems(events, path),
        ...callSettlementProblems(events, path),
      );
    } catch (error) {
      problems.push({
        path: `${path}/branches`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  problems.push(...pointProblems(workflow, path));
  return problems;
}
