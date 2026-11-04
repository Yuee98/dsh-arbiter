/** Fixed prefix agreement is not autonomous task completion or host continuation. */
import type { WorkflowPoint } from '../data/group-types.js';
import { classifyCell } from './behaviour.js';
import { COMPARED_CLASSES, ERROR_CLASSES } from './types.js';
import type { CellFacts } from './cell.js';
import { fractionOf } from './quality.js';
import { sourceOf } from './source.js';
import { nodeCell, workflowConditions } from './workflow-conditions.js';
import type {
  TrajectoryRow,
  TrajectorySection,
  WorkflowMetricSource,
} from './workflow-metrics-types.js';

function chainsOf(
  points: readonly WorkflowPoint[],
): readonly (readonly WorkflowPoint[])[] {
  const byId = new Map(points.map((point) => [point.pointId, point]));
  const predecessors = new Set(
    points.flatMap((point) => {
      const previous =
        point.predecessorPointId === undefined
          ? undefined
          : byId.get(point.predecessorPointId);
      // A continuation on another branch does not remove this branch's terminal.
      return previous !== undefined &&
        (previous.branchId ?? 'main') === (point.branchId ?? 'main')
        ? [previous.pointId]
        : [];
    }),
  );
  return points
    .filter((point) => !predecessors.has(point.pointId))
    .flatMap((terminal) => {
      const chain: WorkflowPoint[] = [],
        seen = new Set<string>();
      let point: WorkflowPoint | undefined = terminal;
      while (point !== undefined) {
        if (seen.has(point.pointId)) return [];
        seen.add(point.pointId);
        chain.unshift(point);
        point =
          point.predecessorPointId === undefined
            ? undefined
            : byId.get(point.predecessorPointId);
      }
      return chain.length < 2 ? [] : [chain];
    });
}
function rowOf(
  rootId: string,
  chain: readonly WorkflowPoint[],
  cells: readonly CellFacts[],
): TrajectoryRow | null {
  const first = cells[0],
    terminal = chain.at(-1);
  if (first === undefined || terminal === undefined) return null;
  const branchId = terminal.branchId ?? 'main';
  if (
    !cells.some((cell) => {
      const source = sourceOf(cell);
      return (
        source.kind === 'workflow' &&
        source.branchId === branchId &&
        chain.some((point) => point.pointId === source.pointId)
      );
    })
  )
    return null;
  const nodes = chain.map((point) => {
    const cell = nodeCell(cells, point.pointId, point.primaryViewId);
    return {
      pointId: point.pointId,
      viewId: point.primaryViewId,
      result:
        cell === null
          ? 'not-planned-or-ambiguous'
          : cell.reference === 'review-failure' &&
              cell.engineWord === 'review-failure' &&
              cell.standing === 'answered'
            ? 'engineering-matched'
            : classifyCell(cell),
    };
  });
  const partial = nodes.some(
    (node) => node.result === 'not-planned-or-ambiguous',
  );
  const firstUnassessable =
    nodes.find((node) => !isComparedResult(node.result))?.pointId ?? null;
  const firstObservedDeviation =
    nodes.find((node) => isErrorResult(node.result))?.pointId ?? null;
  return {
    rootId,
    branchId,
    terminalPointId: terminal.pointId,
    targetId: first.targetId,
    protocol: first.protocol,
    repeat: first.repeat,
    status: partial
      ? 'partial-scope'
      : firstUnassessable !== null
        ? 'incomplete'
        : firstObservedDeviation !== null
          ? 'violated'
          : 'satisfied',
    firstObservedDeviation,
    firstUnassessable,
    nodes,
  };
}
function isComparedResult(result: string): boolean {
  return (
    result === 'engineering-matched' ||
    COMPARED_CLASSES.some((classification) => classification === result)
  );
}
function isErrorResult(result: string): boolean {
  return ERROR_CLASSES.some((classification) => classification === result);
}
export function trajectorySection(
  cells: readonly CellFacts[],
  sources: readonly WorkflowMetricSource[],
): TrajectorySection {
  const rows = sources.flatMap(({ workflow }) =>
    chainsOf(workflow.points).flatMap((chain) =>
      workflowConditions(cells, workflow.rootId).flatMap((condition) => {
        const row = rowOf(workflow.rootId, chain, condition);
        return row === null ? [] : [row];
      }),
    ),
  );
  const count = (status: TrajectoryRow['status']) =>
    rows.filter((row) => row.status === status).length;
  const satisfied = count('satisfied'),
    violated = count('violated');
  return {
    evidence: 'fixed-source-prefixes',
    selected: rows.length,
    completeScope: rows.length - count('partial-scope'),
    assessable: satisfied + violated,
    satisfied,
    violated,
    incomplete: count('incomplete'),
    partialScope: count('partial-scope'),
    agreement: fractionOf(satisfied, satisfied + violated),
    actualContinuation: 'not-observed',
    rows,
  };
}
