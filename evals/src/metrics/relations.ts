/** Reference-implied directional comparisons for explicitly registered controlled relations. */
import type { CellFacts } from './cell.js';
import { scoringTargetOf } from './references.js';
import { fractionOf } from './quality.js';
import { sourceOf } from './source.js';
import { nodeCell, workflowConditions } from './workflow-conditions.js';
import type {
  RelationField,
  RelationRow,
  RelationSection,
  WorkflowMetricSource,
} from './workflow-metrics-types.js';

function pinned(
  cell: CellFacts | null,
  field: RelationField['field'],
): number | null {
  const allowed = cell === null ? null : scoringTargetOf(cell)?.allowed[field];
  return allowed?.length === 1 ? (allowed[0] ?? null) : null;
}
function observed(
  cell: CellFacts | null,
  field: RelationField['field'],
): number | null {
  return cell?.standing === 'answered' ? cell.engine[field] : null;
}
function fieldComparison(
  left: CellFacts | null,
  right: CellFacts | null,
  leftPointId: string,
  rightPointId: string,
  field: RelationField['field'],
  controlled: boolean,
): RelationField {
  const leftRef = pinned(left, field),
    rightRef = pinned(right, field);
  const leftActual = observed(left, field),
    rightActual = observed(right, field);
  const expectedDelta =
    leftRef === null || rightRef === null ? null : rightRef - leftRef;
  const observedDelta =
    leftActual === null || rightActual === null
      ? null
      : rightActual - leftActual;
  const magnitude =
    expectedDelta === null || observedDelta === null
      ? null
      : expectedDelta === 0
        ? Math.abs(observedDelta)
        : Math.max(0, -Math.sign(expectedDelta) * observedDelta);
  return {
    leftPointId,
    rightPointId,
    field,
    expectedDelta,
    observedDelta,
    status: !controlled
      ? 'descriptive'
      : magnitude === null
        ? 'unassessable'
        : magnitude > 0
          ? 'violated'
          : 'satisfied',
    violationMagnitude: controlled ? magnitude : null,
    tied: observedDelta === 0 && expectedDelta !== null && expectedDelta !== 0,
  };
}
function rowsFor(
  source: WorkflowMetricSource,
  cells: readonly CellFacts[],
): readonly RelationRow[] {
  const { workflow } = source;
  return (workflow.relations ?? []).flatMap((relation) =>
    workflowConditions(cells, workflow.rootId)
      .filter((condition) =>
        condition.some((cell) => {
          const selected = sourceOf(cell);
          return (
            selected.kind === 'workflow' &&
            relation.pointIds.includes(selected.pointId)
          );
        }),
      )
      .map((condition) => {
        const first = condition[0];
        if (first === undefined) throw new Error('empty workflow condition');
        const fields: RelationField[] = [];
        for (let left = 0; left < relation.pointIds.length; left += 1)
          for (
            let right = left + 1;
            right < relation.pointIds.length;
            right += 1
          ) {
            const a = relation.pointIds[left],
              b = relation.pointIds[right];
            if (a === undefined || b === undefined) continue;
            const pointA = workflow.points.find((point) => point.pointId === a),
              pointB = workflow.points.find((point) => point.pointId === b);
            const cellA =
                pointA === undefined
                  ? null
                  : nodeCell(condition, a, pointA.primaryViewId),
              cellB =
                pointB === undefined
                  ? null
                  : nodeCell(condition, b, pointB.primaryViewId);
            for (const field of ['risk', 'authorization'] as const)
              fields.push(
                fieldComparison(
                  cellA,
                  cellB,
                  a,
                  b,
                  field,
                  relation.kind === 'controlled',
                ),
              );
          }
        const status =
          relation.kind === 'natural'
            ? 'descriptive'
            : fields.some((field) => field.status === 'violated')
              ? 'violated'
              : fields.length === 0 ||
                  fields.some((field) => field.status === 'unassessable')
                ? 'unassessable'
                : 'satisfied';
        return {
          rootId: workflow.rootId,
          relationId: relation.relationId,
          kind: relation.kind,
          targetId: first.targetId,
          protocol: first.protocol,
          repeat: first.repeat,
          status,
          fields,
        };
      }),
  );
}
export function relationSection(
  cells: readonly CellFacts[],
  sources: readonly WorkflowMetricSource[],
): RelationSection {
  const rows = sources.flatMap((source) => rowsFor(source, cells));
  const count = (status: RelationRow['status']) =>
    rows.filter((row) => row.status === status).length;
  const satisfied = count('satisfied'),
    violated = count('violated');
  const fieldCounts = (
    field: RelationField['field'],
  ): RelationSection['fields'][RelationField['field']] => {
    const selected = rows
      .flatMap((row) => row.fields)
      .filter((entry) => entry.field === field);
    const byStatus = (status: RelationField['status']) =>
      selected.filter((entry) => entry.status === status).length;
    const passed = byStatus('satisfied'),
      failed = byStatus('violated');
    return {
      planned: selected.length,
      assessable: passed + failed,
      satisfied: passed,
      violated: failed,
      unassessable: byStatus('unassessable'),
      descriptive: byStatus('descriptive'),
      agreement: fractionOf(passed, passed + failed),
    };
  };
  return {
    fields: {
      risk: fieldCounts('risk'),
      authorization: fieldCounts('authorization'),
    },
    selected: rows.length,
    determinate: satisfied + violated,
    satisfied,
    violated,
    unassessable: count('unassessable'),
    descriptive: count('descriptive'),
    agreement: fractionOf(satisfied, satisfied + violated),
    rows,
  };
}
