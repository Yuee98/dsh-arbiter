/** Allowlisted source selection. Production rendering/budgeting remains a separate step. */
import type {
  GroupedDataset,
  PendingAction,
  WorkflowEvent,
} from './group-types.js';
import {
  branchOf,
  eventsOnPath,
  pendingOf,
  sessionPrefix,
} from './workflow-path.js';

export interface PointMaterial {
  readonly sessionId: string;
  /** Scenario metadata, never evidence that a human said or authorized it. */
  readonly task: string;
  readonly environment?: {
    readonly cwd?: string;
    readonly description?: string;
  };
  readonly history: readonly WorkflowEvent[];
  readonly parent: {
    readonly sessionId: string;
    readonly status: 'complete' | 'partial' | 'unavailable';
    readonly events: readonly WorkflowEvent[];
  } | null;
  readonly pending: PendingAction;
}

/** A failed dataset cannot yield a partial/model-facing fallback. */
export function selectPointMaterial(
  dataset: GroupedDataset,
  rootId: string,
  pointId: string,
): PointMaterial {
  if (dataset.problems.length > 0)
    throw new Error('cannot select material from an invalid grouped dataset');
  const root = dataset.groups
    .flatMap((group) => group.workflows)
    .find((entry) => entry.document.rootId === rootId)?.document;
  const point = root?.points.find((item) => item.pointId === pointId);
  if (root === undefined || point === undefined)
    throw new Error(`unknown root/point ${rootId}/${pointId}`);
  const path = eventsOnPath(root, branchOf(point));
  const pending = pendingOf(root, point);
  const history = sessionPrefix(
    path,
    point.sessionId,
    point.cutoffEventId,
  ).filter(
    (event) => !(event.kind === 'call' && event.callId === pending.callId),
  );
  const read = point.parentRead;
  const parentPrefix =
    read === undefined
      ? []
      : sessionPrefix(path, read.sessionId, read.cutoffEventId);
  const humanAsks = new Set(
    parentPrefix.flatMap((event) =>
      event.kind === 'answer'
        ? [event.askId]
        : event.kind === 'message' &&
            event.source === 'human' &&
            event.replyToAskId !== undefined
          ? [event.replyToAskId]
          : [],
    ),
  );
  // Parent tools, checkpoints and relays are not original parent-human evidence.
  const parentEvents = parentPrefix.filter(
    (event) =>
      event.kind === 'answer' ||
      (event.kind === 'message' && event.source === 'human') ||
      (event.kind === 'ask' && humanAsks.has(event.askId)),
  );
  return structuredClone({
    sessionId: point.sessionId,
    task: root.task,
    ...(root.environment === undefined
      ? {}
      : { environment: root.environment }),
    history,
    parent:
      read === undefined
        ? null
        : {
            sessionId: read.sessionId,
            status: read.status,
            events: parentEvents,
          },
    pending,
  });
}
